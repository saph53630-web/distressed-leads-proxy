const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

// Always return JSON, never HTML
app.use((req, res, next) => { res.setHeader('Content-Type','application/json'); next(); });

app.get('/', (_, res) => res.json({status:'ok',service:'DistressedLeads Proxy',version:'5.1'}));
app.get('/health', (_, res) => res.json({status:'ok',version:'5.1'}));

// Anthropic proxy
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

async function callPR(token, body) {
  const fetch = (await import('node-fetch')).default;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    console.log('[PR] Request:', JSON.stringify(body).substring(0,300));
    const r = await fetch('https://api.propertyradar.com/v1/properties', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    const text = await r.text();
    console.log(`[PR] ${r.status} — ${text.substring(0,400)}`);
    if (!r.ok) throw new Error(`PR API ${r.status}: ${text.substring(0,200)}`);
    let parsed;
    try { parsed = JSON.parse(text); }
    catch(e) { throw new Error(`PR returned non-JSON (${r.status}): ${text.substring(0,100)}`); }
    const results = parsed.results||parsed.data||parsed.Records||parsed.properties||parsed.items||[];
    console.log(`[PR] ${results.length} results, keys: ${Object.keys(parsed).join(',')}`);
    if(results.length) console.log(`[PR] record keys: ${Object.keys(results[0]).join(',')}`);
    return { results, meta: parsed };
  } catch(e) {
    clearTimeout(timer);
    if(e.name==='AbortError') throw new Error('PropertyRadar timed out — try again');
    throw e;
  }
}

// Search by address
app.post('/api/propertyradar/search', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const street = (req.body.address||'').split(',')[0].trim();
    console.log(`[search] "${street}"`);
    const {results} = await callPR(token, {
      Criteria:[{name:'SiteAddress',value:[street]}],
      Fields:PR_FIELDS, Count:5
    });
    res.json({results, count:results.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Distressed leads — 3 parallel queries
app.post('/api/propertyradar/leads', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const {city, state, signals=[], count=25} = req.body;
    if(!city) return res.status(400).json({error:'Missing city'});
    console.log(`[leads] ${city}, ${state} | signals: ${signals} | count: ${count}`);

    const base = [];
    if(city)  base.push({name:'SiteCity',  value:[city]});
    if(state) base.push({name:'SiteState', value:[state]});
    const perQ = Math.ceil(count/3);

    const queries = [
      { Criteria:[...base,{name:'inForeclosure',value:['Yes']}], Fields:PR_FIELDS, Count:perQ, Sort:[{field:'DefaultAmount',direction:'desc'}] },
      { Criteria:[...base,{name:'isSameMailingOrExempt',value:['No']},{name:'EquityPercent',value:[[40,null]]}], Fields:PR_FIELDS, Count:perQ, Sort:[{field:'EquityPercent',direction:'desc'}] },
      { Criteria:[...base,{name:'isSiteVacant',value:['Yes']}], Fields:PR_FIELDS, Count:perQ, Sort:[{field:'AVM',direction:'desc'}] }
    ];

    const allRes = await Promise.all(
      queries.map(q => callPR(token,q).catch(e => { console.warn('sub-query failed:',e.message); return {results:[]}; }))
    );

    const seen = new Set(), merged = [];
    for(const {results} of allRes)
      for(const r of results) {
        const id = r.RadarID||(r.Address+r.City);
        if(!seen.has(id)){ seen.add(id); merged.push(r); }
      }

    console.log(`[leads] ${merged.length} unique results`);
    res.json({results:merged.slice(0,count), count:merged.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Test connection
app.get('/api/propertyradar/test', async (req, res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  if(!token) return res.status(401).json({error:'Provide token'});
  try {
    const {results, meta} = await callPR(token, {
      Criteria:[{name:'SiteState',value:['CA']}],
      Fields:['RadarID','Address','City','State','Owner','AVM','Beds','Baths','inForeclosure','EquityPercent'],
      Count:2
    });
    res.json({status:'connected', count:results.length, sample:results[0]||null, metaKeys:Object.keys(meta)});
  } catch(e) { res.status(500).json({status:'error', error:e.message}); }
});

// Always JSON 404
app.use((req,res) => res.status(404).json({error:`Not found: ${req.method} ${req.path}`}));
app.use((err,req,res,next) => { console.error(err); res.status(500).json({error:err.message}); });

app.listen(PORT, () => console.log(`DistressedLeads v5.1 on port ${PORT}`));
