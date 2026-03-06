const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ── Anthropic proxy ──
app.post('/api/claude', async (req, res) => {
  try {
    const fetch = (await import('node-fetch')).default;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Every PR field available ──
const PR_FIELDS = [
  "RadarID","Address","City","State","ZipFive","County","APN","PropertyURL","PhotoURL1",
  "Owner","OwnerFirstName","OwnerLastName","OwnerSpouseFirstName",
  "OwnerAddress","OwnerCity","OwnerState","OwnerZipFive",
  "OwnerPhone","OwnerEmail","PrimaryFirstName","PrimaryLastName","PrimaryPhone1","PrimaryEmail1",
  "SecondaryFirstName","SecondaryLastName",
  "AVM","AssessedValue","AnnualTaxes","AvailableEquity","EquityPercent",
  "TotalLoanBalance","NumberLoans","FirstAmount","FirstDate","FirstLenderOriginal","FirstPurpose","FirstRate",
  "LastTransferValue","LastTransferRecDate","LastTransferSeller","LastTransferType",
  "YearBuilt","SqFt","Beds","Baths","LotSize","Units","Stories","Pool","PType","Subdivision",
  "inForeclosure","ForeclosureStage","ForeclosureRecDate","DefaultAmount","DefaultAsOf",
  "isListedForSale","ListingPrice","DaysOnMarket","isSiteVacant","isMailVacant","isSameMailingOrExempt",
  "OpeningBid","WinningBid","SaleAmount","SaleTime","SalePlace","PostReason",
  "LisPendensType","CaseNumber","Attorney",
  "DOTPosition","EstimatedTaxRate","OriginalSaleDate","PreviousSaleDate",
  "Latitude","Longitude"
];

// ── PR fetch with timeout ──
async function callPR(token, body) {
  const fetch = (await import('node-fetch')).default;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch('https://api.propertyradar.com/v1/properties', {
      method: 'POST',
      headers: {'Content-Type':'application/json','Authorization':`Bearer ${token}`},
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await r.text();
    console.log(`[PR] ${r.status} — ${text.substring(0,400)}`);
    if (!r.ok) throw new Error(`PR ${r.status}: ${text.substring(0,300)}`);
    const parsed = JSON.parse(text);
    const results = parsed.results || parsed.data || parsed.Records || parsed.properties || [];
    console.log(`[PR] ${results.length} results | keys: ${Object.keys(parsed).join(',')}`);
    if (results.length) console.log(`[PR] record keys: ${Object.keys(results[0]).join(',')}`);
    return { results, meta: parsed };
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('PropertyRadar timed out after 15s');
    throw e;
  }
}

// ── Search by address ──
app.post('/api/propertyradar/search', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if (!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const { address } = req.body;
    const street = (address||'').split(',')[0].trim();
    console.log(`[search] "${street}"`);
    const { results } = await callPR(token, {
      Criteria: [{name:"SiteAddress", value:[street]}],
      Fields: PR_FIELDS,
      Count: 5
    });
    res.json({ results, count: results.length });
  } catch(e) {
    console.error('[search]', e.message);
    res.status(500).json({error: e.message});
  }
});

// ── Distressed leads — stacks multiple signals for highest quality ──
app.post('/api/propertyradar/leads', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if (!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const { city, state, signals=[], count=25, minScore=0 } = req.body;
    console.log(`[leads] city="${city}" state="${state}" signals=${JSON.stringify(signals)} count=${count}`);

    // Run up to 3 parallel queries with different signal combinations, merge + dedupe
    const queries = buildDistressQueries(city, state, signals, count);
    console.log(`[leads] running ${queries.length} parallel PR queries`);

    const allResults = await Promise.all(
      queries.map(q => callPR(token, q).catch(e => { console.warn('query failed:', e.message); return {results:[]}; }))
    );

    // Merge and deduplicate by RadarID
    const seen = new Set();
    const merged = [];
    for (const { results } of allResults) {
      for (const r of results) {
        const id = r.RadarID || (r.Address+r.City);
        if (!seen.has(id)) { seen.add(id); merged.push(r); }
      }
    }

    console.log(`[leads] merged ${merged.length} unique properties from ${allResults.length} queries`);
    res.json({ results: merged.slice(0, count), count: merged.length });
  } catch(e) {
    console.error('[leads]', e.message);
    res.status(500).json({error: e.message});
  }
});

function buildDistressQueries(city, state, signals, count) {
  const base = [];
  if (city)  base.push({name:"SiteCity",  value:[city]});
  if (state) base.push({name:"SiteState", value:[state]});

  const queries = [];
  const perQuery = Math.ceil(count / 3);

  // Query 1: Foreclosure / NOD / Default — highest urgency
  queries.push({
    Criteria: [...base, {name:"inForeclosure", value:["Yes"]}],
    Fields: PR_FIELDS, Count: perQuery,
    Sort: [{field:"DefaultAmount", direction:"desc"}]
  });

  // Query 2: Absentee + high equity — classic motivated seller
  queries.push({
    Criteria: [...base,
      {name:"isSameMailingOrExempt", value:["No"]},
      {name:"EquityPercent", value:[[40, null]]}
    ],
    Fields: PR_FIELDS, Count: perQuery,
    Sort: [{field:"EquityPercent", direction:"desc"}]
  });

  // Query 3: Vacant or tax delinquent
  queries.push({
    Criteria: [...base, {name:"isSiteVacant", value:["Yes"]}],
    Fields: PR_FIELDS, Count: perQuery,
    Sort: [{field:"AVM", direction:"desc"}]
  });

  // Override if specific signals selected
  if (signals.includes('Pre-Foreclosure')) {
    queries[0].Criteria = [...base, {name:"inForeclosure", value:["Yes"]}];
  }
  if (signals.includes('High Equity')) {
    queries[1].Criteria = [...base, {name:"EquityPercent", value:[[60, null]]}];
  }

  return queries;
}

// ── Test connection ──
app.get('/api/propertyradar/test', async (req, res) => {
  const token = req.headers['x-pr-token'] || req.query.token;
  if (!token) return res.status(401).json({error:'Provide token'});
  try {
    const { results, meta } = await callPR(token, {
      Criteria: [{name:"SiteState", value:["CA"]}],
      Fields: ["RadarID","Address","City","State","Owner","AVM","Beds","Baths","inForeclosure","EquityPercent","isSiteVacant","isSameMailingOrExempt"],
      Count: 2
    });
    res.json({status:'connected', count:results.length, sample:results[0]||null, metaKeys:Object.keys(meta)});
  } catch(e) {
    res.status(500).json({status:'error', error:e.message});
  }
});

app.get('/health', (_, res) => res.json({status:'ok', version:'5.0-multi-signal'}));
app.listen(PORT, () => console.log(`DistressedLeads v5.0 on port ${PORT}`));
