// api/enrich.js - Visits each job detail page to get band + sponsorship

const SUPABASE_URL = 'https://opntstuzymdqkcddfjfn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9wbnRzdHV6eW1kcWtjZGRmamZuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2NjU1NTcsImV4cCI6MjEwMDI0MTU1N30.vTj7S4Mt0fjBAmIBgSo2yYI0l9atcgoQQ35-Cl9NjoE';

const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Accept': 'text/html',
  'Accept-Language': 'en-GB,en;q=0.9',
};

function parseDetail(html) {
  const text = html.toLowerCase();

  // Band number
  let band = null;
  const bm = html.match(/Band\s+(\d+[a-z]?)/i);
  if (bm) {
    const n = parseInt(bm[1]);
    if (!isNaN(n)) band = n;
  }

  // Sponsorship - NHS Jobs exact text
  let hassponsor = false;
  if (text.includes('skilled worker sponsorship to work in the uk') ||
      text.includes('skilled worker sponsorship') ||
      text.includes('certificate of sponsorship')) {
    // Make sure it says available not not available
    const idx = text.indexOf('skilled worker sponsor');
    const nearby = idx >= 0 ? text.slice(idx, idx + 300) : '';
    if (!nearby.includes('not available') && nearby.includes('welcome')) {
      hassponsor = true;
    }
    // Also check direct "sponsorship available" text
    if (text.includes('sponsorship available') && !text.includes('sponsorship not available')) {
      hassponsor = true;
    }
  }

  // Full time check
  const isFullTime = text.includes('full-time') || text.includes('full time');
  const isPartTime = text.includes('part-time') || text.includes('part time');
  const isFixedTerm = text.includes('fixed term') || text.includes('fixed-term');
  const isPermanent = text.includes('permanent');

  return { band, hassponsor, isFullTime, isPartTime, isFixedTerm, isPermanent };
}

async function getUnenriched(limit) {
  const r = await fetch(
    SUPABASE_URL + '/rest/v1/jobs?enriched=eq.false&select=id,url&limit=' + limit,
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
  );
  if (!r.ok) return [];
  return r.json();
}

async function updateJob(id, data) {
  await fetch(SUPABASE_URL + '/rest/v1/jobs?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...data, enriched: true }),
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const limit = parseInt(req.query.limit || '100');
  const jobs = await getUnenriched(limit);
  if (!jobs.length) return res.status(200).json({ ok: true, enriched: 0, remaining: 0 });

  let enriched = 0, rejected = 0;

  for (const job of jobs) {
    try {
      const r = await fetch(job.url, { headers: HDRS, signal: AbortSignal.timeout(10000) });
      if (!r.ok) { await updateJob(job.id, {}); continue; }
      const detail = parseDetail(await r.text());

      // If detail page reveals it's Band 2, part time or fixed term - delete it
      if ((detail.band && detail.band <= 2) || detail.isPartTime || detail.isFixedTerm) {
        await fetch(SUPABASE_URL + '/rest/v1/jobs?id=eq.' + encodeURIComponent(job.id), {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY },
        });
        rejected++;
      } else {
        await updateJob(job.id, detail);
        enriched++;
      }
      await new Promise(r => setTimeout(r, 150));
    } catch {
      await updateJob(job.id, {});
    }
  }

  // Count remaining
  const countR = await fetch(
    SUPABASE_URL + '/rest/v1/jobs?enriched=eq.false&select=id&limit=1',
    { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Prefer': 'count=exact' } }
  );
  const remaining = parseInt(countR.headers.get('content-range')?.split('/')[1] || '0');

  return res.status(200).json({ ok: true, enriched, rejected, remaining });
}
