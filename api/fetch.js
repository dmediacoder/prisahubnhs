// fetch.js - Fetches ALL NHS jobs into one table, no category assignment
const SUPABASE_URL = 'https://opntstuzymdqkcddfjfn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbnRzdHV6eW1kcWtjZGRmamZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2NjU1NTcsImV4cCI6MjEwMDI0MTU1N30.vTj7S4Mt0fjBAmIBgSo2yYI0l9atcgoQQ35-Cl9NjoE';

const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Accept': 'text/html',
  'Accept-Language': 'en-GB,en;q=0.9',
};

function dec(s){return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ');}
function clean(s){return dec(s.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();}
function pick(b,attr){const re=new RegExp('<li[^>]*data-test="'+attr+'"[^>]*>([\\s\\S]*?)<\\/li>','i');const m=b.match(re);return m?clean(m[1]).replace(/^[A-Za-z &\/]+:\s*/,'').trim():'';}

function parseNhs(html){
  const jobs=[];
  const re=/<li[^>]*class="[^"]*\bsearch-result\b[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]*class="[^"]*\bsearch-result\b|<\/ul)/g;
  let m;
  while((m=re.exec(html))!==null){
    const b=m[1];
    const tm=b.match(/<a[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*data-test="search-result-job-title"[^>]*>([\s\S]*?)<\/a>/i)||b.match(/<a[^>]*data-test="search-result-job-title"[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if(!tm)continue;
    const href=dec(tm[1]),title=clean(tm[2]);
    if(!title)continue;
    let org='NHS',loc='United Kingdom';
    const lb=b.match(/<div[^>]*data-test="search-result-location"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="nhsuk-grid-row/i);
    if(lb){const inn=lb[1];const om=inn.match(/<h3[^>]*>([\s\S]*?)<div[^>]*class="location-font-size"/i);if(om)org=clean(om[1]);const lm=inn.match(/<div[^>]*class="location-font-size"[^>]*>([\s\S]*?)<\/div>/i);if(lm)loc=clean(lm[1]).replace(/,\s*$/,'');}
    const salary=pick(b,'search-result-salary');
    const contract=pick(b,'search-result-jobType');
    const pattern=pick(b,'search-result-workingPattern');
    const closing=pick(b,'search-result-closingDate');
    let posted=pick(b,'search-result-publicationDate');
    if(!posted){const dm=b.match(/(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i);if(dm)posted=dm[1];}
    const idM=href.match(/\/jobadvert\/([^?#]+)/);
    if(!idM)continue;
    jobs.push({id:idM[1],title,organisation:org,location:loc,salary,contract,pattern,closing,posted,url:'https://www.jobs.nhs.uk'+href});
  }
  return jobs;
}

function isNhs(org){
  const o=(org||'').toLowerCase();
  return o.includes('nhs')||o.includes('health board')||o.includes('integrated care')||
    (o.includes('ambulance')&&o.includes('service'))||o.includes('university hospitals')||
    (o.includes('royal')&&(o.includes('hospital')||o.includes('infirmary')))||
    o.includes('foundation trust')||o.includes('hospital trust');
}

async function fetchPage(kw,page,bands,ft){
  const p=new URLSearchParams({keyword:kw,language:'en',contractType:'Permanent',sort:'publicationDateDesc',skipPhraseSuggester:'true'});
  if(page>1)p.set('page',String(page));
  if(ft)p.set('workingPattern','full-time');
  if(bands)p.set('payBand',bands);
  try{
    const r=await fetch('https://www.jobs.nhs.uk/candidate/search/results?'+p,{headers:HDRS,signal:AbortSignal.timeout(12000)});
    if(!r.ok)return[];
    return parseNhs(await r.text());
  }catch{return[];}
}

async function dbSave(jobs){
  if(!jobs.length)return 0;
  const rows=jobs.filter(j=>isNhs(j.organisation)).map(j=>({...j,enriched:false,hassponsor:false}));
  if(!rows.length)return 0;
  const r=await fetch(SUPABASE_URL+'/rest/v1/jobs',{
    method:'POST',
    headers:{'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates'},
    body:JSON.stringify(rows),
  });
  if(!r.ok)console.error('DB error:',await r.text());
  return rows.length;
}

// All keywords to fetch - broad searches that cover all our categories
const SEARCHES = [
  // Support Workers - Band 3,4
  {kw:'support worker',         bands:'BAND_3,BAND_4', ft:true},
  // Admin - Band 4,5
  {kw:'administrator',          bands:'BAND_4,BAND_5', ft:false},
  {kw:'medical secretary',      bands:'BAND_4,BAND_5', ft:false},
  {kw:'receptionist',           bands:'BAND_4,BAND_5', ft:false},
  // Nursing - Band 4,5
  {kw:'staff nurse',            bands:'BAND_4,BAND_5', ft:false},
  {kw:'mental health nurse',    bands:'BAND_4,BAND_5', ft:false},
  {kw:'research nurse',         bands:'BAND_4,BAND_5', ft:false},
  // Clinical - Band 4,5
  {kw:'clinical fellow',        bands:'BAND_4,BAND_5', ft:false},
  {kw:'trust doctor',           bands:'BAND_4,BAND_5', ft:false},
  {kw:'foundation year',        bands:'BAND_4,BAND_5', ft:false},
  {kw:'clinical coder',         bands:'BAND_4,BAND_5', ft:false},
  {kw:'dietitian',              bands:'BAND_4,BAND_5', ft:false},
  {kw:'phlebotomist',           bands:'BAND_4,BAND_5', ft:false},
  {kw:'research assistant',     bands:'BAND_4,BAND_5', ft:false},
  {kw:'social worker',          bands:'BAND_4,BAND_5', ft:false},
  // Professional - Band 4,5
  {kw:'data analyst',           bands:'BAND_4,BAND_5', ft:false},
  {kw:'business intelligence',  bands:'BAND_4,BAND_5', ft:false},
  {kw:'finance officer',        bands:'BAND_4,BAND_5', ft:false},
  {kw:'hr adviser',             bands:'BAND_4,BAND_5', ft:false},
  {kw:'it engineer',            bands:'BAND_4,BAND_5', ft:false},
  {kw:'software developer',     bands:'BAND_4,BAND_5', ft:false},
  {kw:'project manager',        bands:'BAND_4,BAND_5', ft:false},
  {kw:'business analyst',       bands:'BAND_4,BAND_5', ft:false},
  {kw:'logistics',              bands:'BAND_4,BAND_5', ft:false},
  {kw:'coordinator',            bands:'BAND_4,BAND_5', ft:false},
  {kw:'estates manager',        bands:'BAND_4,BAND_5', ft:false},
  {kw:'facilities manager',     bands:'BAND_4,BAND_5', ft:false},
  {kw:'microbiology',           bands:'BAND_4,BAND_5', ft:false},
];

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if(req.method==='OPTIONS'){res.status(200).end();return;}

  const results={};
  const seen=new Set();

  for(const search of SEARCHES){
    let saved=0;
    for(let pg=1;pg<=30;pg+=5){
      const pages=[pg,pg+1,pg+2,pg+3,pg+4];
      const pageResults=await Promise.all(pages.map(p=>fetchPage(search.kw,p,search.bands,search.ft)));
      let anyNew=false;
      const batch=[];
      for(const jobs of pageResults){
        if(!jobs.length)continue;
        for(const j of jobs){
          if(seen.has(j.id))continue;
          seen.add(j.id);
          batch.push(j);
          anyNew=true;
        }
      }
      if(batch.length){
        saved+=await dbSave(batch);
      }
      if(!anyNew)break;
    }
    results[search.kw]=saved;
  }

  return res.status(200).json({ok:true,fetched:results,total:Object.values(results).reduce((a,b)=>a+b,0),at:new Date().toISOString()});
}
