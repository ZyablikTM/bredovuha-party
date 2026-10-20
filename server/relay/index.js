// =============================================================================
// БРЕДОВУХА — сервер-пересыльщик для Yandex Cloud
// API Gateway держит WebSocket-соединения и на каждое сообщение вызывает эту функцию.
// Протокол похож на MQTT: клиент подписывается на топик и публикует в топик.
//   клиент → {"op":"sub","t":"<топик>"}                  подписка (повторять раз в ~30 с)
//   клиент → {"op":"pub","t":"<топик>","d":"<строка>","r":true}  публикация, r — запомнить
//   сервер → {"t":"<топик>","d":"<строка>"}               доставка
// Подписчики и последнее запомненное сообщение хранятся в YDB, одна строка на топик.
// =============================================================================
'use strict';

const { Driver, TokenAuthService, TypedValues, TypedData, Types, TableDescription, Column } = require('ydb-sdk');

const TABLE = 'topics';
const SUB_TTL_MS = 90 * 1000;              // подписка живёт, пока клиент её обновляет
const ROW_TTL = 'PT12H';                   // заброшенные комнаты удаляются сами
const MAX_TOPIC_LEN = 120;
const MAX_DATA_LEN = 100 * 1024;           // лимит API Gateway — 128 КБ на сообщение
const TOPIC_RE = /^[A-Za-z0-9_\-\/]+$/;
const SEND_URL = 'https://apigateway-connections.api.cloud.yandex.net/apigateways/websocket/v1/connections/';

// Токен сервисного аккаунта приходит с каждым вызовом; драйвер всегда берёт свежий.
let iamToken = '';
const authService = { getAuthMetadata: () => new TokenAuthService(iamToken).getAuthMetadata() };

let driverPromise = null;
function getDriver() {
  if (!driverPromise) {
    driverPromise = (async () => {
      const driver = new Driver({
        endpoint: process.env.YDB_ENDPOINT,
        database: process.env.YDB_DATABASE,
        authService
      });
      if (!(await driver.ready(10000))) throw new Error('YDB driver not ready');
      await driver.tableClient.withSessionRetry(async (s) => {
        try {
          await s.describeTable(TABLE);
        } catch (e) {
          const opt = t => Types.optional(t);
          await s.createTable(TABLE, new TableDescription()
            .withColumns(
              new Column('topic', opt(Types.UTF8)),
              new Column('subs', opt(Types.UTF8)),
              new Column('retained', opt(Types.UTF8)),
              new Column('exp', opt(Types.TIMESTAMP))
            )
            .withPrimaryKey('topic')
            .withTtl('exp', 0));
          console.log('table created');
        }
      });
      return driver;
    })().catch(e => { driverPromise = null; throw e; });
  }
  return driverPromise;
}

const DECLARE = `
  DECLARE $topic AS Utf8;
`;

async function readRow(session, topic) {
  const res = await session.executeQuery(
    `${DECLARE} SELECT subs, retained FROM ${TABLE} WHERE topic = $topic;`,
    { $topic: TypedValues.utf8(topic) }
  );
  const rows = TypedData.createNativeObjects(res.resultSets[0]);
  if (!rows.length) return { subs: {}, retained: null };
  let subs = {};
  try { subs = JSON.parse(rows[0].subs || '{}') || {}; } catch (e) {}
  return { subs, retained: rows[0].retained ?? null };
}

function pruneSubs(subs, now) {
  const out = {};
  for (const [c, t] of Object.entries(subs)) if (now - t < SUB_TTL_MS) out[c] = t;
  return out;
}

async function writeRow(session, topic, subs, retained) {
  await session.executeQuery(
    `${DECLARE}
     DECLARE $subs AS Utf8; DECLARE $retained AS Utf8?;
     UPSERT INTO ${TABLE} (topic, subs, retained, exp)
     VALUES ($topic, $subs, $retained, CurrentUtcTimestamp() + Interval("${ROW_TTL}"));`,
    {
      $topic: TypedValues.utf8(topic),
      $subs: TypedValues.utf8(JSON.stringify(subs)),
      $retained: retained == null ? TypedValues.optionalNull(Types.UTF8) : TypedValues.optional(TypedValues.utf8(retained))
    }
  );
}

