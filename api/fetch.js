// api/fetch.js - Fetches NHS Jobs and saves to Supabase

const SUPABASE_URL = 'https://opntstuzymdqkcddfjfn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbnRzdHV6eW1kcWtjZGRmamZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2NjU1NTcsImV4cCI6MjEwMDI0MTU1N30.vTj7S4Mt0fjBAmIBgSo2yYI0l9atcgoQQ35-Cl9NjoE';

const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Accept': 'text/html',
  'Accept-Language': 'en-GB,en;q=0.9',
};

function dec(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&nbsp;/g,' ');
}
function clean(s) {
  return dec(s.replace(/<[^>]+>/g,' ')).replace(/\s+/g,' ').trim();
}
function pickField(block, attr) {
  const re = new RegExp('<li[^>]*data-test="' + attr + '"[^>]*>([\\s\\S]*?)<\\/li>', 'i');
  const m = block.match(re);
  return m ? clean(m[1]).replace(/^[A-Za-z &\/]+:\s*/, '').trim() : '';
}

function parseNhs(html) {
  const jobs = [];
  const re = /<li[^>]*class="[^"]*\bsearch-result\b[^"]*"[^>]*>([\s\S]*?)(?=<li[^>]*class="[^"]*\bsearch-result\b|<\/ul)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const b = m[1];
    const tm = b.match(/<a[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*data-test="search-result-job-title"[^>]*>([\s\S]*?)<\/a>/i)
            || b.match(/<a[^>]*data-test="search-result-job-title"[^>]*href="(\/candidate\/jobadvert\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!tm) continue;
    const href = dec(tm[1]), title = clean(tm[2]);
    if (!title) continue;

    let org = 'NHS', loc = 'United Kingdom';
    const lb = b.match(/<div[^>]*data-test="search-result-location"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="nhsuk-grid-row/i);
    if (lb) {
      const inn = lb[1];
      const om = inn.match(/<h3[^>]*>([\s\S]*?)<div[^>]*class="location-font-size"/i);
      if (om) org = clean(om[1]);
      const lm = inn.match(/<div[^>]*class="location-font-size"[^>]*>([\s\S]*?)<\/div>/i);
      if (lm) loc = clean(lm[1]).replace(/,\s*$/, '');
    }

    const salary  = pickField(b, 'search-result-salary');
    const contract = pickField(b, 'search-result-jobType');
    const pattern  = pickField(b, 'search-result-workingPattern');
    const closing  = pickField(b, 'search-result-closingDate');
    let posted = pickField(b, 'search-result-publicationDate');
    if (!posted) {
      const dm = b.match(/(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i);
      if (dm) posted = dm[1];
    }

    const idM = href.match(/\/jobadvert\/([^?#]+)/);
    if (!idM) continue;
    const id  = idM[1];
    const url = 'https://www.jobs.nhs.uk' + href;

    // Skip obviously bad jobs at parse time
    const t = title.toLowerCase();
    const all = t + ' ' + (contract||'').toLowerCase() + ' ' + (pattern||'').toLowerCase();
    if (all.includes('band 2') || all.includes('band two')) continue;
    if (all.includes('internal only') || all.includes('*internal')) continue;
    if (all.includes('fixed term') || all.includes('fixed-term')) continue;
    if (all.includes('locum') || all.includes('temporary')) continue;
    if (t.includes('part time') || t.includes('part-time')) continue;
    if ((pattern||'').toLowerCase().includes('part time')) continue;
    if (t.includes('bank') && !t.includes('blood bank') && !t.includes('bank manager')) continue;

    jobs.push({ id, title, organisation: org, location: loc, salary, contract, pattern, closing, posted, url });
  }
  return jobs;
}

function isNhs(org) {
  const o = (org || '').toLowerCase();
  if (o.includes('nhs'))          return true;
  if (o.includes('health board')) return true;
  if (o.includes('integrated care')) return true;
  if (o.includes('ambulance') && o.includes('service')) return true;
  if (o.includes('university hospitals')) return true;
  if (o.includes('royal') && (o.includes('hospital') || o.includes('infirmary'))) return true;
  if (o.includes('foundation trust')) return true;
  if (o.includes('hospital trust'))   return true;
  return false;
}

async function fetchPage(kw, loc, page, ft, bands, cat) {
  const p = new URLSearchParams({ keyword: kw, language: 'en', contractType: 'Permanent', sort: 'publicationDateDesc', skipPhraseSuggester: 'true' });
  if (loc)           p.set('location',       loc);
  if (page > 1)      p.set('page',           String(page));
  if (ft)            p.set('workingPattern', 'full-time');
  if (bands)         p.set('payBand',        bands);
  if (cat.payRange)  p.set('payRange',       cat.payRange);
  try {
    const r = await fetch('https://www.jobs.nhs.uk/candidate/search/results?' + p, {
      headers: HDRS, signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) return [];
    return parseNhs(await r.text());
  } catch { return []; }
}

async function dbSave(jobs, category) {
  if (!jobs.length) return 0;
  const rows = jobs
    .filter(j => isNhs(j.organisation))
    .map(j => ({ ...j, category, source: 'england', enriched: false, hassponsor: false }));
  if (!rows.length) return 0;
  const r = await fetch(SUPABASE_URL + '/rest/v1/jobs', {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(rows),
  });
  if (!r.ok) {
    const err = await r.text();
    console.error('DB error:', err);
    return 'ERROR: ' + err;
  }
  return rows.length;
}

const CATS = [
  // SUPPORT WORKERS - Band 3 & 4, full time
  { id: 'sw-out',    kw: ['support worker'], loc: '',              ft: true, bands: 'BAND_3,BAND_4' },
  { id: 'sw-lon',    kw: ['support worker'], loc: 'London',        ft: true, bands: 'BAND_3,BAND_4' },
  { id: 'sw-wm',     kw: ['support worker'], loc: 'West Midlands', ft: true, bands: 'BAND_3,BAND_4' },
  { id: 'sw-wales',  kw: ['support worker'], loc: 'Wales',         ft: true, bands: 'BAND_3,BAND_4' },
  { id: 'sw-manc',   kw: ['support worker'], loc: 'Manchester',    ft: true, bands: 'BAND_3,BAND_4' },
  { id: 'sw-wy',     kw: ['support worker'], loc: 'Leeds',         ft: true, bands: 'BAND_3,BAND_4' },
  { id: 'sw-ey',     kw: ['support worker'], loc: 'Hull',          ft: true, bands: 'BAND_3,BAND_4' },
  // ADMIN - Band 4 & 5
  { id: 'admin-out', kw: ['administrator', 'medical secretary', 'receptionist', 'office manager', 'business support'], loc: '',       ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'admin-lon', kw: ['administrator', 'medical secretary', 'receptionist', 'office manager', 'business support'], loc: 'London', ft: false, bands: 'BAND_4,BAND_5' },
  // NURSING - Band 4 & 5
  { id: 'nurse',     kw: ['staff nurse', 'registered nurse'],          loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'mh-nurse',  kw: ['mental health nurse', 'psychiatric nurse'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'res-nurse', kw: ['research nurse', 'clinical research nurse'],loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  // CLINICAL - Band 4 & 5
  { id: 'fellow',    kw: ['clinical fellow', 'junior clinical fellow', 'trust doctor', 'foundation year'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'coder',     kw: ['clinical coder', 'clinical coding'],        loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'diet',      kw: ['dietitian', 'dietician'],                   loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'micro',     kw: ['microbiology', 'microbiologist'],           loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'phleb',     kw: ['phlebotomist', 'phlebotomy'],              loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'res-asst',  kw: ['research assistant', 'clinical research assistant', 'research coordinator', 'research administrator', 'research support officer', 'clinical trials assistant', 'study coordinator'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'sw3',       kw: ['social worker'],                            loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  // PROFESSIONAL - Band 4 & 5
  { id: 'data',      kw: ['data analyst'],                             loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'bi',        kw: ['business intelligence analyst', 'bi analyst'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'fin',       kw: ['finance officer', 'finance manager', 'management accountant', 'payroll officer'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'hr',        kw: ['hr adviser', 'hr officer', 'workforce administrator', 'recruitment adviser', 'learning and development'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'it',        kw: ['it engineer', 'software developer', 'software engineer', 'infrastructure engineer', 'cyber security', 'it support officer', 'service desk analyst'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'pm',        kw: ['project manager', 'programme manager', 'project coordinator', 'pmo'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'ba',        kw: ['business analyst', 'systems analyst', 'digital analyst', 'service improvement analyst'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'log',       kw: ['logistics', 'supply chain', 'procurement officer', 'stores officer'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'coord',     kw: ['coordinator', 'care coordinator', 'referral coordinator', 'discharge coordinator'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
  { id: 'est',       kw: ['estates manager', 'estates officer', 'facilities manager', 'building services manager'], loc: '', ft: false, bands: 'BAND_4,BAND_5' },
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const target = req.query.category || 'all';
  const results = {};

  const cats = target === 'all' ? CATS : CATS.filter(c => c.id === target);

  for (const cat of cats) {
    const seen = new Set(), batch = [];
    for (const kw of cat.kw) {
      // Fetch 5 pages concurrently per keyword
      for (let pg = 1; pg <= 50; pg += 5) {
        const pages = [pg, pg+1, pg+2, pg+3, pg+4];
        const results = await Promise.all(
          pages.map(p => fetchPage(kw, cat.loc, p, cat.ft, cat.bands, cat))
        );
        let anyNew = false;
        for (const jobs of results) {
          if (!jobs.length) continue;
          for (const j of jobs) {
            if (seen.has(j.id)) continue;
            seen.add(j.id);
            batch.push(j);
            anyNew = true;
          }
        }
        if (!anyNew) break;
      }
    }
    const saved = await dbSave(batch, cat.id);
    results[cat.id] = saved;
    if (typeof saved === 'string' && saved.startsWith('ERROR')) break;
  }

  return res.status(200).json({ ok: true, fetched: results, at: new Date().toISOString() });
}
