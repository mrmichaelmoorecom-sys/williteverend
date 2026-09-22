// williteverend.com — single Cloudflare Worker: static assets + server-rendered "/" + /api/state + /api/news + cron refresh.
//
// CPU budget: the Workers Free plan allows 10 ms CPU per invocation (HTTP request AND cron tick). Every refresh
// therefore does only the cheap market pulls, plus at most ONE heavy job (approval | election2028 | news) chosen
// by src/lib/schedule.js. A cold start (empty KV) does the light refresh inline and nothing else.
import config from '../config.json' with { type: 'json' };
import { parseKalshiBatch, parsePolymarketKeyset, parsePolymarketMarket, parsePolymarket2028, parseKalshi2028, pickMonthlyOutEvent } from './lib/markets.js';
import { parseNyt, parseDatawrapperVersion, parseSilverBulletin } from './lib/csv.js';
import { parseRss, mergeItems } from './lib/rss.js';
import { buildSnapshot, computeApproval, KALSHI_TICKERS, PM_KEYSET_EVENTS, PM } from './lib/snapshot.js';
import { pageVars, fillTemplate, fmtDate } from './lib/render.js';
import { pickJob, JOBS } from './lib/schedule.js';

const UA = 'Mozilla/5.0 (compatible; williteverend/1.0; +https://williteverend.com)';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const GAMMA = 'https://gamma-api.polymarket.com';
const FEEDS = [
  // Direct-link feeds first so dedupe keeps the publisher URL over the Google News stub.
  { name: 'The Guardian', homepage: 'https://www.theguardian.com', url: 'https://www.theguardian.com/us-news/donaldtrump/rss' },
  { name: 'Politico', homepage: 'https://www.politico.com', url: 'https://rss.politico.com/white-house.xml' },
  { name: 'The Hill', homepage: 'https://thehill.com', url: 'https://thehill.com/homenews/administration/feed/' },
  { name: 'Google News', homepage: 'https://news.google.com', url: `https://news.google.com/rss/search?q=${encodeURIComponent(config.newsQuery || 'Trump administration')}+when:2d&hl=en-US&gl=US&ceid=US:en`, google: true },
];
const EMPTY_NEWS = { updatedAt: null, items: [] };

// Security headers for the rendered page. connect-src must gain https://clob.polymarket.com and
// https://data-api.polymarket.com if the optional §1.9 browser-side live tick / sparkline is ever added.
const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-src https://embed.polymarket.com; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

