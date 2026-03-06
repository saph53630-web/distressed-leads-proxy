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

// ── PropertyRadar: search by address ──
app.post('/api/propertyradar/search', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing PropertyRadar token'});
  try {
    const fetch = (await import('node-fetch')).default;
    const {address} = req.body;
    const body = {
      Criteria:[{name:"SiteAddress",value:[address]}],
      Fields:[
        "RadarID","Address","City","State","ZipFive","County","APN","PropertyURL","PhotoURL1",
        "Owner","OwnerFirstName","OwnerLastName","OwnerSpouseFirstName",
        "OwnerAddress","OwnerCity","OwnerState","OwnerZipFive",
        "OwnerPhone","OwnerEmail","PrimaryFirstName","PrimaryLastName","PrimaryPhone1","PrimaryEmail1",
        "SecondaryFirstName","SecondaryLastName",
        "AVM","AssessedValue","AnnualTaxes","AvailableEquity","EquityPercent","TotalLoanBalance","NumberLoans",
        "FirstAmount","FirstDate","FirstLenderOriginal","FirstPurpose","FirstRate",
        "LastTransferValue","LastTransferRecDate","LastTransferSeller","LastTransferType",
        "YearBuilt","SqFt","Beds","Baths","LotSize","Units","Stories","Pool","PType","Subdivision",
        "inForeclosure","ForeclosureStage","ForeclosureRecDate","DefaultAmount","DefaultAsOf",
        "isListedForSale","ListingPrice","DaysOnMarket","isSiteVacant","isMailVacant","isSameMailingOrExempt",
        "Latitude","Longitude"
      ],
      Count:1
    };
    const r = await fetch('https://api.propertyradar.com/v1/properties',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
      body:JSON.stringify(body)
    });
    if(!r.ok){ const t=await r.text(); return res.status(r.status).json({error:`PR ${r.status}: ${t}`}); }
    res.json(await r.json());
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── PropertyRadar: distressed leads by city ──
app.post('/api/propertyradar/leads', async (req, res) => {
  const token = req.headers['x-pr-token'];
  if(!token) return res.status(401).json({error:'Missing PropertyRadar token'});
  try {
    const fetch = (await import('node-fetch')).default;
    const {city, state, signals=[], count=25} = req.body;
    const criteria = [{name:"SiteCity",value:[city]}];
    if(state) criteria.push({name:"SiteState",value:[state]});
    const sigMap = {
      'Pre-Foreclosure':{name:"inForeclosure",value:["Yes"]},
      'Tax Delinquent':{name:"TaxDelinquent",value:["Yes"]},
      'Vacant':{name:"isSiteVacant",value:["Yes"]},
      'Absentee Owner':{name:"isSameMailingOrExempt",value:["No"]},
      'High Equity':{name:"EquityPercent",value:[{min:50}]},
    };
    for(const s of signals){ if(sigMap[s]) criteria.push(sigMap[s]); }
    const body = {
      Criteria:criteria,
      Fields:[
        "RadarID","Address","City","State","ZipFive","APN","PropertyURL",
        "Owner","OwnerFirstName","OwnerLastName","OwnerAddress","OwnerCity","OwnerState","OwnerZipFive",
        "OwnerPhone","OwnerEmail","PrimaryPhone1","PrimaryEmail1","SecondaryFirstName","SecondaryLastName",
        "AVM","AssessedValue","AnnualTaxes","AvailableEquity","EquityPercent","TotalLoanBalance",
        "FirstLenderOriginal","FirstAmount","FirstDate","LastTransferValue","LastTransferRecDate",
        "YearBuilt","SqFt","Beds","Baths","PType",
        "inForeclosure","ForeclosureStage","DefaultAmount","isListedForSale","isSiteVacant","isMailVacant","isSameMailingOrExempt",
        "Latitude","Longitude"
      ],
      Count:Math.min(count,100),
      Sort:[{field:"EquityPercent",direction:"desc"}]
    };
    const r = await fetch('https://api.propertyradar.com/v1/properties',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},
      body:JSON.stringify(body)
    });
    if(!r.ok){ const t=await r.text(); return res.status(r.status).json({error:`PR ${r.status}: ${t}`}); }
    res.json(await r.json());
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/health',(_, res)=>res.json({status:'ok',version:'3.0-propertyradar'}));
app.listen(PORT,()=>console.log(`Server on port ${PORT}`));
