import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDb } from '../src/db.js';
import { d1Shim } from '../scripts/d1-shim.js';
import { createBot } from '../src/bot.js';
import { loadConfig } from '../src/config.js';
import { addressKind, paymentUri, zecAmount } from '../src/cobro.js';
import { qrMatrix, qrPng } from '../src/qr.js';
import { quickIntent } from '../src/nlu.js';

// --- direcciones de prueba con sumas de control válidas ---
const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(v) { let c = 1; for (const x of v) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c ^= GEN[i]; } return c >>> 0; }
function bech(hrp, n, m) {
  const data = Array.from({ length: n }, (_, i) => (i * 7 + 3) % 32);
  const exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = polymod(exp.concat(data, [0, 0, 0, 0, 0, 0])) ^ m;
  const chk = Array.from({ length: 6 }, (_, i) => (pm >>> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(chk).map((d) => CH[d]).join('');
}
function taddr(prefix) {
  const body = Buffer.concat([Buffer.from(prefix), Buffer.alloc(20, 7)]);
  const sum = createHash('sha256').update(createHash('sha256').update(body).digest()).digest().subarray(0, 4);
  let n = BigInt('0x' + Buffer.concat([body, sum]).toString('hex'));
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  return s;
}
const UA = bech('u', 170, 0x2bc830a3);
const ZS = bech('zs', 69, 1);
const T1 = taddr([0x1c, 0xb8]);

test('direcciones: unificada, sapling y transparente válidas; erratas, testnet y frases de recuperación, no', async () => {
  assert.equal(T1[0] + T1[1], 't1');
  assert.equal(await addressKind(UA), 'unified');
  assert.equal(await addressKind(ZS), 'sapling');
  assert.equal(await addressKind(T1), 'transparent');
  assert.equal(await addressKind(UA.slice(0, -1) + (UA.at(-1) === 'q' ? 'p' : 'q')), 'invalid');
  assert.equal(await addressKind(T1.slice(0, -1) + (T1.at(-1) === 'a' ? 'b' : 'a')), 'invalid');
  assert.equal(await addressKind(bech('utest', 170, 0x2bc830a3)), 'testnet');
  assert.equal(await addressKind('abandon ability able about above absent absorb abstract absurd abuse access accident'), 'seed');
  assert.equal(await addressKind('clases de inglés del mes de marzo para la niña y su hermano pequeño'), 'invalid');
});

test('URI ZIP-321: importe con 8 decimales, memo solo en blindadas', () => {
  assert.equal(zecAmount(0.123456789), '0.12345679');
  assert.equal(zecAmount(2), '2');
  assert.equal(paymentUri({ address: UA, kind: 'unified', zec: 0.5, concept: 'Clases, marzo' }), `zcash:${UA}?amount=0.5&memo=Q2xhc2VzLCBtYXJ6bw&message=Clases%2C%20marzo`);
  assert.equal(paymentUri({ address: T1, kind: 'transparent', zec: 1, concept: 'x' }), `zcash:${T1}?amount=1&message=x`);
  assert.equal(paymentUri({ address: UA, kind: 'unified' }), `zcash:${UA}`);
});

test('QR: tamaño correcto y PNG válido', async () => {
  assert.equal(qrMatrix('hola').length, 21);
  const png = await qrPng(`zcash:${UA}?amount=0.5`);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test('reglas: «quiero cobrar» y «código qr» abren el cobro', () => {
  assert.equal(quickIntent('quiero cobrar en zec').intent, 'cobrar');
  assert.equal(quickIntent('cobrar').intent, 'cobrar');
  assert.equal(quickIntent('hazme un código QR').intent, 'cobrar');
});

function setup() {
  const db = createDb(d1Shim());
  const sent = [], photos = [];
  const api = {
    async call(method, params) { if (method === 'sendMessage') sent.push(params); return { message_id: sent.length }; },
    async upload(method, params, field, bytes) { photos.push({ method, params, bytes }); return {}; },
  };
  const data = { fetchRates: async () => ({ USD: 40, EUR: 36, MXN: 740, BTC: 0.0005 }) };
  const bot = createBot({ api, db, cfg: { ...loadConfig({}), adminIds: [] }, data, clock: () => Date.UTC(2026, 10, 18, 10) });
  const msg = (text) => bot.handleUpdate({ message: { from: { id: 7, first_name: 'Ana' }, chat: { id: 7, type: 'private' }, text } });
  const tap = (d) => bot.handleUpdate({ callback_query: { id: 'c', from: { id: 7 }, data: d } });
  return { db, sent, photos, msg, tap, last: () => sent.at(-1).text };
}

test('cobrar: 20 dólares → concepto → dirección → QR; se recuerda la dirección y se borra con los datos', async () => {
  const s = setup();
  await s.msg('/start');
  await s.tap('tz:ve'); // Venezuela: precios en dólares
  await s.msg('📥 Cobrar en ZEC');
  assert.match(s.last(), /¿Cuánto quieres cobrar\?/);
  await s.msg('20 dólares');
  assert.match(s.last(), /concepto/);
  await s.msg('Clases de inglés');
  assert.match(s.last(), /dirección de Zcash para recibir/);
  await s.msg('abandon ability able about above absent absorb abstract absurd abuse access accident');
  assert.match(s.last(), /frase de recuperación/);
  await s.msg(UA.slice(0, -2));
  assert.match(s.last(), /no me cuadra/);
  await s.msg(UA);
  assert.equal(s.photos.length, 1);
  assert.match(s.photos[0].params.caption, /0,5 ZEC<\/b> \(≈ 20 dólares[\s\S]*Clases de inglés[\s\S]*blindada/);
  assert.match(s.last(), new RegExp(`zcash:${UA}\\?amount=0\\.5&amp;memo=`));
  await s.tap('cb:save');
  assert.match(s.last(), /Guardada/);
  // La próxima vez, «/cobrar 1,25» va directo al QR con la dirección guardada
  await s.msg('/cobrar 1,25');
  assert.equal(s.photos.length, 2);
  assert.match(s.last(), /Olvidar mi dirección|enlace de pago/);
  assert.match(s.photos[1].params.caption, /1,25 ZEC/);
  await s.msg('/borrar_mis_datos confirmar');
  assert.equal(await s.db.kvGet('cobro_dir:7'), null);
});

test('cobrar sin importe y con dirección transparente: aviso de que se ve en la cadena', async () => {
  const s = setup();
  await s.msg('/start');
  await s.tap('tz:es');
  await s.msg('/cobrar');
  await s.tap('cb:none');
  await s.tap('cb:noc');
  await s.msg(T1);
  assert.match(s.photos[0].params.caption, /lo decide quien paga[\s\S]*transparente/);
  assert.match(s.last(), /se ven en la cadena/);
  assert.match(s.last(), new RegExp(`<code>zcash:${T1}</code>`));
});

test('/donar: sin dirección configurada no aparece; con ella, QR y clave de visualización a la vista', async () => {
  const s = setup();
  await s.msg('/donar');
  assert.match(s.last(), /no recoge donaciones/);
  const db = createDb(d1Shim());
  const sent = [], photos = [];
  const api = { async call(m, p) { if (m === 'sendMessage') sent.push(p); return {}; }, async upload(m, p) { photos.push(p); return {}; } };
  const cfg = { ...loadConfig({ DONAR_DIRECCION: UA, DONAR_CLAVE: 'uivk1prueba' }), adminIds: [] };
  const bot = createBot({ api, db, cfg, data: { fetchRates: async () => ({ USD: 40 }) } });
  assert.ok(bot.commands.some((c) => c.command === 'donar'));
  await bot.handleUpdate({ message: { from: { id: 8 }, chat: { id: 8, type: 'private' }, text: '/donar' } });
  assert.match(photos[0].caption, /Apoya a Zblind/);
  assert.match(sent.at(-1).text, new RegExp(`${UA}[\\s\\S]*uivk1prueba`));
});

test('comprobador de copias: el repositorio de Zblind es oficial con el usuario nuevo y con el antiguo', async () => {
  const C = await import('../src/copias.js');
  assert.match(C.report('https://github.com/riberasistemas/zblind'), /código público de Zblind/);
  assert.match(C.report('github.com/5wt6fw45nt-design/zblind'), /código público de Zblind/);
});