async function sendTo(connId, text) {
  const res = await fetch(SEND_URL + encodeURIComponent(connId) + ':send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + iamToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: Buffer.from(text).toString('base64'), type: 'TEXT' })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`send ${res.status} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
}

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

// Диагностика для проверки после развёртывания: {"diag":1} → по шагам, сколько заняло и где упало
async function diagnose(context) {
  const t0 = Date.now();
  const steps = [];
  const step = (name, extra) => steps.push(`${name} +${Date.now() - t0}ms${extra ? ' ' + extra : ''}`);
  step('start', `token=${iamToken ? 'yes' : 'no'} ctxKeys=${Object.keys(context || {}).join('|')}`);
  try {
    const r = await fetch('https://ydb.serverless.yandexcloud.net:2135', { method: 'HEAD' }).catch(e => ({ status: 'ERR ' + e.message }));
    step('tcp-ydb', String(r.status));
    const driver = await Promise.race([getDriver(), new Promise((_, rej) => setTimeout(() => rej(new Error('driver timeout 20s')), 20000))]);
    step('driver-ready');
    const one = await driver.tableClient.withSessionRetry(s => s.executeQuery('SELECT 1 AS one;'), 15000, 1)
      .then(() => 'ok', e => (e && e.message || String(e)).slice(0, 200));
    step('select-1', one);
    const desc = await driver.tableClient.withSessionRetry(s => s.describeTable(TABLE), 15000, 1)
      .then(d => (d.columns || []).map(c => c.name).join(','), e => 'ERR ' + (e && e.message || String(e)).slice(0, 200));
    step('describe', desc);
    const plain = await driver.tableClient.withSessionRetry(async (s) => {
      try { await s.describeTable('diag_plain'); } catch (e) {
        await s.createTable('diag_plain', new TableDescription()
          .withColumns(new Column('k', Types.optional(Types.UTF8)), new Column('v', Types.optional(Types.UTF8)))
          .withPrimaryKey('k'));
      }
      await s.executeQuery('UPSERT INTO diag_plain (k, v) VALUES ("a", "b");');
      await s.executeQuery('SELECT v FROM diag_plain WHERE k = "a";');
    }, 15000, 1).then(() => 'ok', e => 'ERR ' + (e && e.message || String(e)).slice(0, 200));
    step('plain-table', plain);
    const count = await driver.tableClient.withSessionRetry(s => s.executeQuery(`SELECT COUNT(*) AS n FROM ${TABLE};`), 15000, 1)
      .then(() => 'ok', e => 'ERR ' + (e && e.message || String(e)).slice(0, 120));
    step('count-topics', count);
  } catch (e) {
    step('error', (e && (e.stack || e.message) || String(e)).slice(0, 600));
  }
  return reply({ steps });
}

let loggedEventShape = false;

module.exports.handler = async function (event, context) {
  iamToken = (context && context.token && context.token.access_token) || iamToken;
  if (!loggedEventShape) {
    loggedEventShape = true;
    console.log('event keys:', Object.keys(event || {}).join(','), 'rc:', JSON.stringify(event && event.requestContext || {}).slice(0, 400));
  }
  if (event && event.diag) return diagnose(context);
  const connId = getConnId(event);
  const rc = event.requestContext || {};
  if (rc.eventType && rc.eventType !== 'MESSAGE') return reply(null);   // CONNECT / DISCONNECT
  if (!connId) return reply({ err: 'no connection id' });

  let raw = event.body || '';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString();
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return reply({ err: 'bad json' }); }
  if (!msg || typeof msg !== 'object') return reply({ err: 'bad message' });
  if (msg.op === 'ping') return reply({ op: 'pong' });

  const topic = msg.t;
  if (typeof topic !== 'string' || topic.length > MAX_TOPIC_LEN || !TOPIC_RE.test(topic)) return reply({ err: 'bad topic' });

  const driver = await getDriver();
  const now = Date.now();

  if (msg.op === 'sub') {
    const retained = await driver.tableClient.withSessionRetry(async (s) => {
      const row = await readRow(s, topic);
      const subs = pruneSubs(row.subs, now);
      subs[connId] = now;
      await writeRow(s, topic, subs, row.retained);
      return row.retained;
    });
    // Тело ответа API Gateway сам доставит этому клиенту
    return reply(retained != null ? { t: topic, d: retained, sub: 1 } : { t: topic, sub: 1 });
  }

  if (msg.op === 'pub') {
    if (typeof msg.d !== 'string' || msg.d.length > MAX_DATA_LEN) return reply({ err: 'bad data' });
    const subs = await driver.tableClient.withSessionRetry(async (s) => {
      const row = await readRow(s, topic);
      const live = pruneSubs(row.subs, now);
      if (msg.r || Object.keys(live).length !== Object.keys(row.subs).length) {
        await writeRow(s, topic, live, msg.r ? msg.d : row.retained);
      }
      return live;
    });
    const text = JSON.stringify({ t: topic, d: msg.d });
    const targets = Object.keys(subs).filter(c => c !== connId);
    const results = await Promise.allSettled(targets.map(c => sendTo(c, text)));
    const gone = targets.filter((c, i) => results[i].status === 'rejected' && [400, 404].includes(results[i].reason.status));
    results.forEach((r, i) => { if (r.status === 'rejected' && !gone.includes(targets[i])) console.warn('send failed', targets[i], r.reason.message); });
    if (gone.length) {
      await driver.tableClient.withSessionRetry(async (s) => {
        const row = await readRow(s, topic);
        const live = pruneSubs(row.subs, Date.now());
        gone.forEach(c => delete live[c]);
        await writeRow(s, topic, live, row.retained);
      }).catch(e => console.warn('cleanup failed', e.message));
    }
    return reply(null);
  }

  return reply({ err: 'unknown op' });
};
