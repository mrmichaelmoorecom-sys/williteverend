import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, escapeHtml, escapeRe, stripTags } from '../src/lib/entities.js';

test('decodeEntities handles named, decimal, hex and double-encoded entities', () => {
  assert.equal(decodeEntities('Trump&apos;s &#8216;plan&#8217; &amp; more &#x27;x&#x27; &nbsp;'), 'Trump\'s ‘plan’ & more \'x\'  ');
  assert.equal(decodeEntities('a &amp;#8217; b'), 'a ’ b');
  assert.equal(decodeEntities('&unknown; stays'), '&unknown; stays');
  assert.equal(decodeEntities(''), '');
  assert.equal(decodeEntities(null), '');
});

test('escapeHtml escapes the five specials', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('escapeRe escapes regex metacharacters', () => {
  assert.equal(new RegExp(escapeRe('ABC News - Breaking (News)')).test('x ABC News - Breaking (News)'), true);
});

test('stripTags removes markup and collapses whitespace', () => {
  assert.equal(stripTags('<p>Hello&nbsp;<b>world</b></p>\n\n  x'), 'Hello world x');
});
