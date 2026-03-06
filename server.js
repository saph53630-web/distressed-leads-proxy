const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => { res.setHeader('Content-Type','application/json'); next(); });
app.get('/', (_, res) => res.json({status:'ok',version:'5.6'}));
app.get('/health', (_, res) => res.json({status:'ok',version:'5.6'}));

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
  "OpeningBid","WinningBid","LisPendensType","CaseNumber","Attorney","Latitude","Longitude"
];

const PR_BASE = 'https://api.propertyradar.com/v1/properties';

async function prPost(token, criteria, limit, purchase) {
  const fetch = (await import('node-fetch')).default;
  const params = new URLSearchParams();
  params.set('Purchase', purchase);
  params.set('Limit', limit);
  if(purchase === 1) PR_FIELDS.forEach(f => params.append('Fields', f));
  const r = await fetch(`${PR_BASE}?${params}`, {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
    body: JSON.stringify({Criteria: criteria}),
    signal: AbortSignal.timeout(20000)
  });
  const text = await r.text();
  console.log(`[PR] ${r.status} criteria=${JSON.stringify(criteria).substring(0,100)} — ${text.substring(0,300)}`);
  if(!r.ok) throw new Error(`PR ${r.status}: ${text.substring(0,200)}`);
  const parsed = JSON.parse(text);
  return { results: parsed.results||parsed.data||parsed.Records||parsed.properties||parsed.items||[], meta: parsed };
}

async function callPR(token, criteria, limit=25) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const out = await prPost(token, criteria, limit, 1);
    clearTimeout(timer);
    return out;
  } catch(e) {
    clearTimeout(timer);
    if(e.name==='AbortError') throw new Error('PropertyRadar timed out');
    throw e;
  }
}

// Debug — tests every possible criteria name variant
app.get('/api/propertyradar/debug', async (req, res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  if(!token) return res.status(401).json({error:'Provide token'});
  const fetch = (await import('node-fetch')).default;

  const tests = [
    {label:'State',       criteria:[{name:'State',       value:['CA']}]},
    {label:'SiteState',   criteria:[{name:'SiteState',   value:['CA']}]},
    {label:'City',        criteria:[{name:'City',        value:['Los Angeles']}]},
    {label:'SiteCity',    criteria:[{name:'SiteCity',    value:['Los Angeles']}]},
    {label:'ZipFive_num', criteria:[{name:'ZipFive',     value:[90210]}]},
    {label:'ZipFive_str', criteria:[{name:'ZipFive',     value:['90210']}]},
    {label:'inForeclosure',criteria:[{name:'inForeclosure',value:['Yes']}]},
    {label:'empty',       criteria:[]}
  ];

  const results = {};
  for(const {label, criteria} of tests) {
    try {
      const r = await fetch(`${PR_BASE}?Purchase=0&Limit=1`, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
        body: JSON.stringify({Criteria: criteria}),
        signal: AbortSignal.timeout(8000)
      });
      const text = await r.text();
      results[label] = {status:r.status, preview:text.substring(0,150)};
    } catch(e) {
      results[label] = {error:e.message};
    }
  }
  res.json({version:'5.6', token_prefix:token.substring(0,8)+'...', tests:results});
});

// Test connection
app.get('/api/propertyradar/test', async (req, res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  if(!token) return res.status(401).json({error:'Provide token'});
  try {
    const {results} = await callPR(token, [{name:'State', value:['CA']}], 2);
    res.json({status:'connected', count:results.length, sample:results[0]||null});
  } catch(e) { res.status(500).json({status:'error', error:e.message}); }
});

// Search by address
app.post('/api/propertyradar/search', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const street = (req.body.address||'').split(',')[0].trim();
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
    const base = [];
    if(city)  base.push({name:'City',  value:[city]});
    if(state) base.push({name:'State', value:[state]});
    const perQ = Math.ceil(count/3);
    const criteriaList = [
      [...base, {name:'inForeclosure',        value:['Yes']}],
      [...base, {name:'isSameMailingOrExempt', value:['No']}, {name:'EquityPercent', value:[[40,null]]}],
      [...base, {name:'isSiteVacant',          value:['Yes']}]
    ];
    const allRes = await Promise.all(
      criteriaList.map(c => callPR(token,c,perQ).catch(e=>{console.warn('query fail:',e.message);return {results:[]};}))
    );
    const seen=new Set(), merged=[];
    for(const {results} of allRes)
      for(const r of results){
        const id=r.RadarID||(r.Address+r.City);
        if(!seen.has(id)){seen.add(id);merged.push(r);}
      }
    res.json({results:merged.slice(0,count), count:merged.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.use((req,res) => res.status(404).json({error:`Not found: ${req.method} ${req.path}`}));
app.use((err,req,res,next) => { console.error(err); res.status(500).json({error:err.message}); });
app.listen(PORT, () => console.log(`DistressedLeads v5.6 on port ${PORT}`));
