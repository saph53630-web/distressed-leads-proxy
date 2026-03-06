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
      headers:{
        'Content-Type':'application/json',
        'x-api-key':process.env.ANTHROPIC_API_KEY,
        'anthropic-version':'2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── All PropertyRadar fields ──
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
  "isListedForSale","ListingPrice","DaysOnMarket",
  "isSiteVacant","isMailVacant","isSameMailingOrExempt",
  "Latitude","Longitude"
];

// ── PropertyRadar fetch helper ──
async function callPR(token, body) {
  const fetch = (await import('node-fetch')).default;
  const r = await fetch('https://api.propertyradar.com/v1/properties', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  console.log(`[PR] status=${r.status} body=${text.substring(0,600)}`);
  if (!r.ok) throw new Error(`PropertyRadar ${r.status}: ${text}`);
  const parsed = JSON.parse(text);
  // Normalize: PR returns {results:[...]} but log all keys
  console.log(`[PR] response top-level keys: ${Object.keys(parsed).join(', ')}`);
  const arr = parsed.results || parsed.data || parsed.Records || parsed.properties || [];
  if (arr.length) console.log(`[PR] first record keys: ${Object.keys(arr[0]).join(', ')}`);
  return { results: arr, meta: parsed };
}

// ── Search by address ──
app.post('/api/propertyradar/search', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if (!token) return res.status(401).json({error:'Missing x-pr-token header'});
  try {
    const { address } = req.body;
    console.log(`[PR search] address="${address}"`);
    // Use just street portion for best match
    const street = address ? address.split(',')[0].trim() : address;
    const { results, meta } = await callPR(token, {
      Criteria: [{ name: "SiteAddress", value: [street] }],
      Fields: PR_FIELDS,
      Count: 5
    });
    res.json({ results, count: results.length, meta });
  } catch(e) {
    console.error('[PR search]', e.message);
    res.status(500).json({error: e.message});
  }
});

// ── Leads by city with distress signals ──
app.post('/api/propertyradar/leads', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if (!token) return res.status(401).json({error:'Missing x-pr-token header'});
  try {
    const { city, state, signals = [], count = 25 } = req.body;
    console.log(`[PR leads] city="${city}" state="${state}" signals=${JSON.stringify(signals)}`);

    const criteria = [];
    if (city)  criteria.push({ name: "SiteCity",  value: [city]  });
    if (state) criteria.push({ name: "SiteState", value: [state] });

    // Map signals to PR filter criteria
    const sigMap = {
      'Pre-Foreclosure':    { name: "inForeclosure",         value: ["Yes"]     },
      'Vacant Property':    { name: "isSiteVacant",          value: ["Yes"]     },
      'Absentee Owner':     { name: "isSameMailingOrExempt", value: ["No"]      },
      'High Equity':        { name: "EquityPercent",         value: [[50,null]] },
      'Behind on Payments': { name: "DefaultAmount",         value: [[1, null]] },
      'Tax Delinquent':     { name: "DefaultAmount",         value: [[1, null]] },
    };
    let addedSig = false;
    for (const s of signals) {
      if (sigMap[s]) { criteria.push(sigMap[s]); addedSig = true; break; } // one signal at a time
    }
    // Default filter if nothing matched
    if (!addedSig) criteria.push({ name: "isSameMailingOrExempt", value: ["No"] });

    const { results, meta } = await callPR(token, {
      Criteria: criteria,
      Fields: PR_FIELDS,
      Count: Math.min(count, 100),
      Sort: [{ field: "EquityPercent", direction: "desc" }]
    });
    res.json({ results, count: results.length, meta });
  } catch(e) {
    console.error('[PR leads]', e.message);
    res.status(500).json({error: e.message});
  }
});

// ── Test endpoint ──
app.get('/api/propertyradar/test', async (req, res) => {
  const token = req.headers['x-pr-token'] || req.query.token;
  if (!token) return res.status(401).json({error:'Provide token via x-pr-token header or ?token= param'});
  try {
    const { results, meta } = await callPR(token, {
      Criteria: [{ name: "SiteState", value: ["CA"] }],
      Fields: ["RadarID","Address","City","State","Owner","AVM","Beds","Baths","inForeclosure"],
      Count: 2
    });
    res.json({ status:'connected', resultCount: results.length, sample: results[0]||null, metaKeys: Object.keys(meta) });
  } catch(e) {
    res.status(500).json({status:'error', error: e.message});
  }
});

app.get('/health', (_, res) => res.json({status:'ok', version:'4.0'}));
app.listen(PORT, () => console.log(`DistressedLeads proxy v4.0 on port ${PORT}`));
