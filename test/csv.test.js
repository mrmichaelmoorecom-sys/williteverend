import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, parseNyt, parseSilverBulletin, parseDatawrapperVersion } from '../src/lib/csv.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('parseCsv handles quotes, CRLF and trailing newline', () => {
  const rows = parseCsv('a,b\r\n1,"x, ""y"""\r\n2,z\n');
  assert.deepEqual(rows, [{ a: '1', b: 'x, "y"' }, { a: '2', b: 'z' }]);
});

test('NYT president-averages.csv → latest Trump approve/disapprove', () => {
  const r = parseNyt(fx('nyt_avg.csv'));
  assert.deepEqual(r, { approve: 37.8, disapprove: 59.3, date: '2026-09-22' });
});

test('NYT parser rejects a CSV without Trump rows', () => {
  assert.throws(() => parseNyt('topic,date,answer,pct\nBiden,2024-01-01,Approve,40\n'), /no Trump rows/);
});

test('Silver Bulletin dataset.csv → last row, M/D/YYYY → ISO', () => {
  const r = parseSilverBulletin(fx('sb.csv'));
  assert.equal(r.approve, 38.59664);
  assert.equal(r.disapprove, 58.8613);
  assert.equal(r.date, '2026-09-21');
});

test('Datawrapper resolver: capture the version group (chart id contains a digit)', () => {
  const html = '<!DOCTYPE html><html><head><meta http-equiv="REFRESH" content="0; url=https://datawrapper.dwcdn.net/kSCt4/7832/"></head></html>';
  assert.equal(parseDatawrapperVersion(html, 'kSCt4'), '7832');
  assert.equal(parseDatawrapperVersion(fx('dw_resolver.html'), 'kSCt4'), '7832');   // the real 245-byte resolver body
  assert.throws(() => parseDatawrapperVersion('<html></html>', 'kSCt4'));
});