// ---------- helpers ----------
const json = (data, sMax = 60, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, s-maxage=${sMax}, max-age=30`, 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' },
});

/** Upstream GET. NEVER forwards an Origin header (Kalshi 403s on foreign origins). */
async function get(url, { ua = UA, timeout = 15000, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort('timeout'), timeout);
  try {
    const res = await fetch(url, { headers: { 'user-agent': ua, accept: '*/*', ...headers }, signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res;
  } finally { clearTimeout(t); }
}
const getJson = (url, o) => get(url, o).then((r) => r.json());
const getText = (url, o) => get(url, o).then((r) => r.text());

/** Run a fetch+parse; on failure return { ok:false, error } instead of throwing. */
async function attempt(fn) {
  try { return { ok: true, value: await fn(), at: new Date().toISOString() }; }
  catch (e) { return { ok: false, error: String(e && e.message || e).slice(0, 200) }; }
}
const half = (n) => Math.ceil(n / 2);
const reason = (r) => String((r && r.message) || r).slice(0, 120);

// ---------- upstream pulls ----------
// Both venues answer HTTP 200 with a silently shorter list for unknown tickers/slugs, so success requires
// at least half of the expected markets; anything less is a failure and the previous good map is kept.
const fetchKalshi = async () => {
  const markets = parseKalshiBatch(await getJson(`${KALSHI}/markets?tickers=${KALSHI_TICKERS.join(',')}`));
  const missing = KALSHI_TICKERS.filter((t) => !markets[t]);
  const hit = KALSHI_TICKERS.length - missing.length;
  if (hit < half(KALSHI_TICKERS.length)) throw new Error(`Kalshi: only ${hit}/${KALSHI_TICKERS.length} tickers returned`);
  return { markets, missing, warning: null };
};
const fetchPolymarket = async () => {
  const keyset = await getJson(`${GAMMA}/events/keyset?${PM_KEYSET_EVENTS.map((s) => `slug=${s}`).join('&')}`);
  const got = new Set((keyset && keyset.events || []).map((e) => e.slug));
  const missing = PM_KEYSET_EVENTS.filter((s) => !got.has(s));
  const hit = PM_KEYSET_EVENTS.length - missing.length;
  if (hit < half(PM_KEYSET_EVENTS.length)) throw new Error(`Polymarket: only ${hit}/${PM_KEYSET_EVENTS.length} events returned`);
  const markets = parsePolymarketKeyset(keyset);
  const slugs = [PM.WIN2028, PM.NOM2028];
  const extra = await Promise.allSettled(slugs.map((s) => getJson(`${GAMMA}/markets/slug/${s}`).then(parsePolymarketMarket)));
  const warnings = [];
  extra.forEach((r, i) => {
    if (r.status === 'fulfilled') markets[r.value.id] = r.value;
    else { missing.push(slugs[i]); warnings.push(`${slugs[i]}: ${reason(r.reason)}`); }   // best-effort, but never silent
  });
  return { markets, missing, warning: warnings.join('; ') || null };
};
const fetchMonthly = async (slug) => {
  if (!slug) return null;
  const ev = await getJson(`${GAMMA}/events/slug/${slug}`);
  const markets = parsePolymarketKeyset({ events: [ev] });
  const m = markets[slug] || Object.values(markets)[0];
  if (!m) return null;
  const label = m.endDate ? `Out as President by ${fmtDate(m.endDate)}` : 'Out as President this month';
  return { ...m, label };
};
const discoverMonthly = async () => {
  const j = await getJson(`${GAMMA}/events/keyset?title_search=${encodeURIComponent('out as president')}&closed=false&include_markets=false&limit=50&order=volume&ascending=false`);
  return pickMonthlyOutEvent(j);
};
const fetchElection2028 = async () => {
  const [k, p] = await Promise.allSettled([
    getJson(`${KALSHI}/markets?event_ticker=KXPRESPERSON-28&status=open&limit=200`).then((j) => parseKalshi2028(j, 8)),
    getJson(`${GAMMA}/events/slug/presidential-election-winner-2028`).then((j) => parsePolymarket2028(j, 8)),
  ]);
  if (k.status === 'rejected' && p.status === 'rejected') throw new Error(`2028: ${reason(k.reason)} / ${reason(p.reason)}`);
  return { kalshi: k.status === 'fulfilled' ? k.value : null, polymarket: p.status === 'fulfilled' ? p.value : null, at: new Date().toISOString() };
};
const fetchApproval = async (prev) => {
  const [nyt, sb] = await Promise.all([
    attempt(() => getText('https://www.nytimes.com/newsgraphics/polls/approval/president-averages.csv', { ua: BROWSER_UA }).then(parseNyt)),
    attempt(async () => {
      const v = parseDatawrapperVersion(await getText('https://datawrapper.dwcdn.net/kSCt4/', { ua: BROWSER_UA }), 'kSCt4');
      return parseSilverBulletin(await getText(`https://datawrapper.dwcdn.net/kSCt4/${v}/dataset.csv`, { ua: BROWSER_UA }));
    }),
  ]);
  const prevSrc = (key) => ((prev && prev.approval && prev.approval.sources) || []).find((s) => s.key === key);
  const pickSrc = (r, key) => (r.ok ? r.value : prevSrc(key) && prevSrc(key).ok ? { approve: prevSrc(key).approve, disapprove: prevSrc(key).disapprove, date: prevSrc(key).date } : null);
  const out = computeApproval({ nyt: pickSrc(nyt, 'nyt'), sb: pickSrc(sb, 'sb') });
  for (const s of out.sources) { const r = s.key === 'nyt' ? nyt : sb; if (!r.ok) s.error = r.error; }
  out.updatedAt = new Date().toISOString();
  return out;
};
const fetchNews = async () => {
  const results = await Promise.all(FEEDS.map((f) => attempt(() => getText(f.url).then((xml) => parseRss(xml, f)))));
  const lists = results.map((r) => (r.ok ? r.value : []));
  const items = mergeItems(lists, { cap: 40 });
  const sources = Object.fromEntries(FEEDS.map((f, i) => [f.name, { ok: results[i].ok, count: lists[i].length, error: results[i].error || null }]));
  if (!items.length) throw new Error('all feeds failed: ' + JSON.stringify(sources));
  return { updatedAt: new Date().toISOString(), items, sources };
};

