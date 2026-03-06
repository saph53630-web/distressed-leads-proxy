const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.use((req,res,next) => { res.setHeader('Content-Type','application/json'); next(); });
app.get('/', (_,res) => res.json({status:'ok',version:'7.1'}));
app.get('/health', (_,res) => res.json({status:'ok',version:'7.1'}));

app.post('/api/claude', async (req,res) => {
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

const PR_BASE = 'https://api.propertyradar.com/v1/properties';

// Core PR caller — Purchase=1 returns full data, no Fields filter (get everything)
async function callPR(token, criteria, limit=25) {
  const fetch = (await import('node-fetch')).default;
  const url = `${PR_BASE}?Purchase=1&Limit=${limit}`;
  console.log('[PR] POST', url, JSON.stringify(criteria));
  const r = await fetch(url, {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
    body: JSON.stringify({Criteria: criteria}),
    signal: AbortSignal.timeout(25000)
  });
  const text = await r.text();
  console.log('[PR]', r.status, text.substring(0,500));
  if(!r.ok) throw new Error(`PR ${r.status}: ${text.substring(0,200)}`);
  const parsed = JSON.parse(text);
  // PR returns results array — key varies by plan
  const results = parsed.results || parsed.data || parsed.Records || parsed.properties || parsed.items || [];
  if(results.length) console.log('[PR] first record keys:', Object.keys(results[0]).join(','));
  return {results, total: parsed.totalResultCount||results.length};
}

// ── SEARCH BY ADDRESS ──────────────────────────────────────────
app.post('/api/propertyradar/search', async (req,res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const full = (req.body.address||'').trim();
    if(!full) return res.status(400).json({error:'Missing address'});

    // Parse "123 Main St, Atlanta, GA 30301"
    const parts = full.split(',').map(s=>s.trim());
    const street = parts[0].toUpperCase();
    const zip    = (parts[2]||'').trim().split(' ')[1]||'';

    // Try zip first (most precise), then street only
    const strategies = [];
    if(zip.length===5) strategies.push([{name:'ZipFive',value:[zip]},{name:'Address',value:[street]}]);
    strategies.push([{name:'Address',value:[street]}]);

    for(const criteria of strategies){
      console.log('[search] trying:', JSON.stringify(criteria));
      const {results} = await callPR(token, criteria, 5);
      if(results.length){
        console.log('[search] found', results.length, 'results');
        return res.json({results, count:results.length});
      }
    }
    res.json({results:[], count:0});
  } catch(e){ console.error('[search error]',e.message); res.status(500).json({error:e.message}); }
});

// ── DISTRESSED LEADS ──────────────────────────────────────────
app.post('/api/propertyradar/leads', async (req,res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const {city, state, count=25} = req.body;
    if(!city) return res.status(400).json({error:'Missing city'});
    console.log('[leads]', city, state, 'count:', count);

    const base = [];
    if(city)  base.push({name:'City',  value:[city]});
    if(state) base.push({name:'State', value:[state]});
    const perQ = Math.ceil(count/3);

    const [q1,q2,q3] = await Promise.all([
      callPR(token, [...base, {name:'inForeclosure',value:['Yes']}], perQ)
        .catch(e=>{console.warn('[leads q1]',e.message);return {results:[]};}),
      callPR(token, [...base, {name:'isSameMailingOrExempt',value:['No']},{name:'EquityPercent',value:[[40,null]]}], perQ)
        .catch(e=>{console.warn('[leads q2]',e.message);return {results:[]};}),
      callPR(token, [...base, {name:'isSiteVacant',value:['Yes']}], perQ)
        .catch(e=>{console.warn('[leads q3]',e.message);return {results:[]};})
    ]);

    const seen=new Set(), merged=[];
    for(const {results} of [q1,q2,q3])
      for(const r of results){
        const id=r.RadarID||(r.Address+r.City);
        if(!seen.has(id)){seen.add(id);merged.push(r);}
      }

    console.log('[leads] total unique:', merged.length);
    res.json({results:merged.slice(0,count), count:merged.length});
  } catch(e){ console.error('[leads error]',e.message); res.status(500).json({error:e.message}); }
});

// ── TEST CONNECTION ────────────────────────────────────────────
app.get('/api/propertyradar/test', async (req,res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  if(!token) return res.status(401).json({error:'Provide token'});
  try {
    const {results,total} = await callPR(token,[{name:'State',value:['CA']}],1);
    res.json({status:'connected', total, sample:results[0]||null, fields:results[0]?Object.keys(results[0]):[]});
  } catch(e){ res.status(500).json({status:'error',error:e.message}); }
});

// ── RAW DEBUG ─────────────────────────────────────────────────
app.get('/api/propertyradar/debug', async (req,res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  const city  = req.query.city||'Atlanta';
  const state = req.query.state||'GA';
  if(!token) return res.status(401).json({error:'Provide token'});
  const fetch = (await import('node-fetch')).default;
  const results = {};
  const tests = [
    {label:'city+state P=0', url:`${PR_BASE}?Purchase=0&Limit=2`, body:{Criteria:[{name:'City',value:[city]},{name:'State',value:[state]}]}},
    {label:'city+state P=1', url:`${PR_BASE}?Purchase=1&Limit=2`, body:{Criteria:[{name:'City',value:[city]},{name:'State',value:[state]}]}},
    {label:'state+foreclosure P=1', url:`${PR_BASE}?Purchase=1&Limit=2`, body:{Criteria:[{name:'State',value:[state]},{name:'inForeclosure',value:['Yes']}]}},
    {label:'state only P=1', url:`${PR_BASE}?Purchase=1&Limit=2`, body:{Criteria:[{name:'State',value:[state]}]}}
  ];
  for(const {label,url,body} of tests){
    try{
      const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
      const text = await r.text();
      results[label]={status:r.status, preview:text.substring(0,300)};
    }catch(e){results[label]={error:e.message};}
  }
  res.json({city,state,results});
});

app.use((req,res) => res.status(404).json({error:`Not found: ${req.method} ${req.path}`}));
app.use((err,req,res,next) => { console.error(err); res.status(500).json({error:err.message}); });
app.listen(PORT, () => console.log(`DistressedLeads v7.0 on :${PORT}`));
