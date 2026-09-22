// Regex-based RSS 2.0 parsing (Workers have no DOMParser) + merge/dedupe.
import { decodeEntities, escapeRe } from './entities.js';

const CDATA = /^<!\[CDATA\[([\s\S]*?)\]\]>$/;

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`));
  return m ? m[1].trim().replace(CDATA, '$1').trim() : '';
}

/** Normalize RFC-822-ish pubDate to ISO. Zone abbreviations EDT/EST → numeric offsets. */
export function parseDate(s) {
  if (!s) return null;
  const norm = String(s).trim()
    .replace(/\bEDT\b/, '-0400').replace(/\bEST\b/, '-0500')
    .replace(/\bCDT\b/, '-0500').replace(/\bCST\b/, '-0600')
    .replace(/\bMDT\b/, '-0600').replace(/\bMST\b/, '-0700')
    .replace(/\bPDT\b/, '-0700').replace(/\bPST\b/, '-0800');
  const t = Date.parse(norm);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Parse an RSS feed into [{title, link, source, sourceUrl, pubDate, guid}].
 * @param {string} xml
 * @param {{name?: string, homepage?: string}} feed  default source name when the item has no <source>
 */
export function parseRss(xml, feed = {}) {
  const out = [];
  if (!xml) return out;
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const src = it.match(/<source\s+url="([^"]*)"[^>]*>([\s\S]*?)<\/source>/);
    let title = decodeEntities(tag(it, 'title')).replace(/\s+/g, ' ').trim();
    let source = feed.name || '';
    let sourceUrl = feed.homepage || '';
    if (src) {
      source = decodeEntities(src[2].trim().replace(CDATA, '$1').trim());
      sourceUrl = src[1];
      // Google News: "Headline - Publisher" → strip the suffix using the <source> text.
      title = title.replace(new RegExp(`\\s+-\\s+${escapeRe(source)}$`), '');
      source = shortSource(source);
    }
    const link = decodeEntities(tag(it, 'link')) || (it.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const pubDate = parseDate(tag(it, 'pubDate')) || parseDate(tag(it, 'dc:date')) || null;
    const guid = decodeEntities(tag(it, 'guid')) || link;
    if (!title || !link) continue;
    out.push({ title, link, source, sourceUrl, pubDate, guid });
  }
  return out;
}

/** "ABC News - Breaking News, Latest News and Videos" → "ABC News". */
export function shortSource(name) {
  const s = String(name).split(/\s+[-|–—:]\s+/)[0].trim();
  return s.length >= 3 ? s : String(name).trim();
}

/** Canonical form of a link for dedupe: lowercase host, no query/hash/trailing slash. */
export function normalizeLink(link) {
  try {
    const u = new URL(link);
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch {
    return String(link).toLowerCase().trim();
  }
}

export function normalizeTitle(title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Merge several item lists: dedupe by normalized link, then by normalized title
 * (first occurrence wins, so pass direct-link feeds before Google News), sort desc, cap.
 */
export function mergeItems(lists, { cap = 40, now = Date.now(), maxAgeMs = 3 * 86400e3 } = {}) {
  const seenLink = new Set(), seenTitle = new Set(), out = [];
  for (const list of lists) {
    for (const it of list || []) {
      const l = normalizeLink(it.link), t = normalizeTitle(it.title);
      if (!t || seenLink.has(l) || seenTitle.has(t)) continue;
      if (it.pubDate && now - Date.parse(it.pubDate) > maxAgeMs) continue;
      seenLink.add(l); seenTitle.add(t);
      out.push(it);
    }
  }
  out.sort((a, b) => (Date.parse(b.pubDate || 0) || 0) - (Date.parse(a.pubDate || 0) || 0));
  return out.slice(0, cap);
}
