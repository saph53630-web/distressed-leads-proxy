const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => { res.setHeader('Content-Type','application/json'); next(); });
app.get('/', (_, res) => res.json({status:'ok',version:'5.8'}));
app.get('/health', (_, res) => res.json({status:'ok',version:'5.8'}));

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

// CONFIRMED WORKING criteria names (from debug):
// State, ZipFive, City, inForeclosure, isSiteVacant, isSameMailingOrExempt, EquityPercent
// Purchase=0 = count only (free), Purchase=1 = return data (uses export credits)
// Limit and Fields are query params

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

async function callPR(token, criteria, limit=25) {
  const fetch = (await import('node-fetch')).default;
  const params = new URLSearchParams();
  params.set('Purchase', 1);
  params.set('Limit', limit);
  PR_FIELDS.forEach(f => params.append('Fields', f));
  console.log(`[PR] criteria: ${JSON.stringify(criteria)} limit:${limit}`);
  const r = await fetch(`${PR_BASE}?${params}`, {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
    body: JSON.stringify({Criteria: criteria}),
    signal: AbortSignal.timeout(25000)
  });
  const text = await r.text();
  console.log(`[PR] ${r.status} — ${text.substring(0,400)}`);
  if(!r.ok) throw new Error(`PR ${r.status}: ${text.substring(0,200)}`);
  const parsed = JSON.parse(text);
  const results = parsed.results||parsed.data||parsed.Records||parsed.properties||parsed.items||[];
  console.log(`[PR] ${results.length} results of ${parsed.totalResultCount||'?'} total`);
  if(results.length) console.log(`[PR] keys: ${Object.keys(results[0]).join(',')}`);
  return { results, meta: parsed };
}

// Test connection
app.get('/api/propertyradar/test', async (req, res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  if(!token) return res.status(401).json({error:'Provide token'});
  try {
    const {results, meta} = await callPR(token, [{name:'State', value:['CA']}], 2);
    res.json({
      status:'connected',
      count: results.length,
      totalAvailable: meta.totalResultCount||0,
      sample: results[0]||null
    });
  } catch(e) { res.status(500).json({status:'error', error:e.message}); }
});

// Search by address — parse full address into criteria components
app.post('/api/propertyradar/search', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const full = (req.body.address||req.body.fullAddress||'').trim();
    if(!full) return res.status(400).json({error:'Missing address'});
    console.log(`[search] "${full}"`);

    // Parse "123 Main St, Atlanta, GA 30301" into parts
    const parts = full.split(',').map(p => p.trim());
    const street = parts[0] || '';
    const cityRaw = parts[1] || '';
    const stateZip = (parts[2] || '').trim();
    const state = stateZip.split(' ')[0] || '';
    const zip = stateZip.split(' ')[1] || '';

    // Build criteria — always use street, add city/state/zip if available
    const criteria = [{name:'Address', value:[street]}];
    if(cityRaw) criteria.push({name:'City', value:[cityRaw]});
    if(state) criteria.push({name:'State', value:[state]});
    if(zip && zip.length === 5) criteria.push({name:'ZipFive', value:[zip]});

    console.log('[search] criteria:', JSON.stringify(criteria));
    const {results} = await callPR(token, criteria, 5);
    res.json({results, count:results.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Distressed leads — 3 parallel queries with confirmed criteria names
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
      [...base, {name:'inForeclosure',         value:['Yes']}],
      [...base, {name:'isSameMailingOrExempt',  value:['No']}, {name:'EquityPercent', value:[[40,null]]}],
      [...base, {name:'isSiteVacant',           value:['Yes']}]
    ];

    const allRes = await Promise.all(
      criteriaList.map(c =>
        callPR(token, c, perQ)
          .catch(e => { console.warn('[leads] sub-query failed:', e.message); return {results:[]}; })
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
app.listen(PORT, () => console.log(`DistressedLeads v5.7 on port ${PORT}`));
