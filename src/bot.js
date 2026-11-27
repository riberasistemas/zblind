// Conversación de Zblind: botones, texto libre (reglas + IA), curso, alertas, ajustes y opinión. Sin pagos.

import { ASSETS, COUNTRIES, countryById, countryOf } from './config.js';
import { LESSONS, LESSON_DOLARES } from './lessons.js';
import * as R from './render.js';
import { T } from './render.js';
import { madrid } from './time.js';
import { message } from './telegram.js';
import { withCountry } from './region.js';
import { quickIntent, answer, parseNumber, currencyIn } from './nlu.js';
import { fetchRates, fetchCandles, fetchMaya, fetchNetwork, fetchNodes } from './market.js';
import * as C from './copias.js';
import * as Z from './cobro.js';
import { qrPng } from './qr.js';

export function createBot({ api, db, cfg, clock = Date.now, ai = null, data = { fetchRates, fetchCandles, fetchMaya, fetchNetwork, fetchNodes }, http = (...a) => fetch(...a) }) {
  const reply = (chatId, text, extra = {}) => api.call('sendMessage', message(chatId, text, extra));
  const notifyAdmins = (text) => Promise.allSettled(cfg.adminIds.map((id) => reply(id, text)));
  const fresh = (x, ms) => x && clock() - x.at < ms;
  const kvJson = async (k) => JSON.parse((await db.kvGet(k)) || 'null');

  // --- datos (del motor; si son viejos, se piden al momento) ---

  async function prices(id) {
    let p = await kvJson(`px:${id}`);
    if (!fresh(p, 5 * 60_000)) {
      try {
        p = { rates: await data.fetchRates(id), at: clock() };
        await db.kvSet(`px:${id}`, JSON.stringify(p));
      } catch (e) {
        console.error('[precio]', e.message);
      }
    }
    return p?.rates ?? null;
  }

  async function network() {
    let n = await kvJson('net');
    if (!fresh(n, 30 * 60_000)) {
      try {
        n = { ...(await data.fetchNetwork()), at: clock() };
        await db.kvSet('net', JSON.stringify(n));
      } catch (e) {
        console.error('[red]', e.message);
      }
    }
    return n;
  }

  // Los tres primeros pasos, en grande, para quien no sabe por dónde empezar
  const canDonate = !!cfg.donateAddress;
  const startButtons = { reply_markup: { inline_keyboard: [
    [{ text: '🎓 Primera lección (1 minuto)', callback_data: 'l:0' }],
    [{ text: '🔎 Comprobar si algo es falso', callback_data: 'ck:0' }],
    [{ text: '💰 ¿Cuánto vale hoy?', callback_data: 'p:ZEC' }],
    [{ text: '💬 Grupo de la comunidad', url: 'https://t.me/zcashespchat' }, { text: '✍️ Tu opinión', callback_data: 'set:feedback' }],
    ...(canDonate ? [[{ text: '💛 Apoya a Zblind', callback_data: 'x:donar' }]] : []),
    [{ text: '📤 Compártelo con alguien', url: 'https://t.me/share/url?url=https%3A%2F%2Ft.me%2FZblindBot%3Fstart%3Damigo&text=Mira%20este%20bot%3A%20te%20ense%C3%B1a%20Zcash%20desde%20cero%20en%20espa%C3%B1ol%2C%20con%20el%20precio%20en%20tu%20moneda%20y%20alertas.%20Gratis%20y%20de%20c%C3%B3digo%20abierto.' }],
  ] } };

  // Ejemplo de alerta con cifras que tengan sentido al precio de hoy (no un «900» cuando vale 270)
  const roundNice = (x) => { const m = 10 ** Math.max(0, Math.floor(Math.log10(x)) - 1); return Math.round(x / m) * m; };
  async function alertExample(user, id = 'ZEC') {
    const p = (await prices(id))?.[countryOf(user).currency];
    return p ? { down: R.fmt(roundNice(p * 0.9), 0), up: R.fmt(roundNice(p * 1.15), 0) } : { down: '200', up: '400' };
  }
  const alertHelp = async (chatId, user, id = 'ZEC') => {
    const txt = T.alertUsage(countryOf(user), await alertExample(user, id));
    return reply(chatId, id === 'ZEC' ? txt : txt.replaceAll('zcash', ASSETS[id].name.toLowerCase()));
  };

  const assetButtons = (id) => ({ reply_markup: { inline_keyboard: [[
    { text: '📊 Gráfico', callback_data: `g:${id}` },
    { text: '🔔 Alerta', callback_data: `a:${id}` },
    { text: id === 'ZEC' ? '₿ Bitcoin' : '🛡️ Zcash', callback_data: `p:${id === 'ZEC' ? 'BTC' : 'ZEC'}` },
  ]] } });

  async function cmdPrice(chatId, user, id = 'ZEC', cur = null) {
    const own = countryOf(user);
    const country = cur && cur.currency !== own.currency ? { ...own, currency: cur.currency, currencyName: cur.currencyName, also: null } : own;
    const rates = await prices(id);
    if (!rates) return reply(chatId, T.noData);
    if (!rates[country.currency]) return reply(chatId, T.noCurrency(cur.currencyName));
    const chg = (await kvJson(`chg:${id}`))?.chg ?? null;
    const maya = id === 'ZEC' ? await kvJson('maya') : null;
    const btcRatio = id === 'ZEC' ? rates.BTC : null;
    return reply(chatId, R.priceCard({ asset: ASSETS[id], rates, chg, country, maya, btcRatio }), assetButtons(id));
  }

  async function cmdNodes(chatId, user) {
    let n = await kvJson('nodos');
    if (!fresh(n, 30 * 60_000)) {
      try {
        n = { ...(await data.fetchNodes()), at: clock() };
        await db.kvSet('nodos', JSON.stringify(n));
      } catch (e) {
        console.error('[nodos]', e.message);
      }
    }
    if (!n?.list?.length) return reply(chatId, T.noNodes);
    return reply(chatId, R.nodesCard(n, n.at, countryOf(user).tz));
  }

  async function cmdNetwork(chatId, user) {
    const n = await network();
    if (!n?.height) return reply(chatId, T.noNetwork);
    return reply(chatId, R.networkCard(n, n.at, countryOf(user).tz), { reply_markup: { inline_keyboard: [[{ text: '🎓 ¿Qué es «blindado»?', callback_data: 'l:1' }]] } });
  }

  // --- gráfico (QuickChart dibuja; Telegram descarga la imagen) ---

  async function sendChart(chatId, user, id = 'ZEC') {
    const asset = ASSETS[id];
    try {
      const candles = (await data.fetchCandles(asset.product)).slice(-72);
      const f = new Intl.DateTimeFormat('es-ES', { timeZone: countryOf(user).tz, day: 'numeric', month: 'numeric', hour: '2-digit' });
      const up = candles.at(-1).c >= candles[0].c;
      const chart = {
        type: 'line',
        data: {
          labels: candles.map((c) => f.format(c.t).replace(', ', ' · ') + ' h'),
          datasets: [{ data: candles.map((c) => c.c), borderColor: up ? '#16a34a' : '#dc2626', backgroundColor: up ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.12)', fill: true, pointRadius: 0, borderWidth: 2 }],
        },
        options: { legend: { display: false }, title: { display: true, text: `${asset.name} · 72 h (dólares)`, fontSize: 18 }, scales: { xAxes: [{ ticks: { maxTicksLimit: 8 } }], yAxes: [{ ticks: { beginAtZero: false, maxTicksLimit: 6 } }] } },
      };
      const res = await http('https://quickchart.io/chart/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chart, width: 800, height: 420, backgroundColor: 'white', format: 'png' }),
        signal: AbortSignal.timeout(10_000),
      });
      const url = (await res.json())?.url;
      if (!url) throw new Error('quickchart sin url');
      return api.call('sendPhoto', { chat_id: chatId, photo: url, caption: T.chartCaption(asset), parse_mode: 'HTML' });
    } catch (e) {
      console.error('[gráfico]', e.message);
      return reply(chatId, T.chartFail);
    }
  }

  // --- curso ---

  // Quien aún no ha abierto ninguna lección entra directo a la primera
  const firstSteps = (chatId, user) => (user.seen ? reply(chatId, T.firstSteps, startButtons) : sendLesson(chatId, user, 0));

  async function sendLesson(chatId, user, i) {
    const n = Math.max(0, Math.min(LESSONS.length - 1, i));
    if (n > (user.lesson ?? 0)) await db.setLesson(user.id, n);
    await db.setSeen(user.id, n + 1);
    return reply(chatId, R.lesson(n), R.lessonButtons(n));
  }

  /** «No lo entiendo»: la última lección, otra vez y más fácil, con un ejemplo de la vida diaria. */
  async function explainSimpler(chatId, user, now) {
    const l = LESSONS[user.lesson ?? 0];
    const left = await db.consumeUse(user.id, madrid(now, countryOf(user).tz).date, cfg.aiQuestionsPerDay);
    if (left < 0) return reply(chatId, T.limitAI(cfg.aiQuestionsPerDay));
    const plain = l.text.join('\n').replace(/<[^>]+>/g, '');
    const r = await answer(ai, `No he entendido esta lección. Explícamela otra vez con palabras más sencillas y un ejemplo de la vida diaria:\n${l.title}\n${plain}`, countryOf(user));
    return reply(chatId, r ? `🎓 <b>${R.esc(l.title)}</b>, más fácil:\n\n${R.esc(r)}` : T.aiFail, R.lessonButtons(user.lesson ?? 0));
  }

  // --- alertas ---

  async function createAlert(chatId, user, assetId, op, price) {
    const country = countryOf(user);
    const count = await db.countAlerts(user.id);
    if (count >= cfg.maxAlerts) return reply(chatId, T.alertTooMany(count));
    const rates = await prices(assetId);
    const now = rates?.[country.currency];
    const asset = ASSETS[assetId];
    if (now && ((op === '>' && now >= price) || (op === '<' && now <= price))) return reply(chatId, T.alertAlready(asset, op, price, country));
    const id = await db.addAlert({ userId: user.id, asset: assetId, op, price, currency: country.currency, ts: clock() });
    return reply(chatId, T.alertSet(id, asset, op, price, country));
  }

  async function cmdAlerts(chatId, user) {
    const list = await db.userAlerts(user.id);
    if (!list.length) return reply(chatId, `${T.noAlerts}\n\n${T.alertUsage(countryOf(user), await alertExample(user))}`);
    const c = countryOf(user);
    const lines = list.map((al) => `#${al.id} ${ASSETS[al.asset].name} ${al.op === '>' ? 'pase de' : 'baje de'} ${R.money(al.price, al.currency === c.currency ? c : { ...c, currencyName: al.currency })}`);
    return reply(chatId, `🔔 <b>Tus alertas</b>\n${lines.join('\n')}`, {
      reply_markup: { inline_keyboard: list.map((al) => [{ text: `🗑 Borrar #${al.id}`, callback_data: `del:${al.id}` }]) },
    });
  }

  // --- ajustes, país y opinión ---

  const zoneButtons = () => {
    const rows = [];
    for (let i = 0; i < COUNTRIES.length; i += 2) rows.push(COUNTRIES.slice(i, i + 2).map((c) => ({ text: c.label, callback_data: `tz:${c.id}` })));
    return { reply_markup: { inline_keyboard: rows } };
  };

  async function cmdSettings(chatId, user) {
    return reply(chatId, R.settings({ country: countryOf(user), daily: !!user.daily, alerts: await db.countAlerts(user.id) }), {
      reply_markup: { inline_keyboard: [
        [{ text: '🌎 Cambiar país y moneda', callback_data: 'set:country' }],
        [{ text: user.daily ? '🌙 Apagar resumen de la mañana' : '☀️ Encender resumen de la mañana', callback_data: 'set:daily' }],
        [{ text: '🔔 Mis alertas', callback_data: 'set:alerts' }, { text: '💬 Dar mi opinión', callback_data: 'set:feedback' }],
        [{ text: '📄 Términos y privacidad', callback_data: 'set:terms' }, { text: '🗑 Borrar mis datos', callback_data: 'set:delete' }],
        [{ text: '📤 Compártelo con alguien', url: 'https://t.me/share/url?url=https%3A%2F%2Ft.me%2FZblindBot%3Fstart%3Damigo&text=Mira%20este%20bot%3A%20te%20ense%C3%B1a%20Zcash%20desde%20cero%20en%20espa%C3%B1ol%2C%20con%20el%20precio%20en%20tu%20moneda%20y%20alertas.%20Gratis%20y%20de%20c%C3%B3digo%20abierto.' }],
      ] },
    });
  }

  async function askFeedback(chatId, userId) {
    await db.kvSet(`opinando:${userId}`, clock());
    return reply(chatId, T.feedbackAsk);
  }

  async function takeFeedback(msg, user, now) {
    const at = Number((await db.kvGet(`opinando:${user.id}`)) || 0);
    if (!at) return false;
    await db.kvSet(`opinando:${user.id}`, 0);
    if (now - at > 3600_000 || R.BUTTONS[msg.text.trim()]) return false;
    if (/^cancelar$/i.test(msg.text.trim())) { await reply(msg.chat.id, T.feedbackCancel); return true; }
    const text = msg.text.trim().slice(0, 2000);
    const who = [user.first_name, user.username ? `@${user.username}` : ''].filter(Boolean).join(' ') || String(user.id);
    await db.kvSet(`opinion:${now}:${user.id}`, JSON.stringify({ id: user.id, who, country: countryOf(user).id, text }));
    await notifyAdmins(`💬 <b>Opinión en Zblind</b> de ${R.esc(who)} (${countryOf(user).label}, id ${user.id}):\n\n${R.esc(text)}\n\nPara contestar: /responder ${user.id} tu respuesta`);
    await reply(msg.chat.id, T.feedbackThanks);
    return true;
  }

  // --- «¿Es esto una copia?» ---

  async function askCopia(chatId, userId) {
    await db.kvSet(`copiando:${userId}`, clock());
    return reply(chatId, C.ASK);
  }

  const lessonCopias = (chatId) => reply(chatId, [`<b>${C.LESSON_COPIAS.title}</b>`, '', ...C.LESSON_COPIAS.text].join('\n'), {
    reply_markup: { inline_keyboard: [[{ text: '🔎 ¿Es esto una copia?', callback_data: 'ck:0' }], [{ text: '📚 Índice del curso', callback_data: 'l:idx' }]] },
  });

  const lessonDolares = (chatId) => reply(chatId, [`<b>${LESSON_DOLARES.title}</b>`, '', ...LESSON_DOLARES.text].join('\n'), {
    reply_markup: { inline_keyboard: [[{ text: '📥 Cobrar en ZEC', callback_data: 'cb:new' }, { text: '🔎 ¿Es esto una copia?', callback_data: 'ck:0' }], [{ text: '🎓 Cómo conseguir ZEC', callback_data: 'l:4' }, { text: '📚 Índice del curso', callback_data: 'l:idx' }]] },
  });

  const copiaReply = (chatId, text) => {
    const r = C.report(text);
    return reply(chatId, r || C.NOTHING, { reply_markup: { inline_keyboard: [[{ text: '🕵️ Cómo detectar copias', callback_data: 'cf:0' }]] } });
  };

  async function takeCopia(msg, user, now) {
    const at = Number((await db.kvGet(`copiando:${user.id}`)) || 0);
    if (!at) return false;
    const text = msg.text.trim();
    if (now - at > 3600_000 || R.BUTTONS[text]) { await db.kvSet(`copiando:${user.id}`, 0); return false; }
    if (/^cancelar$/i.test(text)) { await db.kvSet(`copiando:${user.id}`, 0); await reply(msg.chat.id, 'Vale, lo dejamos.'); return true; }
    const found = C.analyze(text).verdict !== 'empty';
    if (found) await db.kvSet(`copiando:${user.id}`, 0); // si no encontró nada, sigue esperando lo que pegue
    await copiaReply(msg.chat.id, text);
    return true;
  }

  // --- «Cobrar en ZEC»: importe → concepto → dirección → QR (ZIP-321). Sin custodia: no tocamos el dinero ---

  const cobroKey = (id) => `cobrando:${id}`;
  const dirKey = (id) => `cobro_dir:${id}`;
  const getCobro = async (id) => { const s = await kvJson(cobroKey(id)); return s && clock() - s.at < 3600_000 ? s : null; };
  const setCobro = (id, s) => db.kvSet(cobroKey(id), JSON.stringify({ ...s, at: clock() }));
  const endCobro = (id) => db.kvSet(cobroKey(id), 'null');
  const cancelRow = [{ text: '✖️ Cancelar', callback_data: 'cb:cancel' }];

  /** «0,5», «0.5 zec», «20 dólares», «5.000 pesos», «20 €». Sin moneda = ZEC. */
  async function cobroAmount(text, user) {
    const t = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const num = t.match(/\d[\d.,]*k?/);
    const n = num && parseNumber(num[0]);
    if (!n) return null;
    const own = countryOf(user);
    let cur = /\b(zec|zcash)\b/.test(t) ? null : currencyIn(t);
    if (!cur && /€/.test(t)) cur = { currency: 'EUR', currencyName: 'euros' };
    if (!cur && /\$/.test(t)) cur = own.currency === 'EUR' ? { currency: 'USD', currencyName: 'dólares' } : { currency: own.currency, currencyName: own.currencyName };
    if (!cur) return n <= 21e6 ? { zec: n } : null;
    const rate = (await prices('ZEC'))?.[cur.currency];
    if (!rate) return { error: true };
    return { zec: Math.round((n / rate) * 1e8) / 1e8, fiat: { amount: n, ...cur } };
  }

  async function startCobro(chatId, user, arg = '') {
    if (/^(olvidar|olvida|borrar)/i.test(arg)) {
      await db.kvSet(dirKey(user.id), 'null');
      return reply(chatId, '🗑 Hecho: he olvidado tu dirección de cobro.');
    }
    const amount = arg ? await cobroAmount(arg, user) : null;
    const saved = await kvJson(dirKey(user.id));
    if (amount?.zec && saved) return finishCobro(chatId, user, { ...amount, concept: '', ...saved, saved: true });
    if (amount?.zec) return askConcept(chatId, user, amount);
    await setCobro(user.id, { step: 'amount' });
    return reply(chatId, [
      '📥 <b>Cobrar en ZEC</b>',
      '',
      'Te preparo un código QR para que te paguen en ZEC. El dinero va directo de la cartera de quien paga a la tuya: Zblind no lo toca.',
      '',
      `¿Cuánto quieres cobrar? Escríbelo en ZEC (por ejemplo <b>0,5</b>) o en tu moneda (por ejemplo <b>20 ${countryOf(user).currencyName}</b>).`,
    ].join('\n'), { reply_markup: { inline_keyboard: [[{ text: '🤷 Que lo decida quien paga', callback_data: 'cb:none' }], cancelRow] } });
  }

  async function askConcept(chatId, user, s) {
    await setCobro(user.id, { ...s, step: 'concept' });
    return reply(chatId, '📝 ¿Le pongo un <b>concepto</b>? Por ejemplo «Clases de inglés, marzo». Lo verá quien paga en su cartera.', {
      reply_markup: { inline_keyboard: [[{ text: 'Sin concepto', callback_data: 'cb:noc' }], cancelRow] },
    });
  }

  async function toAddress(chatId, user, s) {
    const saved = await kvJson(dirKey(user.id));
    if (saved) return finishCobro(chatId, user, { ...s, ...saved, saved: true });
    await setCobro(user.id, { ...s, step: 'address' });
    return reply(chatId, [
      '📬 Pégame tu <b>dirección de Zcash para recibir</b>.',
      '',
      'Mejor una <b>unificada</b> (empieza por <code>u1</code>): la encuentras en tu cartera, en «Recibir».',
      '🔐 Solo la dirección. <b>Nunca</b> tu frase de recuperación: esa no se la das a nadie, tampoco a mí.',
    ].join('\n'), { reply_markup: { inline_keyboard: [cancelRow] } });
  }

  async function finishCobro(chatId, user, s) {
    const uri = Z.paymentUri(s);
    const shielded = Z.isShielded(s.kind);
    const zec = s.zec ? `<b>${R.esc(Number(Z.zecAmount(s.zec)).toLocaleString('es-ES', { maximumFractionDigits: 8 }))} ZEC</b>` : null;
    const caption = [
      '📥 <b>Cobro en ZEC</b>',
      `Importe: ${zec ? (s.fiat ? `${zec} (≈ ${R.esc(R.fmt(s.fiat.amount, s.fiat.amount % 1 ? 2 : 0))} ${R.esc(s.fiat.currencyName)} al precio de ahora)` : zec) : 'lo decide quien paga'}`,
      s.concept ? `Concepto: ${R.esc(s.concept)}` : null,
      `Para: <code>${R.esc(Z.shortAddr(s.address))}</code> ${shielded ? '🛡️ blindada' : '⚠️ transparente'}`,
      '',
      'Quien te paga lo escanea con su cartera de Zcash (por ejemplo Zodl) y le sale todo rellenado.',
    ].filter((l) => l !== null).join('\n');
    try {
      const png = await qrPng(uri);
      const params = { chat_id: chatId, caption, parse_mode: 'HTML' };
      if (api.upload) await api.upload('sendPhoto', params, 'photo', png, 'cobro-zec.png');
      else await api.call('sendPhoto', { ...params, photo: '(png)' });
    } catch (e) {
      console.error('[qr]', e.message);
      await reply(chatId, caption);
    }
    await setCobro(user.id, { step: 'done', address: s.address, kind: s.kind });
    const buttons = [[{ text: '📥 Otro cobro', callback_data: 'cb:new' }]];
    if (!s.saved) buttons.unshift([{ text: '💾 Recordar mi dirección para la próxima', callback_data: 'cb:save' }]);
    else buttons.push([{ text: '🗑 Olvidar mi dirección', callback_data: 'cb:forget' }]);
    return reply(chatId, [
      'Si te paga a distancia, reenvíale la imagen o este enlace de pago (mantén el dedo encima para copiarlo):',
      '',
      `<code>${R.esc(uri)}</code>`,
      shielded ? '' : '\n⚠️ Con una dirección transparente, el pago y el concepto se ven en la cadena. Si puedes, usa una unificada (<code>u1</code>).',
    ].join('\n'), { reply_markup: { inline_keyboard: buttons } });
  }

  async function takeCobro(msg, user) {
    const s = await getCobro(user.id);
    if (!s || s.step === 'done') return false;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    if (R.BUTTONS[text]) { await endCobro(user.id); return false; }
    if (/^cancelar$/i.test(text)) { await endCobro(user.id); await reply(chatId, 'Vale, lo dejamos.'); return true; }
    const kind = await Z.addressKind(text);
    if (kind === 'seed') {
      return reply(chatId, '🚨 <b>Eso parece una frase de recuperación.</b> Borra ese mensaje ahora mismo (mantén el dedo encima → Eliminar). No la guardo. Con esa frase cualquiera vacía tu cartera: para cobrar solo hace falta tu dirección.').then(() => true);
    }
    if (s.step === 'amount') {
      const a = await cobroAmount(text, user);
      if (a?.error) { await reply(chatId, T.noData); return true; }
      if (!a) { await reply(chatId, `No entiendo la cantidad. Escríbela así: <b>0,5</b> (en ZEC) o <b>20 ${countryOf(user).currencyName}</b>.`); return true; }
      await askConcept(chatId, user, a);
      return true;
    }
    if (s.step === 'concept') {
      await toAddress(chatId, user, { ...s, concept: text.replace(/[<>]/g, '').slice(0, 80) });
      return true;
    }
    if (s.step === 'address') {
      const why = {
        testnet: 'Esa dirección es de la red de pruebas (testnet). Para cobrar de verdad necesito una de la red principal: empieza por <code>u1</code>, <code>zs1</code> o <code>t1</code>.',
        invalid: 'Esa dirección no me cuadra: puede faltar o sobrar un carácter. Cópiala otra vez desde tu cartera, en «Recibir», y pégamela entera.',
      }[kind];
      if (why) { await reply(chatId, why); return true; }
      await finishCobro(chatId, user, { ...s, address: text, kind });
      return true;
    }
    return false;
  }

  async function onCobroButton(chatId, user, id) {
    const s = await getCobro(user.id);
    if (id === 'new') return startCobro(chatId, user);
    if (id === 'cancel') { await endCobro(user.id); return reply(chatId, 'Vale, lo dejamos.'); }
    if (id === 'forget') { await db.kvSet(dirKey(user.id), 'null'); return reply(chatId, '🗑 Hecho: he olvidado tu dirección de cobro.'); }
    if (id === 'save' && s?.step === 'done') {
      await db.kvSet(dirKey(user.id), JSON.stringify({ address: s.address, kind: s.kind }));
      return reply(chatId, '💾 Guardada. La próxima vez solo te pregunto el importe. Para olvidarla: /cobrar olvidar');
    }
    if (id === 'none' && s?.step === 'amount') return askConcept(chatId, user, { zec: null });
    if (id === 'noc' && s?.step === 'concept') return toAddress(chatId, user, { ...s, concept: '' });
    return startCobro(chatId, user); // botón de un cobro caducado: se empieza de nuevo
  }

  // --- /donar: privado por defecto; si hay clave de visualización publicada, cuentas a la vista ---

  async function cmdDonate(chatId) {
    if (!canDonate) return reply(chatId, 'Zblind es gratis y por ahora no recoge donaciones. Lo que más nos ayuda: compártelo con alguien 🙏', { reply_markup: { inline_keyboard: [startButtons.reply_markup.inline_keyboard.find((r) => r[0].url?.includes('share'))] } });
    const uri = Z.paymentUri({ address: cfg.donateAddress, kind: 'unified', concept: 'Donación a Zblind' });
    const caption = '💛 <b>Apoya a Zblind</b>\n\nZblind es gratis y de código abierto. Si te sirve, puedes donar el ZEC que quieras escaneando este código con tu cartera.';
    try {
      const png = await qrPng(uri);
      if (api.upload) await api.upload('sendPhoto', { chat_id: chatId, caption, parse_mode: 'HTML' }, 'photo', png, 'donar-zblind.png');
      else await api.call('sendPhoto', { chat_id: chatId, caption, parse_mode: 'HTML', photo: '(png)' });
    } catch (e) {
      console.error('[qr]', e.message);
      await reply(chatId, caption);
    }
    const lines = ['<b>Dirección</b> (mantén el dedo encima para copiarla):', `<code>${R.esc(cfg.donateAddress)}</code>`];
    if (!cfg.donateViewKey) return reply(chatId, [...lines, '', 'Es una dirección blindada: tu donación es privada. Gracias de corazón 💛'].join('\n'));
    return reply(chatId, [
      ...lines,
      '',
      '🔍 <b>Cuentas a la vista.</b> Con Zcash todo es privado por defecto, pero tú puedes elegir enseñarlo. Esta es la <b>clave de visualización</b> de la cuenta de donaciones: con ella cualquiera ve lo que entra, y nadie puede gastarlo.',
      `<code>${R.esc(cfg.donateViewKey)}</code>`,
      '',
      'Se pega en una cartera que admita importar claves de visualización. Así compruebas que lo donado llega de verdad.',
    ].join('\n'));
  }

  async function sendInstructions(chatId, pin = false) {
    const sent = await reply(chatId, T.instructions(cfg), R.KEYBOARD);
    if (pin && sent?.message_id) {
      try {
        await api.call('unpinAllChatMessages', { chat_id: chatId });
        await api.call('pinChatMessage', { chat_id: chatId, message_id: sent.message_id, disable_notification: true });
      } catch (e) {
        console.error('[fijar]', e.message);
      }
    }
  }

  // --- texto libre ---

  async function onText(msg, user, now) {
    if (await takeFeedback(msg, user, now)) return;
    if (await takeCopia(msg, user, now)) return;
    if (await takeCobro(msg, user)) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    // Un enlace o una cuenta pegados sin más: se comprueban directamente
    if (!R.BUTTONS[text] && /(https?:\/\/|t\.me\/|^@[a-z])/i.test(text)) return copiaReply(chatId, text);
    const it = R.BUTTONS[text] ? { intent: R.BUTTONS[text] } : quickIntent(text);
    switch (it?.intent) {
      case 'price': return cmdPrice(chatId, user, it.asset || 'ZEC', it.currency ? it : null);
      case 'lesson': return sendLesson(chatId, user, it.n);
      case 'simpler': return explainSimpler(chatId, user, now);
      case 'chart': return sendChart(chatId, user, it.asset || 'ZEC');
      case 'learn': return user.lesson > 0 && !it.fromStart ? reply(chatId, R.lessonIndex().text, R.lessonIndex().extra) : sendLesson(chatId, user, 0);
      case 'privacy': return reply(chatId, R.privacy(), { reply_markup: { inline_keyboard: [[{ text: '🎓 Empezar el curso', callback_data: 'l:0' }]] } });
      case 'network': return cmdNetwork(chatId, user);
      case 'nodes': return cmdNodes(chatId, user);
      case 'alerts': return cmdAlerts(chatId, user);
      case 'alert': return createAlert(chatId, user, it.asset, it.op, it.price);
      case 'alert_help': return alertHelp(chatId, user);
      case 'hello': return reply(chatId, T.hello(msg.from.first_name), startButtons);
      case 'settings': return cmdSettings(chatId, user);
      case 'zone': return reply(chatId, T.askZone, zoneButtons());
      case 'feedback': return askFeedback(chatId, user.id);
      case 'help': return sendInstructions(chatId);
      case 'smalltalk': return reply(chatId, T.smalltalk);
      case 'copia': return askCopia(chatId, user.id);
      case 'community': return reply(chatId, R.community().text, R.community().extra);
      case 'dollars': return lessonDolares(chatId);
      case 'cobrar': return startCobro(chatId, user);
      case 'donate': return cmdDonate(chatId);
    }
    // Pregunta libre: la responde la IA (con cupo diario)
    const left = await db.consumeUse(user.id, madrid(now, countryOf(user).tz).date, cfg.aiQuestionsPerDay);
    if (left < 0) return reply(chatId, T.limitAI(cfg.aiQuestionsPerDay));
    await api.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const r = await answer(ai, text, countryOf(user));
    return reply(chatId, r ? `${R.esc(r)}\n\n<i>${R.DISCLAIMER}</i>` : T.aiFail);
  }

  // --- botones en línea ---

  async function onCallback(cq) {
    const [kind, id] = String(cq.data || '').split(':');
    await api.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    if (!cq.from) return;
    const now = clock();
    const user = await db.upsertUser(cq.from, now);
    const chatId = cq.from.id;
    const c = countryById(id);
    if (kind === 'tz' && c) {
      await db.setCountry(user.id, c.id, c.tz);
      return withCountry(c, async () => {
        await reply(chatId, T.zoneSet(c));
        if (!user.country) {
          await cmdPrice(chatId, { ...user, country: c.id, tz: c.tz }, 'ZEC');
          return firstSteps(chatId, user);
        }
      });
    }
    return withCountry(countryOf(user), async () => {
      if (kind === 'l') return id === 'idx' ? reply(chatId, R.lessonIndex().text, R.lessonIndex().extra) : sendLesson(chatId, user, Number(id));
      if (kind === 'ck') return askCopia(chatId, user.id);
      if (kind === 'cf') return lessonCopias(chatId);
      if (kind === 'dd') return lessonDolares(chatId);
      if (kind === 'cb') return onCobroButton(chatId, user, id);
      if (kind === 'p' && ASSETS[id]) return cmdPrice(chatId, user, id);
      if (kind === 'g' && ASSETS[id]) return sendChart(chatId, user, id);
      if (kind === 'a' && ASSETS[id]) return alertHelp(chatId, user, id);
      if (kind === 'x' && id === 'privacy') return reply(chatId, R.privacy(), { reply_markup: { inline_keyboard: [[{ text: '🎓 Empezar el curso', callback_data: 'l:0' }]] } });
      if (kind === 'x' && id === 'network') return cmdNetwork(chatId, user);
      if (kind === 'x' && id === 'comunidad') return reply(chatId, R.community().text, R.community().extra);
      if (kind === 'x' && id === 'duda') return reply(chatId, T.askDoubt);
      if (kind === 'x' && id === 'donar') return cmdDonate(chatId);
      if (kind === 'del') return reply(chatId, (await db.deleteAlert(user.id, Number(id))) ? T.alertDeleted(id) : T.alertNotFound);
      if (kind === 'set') {
        if (id === 'country') return reply(chatId, T.askZone, zoneButtons());
        if (id === 'daily') { await db.setDaily(user.id, !user.daily); return reply(chatId, user.daily ? T.dailyOff : T.dailyOn); }
        if (id === 'alerts') return cmdAlerts(chatId, user);
        if (id === 'feedback') return askFeedback(chatId, user.id);
        if (id === 'terms') return reply(chatId, T.terms);
        if (id === 'delete') return reply(chatId, T.deleteAsk);
      }
    });
  }

  // --- admin ---

  async function cmdAdmin(cmd, chatId, arg, now) {
    if (cmd === 'stats') {
      const s = await db.stats(now);
      const src = (await db.sources()).map((r) => `${r.source} ${r.n}`).join(' · ');
      const f = await db.funnel(LESSONS.length);
      return reply(chatId, `Usuarios ${s.users} (+${s.week} esta semana) · bloqueados ${s.blocked}\nAlertas ${s.alerts} · cola ${s.outbox}\nOrigen: ${R.esc(src)}\nCurso: empezaron ${f.started} · lección 2 ${f.second} · acabaron ${f.finished}\nVolvieron otro día ${f.back} · con alerta ${f.alerts}`);
    }
    if (cmd === 'responder') {
      const m = arg.match(/^(\d+)\s+([\s\S]+)$/);
      if (!m) return reply(chatId, 'Uso: /responder USER_ID texto');
      await reply(Number(m[1]), T.feedbackReply(m[2].trim()));
      return reply(chatId, 'Enviado ✅');
    }
    if (cmd === 'opiniones') {
      const rows = await db.kvPrefix('opinion:');
      if (!rows.length) return reply(chatId, 'Aún no hay opiniones.');
      return reply(chatId, rows.slice(-10).map((r) => { const o = JSON.parse(r.v); return `• ${R.esc(o.who)} (${o.country}, ${o.id}): ${R.esc(o.text)}`; }).join('\n\n'));
    }
    return null;
  }

  // --- entrada ---

  async function handleUpdate(u) {
    const fromId = u.message?.from?.id;
    const known = fromId ? await db.getUser(fromId) : null;
    return withCountry(countryOf(known), () => handleUpdateIn(u));
  }

  async function handleUpdateIn(u) {
    const now = clock();
    if (u.callback_query) return onCallback(u.callback_query);
    const msg = u.message;
    if (!msg?.from || msg.chat.type !== 'private') return;
    // Avisos de servicio (p. ej. «mensaje fijado», que firma el propio bot): no son de una persona
    if (msg.from.is_bot || msg.pinned_message) return;
    if (!msg.text) return reply(msg.chat.id, 'Por ahora entiendo texto: escríbeme tu pregunta o usa los botones de abajo 👇');
    const user = await db.upsertUser(msg.from, now);
    if (!msg.text.startsWith('/')) return onText(msg, user, now);

    const [head, ...rest] = msg.text.trim().split(/\s+/);
    const cmd = head.slice(1).split('@')[0].toLowerCase();
    const arg = rest.join(' ');
    const chatId = msg.chat.id;
    switch (cmd) {
      case 'start':
        if (/^[A-Za-z0-9_-]{1,64}$/.test(arg)) await db.setSource(user.id, arg.toLowerCase());
        await sendInstructions(chatId, true);
        if (!user.country) return reply(chatId, T.askZone, zoneButtons());
        if (/^cobrar$/i.test(arg)) return startCobro(chatId, user); // enlace t.me/ZblindBot?start=cobrar
        return firstSteps(chatId, user);
      case 'ayuda': case 'help': return sendInstructions(chatId);
      case 'precio': return cmdPrice(chatId, user, /btc|bitcoin/i.test(arg) ? 'BTC' : 'ZEC');
      case 'grafico': return sendChart(chatId, user, /btc|bitcoin/i.test(arg) ? 'BTC' : 'ZEC');
      case 'aprende': case 'curso': return sendLesson(chatId, user, Number(arg) ? Number(arg) - 1 : user.seen ?? 0);
      case 'privacidad': return reply(chatId, R.privacy());
      case 'red': return cmdNetwork(chatId, user);
      case 'nodos': return cmdNodes(chatId, user);
      case 'alertas': return cmdAlerts(chatId, user);
      case 'ajustes': return cmdSettings(chatId, user);
      case 'pais': case 'zona': case 'moneda': return reply(chatId, T.askZone, zoneButtons());
      case 'opinion': return askFeedback(chatId, user.id);
      case 'copia': return arg ? copiaReply(chatId, arg) : askCopia(chatId, user.id);
      case 'copias': return lessonCopias(chatId);
      case 'comunidad': return reply(chatId, R.community().text, R.community().extra);
      case 'dolares': return lessonDolares(chatId);
      case 'cobrar': case 'cobro': return startCobro(chatId, user, arg);
      case 'donar': case 'apoyar': return cmdDonate(chatId);
      case 'oficial': return reply(chatId, C.SEAL);
      case 'terminos': case 'privacy': return reply(chatId, T.terms);
      case 'borrar_mis_datos':
        if (arg.trim().toLowerCase() !== 'confirmar') return reply(chatId, T.deleteAsk);
        await db.deleteUserData(user.id);
        return reply(chatId, T.deleted);
    }
    if (cfg.adminIds.includes(user.id)) {
      const res = await cmdAdmin(cmd, chatId, arg, now);
      if (res !== null) return res;
    }
    return onText({ ...msg, text: arg || cmd }, user, now);
  }

  const commands = [
    ['precio', 'Precio de Zcash en tu moneda'],
    ['cobrar', 'Cobrar en ZEC con un código QR'],
    ['aprende', 'Curso «Zcash desde cero»'],
    ['privacidad', 'Guía rápida de privacidad'],
    ['red', 'La red Zcash ahora'],
    ['nodos', 'Nodos públicos de la comunidad'],
    ['grafico', 'Gráfico de 72 horas'],
    ['alertas', 'Tus alertas de precio'],
    ['copia', '¿Es esto una copia? Compruébalo'],
    ['copias', 'Cómo detectar copias falsas'],
    ['comunidad', 'Vídeos y artículos de Zcash en Español'],
    ['dolares', 'Dólares digitales y compra entre particulares'],
    ['ajustes', 'Tu país, tu moneda y tus avisos'],
    ['opinion', 'Cuéntanos qué mejorar'],
    ['ayuda', 'Cómo funciona'],
    ...(canDonate ? [['donar', 'Apoya a Zblind con ZEC']] : []),
    ['terminos', 'Términos y privacidad'],
    ['borrar_mis_datos', 'Borrar tus datos'],
  ].map(([command, description]) => ({ command, description }));

  return { handleUpdate, commands };
}
