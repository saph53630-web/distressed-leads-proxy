const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => { res.setHeader('Content-Type','application/json'); next(); });
app.get('/', (_, res) => res.json({status:'ok',version:'5.5'}));
app.get('/health', (_, res) => res.json({status:'ok',version:'5.5'}));

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

// PR API correct field names (from docs):
// Criteria names: State, City, Address, inForeclosure, isSiteVacant, isSameMailingOrExempt, EquityPercent
// Purchase=0 (count only, free) or Purchase=1 (returns data, costs export credits)
// Limit and Fields go as query params

const PR_FIELDS = [
  "RadarID","Address","City","State","ZipFive","County","APN","PropertyURL","PhotoURL1",
  "Owner","OwnerFirstName","OwnerLastName","OwnerSpouseFirstName",
  "OwnerAddress","OwnerCity","OwnerState","OwnerZipFive",
  "OwnerPhone","OwnerEmail","PrimaryPhone1","PrimaryEmail1",
  "AVM","AssessedValue","AnnualTaxes","AvailableEquity","EquityPercent",
  "TotalLoanBalance","NumberLoans","FirstAmount","FirstDate","FirstLenderOriginal","FirstPurpose","FirstRate",
  "LastTransferValue","LastTransferRecDate","LastTransferSeller","LastTransferType",
  "YearBuilt","SqFt","Beds","Baths","LotSize","Units","Stories","Pool","PType","Subdivision",
  "inForeclosure","ForeclosureStage","ForeclosureRecDate","DefaultAmount","DefaultAsOf",
  "isListedForSale","ListingPrice","DaysOnMarket","isSiteVacant","isMailVacant","isSameMailingOrExempt",
  "OpeningBid","WinningBid","LisPendensType","CaseNumber","Attorney",
  "Latitude","Longitude"
];

const PR_BASE = 'https://api.propertyradar.com/v1/properties';

async function callPR(token, criteria, limit=25, purchase=1) {
  const fetch = (await import('node-fetch')).default;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  const params = new URLSearchParams();
  params.set('Purchase', purchase);
  params.set('Limit', limit);
  if(purchase === 1) PR_FIELDS.forEach(f => params.append('Fields', f));

  const url = `${PR_BASE}?${params.toString()}`;
  const body = { Criteria: criteria };

  try {
    console.log(`[PR] POST ${PR_BASE}?Purchase=${purchase}&Limit=${limit}`);
    console.log(`[PR] Criteria:`, JSON.stringify(criteria));
    const r = await fetch(url, {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,'Accept':'application/json'},
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await r.text();
    console.log(`[PR] ${r.status} — ${text.substring(0,600)}`);
    if(text.trimStart().startsWith('<')) throw new Error(`PR returned HTML (${r.status}) — token invalid/expired`);
    if(!r.ok) throw new Error(`PR ${r.status}: ${text.substring(0,300)}`);
    let parsed;
    try { parsed = JSON.parse(text); } catch(e) { throw new Error(`PR non-JSON: ${text.substring(0,150)}`); }
    const results = parsed.results||parsed.data||parsed.Records||parsed.properties||parsed.items||[];
    console.log(`[PR] ${results.length} results — keys: ${Object.keys(parsed).join(',')}`);
    if(results.length) console.log(`[PR] first record keys: ${Object.keys(results[0]).join(',')}`);
    return { results, meta: parsed };
  } catch(e) {
    clearTimeout(timer);
    if(e.name==='AbortError') throw new Error('PropertyRadar timed out — try again');
    throw e;
  }
}

// Debug — tries multiple criteria name formats to find what works
app.get('/api/propertyradar/debug', async (req, res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  if(!token) return res.status(401).json({error:'Provide token'});
  const fetch = (await import('node-fetch')).default;

  const tests = {
    'State': [{name:'State', value:['CA']}],
    'SiteState': [{name:'SiteState', value:['CA']}],
    'state_lowercase': [{name:'state', value:['CA']}],
    'ZipFive': [{name:'ZipFive', value:['90210']}],
    'empty_criteria': []
  };

  const results = {};
  for(const [label, criteria] of Object.entries(tests)) {
    try {
      const r = await fetch(`${PR_BASE}?Purchase=0&Limit=1`, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
        body: JSON.stringify({Criteria: criteria}),
        signal: AbortSignal.timeout(8000)
      });
      const text = await r.text();
      results[label] = {status:r.status, preview:text.substring(0,200)};
    } catch(e) {
      results[label] = {error:e.message};
    }
  }
  res.json({token_prefix:token.substring(0,8)+'...', tests:results});
});

// Test connection
app.get('/api/propertyradar/test', async (req, res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  if(!token) return res.status(401).json({error:'Provide token'});
  try {
    const {results, meta} = await callPR(token, [{name:'State', value:['CA']}], 2, 1);
    res.json({status:'connected', count:results.length, sample:results[0]||null, meta_keys:Object.keys(meta)});
  } catch(e) { res.status(500).json({status:'error', error:e.message}); }
});

// Search by address
app.post('/api/propertyradar/search', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const street = (req.body.address||'').split(',')[0].trim();
    console.log(`[search] "${street}"`);
    const {results} = await callPR(token, [{name:'Address', value:[street]}], 5);
    res.json({results, count:results.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Distressed leads
app.post('/api/propertyradar/leads', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const {city, state, count=25} = req.body;
    if(!city) return res.status(400).json({error:'Missing city'});
    console.log(`[leads] ${city}, ${state} | count:${count}`);

    const base = [];
    if(city)  base.push({name:'City',  value:[city]});
    if(state) base.push({name:'State', value:[state]});
    const perQ = Math.ceil(count/3);

    const criteriaList = [
      [...base, {name:'inForeclosure', value:['Yes']}],
      [...base, {name:'isSameMailingOrExempt', value:['No']}, {name:'EquityPercent', value:[[40,null]]}],
      [...base, {name:'isSiteVacant', value:['Yes']}]
    ];

    const allRes = await Promise.all(
      criteriaList.map(criteria =>
        callPR(token, criteria, perQ)
          .catch(e => { console.warn('sub-query failed:', e.message); return {results:[]}; })
      )
    );

    const seen=new Set(), merged=[];
    for(const {results} of allRes)
      for(const r of results){
        const id=r.RadarID||(r.Address+r.City);
        if(!seen.has(id)){seen.add(id);merged.push(r);}
      }

    console.log(`[leads] ${merged.length} unique results`);
    res.json({results:merged.slice(0,count), count:merged.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.use((req,res) => res.status(404).json({error:`Not found: ${req.method} ${req.path}`}));
app.use((err,req,res,next) => { console.error(err); res.status(500).json({error:err.message}); });
app.listen(PORT, () => console.log(`DistressedLeads v5.5 on port ${PORT}`));