// ---------- refresh (cron + cold start) ----------
/** KV writes must never take the page down (a 429 on the 1 write/s/key limit under concurrency just retries next tick). */
async function kvPut(env, key, value) {
  try { await env.STATE.put(key, JSON.stringify(value)); return true; }
  catch (e) { console.error(`kv put ${key}`, e); return false; }
}

/**
 * Light refresh (Kalshi batch + Polymarket keyset/2 slugs + the rolling monthly market) on every call, plus at
 * most one heavy job: `job` forces one, `schedule: true` picks the stale one (cron), neither = cold start.
 * Returns { snap, news, job }.
 */
export async function refresh(env, { schedule = false, job = null } = {}) {
  const now = Date.now();
  const prev = (await env.STATE.get('snapshot', 'json')) || null;
  const kvOverride = await env.STATE.get('override');
  if (!job && schedule) job = pickJob(prev, now);
  if (job && !JOBS.includes(job)) throw new Error(`unknown job ${job}`);

  let monthlySlug = (prev && prev.monthly && prev.monthly.id) || null;
  if (monthlySlug && prev.monthly.endDate && Date.parse(prev.monthly.endDate) < now) monthlySlug = null;
  const needDiscover = job === 'election2028' || !prev;
  const [kalshi, polymarket, disc] = await Promise.all([
    attempt(fetchKalshi), attempt(fetchPolymarket), needDiscover ? attempt(discoverMonthly) : Promise.resolve({ ok: true, value: monthlySlug }),
  ]);
  if (disc.ok) monthlySlug = disc.value;
  const monthly = await attempt(() => fetchMonthly(monthlySlug));

  const election2028 = job === 'election2028' ? await attempt(fetchElection2028) : null;
  const approval = job === 'approval' ? await attempt(() => fetchApproval(prev)) : null;
  const news = job === 'news' ? await attempt(fetchNews) : null;

  const carry = (r, key) => (r.ok
    ? { ok: true, markets: r.value.markets, at: r.at, error: r.value.warning || null, partial: r.value.missing.length > 0, missing: r.value.missing }
    : { ok: false, markets: (prev && prev.markets && prev.markets[key]) || {}, at: prev && prev.sources && prev.sources[key] ? prev.sources[key].at : null, error: r.error });
  const snap = buildSnapshot({
    now, config, kvOverride,
    kalshi: carry(kalshi, 'kalshi'), polymarket: carry(polymarket, 'polymarket'),
    monthly: monthly.ok ? monthly.value : (prev && prev.monthly) || null,
    election2028: election2028 && election2028.ok ? election2028.value : (prev && prev.election2028) || null,
    approval: approval && approval.ok ? approval.value : (prev && prev.approval) || null,
    newsMeta: news ? { ok: news.ok, at: news.ok ? news.value.updatedAt : (prev && prev.sources && prev.sources.news && prev.sources.news.at) || null, error: news.error || null } : null,
    prev,
  });
  // Last ATTEMPT time per heavy job (drives the scheduler; a failing job cannot starve the others).
  snap.jobs = { ...((prev && prev.jobs) || {}), ...(job ? { [job]: new Date(now).toISOString() } : {}) };
  await kvPut(env, 'snapshot', snap);
  let newsDoc = null;
  if (news && news.ok) { newsDoc = news.value; await kvPut(env, 'news', newsDoc); }
  return { snap, news: newsDoc, job };
}

