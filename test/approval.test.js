// The approval source parsers. Fixtures mirror the shapes recorded in docs/DATA_SOURCES.md; the real
// endpoints are not reachable from CI, so these pin the parsing contract, not the upstreams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRcp, parseDdhq, parseYouGov, parseStrengthInNumbers, inferYear, APPROVAL_SOURCES, AVERAGED_KEYS } from '../src/lib/approval.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-09-22T06:30:00Z');

test('RCP: reads the rcp_average block, not a neighbouring poll, and dates it from the END of the window', () => {
  const r = parseRcp(fx('rcp.html'), { now: NOW });
  assert.deepEqual(r, { approve: 40.1, disapprove: 58.6, date: '2026-09-20' });   // "9/2 - 9/20" → the 20th
  assert.notEqual(r.approve, 99.9);   // the id-8650 block above it must not win
  assert.throws(() => parseRcp('<html>nothing here</html>', { now: NOW }), /no rcp_average block/);
  assert.throws(() => parseRcp(fx('rcp.html'), { now: NOW, pollId: '1234' }), /no rcp_average block/);
});

test('RCP: a bare M/D window takes the year from the clock, including across New Year', () => {
  assert.equal(inferYear(9, 20, NOW), '2026-09-20');
  assert.equal(inferYear(1, 5, Date.parse('2026-01-10T00:00:00Z')), '2026-01-05');
  // late December, read on 2 January: the window belongs to the year that just ended, not this one
  assert.equal(inferYear(12, 28, Date.parse('2027-01-02T00:00:00Z')), '2026-12-28');
});

test('DDHQ: newest point wins wherever it sits in the series, and option ids map to approve/disapprove', () => {
  // the fixture lists 09-18, 09-20, 09-19 — the newest is deliberately in the middle
  assert.deepEqual(parseDdhq(fx('ddhq.html')), { approve: 39, disapprove: 59.6, date: '2026-09-20' });
  // the same document unescaped (the page could stop escaping its JSON without changing shape)
  assert.deepEqual(parseDdhq(fx('ddhq.html').replace(/\\"/g, '"')), { approve: 39, disapprove: 59.6, date: '2026-09-20' });
  assert.throws(() => parseDdhq('<html></html>'), /no timeseries/);
});

test('YouGov: the published smoothed series is preferred, with raw values as the fallback, dated from timestamps', () => {
  const overall = JSON.parse(fx('yougov_overall.json'));
  const details = JSON.parse(fx('yougov_details.json'));
  assert.deepEqual(parseYouGov(overall, details), { approve: 38.7, disapprove: 57.9, date: '2026-09-14' });
  const raw = parseYouGov({ raw_values: overall.raw_values }, details);
  assert.deepEqual(raw, { approve: 39.7, disapprove: 57.8, date: '2026-09-14' });
  assert.throws(() => parseYouGov({}, details), /no values/);
  assert.throws(() => parseYouGov(overall, {}), /no timestamps/);
});

test('Strength In Numbers: last dated row of the net-only series, rounded to one decimal', () => {
  assert.deepEqual(parseStrengthInNumbers(fx('sin.csv')), { net: -24.8, date: '2026-09-21' });
  // a trailing blank line must not be mistaken for the latest row
  assert.deepEqual(parseStrengthInNumbers(fx('sin.csv') + '\n\n'), { net: -24.8, date: '2026-09-21' });
  assert.throws(() => parseStrengthInNumbers('Date,Something\n2026-09-21,1\n'), /unexpected header/);
});

test('the registry keeps every key unique and averages only the aggregators', () => {
  const keys = APPROVAL_SOURCES.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(AVERAGED_KEYS, ['nyt', 'sb', 'rcp', 'ddhq']);
  for (const s of APPROVAL_SOURCES) {
    assert.ok(['average', 'poll', 'net'].includes(s.kind), `${s.key} kind`);
    assert.ok(s.maxAgeDays > 0, `${s.key} maxAgeDays`);
    assert.ok(s.link === null || /^https:\/\//.test(s.link), `${s.key} link`);
  }
});
