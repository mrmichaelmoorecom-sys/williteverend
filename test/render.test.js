import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKalshiBatch, parsePolymarketKeyset, parsePolymarketMarket } from '../src/lib/markets.js';
import { buildSnapshot, computeApproval, K } from '../src/lib/snapshot.js';
import { pageVars, fillTemplate, relTime, fmtVolume, fmtDate, easternOffsetHours, daysLine, renderNews, renderOdds, renderApproval, renderHeadline, endedLabel } from '../src/lib/render.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-22T06:30:00Z');
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

function snap(over = {}) {
  const kalshi = parseKalshiBatch(JSON.parse(fx('k_batch.json')));
  const polymarket = parsePolymarketKeyset(JSON.parse(fx('pm_keyset.json')));
  for (const f of ['pm_win2028.json', 'pm_nom2028.json']) { const m = parsePolymarketMarket(JSON.parse(fx(f))); polymarket[m.id] = m; }
  const approval = computeApproval({ nyt: { approve: 37.8, disapprove: 59.3, date: '2026-09-22' }, sb: { approve: 38.59664, disapprove: 58.8613, date: '2026-09-21' }, now: NOW });
  return buildSnapshot({ now: NOW, config, kalshi: { ok: true, markets: kalshi, at: new Date(NOW).toISOString() }, polymarket: { ok: true, markets: polymarket, at: new Date(NOW).toISOString() }, approval, ...over });
}

