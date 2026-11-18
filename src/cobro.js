// «Cobrar en ZEC»: petición de pago con el estándar ZIP-321 (zcash:dirección?amount=…&memo=…).
// Zblind no toca el dinero: solo arma el código que la cartera de quien paga sabe leer.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32 = 1, BECH32M = 0x2bc830a3;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
/** Comprueba una dirección bech32/bech32m: devuelve su prefijo si la suma de control cuadra. */
function bech32Hrp(addr, constant) {
  const s = addr.toLowerCase();
  const p = s.lastIndexOf('1');
  if (p < 1 || s.length - p < 7) return null;
  const hrp = s.slice(0, p);
  const data = [];
  for (const c of s.slice(p + 1)) { const v = CHARSET.indexOf(c); if (v < 0) return null; data.push(v); }
  const exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  return polymod(exp.concat(data)) === constant ? hrp : null;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
async function base58check(addr) {
  let n = 0n;
  for (const c of addr) { const v = B58.indexOf(c); if (v < 0) return null; n = n * 58n + BigInt(v); }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of addr) { if (c !== '1') break; bytes.unshift(0); }
  if (bytes.length !== 26) return null;
  const body = new Uint8Array(bytes.slice(0, 22));
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', await crypto.subtle.digest('SHA-256', body)));
  return bytes.slice(22).every((b, i) => b === h[i]) ? body : null;
}

/**
 * Tipo de dirección de Zcash (red principal): 'unified' (u1), 'sapling' (zs1), 'transparent' (t1/t3),
 * 'tex' (tex1, solo transparente) o un error: 'testnet', 'seed' (parece una frase de recuperación) o 'invalid'.
 */
export async function addressKind(text) {
  const a = String(text || '').trim();
  const words = a.toLowerCase().split(/\s+/);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]{3,8}$/.test(w))) return 'seed'; // palabras BIP-39
  if (/^(utest|ztestsapling|textest|tm)/i.test(a)) return 'testnet';
  if (/^u1[02-9ac-hj-np-z]+$/i.test(a) && a.length >= 100 && bech32Hrp(a, BECH32M) === 'u') return 'unified';
  if (/^zs1/i.test(a) && a.length === 78 && bech32Hrp(a, BECH32) === 'zs') return 'sapling';
  if (/^tex1/i.test(a) && bech32Hrp(a, BECH32M) === 'tex') return 'tex';
  if (/^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) {
    const body = await base58check(a);
    if (body && body[0] === 0x1c && (body[1] === 0xb8 || body[1] === 0xbd)) return 'transparent';
  }
  return 'invalid';
}
export const isShielded = (kind) => kind === 'unified' || kind === 'sapling';

/** «u1abcd…wxyz»: para enseñar una dirección sin ocupar media pantalla. */
export const shortAddr = (a) => (a.length > 20 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);

/** Cantidad en ZEC para la URI: como mucho 8 decimales, sin ceros sobrantes. */
export const zecAmount = (x) => (Math.round(x * 1e8) / 1e8).toFixed(8).replace(/\.?0+$/, '');

const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** URI de pago ZIP-321. El concepto va como mensaje y, si la dirección es blindada, también como memo cifrado. */
export function paymentUri({ address, kind, zec = null, concept = '' }) {
  const q = [];
  if (zec) q.push(`amount=${zecAmount(zec)}`);
  if (concept && isShielded(kind)) q.push(`memo=${b64url(concept)}`);
  if (concept) q.push(`message=${encodeURIComponent(concept)}`);
  return `zcash:${address}${q.length ? `?${q.join('&')}` : ''}`;
}
