// The Worker's HTTP handler: routing, cold-start inline refresh (deduped per isolate), cache-key normalisation,
// CORS/404/health/OPTIONS, and the fault-injection path — "/" must still answer NO + countdown when KV, the
// Cache API or the asset binding is broken (the brief's "must render sensibly if /api is down").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const TPL = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ORIGIN = 'https://williteverend.com';
const daysLeft = () => Math.floor((Date.parse('2029-01-20T17:00:00Z') - Date.now()) / 86400e3);   // renderPage() uses the wall clock

function mockFetch(calls) {
  const text = (body, type = 'application/json') => new Response(body, { status: 200, headers: { 'content-type': type } });
  globalThis.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.includes('/markets?tickers=')) return text(fx('k_batch.json'));
    if (u.includes('/events/keyset?slug=')) return text(fx('pm_keyset.json'));
    if (u.includes('/markets/slug/will-donald-trump-win-the-2028-us')) return text(fx('pm_win2028.json'));
    if (u.includes('/markets/slug/will-donald-trump-win-the-2028-rep')) return text(fx('pm_nom2028.json'));
    if (u.includes('/events/keyset?title_search=')) return text('{"events":[]}');
    return new Response('nope', { status: 404 });
  };
}
function kv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { m, get: async (k, type) => { const v = m.get(k); return v == null ? null : type === 'json' ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}
/** Map-backed stand-in for caches.default (Node has no Cache API). */
function cacheStub() {
  const store = new Map();
  globalThis.caches = { default: { match: async (req) => { const r = store.get(req.url); return r && r.clone(); }, put: async (req, res) => { store.set(req.url, res); } } };
  return store;
}
const ASSETS = { fetch: async (req) => (new URL(req.url).pathname === '/index.html' ? new Response(TPL, { headers: { 'content-type': 'text/html' } }) : new Response('/* css */', { headers: { 'content-type': 'text/css' } })) };
const ctx = { waitUntil() {} };
const worker = await import('../src/index.js');
worker.tuning.retryDelayMs = () => 0;
const req = (p, init) => new Request(ORIGIN + p, init);

test('GET / on an empty KV: cold-start refresh inline, NO + live countdown + odds rendered, no unfilled placeholders, snapshot written', async () => {
  const calls = []; mockFetch(calls); cacheStub();
  const STATE = kv();
  const res = await worker.default.fetch(req('/'), { STATE, ASSETS }, ctx);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=0, s-maxage=60');
  assert.ok(res.headers.get('content-security-policy'));
  assert.match(body, /<h1 class="answer" id="answer"[^>]*>NO<\/h1>/);
  assert.match(body, new RegExp(`>${daysLeft().toLocaleString('en-US')} days left<`));
  assert.match(body, /id="ends-pct">89\.6%</);
  assert.match(body, /News unavailable/);
  assert.doesNotMatch(body, /\{\{\w+\}\}/);
  assert.ok(STATE.m.has('snapshot'));
  assert.equal(JSON.parse(STATE.m.get('snapshot')).ends.pct, 89.6);
});

test('cold-start dedupe: concurrent / and /api/state on an empty KV trigger exactly one upstream refresh', async () => {
  const calls = []; mockFetch(calls); cacheStub();
  const STATE = kv();
  const rs = await Promise.all([req('/'), req('/api/state'), req('/')].map((r) => worker.default.fetch(r, { STATE, ASSETS }, ctx)));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200]);
  assert.equal(calls.filter((u) => u.includes('/markets?tickers=')).length, 1);
});

test('/api/state and /api/snapshot: JSON, CORS *, verdict NO / 89.6; cache key normalises the alias, the query string and /index.html', async () => {
  const calls = []; mockFetch(calls);
  const store = cacheStub();
  const STATE = kv();
  for (const p of ['/api/snapshot?x=1', '/api/state', '/index.html?utm=x', '/?fbclid=1']) {
    const res = await worker.default.fetch(req(p), { STATE, ASSETS }, ctx);
    assert.equal(res.status, 200, p);
    if (p.startsWith('/api')) {
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      const j = await res.json();
      assert.equal(j.verdict, 'NO'); assert.equal(j.ends.pct, 89.6); assert.equal(j.confirmed, false);
      assert.deepEqual(Object.keys(j.sources.kalshi).sort(), ['at', 'carried', 'error', 'missing', 'ok', 'partial', 'via']);
    }
  }
  assert.deepEqual([...store.keys()].sort(), [`${ORIGIN}/`, `${ORIGIN}/api/state`]);
  // a cache hit is served as-is (no rebuild)
  calls.length = 0;
  const hit = await worker.default.fetch(req('/api/state'), { STATE: kv(), ASSETS }, ctx);
  assert.equal(hit.status, 200); assert.equal((await hit.json()).ends.pct, 89.6); assert.equal(calls.length, 0);
});

