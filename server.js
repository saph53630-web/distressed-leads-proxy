const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3000;

app.use((req,res,next) => { res.setHeader('Content-Type','application/json'); next(); });
app.get('/', (_,res) => res.json({status:'ok',version:'8.1'}));
app.get('/health', (_,res) => res.json({status:'ok',version:'8.1'}));

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
  console.log('[PR]', r.status, text.substring(0,400));
  if(r.status===503) throw new Error('PropertyRadar temporarily unavailable — try again');
  if(!r.ok) throw new Error(`PR ${r.status}: ${text.substring(0,200)}`);
  const parsed = JSON.parse(text);
  const results = parsed.results || [];
  if(results.length) console.log('[PR] keys:', Object.keys(results[0]).join(','));
  return {results, total: parsed.totalResultCount||results.length};
}

// ── SEARCH BY ADDRESS ──────────────────────────────────────────
app.post('/api/propertyradar/search', async (req,res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing x-pr-token'});
  try {
    const full = (req.body.address||'').trim();
    if(!full) return res.status(400).json({error:'Missing address'});
    const parts = full.split(',').map(s=>s.trim());
    const street = parts[0].toUpperCase();
    const zip    = (parts[2]||'').trim().split(' ')[1]||'';
    const strategies = [];
    if(zip.length===5) strategies.push([{name:'ZipFive',value:[zip]},{name:'Address',value:[street]}]);
    strategies.push([{name:'Address',value:[street]}]);
    for(const criteria of strategies){
      const {results} = await callPR(token, criteria, 5);
      if(results.length) return res.json({results, count:results.length});
    }
    res.json({results:[], count:0});
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── DISTRESSED LEADS ──────────────────────────────────────────
// CONFIRMED: City+State with Purchase=1 works and returns real data
// inForeclosure causes 503 — use absentee + vacancy + equity signals only
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

    // Run 4 queries in parallel — field names confirmed from live PR API
    const perQ2 = Math.ceil(count/4);
    const [q1,q2,q3,q4] = await Promise.all([
      // Absentee owners — isNotSameMailingOrExempt=1 confirmed in response
      callPR(token, [...base, {name:'isNotSameMailingOrExempt',value:[1]}], perQ2)
        .catch(e=>{console.warn('[q1 absentee]',e.message);return {results:[]};}),
      // Tax delinquent — confirmed field name inTaxDelinquency
      callPR(token, [...base, {name:'inTaxDelinquency',value:[1]}], perQ2)
        .catch(e=>{console.warn('[q2 tax]',e.message);return {results:[]};}),
      // Pre-foreclosure — confirmed field isPreforeclosure
      callPR(token, [...base, {name:'isPreforeclosure',value:[1]}], perQ2)
        .catch(e=>{console.warn('[q3 preforeclosure]',e.message);return {results:[]};}),
      // High equity — EquityPercent range
      callPR(token, [...base, {name:'EquityPercent',value:[[40,null]]}], perQ2)
        .catch(e=>{console.warn('[q4 equity]',e.message);return {results:[]};})
    ]);

    const seen=new Set(), merged=[];
    for(const {results} of [q1,q2,q3,q4])
      for(const r of results){
        const id=r.RadarID||(r.Address+r.City);
        if(!seen.has(id)){seen.add(id);merged.push(r);}
      }

    console.log('[leads] total unique:', merged.length);
    res.json({results:merged.slice(0,count), count:merged.length});
  } catch(e){ res.status(500).json({error:e.message}); }
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

// ── DEBUG ──────────────────────────────────────────────────────
app.get('/api/propertyradar/debug', async (req,res) => {
  const token = req.headers['x-pr-token']||req.query.token;
  if(!token) return res.status(401).json({error:'Provide token'});
  const city = req.query.city||'Atlanta';
  const state = req.query.state||'GA';
  const fetch = (await import('node-fetch')).default;
  try {
    const r = await fetch(`${PR_BASE}?Purchase=1&Limit=2`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
      body:JSON.stringify({Criteria:[{name:'City',value:[city]},{name:'State',value:[state]}]}),
      signal:AbortSignal.timeout(15000)
    });
    const text = await r.text();
    res.json({status:r.status, city, state, raw:text.substring(0,1000)});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.use((req,res) => res.status(404).json({error:`Not found: ${req.method} ${req.path}`}));
app.use((err,req,res,next) => { console.error(err); res.status(500).json({error:err.message}); });
app.listen(PORT, () => console.log(`DistressedLeads v8.0 on :${PORT}`));
