import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKalshiBatch, parsePolymarketKeyset, parsePolymarketMarket } from '../src/lib/markets.js';
import { buildSnapshot, computeApproval } from '../src/lib/snapshot.js';
import { pageVars, fillTemplate, relTime, fmtVolume, daysLine, renderNews, renderOdds, renderApproval } from '../src/lib/render.js';

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

test('source-down warning and venue-only tag', () => {
  const s = snap();
  s.sources.kalshi = { ok: false, at: '2026-09-21T10:00:00Z', error: 'x' };
  assert.match(renderOdds(s), /Kalshi unavailable — showing last good values from Sep 21, 2026/);
  const only = buildSnapshot({ now: NOW, config, polymarket: { ok: true, markets: s.markets.polymarket } });
  assert.match(pageVars({ snap: only, news: null, now: NOW }).headline, /\(Polymarket only\)/);
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
