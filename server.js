const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => { res.setHeader('Content-Type','application/json'); next(); });
app.get('/', (_, res) => res.json({status:'ok',version:'5.2'}));
app.get('/health', (_, res) => res.json({status:'ok',version:'5.2'}));

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

// The correct PR API URL — try both known variants
const PR_URLS = [
  'https://api.propertyradar.com/v1/properties',
  'https://app.propertyradar.com/api/v1/properties'
];

async function callPR(token, body) {
  const fetch = (await import('node-fetch')).default;

  // Try primary URL
  const url = PR_URLS[0];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    console.log(`[PR] POST ${url}`);
    console.log(`[PR] Body: ${JSON.stringify(body).substring(0,300)}`);

    const r = await fetch(url, {
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'Authorization':`Bearer ${token}`,
        'Accept':'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);

    const text = await r.text();
    console.log(`[PR] Status: ${r.status}`);
    console.log(`[PR] Headers: ${JSON.stringify(Object.fromEntries(r.headers))}`);
    console.log(`[PR] Body preview: ${text.substring(0,600)}`);

    // If we got HTML back, the URL is wrong or server is down
    if(text.trimStart().startsWith('<')) {
      throw new Error(`PR API returned HTML (status ${r.status}) — check URL or token. Preview: ${text.substring(0,100)}`);
    }

    if(!r.ok) {
      throw new Error(`PR API ${r.status}: ${text.substring(0,300)}`);
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch(e) { throw new Error(`PR non-JSON response (${r.status}): ${text.substring(0,150)}`); }

    const results = parsed.results||parsed.data||parsed.Records||parsed.properties||parsed.items||[];
    console.log(`[PR] ${results.length} results. Keys: ${Object.keys(parsed).join(',')}`);
    if(results.length) console.log(`[PR] First record keys: ${Object.keys(results[0]).join(',')}`);
    return { results, meta: parsed };

  } catch(e) {
    clearTimeout(timer);
    if(e.name==='AbortError') throw new Error('PropertyRadar timed out after 25s');
    throw e;
  }
}

// Debug endpoint — shows exactly what PR returns
app.get('/api/propertyradar/debug', async (req, res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  if(!token) return res.status(401).json({error:'Provide token'});
  const fetch = (await import('node-fetch')).default;
  const results = {};
  for(const url of PR_URLS) {
    try {
      const r = await fetch(url, {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`,'Accept':'application/json'},
        body: JSON.stringify({Criteria:[{name:'SiteState',value:['CA']}],Fields:['RadarID','Address','City'],Count:1}),
        signal: AbortSignal.timeout(10000)
      });
      const text = await r.text();
      results[url] = {status:r.status, isHTML:text.trimStart().startsWith('<'), preview:text.substring(0,200)};
    } catch(e) {
      results[url] = {error:e.message};
    }
  }
  res.json({token_length:token.length, token_prefix:token.substring(0,8)+'...', url_results:results});
});

// Test connection
app.get('/api/propertyradar/test', async (req, res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  if(!token) return res.status(401).json({error:'Provide token'});
  try {
    const {results, meta} = await callPR(token, {
      Criteria:[{name:'SiteState',value:['CA']}],
      Fields:['RadarID','Address','City','State','Owner','AVM','inForeclosure','EquityPercent'],
      Count:2
    });
    res.json({status:'connected', count:results.length, sample:results[0]||null, metaKeys:Object.keys(meta)});
  } catch(e) {
    res.status(500).json({status:'error', error:e.message});
  }
});

// Search by address
app.post('/api/propertyradar/search', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const street = (req.body.address||'').split(',')[0].trim();
    const {results} = await callPR(token, {
      Criteria:[{name:'SiteAddress',value:[street]}],
      Fields:PR_FIELDS, Count:5
    });
    res.json({results, count:results.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// Distressed leads
app.post('/api/propertyradar/leads', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const {city, state, signals=[], count=25} = req.body;
    if(!city) return res.status(400).json({error:'Missing city'});
    console.log(`[leads] ${city}, ${state} count:${count}`);

    const base = [];
    if(city)  base.push({name:'SiteCity',  value:[city]});
    if(state) base.push({name:'SiteState', value:[state]});
    const perQ = Math.ceil(count/3);

    const queries = [
      {Criteria:[...base,{name:'inForeclosure',value:['Yes']}], Fields:PR_FIELDS, Count:perQ, Sort:[{field:'DefaultAmount',direction:'desc'}]},
      {Criteria:[...base,{name:'isSameMailingOrExempt',value:['No']},{name:'EquityPercent',value:[[40,null]]}], Fields:PR_FIELDS, Count:perQ, Sort:[{field:'EquityPercent',direction:'desc'}]},
      {Criteria:[...base,{name:'isSiteVacant',value:['Yes']}], Fields:PR_FIELDS, Count:perQ, Sort:[{field:'AVM',direction:'desc'}]}
    ];

    const allRes = await Promise.all(
      queries.map(q => callPR(token,q).catch(e => { console.warn('sub-query failed:',e.message); return {results:[]}; }))
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

app.listen(PORT, () => console.log(`DistressedLeads v5.2 on port ${PORT}`));
