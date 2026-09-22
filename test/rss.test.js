import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseRss, parseDate, mergeItems, normalizeLink, normalizeTitle } from '../src/lib/rss.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');

test('Google News: strips " - Publisher" suffix using <source>, decodes entities, keeps stub link + guid', () => {
  const items = parseRss(fx('f_gnews.xml'), { name: 'Google News' });
  assert.equal(items.length, 8);
  const first = items[0];
  assert.equal(first.title, 'Trump Administration');
  assert.equal(first.source, 'ABC News');
  assert.equal(first.sourceUrl, 'https://abcnews.com');
  assert.match(first.link, /^https:\/\/news\.google\.com\/rss\/articles\/.+\?oc=5$/);
  assert.equal(first.pubDate, '2026-09-21T20:43:44.000Z');
  assert.match(first.guid, /^CBMi/);
  const aj = items[1];
  assert.equal(aj.title, 'CNN, Politico, MS NOW sue Trump administration over White House ban');
  assert.equal(aj.source, 'Al Jazeera');
  for (const it of items) assert.ok(!/&(amp|apos|#\d+);/.test(it.title), `entity left in: ${it.title}`);
});

test('Politico: EDT pubDates normalize to -0400, source hardcoded, no CDATA leakage', () => {
  const items = parseRss(fx('f_politico.xml'), { name: 'Politico', homepage: 'https://www.politico.com' });
  assert.equal(items.length, 5);
  assert.equal(items[0].title, 'Top House Oversight Dem demands answers to Trump’s media ban');
  assert.equal(items[0].link, 'https://www.politico.com/news/2026/09/21/garcia-demands-answers-trumps-media-ban-01086516');
  assert.equal(items[0].pubDate, '2026-09-21T22:00:00.000Z');   // 18:00 EDT
  assert.equal(items[0].source, 'Politico');
  assert.equal(items[0].guid, '000001a0-c5eb-d462-adb2-e5fbe8610000');
  for (const it of items) assert.ok(!it.title.includes('CDATA'));
});

test('The Hill: CDATA fields, +0000 dates, WordPress guid', () => {
  const items = parseRss(fx('f_hill.xml'), { name: 'The Hill', homepage: 'https://thehill.com' });
  assert.ok(items.length >= 10);
  assert.equal(items[0].title, 'White House launches Trump TV following press bans');
  assert.equal(items[0].link, 'https://thehill.com/homenews/administration/6103061-white-house-launches-trump-tv/');
  assert.equal(items[0].pubDate, '2026-09-22T03:08:31.000Z');
  assert.equal(items[0].guid, 'https://thehill.com/?p=6103061');
});

test('Guardian: plain titles, GMT dates', () => {
  const items = parseRss(fx('f_guardian.xml'), { name: 'The Guardian', homepage: 'https://www.theguardian.com' });
  assert.equal(items.length, 20);
  assert.equal(items[0].title, 'US TV networks suspend White House pool coverage over Trump media ban');
  assert.equal(items[0].link, 'https://www.theguardian.com/us-news/2026/sep/21/trump-tv-networks-white-house-pool-coverage');
  assert.equal(items[0].pubDate, '2026-09-22T01:37:29.000Z');
});

test('parseDate: EDT/EST abbreviations and garbage', () => {
  assert.equal(parseDate('Mon, 21 Sep 2026 18:00:00 EDT'), '2026-09-21T22:00:00.000Z');
  assert.equal(parseDate('Mon, 21 Dec 2026 18:00:00 EST'), '2026-12-21T23:00:00.000Z');
  assert.equal(parseDate('Tue, 22 Sep 2026 03:08:31 +0000'), '2026-09-22T03:08:31.000Z');
  assert.equal(parseDate('not a date'), null);
  assert.equal(parseDate(''), null);
});

test('mergeItems dedupes by link then title, keeps first (direct) link, sorts desc, caps', () => {
  const now = Date.parse('2026-09-22T06:30:00Z');
  const a = [{ title: 'Same Story!', link: 'https://www.politico.com/x/', pubDate: '2026-09-21T10:00:00Z', source: 'Politico' }];
  const b = [
    { title: 'same story', link: 'https://news.google.com/rss/articles/abc?oc=5', pubDate: '2026-09-21T11:00:00Z', source: 'Google' },
    { title: 'Other', link: 'https://politico.com/x?utm=1', pubDate: '2026-09-21T12:00:00Z', source: 'Google' },   // same link as a[0]
    { title: 'Newest', link: 'https://example.com/n', pubDate: '2026-09-22T01:00:00Z', source: 'Google' },
    { title: 'Ancient', link: 'https://example.com/old', pubDate: '2026-09-01T01:00:00Z', source: 'Google' },
  ];
  const out = mergeItems([a, b], { cap: 10, now });
  assert.deepEqual(out.map((i) => i.title), ['Newest', 'Same Story!']);
  assert.equal(out[1].link, 'https://www.politico.com/x/');
  assert.equal(mergeItems([a, b], { cap: 1, now }).length, 1);
  assert.equal(normalizeLink('https://WWW.Example.com/a/b/?q=1#x'), 'example.com/a/b');
  assert.equal(normalizeTitle('Trump’s  “plan”: NO!'), 'trump s plan no');
});
