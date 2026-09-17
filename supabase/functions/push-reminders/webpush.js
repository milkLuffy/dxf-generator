// Web Push 送出(RFC 8291 aes128gcm 內容加密 + RFC 8292 VAPID)
// 只用 WebCrypto,Deno(Supabase Edge Function)與 Node 都能跑,不依賴 npm 套件。
const te = new TextEncoder();

export function b64uEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
// HKDF(RFC 5869),長度 <= 32 只需要一輪
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const t1 = await hmac(prk, concat(info, new Uint8Array([1])));
  return t1.slice(0, length);
}

// 加密推播內容。asKeyPair / salt 可由測試帶入固定值,正式使用每次隨機產生。
export async function encryptPayload(plaintext, uaPublicB64u, authSecretB64u, opts = {}) {
  const uaPublic = b64uDecode(uaPublicB64u);
  const authSecret = b64uDecode(authSecretB64u);
  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(16));
  const asKeys = opts.asKeyPair || await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);

  const body = typeof plaintext === 'string' ? te.encode(plaintext) : plaintext;
  const padded = concat(body, new Uint8Array([2]));   // 單一 record:內容後接 0x02 分隔
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, padded));

  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]),
    new Uint8Array([asPublic.length]), asPublic);
  return concat(header, cipher);
}

// VAPID JWT(ES256)。privateJwk = {kty:'EC',crv:'P-256',x,y,d}
async function vapidAuthHeader(endpoint, subject, publicKeyB64u, privateJwk) {
  const aud = new URL(endpoint).origin;
  const header = b64uEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64uEncode(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(header + '.' + claims)));
  return 'vapid t=' + header + '.' + claims + '.' + b64uEncode(sig) + ', k=' + publicKeyB64u;
}

// subscription = {endpoint, keys:{p256dh, auth}};回傳 fetch 的 Response
export async function sendWebPush(subscription, payload, vapid, { ttl = 12 * 3600, urgency = 'normal', topic } = {}) {
  const body = await encryptPayload(typeof payload === 'string' ? payload : JSON.stringify(payload),
    subscription.keys.p256dh, subscription.keys.auth);
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: await vapidAuthHeader(subscription.endpoint, vapid.subject, vapid.publicKey, vapid.privateJwk)
  };
  if (topic) headers.Topic = topic;
  return fetch(subscription.endpoint, { method: 'POST', headers, body });
}
