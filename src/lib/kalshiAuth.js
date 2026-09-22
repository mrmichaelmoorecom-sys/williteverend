// Optional Kalshi API-key signing (RSA-PSS / SHA-256), per Kalshi's "API keys" docs:
//   message   = `${timestampMs}${METHOD}${path}`  (path WITHOUT the query string, e.g. /trade-api/v2/markets)
//   signature = base64( RSA-PSS-SHA256(message, saltLength = 32) )
//   headers   = KALSHI-ACCESS-KEY / KALSHI-ACCESS-TIMESTAMP (ms) / KALSHI-ACCESS-SIGNATURE
// Used only when the Worker has the secrets KALSHI_KEY_ID + KALSHI_PRIVATE_KEY (PKCS#8 PEM); without them
// every call stays keyless, so local dev and tests are unchanged. Kalshi issues PKCS#1 PEMs ("BEGIN RSA PRIVATE
// KEY"); convert once with `openssl pkcs8 -topk8 -nocrypt -in kalshi.pem -out kalshi.pk8` (WebCrypto imports
// only PKCS#8). Pure WebCrypto: works in Workers and Node ≥ 20.

const keyCache = new Map();   // pem → Promise<CryptoKey>, one import per isolate

function pemToDer(pem) {
  const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Import a PKCS#8 PEM as an RSA-PSS signing key (cached per PEM). Throws on a PKCS#1 ("RSA PRIVATE KEY") PEM. */
export function importKalshiKey(pem, subtle = globalThis.crypto && globalThis.crypto.subtle) {
  if (!subtle) throw new Error('WebCrypto unavailable');
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) throw new Error('KALSHI_PRIVATE_KEY must be PKCS#8 (run: openssl pkcs8 -topk8 -nocrypt -in kalshi.pem)');
  let p = keyCache.get(pem);
  if (!p) {
    p = subtle.importKey('pkcs8', pemToDer(pem), { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
    p.catch(() => keyCache.delete(pem));
    keyCache.set(pem, p);
  }
  return p;
}

/** The three auth headers for one request. `path` is the URL path only (query string stripped here). */
export async function kalshiAuthHeaders({ keyId, privateKeyPem, method = 'GET', path, now = Date.now(), subtle }) {
  const key = await importKalshiKey(privateKeyPem, subtle);
  const ts = String(Math.floor(now));
  const msg = `${ts}${method.toUpperCase()}${String(path).split('?')[0]}`;
  const sig = await (subtle || globalThis.crypto.subtle).sign({ name: 'RSA-PSS', saltLength: 32 }, key, new TextEncoder().encode(msg));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-TIMESTAMP': ts, 'KALSHI-ACCESS-SIGNATURE': btoa(bin) };
}

/** Header factory for the Worker: returns null when the secrets are absent (keyless mode). */
export function kalshiSigner(env) {
  const keyId = env && env.KALSHI_KEY_ID, pem = env && env.KALSHI_PRIVATE_KEY;
  if (!keyId || !pem) return null;
  return (url, method = 'GET') => kalshiAuthHeaders({ keyId, privateKeyPem: pem, method, path: new URL(url).pathname });
}
