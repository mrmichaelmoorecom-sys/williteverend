// HTML entity decoding + escaping (no DOM available in Workers).

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®',
  trade: '™', bull: '•', middot: '·', laquo: '«', raquo: '»',
  eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä',
  ntilde: 'ñ', ccedil: 'ç', deg: '°', euro: '€', pound: '£',
};

/** Decode HTML entities (named, decimal, hex). Runs twice so `&amp;#8217;` → `’`. */
export function decodeEntities(s) {
  if (!s) return '';
  const once = (t) => t.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return e in NAMED ? NAMED[e] : m;
  });
  return once(once(String(s)));
}

/** Escape text for insertion into HTML. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Escape a string for use inside a RegExp. */
export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip tags from an HTML fragment (for descriptions). */
export function stripTags(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}
