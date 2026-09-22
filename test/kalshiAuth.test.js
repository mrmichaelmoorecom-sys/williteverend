import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify, constants } from 'node:crypto';
import { kalshiAuthHeaders, kalshiSigner, importKalshiKey } from '../src/lib/kalshiAuth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' });

test('kalshiAuthHeaders: RSA-PSS/SHA-256 (salt 32) over `${ts}${METHOD}${path-without-query}`, base64, ms timestamp', async () => {
  const now = 1789453800123.9;
  const h = await kalshiAuthHeaders({ keyId: 'kid-1', privateKeyPem: pkcs8, method: 'get', path: '/trade-api/v2/markets?tickers=A,B', now });
  assert.equal(h['KALSHI-ACCESS-KEY'], 'kid-1');
  assert.equal(h['KALSHI-ACCESS-TIMESTAMP'], '1789453800123');
  const v = createVerify('sha256');
  v.update('1789453800123GET/trade-api/v2/markets');
  assert.equal(v.verify({ key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64')), true);
  // a different message does not verify
  const v2 = createVerify('sha256'); v2.update('1789453800123GET/trade-api/v2/markets?tickers=A,B');
  assert.equal(v2.verify({ key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64')), false);
});

test('kalshiSigner: null without both secrets; with them a per-request header factory keyed on the URL path', async () => {
  assert.equal(kalshiSigner({}), null);
  assert.equal(kalshiSigner({ KALSHI_KEY_ID: 'k' }), null);
  assert.equal(kalshiSigner(undefined), null);
  const sign = kalshiSigner({ KALSHI_KEY_ID: 'k', KALSHI_PRIVATE_KEY: pkcs8 });
  const h = await sign('https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=KXPRESPERSON-28');
  assert.deepEqual(Object.keys(h).sort(), ['KALSHI-ACCESS-KEY', 'KALSHI-ACCESS-SIGNATURE', 'KALSHI-ACCESS-TIMESTAMP']);
  assert.ok(Math.abs(Number(h['KALSHI-ACCESS-TIMESTAMP']) - Date.now()) < 5000);
});

test('a PKCS#1 PEM (what Kalshi downloads) is rejected with the conversion hint; the import is cached per PEM', async () => {
  assert.throws(() => importKalshiKey(pkcs1), /pkcs8 -topk8/);
  const a = importKalshiKey(pkcs8), b = importKalshiKey(pkcs8);
  assert.equal(a, b);
  await assert.rejects(importKalshiKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'));
});
