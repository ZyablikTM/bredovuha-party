// =============================================================================
// БРЕДОВУХА — сервер-пересыльщик для Yandex Cloud
// API Gateway держит WebSocket-соединения и на каждое сообщение вызывает эту функцию.
//
// Сервер не хранит игру: её по-прежнему хранит ведущий. Сервер помнит только,
// какое соединение у ведущего комнаты (крошечный файл в Object Storage):
//   ведущий → {"op":"host","t":"<топик to_host>"}       «я ведущий, шлите мне»
//   игрок   → {"op":"pub","t":"<топик to_host>","d":"…"}  сервер доставит ведущему,
//             ведущий получит {"t","d","from":"<соединение игрока>"}
//   ведущий → {"op":"pub","t":"<топик to_players>","d":"…","to":["<соединение>",…]}
//             сервер доставит перечисленным игрокам; в ответ {"gone":[…]} — кого уже нет
//   любой   → {"op":"ping"} → {"op":"pong"}
// =============================================================================
'use strict';

const BUCKET = process.env.BUCKET;
const STORAGE = 'https://storage.yandexcloud.net/';
const SEND_URL = 'https://apigateway-connections.api.cloud.yandex.net/apigateways/websocket/v1/connections/';
const MAX_TOPIC_LEN = 120;
const MAX_DATA_LEN = 100 * 1024;           // лимит API Gateway — 128 КБ на сообщение
const MAX_TARGETS = 20;
const HOST_CACHE_MS = 15000;               // сколько экземпляр функции помнит ведущего без перечитывания
const TOPIC_RE = /^[A-Za-z0-9_\-\/]+$/;
const CONN_RE = /^[A-Za-z0-9_\-.]{1,50}$/;

// Токен сервисного аккаунта приходит с каждым вызовом
let iamToken = '';
const hostCache = new Map();               // топик -> { conn, at }

function objectUrl(topic) {
  return STORAGE + BUCKET + '/hosts/' + encodeURIComponent(topic);
}

async function storageGet(topic) {
  const res = await fetch(objectUrl(topic), { headers: { 'X-YaCloud-SubjectToken': iamToken } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`storage get ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.text()).trim() || null;
}

async function storagePut(topic, conn) {
  const res = await fetch(objectUrl(topic), {
    method: 'PUT',
    headers: { 'X-YaCloud-SubjectToken': iamToken, 'Content-Type': 'text/plain' },
    body: conn
  });
  if (!res.ok) throw new Error(`storage put ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function getHost(topic) {
  const c = hostCache.get(topic);
  if (c && Date.now() - c.at < HOST_CACHE_MS) return c.conn;
  const conn = await storageGet(topic);
  hostCache.set(topic, { conn, at: Date.now() });
  return conn;
}

async function sendTo(connId, text) {
  const res = await fetch(SEND_URL + encodeURIComponent(connId) + ':send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + iamToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: Buffer.from(text).toString('base64'), type: 'TEXT' })
  });
  if (!res.ok) {
    const err = new Error(`send ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
}

const isGone = (e) => e && (e.status === 404 || e.status === 400 || e.status === 410);

function getConnId(event) {
  const rc = event.requestContext || {};
  if (rc.connectionId) return rc.connectionId;
  const h = event.headers || {};
  for (const k of Object.keys(h)) if (k.toLowerCase() === 'x-yc-apigateway-websocket-connection-id') return h[k];
  return null;
}

function reply(obj) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: obj ? JSON.stringify(obj) : ''
  };
}

// Проверка после развёртывания: {"diag":1} → работает ли хранилище
async function diagnose() {
  const t0 = Date.now();
  const steps = [];
  const step = (name, extra) => steps.push(`${name} +${Date.now() - t0}ms${extra ? ' ' + extra : ''}`);
  step('start', `token=${iamToken ? 'yes' : 'no'} bucket=${BUCKET}`);
  try {
    await storagePut('diag', 'diag-conn');
    step('put');
    step('get', await storageGet('diag'));
  } catch (e) {
    step('error', (e && e.message || String(e)).slice(0, 400));
  }
  return reply({ steps });
}

module.exports.handler = async function (event, context) {
  iamToken = (context && context.token && context.token.access_token) || iamToken;
  if (event && event.diag) return diagnose();

  const rc = event.requestContext || {};
  if (rc.eventType && rc.eventType !== 'MESSAGE') return reply(null);   // CONNECT / DISCONNECT
  const connId = getConnId(event);
  if (!connId) return reply({ err: 'no connection id' });

  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString();
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return reply({ err: 'bad json' }); }
  if (!msg || typeof msg !== 'object') return reply({ err: 'bad message' });
  if (msg.op === 'ping') return reply({ op: 'pong', id: msg.id });

  const topic = msg.t;
  if (typeof topic !== 'string' || topic.length > MAX_TOPIC_LEN || !TOPIC_RE.test(topic)) return reply({ err: 'bad topic' });

  if (msg.op === 'host') {
    const c = hostCache.get(topic);
    if (!c || c.conn !== connId || Date.now() - c.at > HOST_CACHE_MS) {
      const stored = await storageGet(topic);
      if (stored !== connId) await storagePut(topic, connId);
      hostCache.set(topic, { conn: connId, at: Date.now() });
    }
    return reply({ op: 'hosted', t: topic, conn: connId });
  }

  if (msg.op === 'pub') {
    if (typeof msg.d !== 'string' || msg.d.length > MAX_DATA_LEN) return reply({ err: 'bad data' });

    // Ведущий рассылает игрокам: адресаты перечислены явно
    if (Array.isArray(msg.to)) {
      const targets = msg.to.filter(c => typeof c === 'string' && CONN_RE.test(c) && c !== connId).slice(0, MAX_TARGETS);
      const text = JSON.stringify({ t: topic, d: msg.d });
      const results = await Promise.allSettled(targets.map(c => sendTo(c, text)));
      const gone = targets.filter((c, i) => results[i].status === 'rejected' && isGone(results[i].reason));
      results.forEach((r, i) => { if (r.status === 'rejected' && !isGone(r.reason)) console.warn('send failed', targets[i], r.reason.message); });
      return reply(gone.length ? { op: 'gone', t: topic, gone } : null);
    }

    // Игрок пишет ведущему
    const text = JSON.stringify({ t: topic, d: msg.d, from: connId });
    let host = await getHost(topic);
    if (!host) return reply({ op: 'nohost', t: topic });
    try {
      await sendTo(host, text);
    } catch (e) {
      if (!isGone(e)) throw e;
      // Ведущий переподключился: перечитываем, вдруг у него уже новое соединение
      hostCache.delete(topic);
      const fresh = await getHost(topic);
      if (!fresh || fresh === host) return reply({ op: 'nohost', t: topic });
      await sendTo(fresh, text).catch(() => {});
    }
    return reply(null);
  }

  return reply({ err: 'unknown op' });
};
