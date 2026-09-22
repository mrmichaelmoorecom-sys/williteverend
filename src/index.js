// williteverend.com — single Cloudflare Worker: static assets + server-rendered "/" + /api/state + /api/news + cron refresh.
import config from '../config.json';
import { parseKalshiBatch, parsePolymarketKeyset, parsePolymarketMarket, parsePolymarket2028, parseKalshi2028, pickMonthlyOutEvent } from './lib/markets.js';
import { parseNyt, parseDatawrapperVersion, parseSilverBulletin } from './lib/csv.js';
import { parseRss, mergeItems } from './lib/rss.js';
import { buildSnapshot, computeApproval, KALSHI_TICKERS, PM_KEYSET_EVENTS, PM } from './lib/snapshot.js';
import { pageVars, fillTemplate } from './lib/render.js';

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

// ---------- helpers ----------
const json = (data, sMax = 60, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, s-maxage=${sMax}, max-age=30`, 'access-control-allow-origin': '*' },
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

// ---------- upstream pulls ----------
const fetchKalshi = () => getJson(`${KALSHI}/markets?tickers=${KALSHI_TICKERS.join(',')}`).then(parseKalshiBatch);
const fetchPolymarket = async () => {
  const keyset = await getJson(`${GAMMA}/events/keyset?${PM_KEYSET_EVENTS.map((s) => `slug=${s}`).join('&')}`);
  const markets = parsePolymarketKeyset(keyset);
  const extra = await Promise.allSettled([
    getJson(`${GAMMA}/markets/slug/${PM.WIN2028}`).then(parsePolymarketMarket),
    getJson(`${GAMMA}/markets/slug/${PM.NOM2028}`).then(parsePolymarketMarket),
  ]);
  for (const r of extra) if (r.status === 'fulfilled') markets[r.value.id] = r.value;
  return markets;
};
const fetchMonthly = async (slug) => {
  if (!slug) return null;
  const ev = await getJson(`${GAMMA}/events/slug/${slug}`);
  const markets = parsePolymarketKeyset({ events: [ev] });
  const m = markets[slug] || Object.values(markets)[0];
  if (!m) return null;
  const end = m.endDate ? new Date(m.endDate) : null;
  const label = end ? `Out as President by ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}` : 'Out as President this month';
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
  if (k.status === 'rejected' && p.status === 'rejected') throw new Error(`2028: ${k.reason} / ${p.reason}`);
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
export async function refresh(env, { heavy = false } = {}) {
  const prev = (await env.STATE.get('snapshot', 'json')) || null;
  const kvOverride = await env.STATE.get('override');
  let monthlySlug = (prev && prev.monthly && prev.monthly.id) || null;
  if (monthlySlug && prev.monthly.endDate && Date.parse(prev.monthly.endDate) < Date.now()) monthlySlug = null;
  const needDiscover = heavy || !prev;
  const [kalshi, polymarket, disc] = await Promise.all([
    attempt(fetchKalshi), attempt(fetchPolymarket), needDiscover ? attempt(discoverMonthly) : Promise.resolve({ ok: true, value: monthlySlug }),
  ]);
  if (disc.ok) monthlySlug = disc.value;
  const monthly = await attempt(() => fetchMonthly(monthlySlug));
  const heavyNow = heavy || !prev;
  const [election2028, approval, news] = heavyNow
    ? await Promise.all([attempt(fetchElection2028), attempt(() => fetchApproval(prev)), attempt(fetchNews)])
    : [null, null, null];

  const carry = (r, key) => (r.ok ? { ok: true, markets: r.value, at: r.at } : { ok: false, markets: (prev && prev.markets && prev.markets[key]) || {}, at: prev && prev.sources && prev.sources[key] ? prev.sources[key].at : null, error: r.error });
  const snap = buildSnapshot({
    config, kvOverride,
    kalshi: carry(kalshi, 'kalshi'), polymarket: carry(polymarket, 'polymarket'),
    monthly: monthly.ok ? monthly.value : (prev && prev.monthly) || null,
    election2028: election2028 && election2028.ok ? election2028.value : (prev && prev.election2028) || null,
    approval: approval && approval.ok ? approval.value : (prev && prev.approval) || null,
    newsMeta: news ? { ok: news.ok, at: news.ok ? news.value.updatedAt : (prev && prev.sources && prev.sources.news && prev.sources.news.at) || null, error: news.error || null } : null,
    prev,
  });
  await env.STATE.put('snapshot', JSON.stringify(snap));
  let newsDoc = null;
  if (news && news.ok) { newsDoc = news.value; await env.STATE.put('news', JSON.stringify(newsDoc)); }
  return { snap, news: newsDoc };
}

// ---------- state access (KV, cold-start inline compute) ----------
async function getSnapshot(env) {
  const s = await env.STATE.get('snapshot', 'json');
  if (s) return s;
  return (await refresh(env, { heavy: true })).snap;
}
async function getNews(env) {
  const n = await env.STATE.get('news', 'json');
  if (n) return n;
  const r = await attempt(fetchNews);
  if (r.ok) { await env.STATE.put('news', JSON.stringify(r.value)); return r.value; }
  return { updatedAt: null, items: [], error: r.error };
}

async function cached(request, ctx, build) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  try { const hit = await cache.match(key); if (hit) return hit; } catch { /* cache unavailable */ }
  const res = await build();
  if (res.ok) { try { ctx.waitUntil(cache.put(key, res.clone())); } catch { /* ignore */ } }
  return res;
}

async function renderPage(request, env) {
  const url = new URL(request.url);
  const tplRes = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin), { method: 'GET' }));
  const tpl = await tplRes.text();
  const [snap, news] = await Promise.all([getSnapshot(env), getNews(env)]);
  const html = fillTemplate(tpl, pageVars({ snap, news, origin: url.origin }));
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=0, s-maxage=60' } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET' } });
    try {
      if (path === '/api/state' || path === '/api/snapshot') return cached(request, ctx, async () => json(await getSnapshot(env), 60));
      if (path === '/api/news') return cached(request, ctx, async () => json(await getNews(env), 120));
      if (path === '/api/health') return json({ ok: true, now: new Date().toISOString() }, 0);
      if (path.startsWith('/api/')) return json({ error: 'not found' }, 0, 404);
      if (path === '/' || path === '/index.html') return cached(request, ctx, () => renderPage(request, env));
    } catch (e) {
      if (path.startsWith('/api/')) return json({ error: String(e && e.message || e) }, 0, 500);
      // Page must still render: serve the raw template with the answer computed from config alone.
      const tplRes = await env.ASSETS.fetch(new Request(new URL('/index.html', url.origin)));
      const snap = buildSnapshot({ config });
      const html = fillTemplate(await tplRes.text(), pageVars({ snap, news: null, origin: url.origin }));
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    const heavy = controller.cron === '5 * * * *';
    await refresh(env, { heavy }).catch((e) => console.error('refresh failed', e));
  },
};