test('/api/news: empty doc with s-maxage=30 before the first news job, s-maxage=120 once KV has items', async () => {
  const calls = []; mockFetch(calls); cacheStub();
  let res = await worker.default.fetch(req('/api/news'), { STATE: kv({ snapshot: '{"verdict":"NO"}' }), ASSETS }, ctx);
  assert.deepEqual(await res.json(), { updatedAt: null, items: [] });
  assert.match(res.headers.get('cache-control'), /s-maxage=30\b/);
  cacheStub();
  const news = JSON.stringify({ updatedAt: '2026-09-22T06:00:00Z', items: [{ title: 'x', link: 'https://a.test/x', source: 'S', pubDate: '2026-09-22T05:00:00Z' }] });
  res = await worker.default.fetch(req('/api/news'), { STATE: kv({ news }), ASSETS }, ctx);
  assert.equal((await res.json()).items.length, 1);
  assert.match(res.headers.get('cache-control'), /s-maxage=120\b/);
});

test('/api/health, unknown /api/*, OPTIONS, and static assets fall through to ASSETS', async () => {
  mockFetch([]); cacheStub();
  const env = { STATE: kv(), ASSETS };
  const h = await worker.default.fetch(req('/api/health'), env, ctx);
  assert.equal(h.status, 200); assert.equal((await h.json()).ok, true);
  const nf = await worker.default.fetch(req('/api/nope'), env, ctx);
  assert.equal(nf.status, 404); assert.deepEqual(await nf.json(), { error: 'not found' });
  const opt = await worker.default.fetch(req('/api/state', { method: 'OPTIONS' }), env, ctx);
  assert.equal(opt.headers.get('access-control-allow-origin'), '*');
  const css = await worker.default.fetch(req('/style.css'), env, ctx);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('fetch(): KV errors never escape — / falls back to NO + countdown (no-store), /api/* returns 500 JSON; malformed KV and a dead asset binding too', async () => {
  const calls = []; mockFetch(calls); cacheStub();
  const STATE = { get: async () => { throw new Error('KV down'); }, put: async () => {} };
  const orig = console.error; console.error = () => {};
  try {
    for (const p of ['/', '/index.html']) {
      const res = await worker.default.fetch(req(p), { STATE, ASSETS }, ctx);
      const body = await res.text();
      assert.equal(res.status, 200, p);
      assert.match(body, />NO</); assert.match(body, /days left/); assert.match(body, /id="ends-pct">—</);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.doesNotMatch(body, /\{\{\w+\}\}/);
    }
    for (const p of ['/api/state', '/api/news']) {
      const res = await worker.default.fetch(req(p), { STATE, ASSETS }, ctx);
      assert.equal(res.status, 500, p);
      assert.match(res.headers.get('content-type'), /json/);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.deepEqual(await res.json(), { error: 'KV down' });
    }
    // malformed snapshot value (STATE.get(...,'json') throws SyntaxError) behaves the same
    const BAD = { get: async (k, t) => (k === 'snapshot' && t === 'json' ? JSON.parse('{not json') : null), put: async () => {} };
    const r = await worker.default.fetch(req('/'), { STATE: BAD, ASSETS }, ctx);
    assert.equal(r.status, 200); assert.match(await r.text(), />NO</);
    const rj = await worker.default.fetch(req('/api/state'), { STATE: BAD, ASSETS }, ctx);
    assert.equal(rj.status, 500); assert.match((await rj.json()).error, /JSON/);
    // asset binding down as well: still a 200 page with the answer and the countdown
    const DOWN = { fetch: async () => { throw new Error('assets down'); } };
    const r2 = await worker.default.fetch(req('/'), { STATE, ASSETS: DOWN }, ctx);
    assert.equal(r2.status, 200);
    const b2 = await r2.text();
    assert.match(b2, />NO</); assert.match(b2, /days left/); assert.equal(r2.headers.get('cache-control'), 'no-store');
    // no Cache API at all (caches undefined): everything still works
    delete globalThis.caches;
    const r3 = await worker.default.fetch(req('/api/state'), { STATE: kv(), ASSETS }, ctx);
    assert.equal(r3.status, 200); assert.equal((await r3.json()).ends.pct, 89.6);
    // a throwing Cache API is ignored
    globalThis.caches = { default: { match: async () => { throw new Error('cache down'); }, put: async () => { throw new Error('cache down'); } } };
    const r4 = await worker.default.fetch(req('/'), { STATE: kv(), ASSETS }, ctx);
    assert.equal(r4.status, 200); assert.match(await r4.text(), />NO</);
  } finally { console.error = orig; }
});