test('template fill renders NO, 851 days, 89.6% / 23.5%, approval and news with no JS', () => {
  const tpl = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const news = { updatedAt: new Date(NOW - 3600e3).toISOString(), items: [{ title: 'Trump <b>&</b> friends', link: 'https://x.test/a?b=1&c=2', source: 'Politico', pubDate: new Date(NOW - 7200e3).toISOString() }] };
  const html = fillTemplate(tpl, pageVars({ snap: snap(), news, origin: 'https://williteverend.com', now: NOW }));
  assert.ok(!/\{\{\w+\}\}/.test(html), 'unfilled placeholder');
  assert.match(html, /<h1 class="answer" id="answer"[^>]*>NO<\/h1>/);
  assert.match(html, />851 days left</);
  assert.match(html, /id="ends-pct">89\.6%</);
  assert.match(html, /id="early-pct">23\.5%</);
  assert.match(html, /<dd>38\.2%<\/dd>/);
  assert.match(html, /<dd>59\.1%<\/dd>/);
  assert.match(html, /<dd>−20\.9<\/dd>/);
  assert.match(html, /Trump &lt;b&gt;&amp;&lt;\/b&gt; friends/);
  assert.match(html, /href="https:\/\/x\.test\/a\?b=1&amp;c=2" target="_blank" rel="noopener"/);
  assert.match(html, /2h ago/);
  assert.match(html, /og:image" content="https:\/\/williteverend\.com\/portrait\.jpg"/);
  assert.match(html, /<script type="application\/json" id="state">\{"updatedAt"/);
  assert.match(html, /embed\.polymarket\.com\/market\?market=trump-out-as-president-before-2027/);
  assert.match(html, /kalshi\.com\/markets\/kxtrumpout27\/x\/kxtrumpout27-27/);
  assert.match(html, /buymeacoffee\.com\/mrmichaelmoore/);
});

test('YES state renders YES + "It ended <date>" and updates og description', () => {
  const s = snap({ config: { ...config, override: 'YES' } });
  const tpl = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const html = fillTemplate(tpl, pageVars({ snap: s, news: null, origin: 'https://williteverend.com', now: NOW }));
  assert.match(html, /<h1 class="answer" id="answer"[^>]*>YES<\/h1>/);
  assert.match(html, /It ended Sep 22, 2026/);
  assert.match(html, /class="answer-yes"/);
  assert.match(html, /content="YES\. It ended/);
  assert.match(html, /News unavailable/);
  // the "chance it ends" lines contradict a YES: gone, replaced by public copy (never the raw reason)
  assert.doesNotMatch(html, /id="ends-pct"/);
  assert.doesNotMatch(html, /id="early-pct"/);
  assert.match(html, /class="chance ended"/);
  assert.match(html, /Marked as ended\./);
  assert.doesNotMatch(html.slice(html.indexOf('<div class="banner"'), html.indexOf('</header>')), /config override/);   // raw reason only in the state JSON
  assert.doesNotMatch(html, /Markets now expect an early exit/);
  const vars = pageVars({ snap: s, news: null, origin: 'https://williteverend.com', now: NOW });
  assert.doesNotMatch(vars.ogDescription, /Chance it actually ends/);
  assert.equal(endedLabel({ verdictReason: 'term ended on schedule' }), 'The term ended on schedule.');
  assert.match(endedLabel({ verdictReason: 'Kalshi KXTRUMPOUT27-27-JAN2029 settled YES' }), /^Kalshi.s "leaves office" market settled YES\.$/);
  assert.match(endedLabel({ verdictReason: 'Polymarket trump-out-as-president-before-2027 resolved YES' }), /^Polymarket.s "out as President" market resolved YES\.$/);
  assert.equal(endedLabel({ verdictReason: 'manual override (YES)' }), 'Marked as ended.');
  assert.match(renderHeadline({ verdict: 'YES', verdictReason: 'term ended on schedule', ends: { pct: 89.6 }, early: { pct: 23.5, expectEarly: true } }), /^<p class="chance ended">.*schedule\.<\/span><\/p>$/);
});

test('unconfirmed YES (Kalshi umbrella only): YES + live countdown, honest banner copy, confirmed:false in #state', () => {
  const s = snap();
  const kalshi = { ...s.markets.kalshi, [K.OUT_JAN2029]: { ...s.markets.kalshi[K.OUT_JAN2029], status: 'finalized', result: 'yes' } };
  const u = buildSnapshot({ now: NOW, config, kalshi: { ok: true, markets: kalshi }, polymarket: { ok: true, markets: s.markets.polymarket } });
  assert.equal(u.verdict, 'YES'); assert.equal(u.confirmed, false); assert.equal(u.endedAt, null);
  const tpl = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const html = fillTemplate(tpl, pageVars({ snap: u, news: null, origin: 'https://williteverend.com', now: NOW }));
  assert.match(html, /<h1 class="answer" id="answer"[^>]*>YES<\/h1>/);
  assert.match(html, />851 days left</);
  assert.doesNotMatch(html, /It ended/);
  assert.doesNotMatch(html, /0 days left/);
  assert.match(html, /settled YES — it also pays out on an announced departure within a year\./);
  assert.doesNotMatch(html, /id="ends-pct"/);
  assert.match(html, /"confirmed":false/);
  assert.equal(daysLine({ termEnd: '2029-01-20T17:00:00Z', verdict: 'YES', endedAt: null }, NOW).text, '851 days left');
  // a confirmed YES still reads "It ended"; an endedAt in the future (clock skew) keeps the countdown rather than "0 days left"
  assert.equal(daysLine({ termEnd: '2029-01-20T17:00:00Z', verdict: 'YES', endedAt: '2026-09-22T00:00:00Z' }, NOW).text, 'It ended Sep 21, 2026');
  assert.equal(daysLine({ termEnd: '2029-01-20T17:00:00Z', verdict: 'YES', endedAt: '2026-09-23T00:00:00Z' }, NOW).text, '851 days left');
});

test('graceful degradation: no odds / no approval / no news', () => {
  const bare = buildSnapshot({ now: NOW, config });
  assert.match(renderOdds(bare), /Odds unavailable/);
  assert.match(renderApproval(bare), /Approval unavailable/);
  assert.match(renderNews(null), /News unavailable/);
  assert.match(renderNews({ items: [] }), /News unavailable/);
  const vars = pageVars({ snap: bare, news: null, origin: '', now: NOW });
  assert.equal(vars.answer, 'NO');
  assert.match(vars.headline, /—/);
});

test('source-down warning (live relative time), partial warning and venue-only tag', () => {
  const s = snap();
  s.sources.kalshi = { ok: false, at: '2026-09-21T10:00:00Z', error: 'x' };
  assert.match(renderOdds(s, NOW), /Kalshi unavailable — showing last good values from <time datetime="2026-09-21T10:00:00Z">21h ago<\/time>\./);
  s.sources.kalshi = { ok: true, at: '2026-09-22T06:00:00Z', partial: true, missing: ['KXTRUMPPRES-28', 'KXTRUMPAPPROVALBELOW-26DEC31-37'] };
  assert.match(renderOdds(s, NOW), /Kalshi did not return 2 of the expected markets \(KXTRUMPPRES-28, KXTRUMPAPPROVALBELOW-26DEC31-37\)/);
  assert.doesNotMatch(renderOdds(s, NOW), /unavailable — showing/);
  s.sources.kalshi = { ok: true, at: 'x', partial: false, missing: [] };
  assert.doesNotMatch(renderOdds(s, NOW), /class="warn"/);
  const only = buildSnapshot({ now: NOW, config, polymarket: { ok: true, markets: s.markets.polymarket } });
  assert.match(pageVars({ snap: only, news: null, now: NOW }).headline, /\(Polymarket only\)/);
});

test('renderNews never emits a non-http(s) href (stale KV content written before the scheme filter)', () => {
  const bad = { items: [{ title: 'x', link: 'javascript:alert(1)', pubDate: '2026-09-22T03:00:00Z' }, { title: 'y', link: 'data:text/html,hi' }] };
  const out = renderNews(bad, NOW);
  assert.doesNotMatch(out, /href="javascript:/);
  assert.doesNotMatch(out, /href="data:/);
  assert.match(out, /News unavailable/);
  const mixed = renderNews({ items: [...bad.items, { title: 'ok', link: 'https://a.test/x', source: 'S', pubDate: '2026-09-22T03:00:00Z' }] }, NOW);
  assert.match(mixed, /href="https:\/\/a\.test\/x"/);
  assert.doesNotMatch(mixed, /javascript:/);
});

test('pageVars: origin comes from the caller (config site, not the Host header) and stateJson has no raw <', () => {
  const s = snap();
  const vars = pageVars({ snap: s, news: { items: [{ title: '</script><script>alert(1)</script>', link: 'https://a.test/x' }] }, origin: 'https://williteverend.com', now: NOW });
  assert.equal(vars.origin, 'https://williteverend.com');
  assert.doesNotMatch(vars.stateJson, /</);
  assert.match(vars.stateJson, /"stale":false/);
  assert.match(vars.stateJson, /"verdictReason":"no settled exit market/);
  const tpl = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(fillTemplate(tpl, vars), /<link rel="canonical" href="https:\/\/williteverend\.com\/">/);
});

test('fmtDate: fixed America/New_York formatter matches Intl across DST boundaries', () => {
  const intl = (iso) => new Date(Date.parse(iso)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
  for (const iso of ['2026-09-22T03:59:59Z', '2026-09-22T04:00:00Z', '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z',
    '2026-12-31T04:59:59Z', '2026-12-31T05:00:00Z', '2029-01-20T17:00:00Z', '2027-01-01T04:59:00Z', '2026-10-01T03:59:00Z', '2028-03-12T06:30:00Z']) {
    assert.equal(fmtDate(iso), intl(iso), iso);
  }
  assert.equal(easternOffsetHours(Date.parse('2026-07-04T12:00:00Z')), -4);
  assert.equal(easternOffsetHours(Date.parse('2026-01-04T12:00:00Z')), -5);
  assert.equal(fmtDate('garbage'), '');
});

test('helpers', () => {
  assert.equal(relTime(new Date(NOW - 30e3).toISOString(), NOW), 'just now');
  assert.equal(relTime(new Date(NOW - 5 * 60e3).toISOString(), NOW), '5m ago');
  assert.equal(relTime(new Date(NOW - 3 * 3600e3).toISOString(), NOW), '3h ago');
  assert.equal(relTime(new Date(NOW - 3 * 86400e3).toISOString(), NOW), '3d ago');
  assert.equal(fmtVolume(5976411.95), '$6.0M');
  assert.equal(fmtVolume(63186.31), '$63K');
  assert.equal(fmtVolume(null), '');
  assert.deepEqual(daysLine({ termEnd: '2029-01-20T17:00:00Z', verdict: 'NO' }, NOW).text, '851 days left');
  assert.equal(daysLine({ termEnd: '2029-01-20T17:00:00Z', verdict: 'NO' }, Date.parse('2029-01-19T16:00:00Z')).text, '1 day left');
  assert.equal(daysLine({ termEnd: '2029-01-20T17:00:00Z', verdict: 'YES', endedAt: '2029-01-20T17:00:00Z' }, Date.parse('2029-01-21T00:00:00Z')).text, 'It ended Jan 20, 2029');
});