// ---------- state access (KV; cold start = ONE in-flight light refresh per isolate) ----------
let coldStart = null;
function coldRefresh(env) {
  if (!coldStart) coldStart = refresh(env).finally(() => { coldStart = null; });
  return coldStart;
}
async function getSnapshot(env) {
  return (await env.STATE.get('snapshot', 'json')) || (await coldRefresh(env)).snap;
}
/** News is only ever produced by the cron's news job; before that the section renders "unavailable". */
async function getNews(env) {
  return (await env.STATE.get('news', 'json')) || EMPTY_NEWS;
}

async function cached(request, ctx, build) {
  const cache = caches.default;
  const u = new URL(request.url);
  // Nothing in the render or /api handlers reads the query string, so ?utm_*/?fbclid=/?_= variants share one
  // entry (keyed on origin + path). Origin stays in the key: apex vs www vs workers.dev may legitimately differ.
  const path = u.pathname === '/index.html' ? '/' : u.pathname === '/api/snapshot' ? '/api/state' : u.pathname;
  const key = new Request(u.origin + path, { method: 'GET' });
  try { const hit = await cache.match(key); if (hit) return hit; } catch { /* cache unavailable */ }
  const res = await build();
  if (res.ok) { try { ctx.waitUntil(cache.put(key, res.clone())); } catch { /* ignore */ } }
  return res;
}

const siteOrigin = (url) => (config.links && config.links.site) || url.origin;

async function renderPage(request, env) {
  const url = new URL(request.url);
  const tplRes = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), { method: 'GET' }));
  const tpl = await tplRes.text();
  let [snap, news] = await Promise.all([env.STATE.get('snapshot', 'json'), env.STATE.get('news', 'json')]);
  if (!snap) snap = (await coldRefresh(env)).snap;
  if (!news) news = EMPTY_NEWS;
  const html = fillTemplate(tpl, pageVars({ snap, news, origin: siteOrigin(url) }));
  return new Response(html, { headers: { ...HTML_HEADERS, 'cache-control': 'public, max-age=0, s-maxage=60' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET' } });
    try {
      if (path === '/api/state' || path === '/api/snapshot') return cached(request, ctx, async () => json(await getSnapshot(env), 60));
      if (path === '/api/news') return cached(request, ctx, async () => { const n = await getNews(env); return json(n, n.items.length ? 120 : 30); });
      if (path === '/api/health') return json({ ok: true, now: new Date().toISOString() }, 0);
      if (path.startsWith('/api/')) return json({ error: 'not found' }, 0, 404);
      if (path === '/' || path === '/index.html') return cached(request, ctx, () => renderPage(request, env));
    } catch (e) {
      if (path.startsWith('/api/')) return json({ error: String(e && e.message || e) }, 0, 500);
      // Page must still render: serve the raw template with the answer computed from config alone.
      const tplRes = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)));
      const snap = buildSnapshot({ config });
      const html = fillTemplate(await tplRes.text(), pageVars({ snap, news: null, origin: siteOrigin(url) }));
      return new Response(html, { status: 200, headers: { ...HTML_HEADERS, 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    // Every tick: markets + one due heavy job. Locally, `?cron=news|approval|election2028` forces that job.
    const job = JOBS.includes(controller.cron) ? controller.cron : null;
    await refresh(env, { schedule: true, job }).catch((e) => console.error('refresh failed', e));
  },
};
