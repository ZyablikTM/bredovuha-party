// =============================================================================
// БРЕДОВУХА — движок игры
// Сеть: два MQTT-брокера одновременно + BroadcastChannel (вкладки одного браузера).
// Ведущий хранит всё состояние и рассылает его игрокам (STATE_SYNC, retained);
// игроки шлют пронумерованные действия, ведущий подтверждает их через lastSeq.
// =============================================================================
(function () {
  'use strict';

  // ===========================================================================
  // ДАННЫЕ
  // ===========================================================================
  const PACKS = window.BRED_PACKS || [];
  const ALL_Q = [];
  const Q_BY_ID = {};
  PACKS.forEach(pack => pack.questions.forEach(q => {
    q.packId = pack.id;
    ALL_Q.push(q);
    Q_BY_ID[q.id] = q;
  }));

  // ===========================================================================
  // НАСТРОЙКИ
  // ===========================================================================
  const NET_NS = 'bredovuha_v1';
  const MQTT_BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt'
  ];
  const HOST_HEARTBEAT_MS = 4000;   // ведущий повторно рассылает состояние
  const PLAYER_PING_MS = 4000;      // игрок сообщает «я на связи»
  const OFFLINE_AFTER_MS = 13000;   // без сигнала дольше — считаем офлайн
  const ACTION_RETRY_MS = 1500;     // повтор неподтверждённого действия
  const HOST_SAVE_KEY = 'bred_host_session_v1';
  const PLAYER_SAVE_KEY = 'bred_player_session_v1';
  const HOST_SAVE_TTL_MS = 12 * 60 * 60 * 1000;
  const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ROOM_CODE_LEN = 4;
  const PLAYER_ID_RE = /^[A-Za-z0-9_-]{3,40}$/;
  const AVATARS = ['🦊', '🐸', '🐼', '🐙', '🦄', '🐯', '🐵', '🐧', '🦉', '🐲', '🐨', '🦖', '🐷', '🐰', '🦀', '👽'];
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 12;
  const LIE_MAX_LEN = 40;
  const MIN_OPTIONS = 4;          // вариантов на голосовании (вместе с правдой) не меньше этого
  const REVEAL_LIE_MS = 4500;
  const REVEAL_TRUTH_MS = 9000;
  const PTS = { truth: 1000, fooled: 500, bluff: 500, like: 100 };
  const TRUTH_HIT_MSG = '🎯 Ты угадал настоящую правду! Придумай ложь, чтобы запутать друзей';

  // ===========================================================================
  // УТИЛИТЫ
  // ===========================================================================
  function makeStore(getStore) {
    return {
      get(k) { try { return getStore().getItem(k); } catch (e) { return null; } },
      set(k, v) { try { getStore().setItem(k, v); } catch (e) {} },
      del(k) { try { getStore().removeItem(k); } catch (e) {} }
    };
  }
  const lstore = makeStore(() => window.localStorage);
  const sstore = makeStore(() => window.sessionStorage);

  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function randInt(n) {
    if (window.crypto && crypto.getRandomValues) {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return buf[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  function randomString(len, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
    let s = '';
    for (let i = 0; i < len; i++) s += alphabet[randInt(alphabet.length)];
    return s;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function normalizeRoomCode(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LEN);
  }

  function sanitizeName(s) {
    return String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  }

  // Ложь в виде для показа: без лишних пробелов и точки в конце, с заглавной буквы
  function cleanLie(s) {
    let t = String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    t = t.replace(/[.!?…]+$/, '').trim().slice(0, LIE_MAX_LEN);
    return t;
  }

  function displayCase(s) {
    const t = String(s || '');
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString('ru-RU');
  }

  // FNV-1a: короткий хэш для «меток авторства» вариантов
  function hash8(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function showToast(msg, kind = 'info') {
    const box = $('toast-box');
    if (!box) return;
    const colors = {
      info: 'bg-violet-900/95 border-violet-500 text-violet-50',
      ok: 'bg-emerald-600/95 border-emerald-300 text-white',
      warn: 'bg-amber-400/95 border-amber-200 text-slate-950',
      error: 'bg-rose-700/95 border-rose-300 text-white'
    };
    const el = document.createElement('div');
    el.className = `px-4 py-2.5 rounded-xl border shadow-2xl text-sm font-semibold text-center transition-opacity duration-300 ${colors[kind] || colors.info}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; }, 2800);
    setTimeout(() => el.remove(), 3200);
  }

  // ===========================================================================
  // TRUTH GUARD: проверка, не вписал ли игрок настоящий ответ
  // ===========================================================================
  function normText(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[-‐–—_/]/g, ' ')
      .replace(/[^a-zа-я0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function asNumber(s) {
    const t = String(s || '').trim().replace(/\s+/g, '').replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function isTooCloseToTruth(text, q) {
    const n = normText(text);
    if (!n || !q) return false;
    const nNum = asNumber(text);
    const candidates = [q.answer, ...(q.synonyms || [])];
    for (const c of candidates) {
      const cNum = asNumber(c);
      if (nNum !== null && cNum !== null) {
        if (Math.abs(nNum - cNum) < 1e-9) return true;
        continue;
      }
      const nc = normText(c);
      if (!nc) continue;
      if (n === nc) return true;
      if (nNum !== null || cNum !== null) continue;
      // Порог зависит от длины: короткие ответы сравниваются строго («кот» ≠ «кит»)
      const threshold = nc.length <= 3 ? 0 : (nc.length <= 6 ? 1 : 2);
      if (threshold > 0 && levenshtein(n, nc) <= threshold) return true;
    }
    // Ложь, целиком содержащая правильный ответ («длинный мост» при ответе «мост»)
    const main = normText(q.answer);
    if (main.length >= 4 && (' ' + n + ' ').includes(' ' + main + ' ')) return true;
    return false;
  }

  function questionHtml(q, revealAnswer) {
    if (!q) return '';
    const parts = escapeHtml(q.questionText).split('______');
    const fill = revealAnswer
      ? `<span class="filled">${escapeHtml(q.answer)}</span>`
      : '<span class="blank">______</span>';
    return parts.join(fill);
  }

  // ===========================================================================
  // ЗВУК (Web Audio API, только синтез)
  // ===========================================================================
  const Sound = {
    enabled: lstore.get('bred_sound') !== 'off',
    ctx: null,
    ensure() {
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) {}
      return this.ctx;
    },
    tone(freq, dur = 0.12, type = 'sine', vol = 0.08, delay = 0, slideTo = null) {
      if (!this.enabled) return;
      const ctx = this.ensure();
      if (!ctx) return;
      try {
        const t0 = ctx.currentTime + delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t0);
        if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + dur + 0.02);
      } catch (e) {}
    },
    join() { this.tone(660, 0.12, 'triangle'); this.tone(990, 0.18, 'triangle', 0.08, 0.1); },
    tick() { this.tone(1250, 0.05, 'square', 0.035); },
    submit() { this.tone(380, 0.18, 'sine', 0.07, 0, 1200); },
    pop() { this.tone(880, 0.07, 'sine', 0.06); },
    drumroll() {
      for (let i = 0; i < 18; i++) this.tone(i % 2 ? 140 : 120, 0.05, 'triangle', 0.05 + i * 0.004, i * 0.055);
    },
    fail() { this.tone(392, 0.28, 'sawtooth', 0.045); this.tone(330, 0.28, 'sawtooth', 0.045, 0.28); this.tone(262, 0.55, 'sawtooth', 0.045, 0.56); },
    fanfare() {
      [523, 659, 784].forEach((f, i) => this.tone(f, 0.16, 'square', 0.05, i * 0.13));
      this.tone(1047, 0.6, 'square', 0.06, 0.42);
      this.tone(784, 0.6, 'triangle', 0.05, 0.42);
    },
    start() { [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.06, i * 0.08)); }
  };

  function renderSoundButton() {
    $('sound-icon').textContent = Sound.enabled ? '🔊' : '🔇';
    $('sound-label').textContent = Sound.enabled ? 'Звук' : 'Без звука';
  }

  window.toggleSound = function () {
    Sound.enabled = !Sound.enabled;
    lstore.set('bred_sound', Sound.enabled ? 'on' : 'off');
    renderSoundButton();
    Sound.pop();
  };

  // Браузеры разрешают звук только после жеста пользователя
  document.addEventListener('pointerdown', () => Sound.ensure(), { once: true });

  // ===========================================================================
  // ВКЛАДКИ И МОДАЛКИ
  // ===========================================================================
  window.switchMode = function (mode) {
    ['online', 'catalog'].forEach(m => {
      $('view-' + m).classList.toggle('hidden', m !== mode);
      $('tab-' + m).className = 'px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold transition ' +
        (m === mode ? 'bg-gradient-to-r from-pink-500 to-violet-600 text-white shadow' : 'text-violet-200 hover:text-white hover:bg-violet-900/60');
    });
    if (mode === 'catalog') renderCatalog();
  };

  window.toggleQrModal = function (show) {
    $('qr-modal').classList.toggle('hidden', !show);
  };
  $('qr-modal').addEventListener('click', (ev) => {
    if (ev.target.id === 'qr-modal') window.toggleQrModal(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') window.toggleQrModal(false);
  });

  // ===========================================================================
  // СОСТОЯНИЕ
  // ===========================================================================
  let mpRole = null;            // 'host' | 'player' | null
  let roomCode = null;

  // ID и секретный ключ игрока живут в sessionStorage: переживают перезагрузку вкладки,
  // но у каждой вкладки свои — можно тестировать несколько игроков в одном браузере
  let myPlayerId = sstore.get('bred_pid_v1');
  if (!myPlayerId || !PLAYER_ID_RE.test(myPlayerId)) {
    myPlayerId = 'p_' + randomString(10);
    sstore.set('bred_pid_v1', myPlayerId);
  }
  let myKey = sstore.get('bred_key_v1');
  if (!myKey || myKey.length < 8) {
    myKey = randomString(16);
    sstore.set('bred_key_v1', myKey);
  }
  let myName = '';
  let myAvatar = AVATARS[0];

  const net = { mqtt: [], mqttWaitTimer: null, bc: null };
  let tickTimer = null;

  // Только у ведущего
  const lastSeen = {};
  let hostBootAt = 0;
  let lastBroadcastAt = 0;
  let broadcastTimer = null;
  let wakeLock = null;

  // Только у игрока
  let knownSession = null;
  let lastStateV = -1;
  let lastHostContact = 0;
  let lastJoinSentAt = 0;
  let lastPingAt = 0;
  let clockOffset = 0;          // время ведущего минус локальное
  let actionQueue = [];
  let inFlight = null;
  let playerHalted = null;      // 'kicked' | 'closed' | null
  let local = freshLocal();     // локальные данные игрока по текущей игре

  function freshLocal() {
    return {
      lies: {},                 // stage -> { text, auto }
      votes: {},                // stage -> oid
      likes: {},                // stage -> oid
      pendingLie: null,         // stage, пока ведущий не подтвердил ложь
      pendingVote: null,
      knownRejects: null,
      lieError: '',
      lastStage: null,
      lastPhase: null,
      lastRevealStep: null
    };
  }

  function freshGameState(opts = {}) {
    const rounds = opts.rounds || 5;
    return {
      roomCode: opts.roomCode || '',
      sessionId: 's_' + randomString(12),
      createdAt: Date.now(),
      v: 0,
      stage: 0,
      phase: 'LOBBY',
      settings: {
        packId: opts.packId || 0,
        rounds,
        lieSec: opts.lieSec || 45,
        voteSec: opts.voteSec || 30
      },
      round: 0,
      totalRounds: rounds + 1,
      isFinal: false,
      qid: null,
      deadline: 0,
      hostNow: 0,
      usedQ: [],
      players: {},
      hostPid: null,            // ID игрока-ведущего, если ведущий тоже играет
      kicked: [],
      options: null,
      reveal: null,
      lastDeltas: null,
      secret: { keys: {}, lies: {}, votes: {}, likes: {}, optionsFull: [] }
    };
  }

  let gameState = freshGameState();

  function topicFor(dir, code = roomCode) {
    return `${NET_NS}/${code}/${dir}`;
  }

  function serverNow() {
    return mpRole === 'host' ? Date.now() : Date.now() + clockOffset;
  }

  function currentQuestion() {
    return gameState.qid ? Q_BY_ID[gameState.qid] : null;
  }

  function sortedPlayers(st = gameState) {
    return Object.values(st.players || {}).sort((a, b) => (b.score - a.score) || ((a.joinedAt || 0) - (b.joinedAt || 0)));
  }

  // ===========================================================================
  // ТРАНСПОРТЫ: MQTT (2 брокера) + BroadcastChannel
  // ===========================================================================
  function setupMqtt() {
    clearTimeout(net.mqttWaitTimer);
    if (typeof mqtt === 'undefined') {
      net.mqttWaitTimer = setTimeout(setupMqtt, 500);
      return;
    }
    const role = mpRole;
    const code = roomCode;
    MQTT_BROKERS.forEach(url => {
      let client;
      try {
        client = mqtt.connect(url, {
          keepalive: 30,
          reconnectPeriod: 3000,
          connectTimeout: 10000,
          clean: true,
          clientId: 'bred_' + randomString(12)
        });
      } catch (e) {
        return;
      }
      net.mqtt.push({ client, url });

      client.on('connect', () => {
        if (mpRole !== role || roomCode !== code) return;
        if (role === 'host') {
          client.subscribe(topicFor('to_host', code), { qos: 1 });
          // retained: только что вошедший игрок сразу получает актуальное состояние
          try { client.publish(topicFor('to_players', code), JSON.stringify(statePacket()), { qos: 1, retain: true }); } catch (e) {}
        } else {
          client.subscribe(topicFor('to_players', code), { qos: 1 });
          sendJoin();
        }
        updateNetStatus();
      });
      client.on('message', (topic, payload) => {
        if (!payload || !payload.length) return;
        let data;
        try { data = JSON.parse(payload.toString()); } catch (e) { return; }
        handleIncomingMessage(data);
      });
      client.on('close', updateNetStatus);
      client.on('offline', updateNetStatus);
      client.on('error', () => {});
    });
  }

  function mqttPublish(topic, msg, opts) {
    const payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
    net.mqtt.forEach(({ client }) => {
      if (client.connected) {
        try { client.publish(topic, payload, opts); } catch (e) {}
      }
    });
  }

  function mqttConnectedCount() {
    return net.mqtt.filter(m => m.client.connected).length;
  }

  function setupBroadcast() {
    try {
      if ('BroadcastChannel' in window) {
        net.bc = new BroadcastChannel(NET_NS + '_' + roomCode);
        net.bc.onmessage = (ev) => handleIncomingMessage(ev.data);
      }
    } catch (e) {}
  }

  function teardownNet(delayMs = 0) {
    clearTimeout(net.mqttWaitTimer);
    const clients = net.mqtt.map(m => m.client);
    const bc = net.bc;
    net.mqtt = [];
    net.bc = null;
    const close = () => {
      clients.forEach(c => { try { c.end(false); } catch (e) {} });
      try { if (bc) bc.close(); } catch (e) {}
    };
    if (delayMs > 0) setTimeout(close, delayMs); else close();
  }

  function reconnectTransports() {
    teardownNet();
    setupBroadcast();
    setupMqtt();
  }

  function startTick(fn, ms) {
    stopTick();
    tickTimer = setInterval(fn, ms);
  }

  function stopTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  function handleIncomingMessage(data) {
    if (!data || typeof data !== 'object' || !data.type) return;
    if (data.room !== roomCode) return;
    if (mpRole === 'host') hostHandleMessage(data);
    else if (mpRole === 'player') playerHandleMessage(data);
  }

  function updateNetStatus() {
    if (mpRole === 'host') renderHostNetStatus();
    else if (mpRole === 'player') renderPlayerConn();
  }

  // Возврат на вкладку / восстановление сети: мобильные браузеры рвут сокеты в фоне
  function onResume() {
    if (mpRole === 'player' && !playerHalted) {
      if (mqttConnectedCount() === 0 || Date.now() - lastHostContact > 6000) reconnectTransports();
      sendJoin();
      if (inFlight) inFlight.sentAt = 0;
    } else if (mpRole === 'host') {
      if (mqttConnectedCount() === 0) reconnectTransports();
      requestWakeLock();
      broadcastNow();
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onResume();
  });
  window.addEventListener('online', onResume);

  async function requestWakeLock() {
    try {
      if (mpRole === 'host' && 'wakeLock' in navigator && document.visibilityState === 'visible') {
        wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (e) {}
  }

  // ===========================================================================
  // ВЕДУЩИЙ: приём сообщений
  // ===========================================================================
  function isPlayerOnline(pid, now = Date.now()) {
    if (pid === gameState.hostPid) return true;
    const t = lastSeen[pid] ?? hostBootAt;
    return now - t < OFFLINE_AFTER_MS;
  }

  function touch(pid) {
    const wasOnline = isPlayerOnline(pid);
    lastSeen[pid] = Date.now();
    return !wasOnline;
  }

  function hostHandleMessage(data) {
    const pid = data.playerId;
    if (typeof pid !== 'string' || !PLAYER_ID_RE.test(pid)) return;
    switch (data.type) {
      case 'PLAYER_JOIN':
        hostOnJoin(pid, data);
        break;
      case 'PING':
        if (gameState.players[pid] && touch(pid)) scheduleBroadcast();
        break;
      case 'PLAYER_LEAVE':
        if (gameState.players[pid]) {
          lastSeen[pid] = 0;
          scheduleBroadcast();
        }
        break;
      case 'PLAYER_ACTION':
        hostOnAction(pid, data);
        break;
    }
  }

  function pickAvatar(wanted, pid) {
    const taken = new Set(Object.values(gameState.players).filter(p => p.id !== pid).map(p => p.avatar));
    if (AVATARS.includes(wanted) && !taken.has(wanted)) return wanted;
    return AVATARS.find(a => !taken.has(a)) || wanted || AVATARS[0];
  }

  function uniqueName(name, pid) {
    const taken = new Set(Object.values(gameState.players).filter(p => p.id !== pid).map(p => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; i < 100; i++) {
      const candidate = `${name.slice(0, 12)} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return name;
  }

  function hostOnJoin(pid, data) {
    if (gameState.kicked.includes(pid)) {
      scheduleBroadcast();
      return;
    }
    const name = sanitizeName(data.name) || 'Игрок';
    const key = typeof data.key === 'string' ? data.key.slice(0, 40) : '';
    const existing = gameState.players[pid];

    if (existing) {
      touch(pid);
      if (existing.name !== name) existing.name = uniqueName(name, pid);
      if (data.avatar && data.avatar !== existing.avatar) existing.avatar = pickAvatar(data.avatar, pid);
      if (key) gameState.secret.keys[pid] = key;
      scheduleBroadcast();
      return;
    }

    // Игрок вернулся с другого устройства: забираем его офлайн-место с тем же именем
    const lower = name.toLowerCase();
    const ghost = Object.values(gameState.players).find(p => p.name.toLowerCase() === lower && !isPlayerOnline(p.id));
    if (ghost) {
      const oldId = ghost.id;
      delete gameState.players[oldId];
      delete lastSeen[oldId];
      ghost.id = pid;
      gameState.players[pid] = ghost;
      const s = gameState.secret;
      ['lies', 'votes', 'likes'].forEach(k => {
        if (s[k][oldId] !== undefined) { s[k][pid] = s[k][oldId]; delete s[k][oldId]; }
      });
      s.optionsFull.forEach(o => {
        o.authors = o.authors.map(a => a === oldId ? pid : a);
        o.autoAuthors = o.autoAuthors.map(a => a === oldId ? pid : a);
      });
      if (key) s.keys[pid] = key;
      delete s.keys[oldId];
      refreshOptionMarks();
      touch(pid);
      Sound.join();
      scheduleBroadcast();
      return;
    }

    if (Object.keys(gameState.players).length >= MAX_PLAYERS) {
      scheduleBroadcast();
      return;
    }

    gameState.players[pid] = {
      id: pid,
      name: uniqueName(name, pid),
      avatar: pickAvatar(data.avatar, pid),
      score: 0,
      likes: 0,
      rejects: 0,
      lastSeq: 0,
      joinedAt: Date.now()
    };
    if (key) gameState.secret.keys[pid] = key;
    touch(pid);
    Sound.join();
    scheduleBroadcast();
  }

  // Действия игрока нумеруются (seq): ведущий применяет каждое ровно один раз,
  // а lastSeq в состоянии служит подтверждением
  function hostOnAction(pid, data) {
    const p = gameState.players[pid];
    if (!p) return;
    touch(pid);
    const seq = Number(data.seq);
    if (!Number.isInteger(seq) || seq <= (p.lastSeq || 0)) {
      if (Date.now() - lastBroadcastAt > 1000) scheduleBroadcast();
      return;
    }
    p.lastSeq = seq;
    if (data.stage === gameState.stage) {
      if (data.kind === 'lie') applyLie(p, data);
      else if (data.kind === 'vote') applyVote(p, data.oid);
      else if (data.kind === 'like') applyLike(p, data.oid);
    }
    scheduleBroadcast();
  }

  function applyLie(p, data) {
    const s = gameState.secret;
    if (gameState.phase !== 'LIE' || s.lies[p.id]) return;
    const q = currentQuestion();
    if (!q) return;
    if (data.auto) {
      const want = normText(data.text);
      const fake = q.fakeLies.find(f => normText(f) === want) || pickFakeLie(q);
      s.lies[p.id] = { text: fake, auto: true };
    } else {
      const text = cleanLie(data.text);
      if (!text || isTooCloseToTruth(text, q)) {
        p.rejects = (p.rejects || 0) + 1;
        return;
      }
      s.lies[p.id] = { text, auto: false };
    }
    Sound.submit();
  }

  function applyVote(p, oid) {
    const s = gameState.secret;
    if (gameState.phase !== 'VOTE' || s.votes[p.id]) return;
    const o = s.optionsFull.find(x => x.oid === oid);
    if (!o || o.authors.includes(p.id)) return;
    s.votes[p.id] = oid;
    Sound.pop();
  }

  function applyLike(p, oid) {
    const s = gameState.secret;
    if (gameState.phase !== 'VOTE' || s.likes[p.id]) return;
    const o = s.optionsFull.find(x => x.oid === oid);
    if (!o || o.authors.includes(p.id)) return;
    s.likes[p.id] = oid;
  }

  // ===========================================================================
  // ВЕДУЩИЙ: рассылка состояния
  // ===========================================================================
  // Секреты (тексты лжи до голосования, голоса, авторство) не уходят в сеть до вскрытия
  function buildPublicState() {
    const now = Date.now();
    const s = gameState.secret;
    const players = {};
    Object.values(gameState.players).forEach(p => {
      players[p.id] = {
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        score: p.score,
        likes: p.likes,
        rejects: p.rejects || 0,
        lastSeq: p.lastSeq || 0,
        joinedAt: p.joinedAt,
        hasLie: !!s.lies[p.id],
        hasVote: !!s.votes[p.id],
        liked: !!s.likes[p.id],
        online: isPlayerOnline(p.id, now)
      };
    });
    const { secret, ...pub } = gameState;
    return { ...pub, players, hostNow: now };
  }

  function statePacket() {
    return { type: 'STATE_SYNC', room: roomCode, state: buildPublicState() };
  }

  function scheduleBroadcast() {
    if (mpRole !== 'host' || broadcastTimer) return;
    broadcastTimer = setTimeout(broadcastNow, 40);
  }

  function broadcastNow() {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
    if (mpRole !== 'host') return;
    gameState.v++;
    lastBroadcastAt = Date.now();
    const packet = statePacket();
    if (net.bc) {
      try { net.bc.postMessage(packet); } catch (e) {}
    }
    mqttPublish(topicFor('to_players'), packet, { qos: 1, retain: true });
    saveHostSession();
    renderHost();
  }

  function saveHostSession() {
    if (mpRole !== 'host') return;
    lstore.set(HOST_SAVE_KEY, JSON.stringify({ savedAt: Date.now(), state: gameState }));
  }

  function loadHostSession() {
    try {
      const saved = JSON.parse(lstore.get(HOST_SAVE_KEY) || 'null');
      if (!saved || !saved.state || !saved.state.roomCode) return null;
      if (Date.now() - saved.savedAt > HOST_SAVE_TTL_MS) {
        lstore.del(HOST_SAVE_KEY);
        return null;
      }
      return saved;
    } catch (e) {
      return null;
    }
  }

  function hostTick() {
    if (mpRole !== 'host') return;
    const now = Date.now();
    const st = gameState;

    if (st.phase === 'LIE') {
      const online = Object.values(st.players).filter(p => isPlayerOnline(p.id, now));
      const allIn = online.length > 0 && online.every(p => st.secret.lies[p.id]);
      if (allIn || now >= st.deadline) toVote();
    } else if (st.phase === 'VOTE') {
      const online = Object.values(st.players).filter(p => isPlayerOnline(p.id, now));
      const allIn = online.length > 0 && online.every(p => st.secret.votes[p.id]);
      if (allIn || now >= st.deadline) toReveal();
    } else if (st.phase === 'REVEAL' && st.reveal && now >= st.reveal.nextAt) {
      advanceReveal();
    }

    // Пульс: состояние регулярно повторяется — потерянные пакеты и онлайн-статусы восстанавливаются сами
    if (Date.now() - lastBroadcastAt >= HOST_HEARTBEAT_MS) broadcastNow();
    renderHostNetStatus();
  }

  // ===========================================================================
  // ВЕДУЩИЙ: игровой цикл
  // ===========================================================================
  function questionPool(packId) {
    return packId ? ALL_Q.filter(q => q.packId === packId) : ALL_Q;
  }

  function pickQuestion() {
    const pool = questionPool(gameState.settings.packId);
    let fresh = pool.filter(q => !gameState.usedQ.includes(q.id));
    if (!fresh.length) {
      const ids = new Set(pool.map(q => q.id));
      gameState.usedQ = gameState.usedQ.filter(id => !ids.has(id));
      fresh = pool;
    }
    const q = fresh[randInt(fresh.length)];
    gameState.usedQ.push(q.id);
    return q;
  }

  function pickFakeLie(q, takenNorm = new Set()) {
    const free = q.fakeLies.filter(f => !takenNorm.has(normText(f)));
    const list = free.length ? free : q.fakeLies;
    return list[randInt(list.length)];
  }

  function resetRoundSecrets() {
    const keys = gameState.secret.keys;
    gameState.secret = { keys, lies: {}, votes: {}, likes: {}, optionsFull: [] };
    gameState.options = null;
    gameState.reveal = null;
  }

  function startQuestion() {
    gameState.round++;
    gameState.isFinal = gameState.round === gameState.totalRounds;
    gameState.qid = pickQuestion().id;
    resetRoundSecrets();
    gameState.lastDeltas = null;
    gameState.phase = 'LIE';
    gameState.stage++;
    gameState.deadline = Date.now() + gameState.settings.lieSec * 1000;
    Sound.start();
    broadcastNow();
  }

  function refreshOptionMarks() {
    const s = gameState.secret;
    if (!gameState.options || !s.optionsFull.length) return;
    gameState.options = s.optionsFull.map(o => ({
      oid: o.oid,
      text: o.text,
      marks: o.authors.map(pid => hash8((s.keys[pid] || pid) + ':' + o.oid))
    }));
  }

  function toVote() {
    const st = gameState;
    const s = st.secret;
    const q = currentQuestion();
    if (st.phase !== 'LIE' || !q) return;

    // Кто не успел — получает ложь от игры (со штрафом как за «Придумать за меня»)
    const taken = new Set(Object.values(s.lies).map(l => normText(l.text)));
    Object.values(st.players).forEach(p => {
      if (!s.lies[p.id]) {
        const text = pickFakeLie(q, taken);
        taken.add(normText(text));
        s.lies[p.id] = { text, auto: true, forced: true };
      }
    });

    // Одинаковая ложь от разных игроков — один вариант с несколькими авторами
    const groups = new Map();
    Object.entries(s.lies).forEach(([pid, lie]) => {
      if (!st.players[pid]) return;
      const key = normText(lie.text);
      if (!groups.has(key)) {
        groups.set(key, { oid: 'o' + randomString(6), text: displayCase(lie.text), truth: false, authors: [], autoAuthors: [] });
      }
      const g = groups.get(key);
      g.authors.push(pid);
      if (lie.auto) g.autoAuthors.push(pid);
    });
    // Мало игроков или совпавшие ответы — добавляем ложь от игры, чтобы правда не бросалась в глаза
    const houseLies = shuffle(q.fakeLies).filter(f => !groups.has(normText(f)));
    while (groups.size + 1 < MIN_OPTIONS && houseLies.length) {
      const f = houseLies.shift();
      groups.set(normText(f), { oid: 'o' + randomString(6), text: displayCase(f), truth: false, authors: [], autoAuthors: [] });
    }
    const truth = { oid: 'o' + randomString(6), text: displayCase(q.answer), truth: true, authors: [], autoAuthors: [] };
    s.optionsFull = shuffle([...groups.values(), truth]);
    st.options = [];
    refreshOptionMarks();

    st.phase = 'VOTE';
    st.stage++;
    st.deadline = Date.now() + st.settings.voteSec * 1000;
    Sound.submit();
    broadcastNow();
  }

  function toReveal() {
    const st = gameState;
    const s = st.secret;
    const q = currentQuestion();
    if (st.phase !== 'VOTE' || !q) return;
    const mult = st.isFinal ? 2 : 1;

    const deltas = {};
    const add = (pid, pts, label) => {
      if (!st.players[pid] || !pts) return;
      if (!deltas[pid]) deltas[pid] = { total: 0, parts: [] };
      deltas[pid].total += pts;
      deltas[pid].parts.push(`${label} +${fmt(pts)}`);
    };

    const votersByOid = {};
    Object.entries(s.votes).forEach(([pid, oid]) => {
      if (!st.players[pid]) return;
      (votersByOid[oid] = votersByOid[oid] || []).push(pid);
    });
    const allVoters = Object.keys(s.votes).filter(pid => st.players[pid]);
    const likesByOid = {};
    Object.entries(s.likes).forEach(([pid, oid]) => {
      if (!st.players[pid]) return;
      (likesByOid[oid] = likesByOid[oid] || []).push(pid);
    });

    const authorPts = {};   // oid -> pid -> очки за этот вариант (для анимации вскрытия)
    s.optionsFull.forEach(o => {
      const voters = votersByOid[o.oid] || [];
      if (o.truth) {
        voters.forEach(v => add(v, PTS.truth * mult, '🎯 правда'));
        return;
      }
      authorPts[o.oid] = {};
      const others = allVoters.filter(v => !o.authors.includes(v));
      o.authors.forEach(a => {
        const factor = o.autoAuthors.includes(a) ? 0.5 : 1;
        let got = 0;
        if (voters.length) {
          const pts = Math.round(PTS.fooled * mult * factor * voters.length);
          add(a, pts, `🎭 обманул ×${voters.length}`);
          got += pts;
        }
        // «Мастер блефа»: ложь выбрали все остальные проголосовавшие, и их минимум двое
        if (voters.length >= 2 && voters.length === others.length) {
          add(a, PTS.bluff, '👑 мастер блефа');
          got += PTS.bluff;
        }
        authorPts[o.oid][a] = got;
      });
      (likesByOid[o.oid] || []).forEach(liker => {
        o.authors.forEach(a => {
          if (a === liker) return;
          add(a, PTS.like, '👍 лайк');
          st.players[a].likes = (st.players[a].likes || 0) + 1;
        });
      });
    });

    Object.entries(deltas).forEach(([pid, d]) => { st.players[pid].score += d.total; });

    // Шаги вскрытия: сначала лжи, в которые кто-то поверил (по возрастанию голосов), затем правда
    const steps = [];
    s.optionsFull
      .filter(o => !o.truth && (votersByOid[o.oid] || []).length > 0)
      .sort((a, b) => (votersByOid[a.oid].length - votersByOid[b.oid].length))
      .forEach(o => steps.push({
        kind: 'lie',
        oid: o.oid,
        text: o.text,
        voters: votersByOid[o.oid],
        authors: o.authors,
        autoAuthors: o.autoAuthors,
        pts: authorPts[o.oid] || {}
      }));
    const truth = s.optionsFull.find(o => o.truth);
    steps.push({ kind: 'truth', oid: truth.oid, text: truth.text, voters: votersByOid[truth.oid] || [] });

    st.reveal = {
      steps,
      step: 0,
      nextAt: Date.now() + (steps[0].kind === 'truth' ? REVEAL_TRUTH_MS : REVEAL_LIE_MS),
      options: s.optionsFull.map(o => ({
        oid: o.oid,
        text: o.text,
        truth: o.truth,
        authors: o.authors,
        voters: votersByOid[o.oid] || [],
        likes: (likesByOid[o.oid] || []).length
      }))
    };
    st.lastDeltas = deltas;
    st.phase = 'REVEAL';
    st.stage++;
    broadcastNow();
  }

  function advanceReveal() {
    const st = gameState;
    if (st.phase !== 'REVEAL' || !st.reveal) return;
    if (st.reveal.step >= st.reveal.steps.length - 1) {
      toScores();
      return;
    }
    st.reveal.step++;
    const cur = st.reveal.steps[st.reveal.step];
    st.reveal.nextAt = Date.now() + (cur.kind === 'truth' ? REVEAL_TRUTH_MS : REVEAL_LIE_MS);
    broadcastNow();
  }

  function toScores() {
    gameState.phase = 'SCORES';
    gameState.stage++;
    broadcastNow();
  }

  function toFinal() {
    gameState.phase = 'FINAL';
    gameState.stage++;
    Sound.fanfare();
    broadcastNow();
  }

  window.hostStartGame = function () {
    if (mpRole !== 'host') return;
    const count = Object.keys(gameState.players).length;
    if (count < MIN_PLAYERS) {
      showToast(`Нужно хотя бы ${MIN_PLAYERS} игрока`, 'warn');
      return;
    }
    Object.values(gameState.players).forEach(p => { p.score = 0; p.likes = 0; });
    gameState.round = 0;
    gameState.totalRounds = gameState.settings.rounds + 1;
    startQuestion();
  };

  window.hostSkip = function () {
    if (mpRole !== 'host') return;
    const ph = gameState.phase;
    if (ph === 'LIE') toVote();
    else if (ph === 'VOTE') toReveal();
    else if (ph === 'REVEAL') advanceReveal();
  };

  window.hostNext = function () {
    if (mpRole !== 'host' || gameState.phase !== 'SCORES') return;
    if (gameState.round >= gameState.totalRounds) toFinal();
    else startQuestion();
  };

  window.hostPlayAgain = function () {
    if (mpRole !== 'host') return;
    Object.values(gameState.players).forEach(p => { p.score = 0; p.likes = 0; });
    gameState.round = 0;
    gameState.qid = null;
    gameState.lastDeltas = null;
    resetRoundSecrets();
    gameState.phase = 'LOBBY';
    gameState.stage++;
    broadcastNow();
  };

  window.hostSetting = function (field, value) {
    if (mpRole !== 'host' || gameState.phase !== 'LOBBY') return;
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    gameState.settings[field] = n;
    if (field === 'rounds') gameState.totalRounds = n + 1;
    broadcastNow();
  };

  // Ведущий тоже играет: его место — обычный игрок, но действия применяются сразу, без сети
  function addHostPlayer(name) {
    gameState.hostPid = myPlayerId;
    gameState.secret.keys[myPlayerId] = myKey;
    gameState.players[myPlayerId] = {
      id: myPlayerId,
      name: uniqueName(sanitizeName(name) || 'Ведущий', myPlayerId),
      avatar: pickAvatar(myAvatar, myPlayerId),
      score: 0,
      likes: 0,
      rejects: 0,
      lastSeq: 0,
      joinedAt: Date.now()
    };
  }

  window.hostTogglePlay = function (on) {
    if (mpRole !== 'host' || gameState.phase !== 'LOBBY') return;
    if (on) {
      if (gameState.players[myPlayerId]) return;
      if (Object.keys(gameState.players).length >= MAX_PLAYERS) {
        showToast('Комната заполнена', 'warn');
        broadcastNow();
        return;
      }
      addHostPlayer(lstore.get('bred_last_name') || 'Ведущий');
      Sound.join();
    } else {
      if (gameState.hostPid && gameState.players[gameState.hostPid]) myAvatar = gameState.players[gameState.hostPid].avatar;
      if (gameState.hostPid) delete gameState.players[gameState.hostPid];
      gameState.hostPid = null;
    }
    broadcastNow();
  };

  window.hostKick = function (pid) {
    const p = gameState.players[pid];
    if (pid === gameState.hostPid) return;
    if (!p || !confirm(`Удалить игрока «${p.name}» из комнаты?`)) return;
    delete gameState.players[pid];
    delete lastSeen[pid];
    if (!gameState.kicked.includes(pid)) gameState.kicked.push(pid);
    broadcastNow();
  };

  // ===========================================================================
  // ВЕДУЩИЙ: запуск / восстановление / закрытие
  // ===========================================================================
  function makeRoomCode() {
    return randomString(ROOM_CODE_LEN, ROOM_ALPHABET);
  }

  window.startHostSession = function () {
    const saved = loadHostSession();
    if (saved && !confirm(`У вас есть незакрытая комната ${saved.state.roomCode}. Создать новую вместо неё?`)) return;
    const plays = $('create-play').checked;
    const name = sanitizeName($('create-name').value);
    if (plays && !name) {
      showToast('Введите ваше имя — вы ведь тоже играете!', 'warn');
      $('create-name').focus();
      return;
    }
    if (saved) publishRoomClosed(saved.state);
    gameState = freshGameState({
      roomCode: makeRoomCode(),
      packId: Number($('create-pack').value) || 0,
      rounds: Number($('create-rounds').value) || 5,
      lieSec: Number($('create-lie').value) || 45,
      voteSec: Number($('create-vote').value) || 30
    });
    if (plays) {
      lstore.set('bred_last_name', name);
      addHostPlayer(name);
    }
    enterHostMode();
  };

  window.resumeHostSession = function () {
    const saved = loadHostSession();
    if (!saved) {
      showToast('Сохранённая комната не найдена', 'warn');
      renderResumeBox();
      return;
    }
    gameState = saved.state;
    gameState.kicked = gameState.kicked || [];
    // Ведущий-игрок продолжает играть своим местом, даже если комнату восстановили в другой вкладке
    if (gameState.hostPid && gameState.players[gameState.hostPid]) {
      myPlayerId = gameState.hostPid;
      sstore.set('bred_pid_v1', myPlayerId);
      if (gameState.secret.keys[myPlayerId]) myKey = gameState.secret.keys[myPlayerId];
      sstore.set('bred_key_v1', myKey);
      myAvatar = gameState.players[myPlayerId].avatar;
    }
    // Таймер текущей фазы перезапускается, чтобы игроки не потеряли время на перезагрузку
    if (gameState.phase === 'LIE') gameState.deadline = Date.now() + gameState.settings.lieSec * 1000;
    if (gameState.phase === 'VOTE') gameState.deadline = Date.now() + gameState.settings.voteSec * 1000;
    if (gameState.phase === 'REVEAL' && gameState.reveal) gameState.reveal.nextAt = Date.now() + REVEAL_LIE_MS;
    enterHostMode();
    showToast(`Комната ${gameState.roomCode} восстановлена`, 'ok');
  };

  window.discardHostSession = function () {
    const saved = loadHostSession();
    if (saved) publishRoomClosed(saved.state);
    lstore.del(HOST_SAVE_KEY);
    renderResumeBox();
  };

  // Помечает комнату закрытой у брокеров (отдельными короткими подключениями)
  function publishRoomClosed(st) {
    const code = st.roomCode;
    const msg = { type: 'ROOM_CLOSED', room: code, sessionId: st.sessionId };
    try {
      const bc = new BroadcastChannel(NET_NS + '_' + code);
      bc.postMessage(msg);
      bc.close();
    } catch (e) {}
    if (typeof mqtt === 'undefined') return;
    MQTT_BROKERS.forEach(url => {
      try {
        const c = mqtt.connect(url, { connectTimeout: 8000, reconnectPeriod: 0 });
        c.on('connect', () => c.publish(topicFor('to_players', code), JSON.stringify(msg), { qos: 1, retain: true }, () => c.end(false)));
        c.on('error', () => {});
        setTimeout(() => { try { c.end(true); } catch (e) {} }, 10000);
      } catch (e) {}
    });
  }

  window.hostCloseRoom = function () {
    if (mpRole !== 'host') return;
    if (!confirm('Закрыть комнату? Игроки будут отключены.')) return;
    const closing = { type: 'ROOM_CLOSED', room: roomCode, sessionId: gameState.sessionId };
    if (net.bc) { try { net.bc.postMessage(closing); } catch (e) {} }
    mqttPublish(topicFor('to_players'), closing, { qos: 1, retain: true });
    lstore.del(HOST_SAVE_KEY);
    stopTick();
    teardownNet(1500);
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    wakeLock = null;
    mpRole = null;
    roomCode = null;
    gameState = freshGameState();
    showLobbySelect();
    renderResumeBox();
  };

  function inviteUrl() {
    return `${window.location.href.split('?')[0].split('#')[0]}?room=${roomCode}`;
  }

  function enterHostMode() {
    teardownNet();
    stopTick();
    mpRole = 'host';
    roomCode = gameState.roomCode;
    local = loadLocal(roomCode);
    hostBootAt = Date.now();
    lastBroadcastAt = 0;
    Object.keys(lastSeen).forEach(k => delete lastSeen[k]);

    $('lobby-select').classList.add('hidden');
    $('host-view').classList.remove('hidden');
    $('player-view').classList.add('hidden');
    $('host-stage').dataset.key = '';
    $('player-stage').innerHTML = '';
    $('player-stage').dataset.key = '';

    const url = inviteUrl();
    $('host-code').textContent = roomCode;
    $('invite-url').value = url;
    $('qr-room-code').textContent = roomCode;
    $('qr-box').innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=${encodeURIComponent(url)}" alt="QR-код приглашения" class="w-52 h-52" />`;

    setupBroadcast();
    setupMqtt();
    startTick(hostTick, 400);
    requestWakeLock();
    broadcastNow();
    Sound.join();
  }

  window.copyInviteLink = function () {
    const url = inviteUrl();
    const done = () => { Sound.pop(); showToast('Ссылка скопирована — отправьте её друзьям', 'ok'); };
    const fallback = () => {
      const input = $('invite-url');
      input.value = url;
      input.select();
      try { document.execCommand('copy'); done(); } catch (e) { showToast('Скопируйте ссылку вручную', 'warn'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done, fallback);
    } else {
      fallback();
    }
  };

  window.openTestPlayerTab = function () {
    window.open(inviteUrl() + '&test=1', '_blank', 'noopener');
  };

  // ===========================================================================
  // ОТРИСОВКА: общие куски
  // ===========================================================================
  function playerChip(p, extra = '') {
    if (!p) return '';
    return `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-black/40 border border-violet-700/70 text-xs font-semibold ${extra}">
      <span class="text-base leading-none">${p.avatar}</span><span class="truncate max-w-[7rem]">${escapeHtml(p.name)}</span></span>`;
  }

  function chipsFor(ids, st, extra) {
    return ids.map(id => playerChip(st.players[id], extra)).join(' ');
  }

  function timerHtml(deadline, totalSec, big) {
    return `<div class="flex items-center gap-3">
      <div class="timer-track flex-1"><div class="timer-fill" data-deadline="${deadline}" data-total="${totalSec * 1000}" style="width:100%"></div></div>
      <div class="font-display font-black ${big ? 'text-3xl w-14' : 'text-xl w-10'} text-right tabular-nums" data-countdown="${deadline}">${totalSec}</div>
    </div>`;
  }

  function roundBadge(st) {
    if (st.isFinal) return '<span class="px-3 py-1 rounded-full bg-gradient-to-r from-orange-500 to-rose-600 text-white text-xs font-black tracking-wide neon-pink">🔥 ФИНАЛ • ОЧКИ ×2</span>';
    return `<span class="px-3 py-1 rounded-full bg-violet-800/70 border border-violet-600 text-xs font-bold">Вопрос ${st.round} из ${st.totalRounds}</span>`;
  }

  function categoryBadge(q) {
    if (!q) return '';
    const pack = PACKS.find(p => p.id === q.packId);
    return `<span class="px-3 py-1 rounded-full bg-black/40 border border-violet-700 text-xs text-violet-200">${pack ? pack.emoji : '❓'} ${escapeHtml(q.category)}</span>`;
  }

  function revealCardHtml(st, big) {
    const rv = st.reveal;
    if (!rv) return '';
    const cur = rv.steps[rv.step];
    const q = currentQuestion();
    const textSize = big ? 'text-4xl sm:text-6xl' : 'text-3xl';
    const dots = rv.steps.map((s, i) => `<span class="w-2.5 h-2.5 rounded-full ${i < rv.step ? 'bg-violet-400' : (i === rv.step ? (s.kind === 'truth' ? 'bg-emerald-400' : 'bg-pink-500') : 'bg-white/15')}"></span>`).join('');
    let body;
    if (cur.kind === 'lie') {
      const authorsHtml = cur.authors.map(a => {
        const p = st.players[a];
        const pts = cur.pts[a] || 0;
        const auto = cur.autoAuthors.includes(a) ? ' <span class="text-[10px] text-amber-300">(🎲 игра помогла)</span>' : '';
        return `<div class="flex items-center justify-center gap-2">${playerChip(p, 'text-sm')}<span class="font-display font-black text-yellow-300">+${fmt(pts)}</span>${auto}</div>`;
      }).join('');
      body = `
        <div class="relative glass rounded-3xl p-6 sm:p-8 text-center pop-in">
          <div class="text-xs uppercase tracking-[0.25em] text-violet-300 mb-2">Варианты</div>
          <div class="font-display font-black ${textSize} mb-4">«${escapeHtml(cur.text)}»</div>
          <div class="text-sm text-violet-200 mb-2">Попались на удочку:</div>
          <div class="flex flex-wrap justify-center gap-1.5 mb-5">${chipsFor(cur.voters, st)}</div>
          <div class="fade-up late-1">
            <div class="inline-block stamp late-1 px-5 py-2 rounded-xl border-4 border-rose-500 text-rose-400 font-display font-black text-3xl sm:text-4xl tracking-widest mb-4">БРЕД!</div>
          </div>
          <div class="fade-up late-2 space-y-1.5">
            <div class="text-sm text-violet-200">Автор бреда:</div>
            ${authorsHtml || '<div class="text-sm text-violet-300">Это была ложь от игры 🤖</div>'}
          </div>
        </div>`;
    } else {
      body = `
        <div class="relative glass rounded-3xl p-6 sm:p-8 text-center pop-in glow-pulse border-emerald-400/60">
          <div class="inline-block stamp px-5 py-2 rounded-xl border-4 border-emerald-400 text-emerald-300 font-display font-black text-3xl sm:text-4xl tracking-widest mb-3">ПРАВДА!</div>
          <div class="font-display font-black ${textSize} text-emerald-300 mb-4">«${escapeHtml(cur.text)}»</div>
          <div class="text-sm text-violet-200 mb-2">${cur.voters.length ? `Угадали (+${fmt(PTS.truth * (st.isFinal ? 2 : 1))}):` : 'Никто не угадал 😱'}</div>
          <div class="flex flex-wrap justify-center gap-1.5 mb-4">${chipsFor(cur.voters, st, 'border-emerald-500')}</div>
          ${q ? `<div class="fade-up late-1 max-w-2xl mx-auto text-left bg-black/30 border border-emerald-800/60 rounded-2xl p-4 ${big ? 'text-base sm:text-lg' : 'text-sm'}">
            <div class="text-xs uppercase tracking-widest text-emerald-400 mb-1">💡 Как это было</div>
            <div class="text-violet-50/90">${escapeHtml(q.explanation)}</div>
          </div>` : ''}
        </div>`;
    }
    return `
      <div class="text-center mb-3 ${big ? 'text-lg sm:text-2xl' : 'text-base'} font-semibold text-violet-100/90">${questionHtml(q, cur.kind === 'truth')}</div>
      ${body}
      <div class="flex justify-center gap-1.5 mt-4">${dots}</div>`;
  }

  function scoreboardHtml(st, big, highlightId) {
    const deltas = st.lastDeltas || {};
    const rows = sortedPlayers(st).map((p, i) => {
      const d = deltas[p.id];
      const me = p.id === highlightId;
      return `
        <div class="flex items-center gap-3 rounded-2xl px-3 py-2.5 ${me ? 'bg-pink-500/20 border border-pink-400' : 'bg-black/30 border border-violet-800/60'} fade-up" style="animation-delay:${i * 0.07}s">
          <div class="w-7 text-center font-display font-black ${i === 0 ? 'text-yellow-300' : 'text-violet-300'}">${i + 1}</div>
          <div class="${big ? 'text-3xl' : 'text-2xl'}">${p.avatar}</div>
          <div class="flex-1 min-w-0">
            <div class="font-bold truncate ${big ? 'text-lg' : ''}">${escapeHtml(p.name)}${p.online ? '' : ' <span class="text-[10px] text-slate-400 font-normal">офлайн</span>'}</div>
            ${d ? `<div class="text-[11px] text-violet-300 truncate">${d.parts.map(escapeHtml).join(' • ')}</div>` : ''}
          </div>
          ${d ? `<div class="font-display font-black text-emerald-400 ${big ? 'text-lg' : 'text-sm'}">+${fmt(d.total)}</div>` : ''}
          <div class="font-display font-black text-yellow-300 ${big ? 'text-2xl' : 'text-lg'} tabular-nums">${fmt(p.score)}</div>
        </div>`;
    }).join('');
    return `<div class="space-y-2">${rows}</div>`;
  }

  function podiumHtml(st, big) {
    const ps = sortedPlayers(st);
    const order = [ps[1], ps[0], ps[2]];
    const heights = big ? ['h-32', 'h-44', 'h-24'] : ['h-20', 'h-28', 'h-14'];
    const medals = ['🥈', '🥇', '🥉'];
    const cols = order.map((p, i) => {
      if (!p) return '<div class="flex-1"></div>';
      return `<div class="flex-1 flex flex-col items-center justify-end">
        <div class="${big ? 'text-5xl' : 'text-4xl'} mb-1 pop-in" style="animation-delay:${0.6 + i * 0.2}s">${p.avatar}</div>
        <div class="font-bold text-sm truncate max-w-full px-1">${escapeHtml(p.name)}</div>
        <div class="font-display font-black text-yellow-300 mb-1">${fmt(p.score)}</div>
        <div class="podium-bar w-full ${heights[i]} rounded-t-2xl ${i === 1 ? 'bg-gradient-to-t from-yellow-600 to-yellow-300 neon-gold' : 'bg-gradient-to-t from-violet-800 to-violet-500'} flex items-start justify-center pt-2 text-3xl" style="animation-delay:${i * 0.15}s">${medals[i]}</div>
      </div>`;
    }).join('');
    const maxLikes = Math.max(0, ...ps.map(p => p.likes || 0));
    const fans = maxLikes > 0 ? ps.filter(p => p.likes === maxLikes) : [];
    const rest = ps.slice(3).map((p, i) => `<div class="flex items-center gap-2 text-sm bg-black/30 rounded-xl px-3 py-1.5"><span class="text-violet-300 w-5">${i + 4}</span><span>${p.avatar}</span><span class="flex-1 truncate">${escapeHtml(p.name)}</span><span class="font-bold text-yellow-300">${fmt(p.score)}</span></div>`).join('');
    return `
      <div class="flex items-end gap-2 sm:gap-4 max-w-xl mx-auto">${cols}</div>
      ${fans.length ? `<div class="mt-5 glass rounded-2xl p-4 text-center fade-up late-2">
        <div class="text-xs uppercase tracking-widest text-pink-300 mb-1">🏆 Приз зрительских симпатий</div>
        <div class="font-display font-black text-xl">${fans.map(f => `${f.avatar} ${escapeHtml(f.name)}`).join(', ')} <span class="text-pink-300">— ${maxLikes} 👍</span></div>
      </div>` : ''}
      ${rest ? `<div class="mt-4 space-y-1.5 max-w-md mx-auto">${rest}</div>` : ''}`;
  }

  // Таймеры обновляются отдельно, без перерисовки экрана
  let lastTickSecond = null;
  setInterval(() => {
    const now = serverNow();
    let minLeft = null;
    document.querySelectorAll('[data-deadline]').forEach(el => {
      const dl = Number(el.dataset.deadline);
      const total = Number(el.dataset.total) || 1;
      const left = Math.max(0, dl - now);
      el.style.width = `${Math.min(100, (left / total) * 100)}%`;
      el.classList.toggle('hurry', left <= 5000);
    });
    document.querySelectorAll('[data-countdown]').forEach(el => {
      const left = Math.max(0, Number(el.dataset.countdown) - now);
      const sec = Math.ceil(left / 1000);
      el.textContent = sec;
      el.classList.toggle('text-rose-400', sec <= 5);
      minLeft = minLeft === null ? sec : Math.min(minLeft, sec);
    });
    // Тиканье на последних 5 секундах
    if (minLeft !== null && minLeft >= 1 && minLeft <= 5 && minLeft !== lastTickSecond) Sound.tick();
    lastTickSecond = minLeft;
  }, 250);

  // ===========================================================================
  // ОТРИСОВКА: ведущий
  // ===========================================================================
  function renderHostNetStatus() {
    if (mpRole !== 'host') return;
    const mq = mqttConnectedCount();
    const players = Object.values(gameState.players);
    const online = players.filter(p => isPlayerOnline(p.id)).length;
    $('host-net-dot').className = `w-2.5 h-2.5 rounded-full ${mq > 0 ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse'}`;
    $('host-net-info').textContent = `Серверы ${mq}/${MQTT_BROKERS.length} • Игроков онлайн ${online}/${players.length}`;
  }

  function hostViewKey() {
    const st = gameState;
    if (st.phase === 'LOBBY') return 'LOBBY';
    if (st.phase === 'REVEAL') return `REVEAL:${st.stage}:${st.reveal ? st.reveal.step : 0}`;
    return `${st.phase}:${st.stage}`;
  }

  function hostIsPlaying() {
    return !!(gameState.hostPid && gameState.hostPid === myPlayerId && gameState.players[myPlayerId]);
  }

  function renderHost(forceFrame) {
    if (mpRole !== 'host') return;
    renderHostNetStatus();
    const stageEl = $('host-stage');
    const st = gameState;

    if (local.lastStage !== st.stage) {
      local.lastStage = st.stage;
      local.lieError = '';
      local.pendingLie = null;
      local.pendingVote = null;
    }

    // Ведущий играет сам: вместо большого экрана — его пульт и полоса управления комнатой
    if (hostIsPlaying() && st.phase !== 'LOBBY') {
      if (stageEl.dataset.key !== 'HP') {
        stageEl.dataset.key = 'HP';
        stageEl.innerHTML = '<div class="max-w-xl mx-auto"><div id="hp-ctl" class="mb-3"></div><div id="hp-stage"></div></div>';
      }
      const pub = buildPublicState();
      $('hp-ctl').innerHTML = hostControlsHtml(pub);
      paintPlayerPanel($('hp-stage'), pub, pub.players[myPlayerId], forceFrame);
      if (st.phase === 'REVEAL' && st.reveal) {
        const stepKey = st.stage + ':' + st.reveal.step;
        if (local.lastRevealStep !== stepKey) {
          local.lastRevealStep = stepKey;
          playRevealSound(st);
        }
      }
      return;
    }

    const key = hostViewKey();
    if (stageEl.dataset.key !== key) {
      stageEl.dataset.key = key;
      stageEl.innerHTML = hostFrame(buildPublicState());
      if (st.phase === 'REVEAL') playRevealSound(st);
    }
    hostUpdateDynamic(st);
  }

  function hostFrame(st) {
    const q = currentQuestion();
    const fileWarn = location.protocol === 'file:'
      ? `<div class="mb-4 rounded-2xl border border-amber-400/60 bg-amber-500/10 p-3 text-sm text-amber-100">
          ⚠️ Игра открыта как файл с компьютера. Тестовые вкладки здесь работают, но друзья с телефонов по ссылке не зайдут. Для игры по сети выложите папку на GitHub Pages (инструкция в README.md).
        </div>` : '';

    if (st.phase === 'LOBBY') {
      const packOpts = [`<option value="0">🎲 Все паки вперемешку (${ALL_Q.length})</option>`]
        .concat(PACKS.map(p => `<option value="${p.id}">${p.emoji} ${escapeHtml(p.title)} (${p.questions.length})</option>`)).join('');
      const sel = (id, field, opts) => `<select id="${id}" onchange="window.hostSetting('${field}', this.value)" class="w-full bg-black/40 border border-violet-700 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-pink-500">${opts}</select>`;
      return `${fileWarn}
        <div class="grid lg:grid-cols-5 gap-4">
          <div class="lg:col-span-2 glass rounded-3xl p-5 text-center fade-up">
            <div class="text-sm text-violet-300 mb-1">Заходите с телефонов на</div>
            <div class="font-semibold text-xs break-all text-cyan-300 mb-3">${escapeHtml(inviteUrl())}</div>
            <div class="bg-white rounded-2xl p-3 inline-block mb-3"><img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=0&data=${encodeURIComponent(inviteUrl())}" alt="QR" class="w-44 h-44 sm:w-52 sm:h-52" /></div>
            <div class="text-sm text-violet-300">или введите код</div>
            <div class="font-display font-black text-6xl tracking-[0.2em] text-yellow-300 neon-title">${roomCode}</div>
          </div>
          <div class="lg:col-span-3 space-y-4">
            <div class="glass rounded-3xl p-5 fade-up">
              <div class="flex items-center justify-between mb-3">
                <h2 class="font-display font-extrabold text-xl">Игроки <span id="h-count" class="text-violet-300"></span></h2>
                <span class="text-xs text-violet-300">от ${MIN_PLAYERS} до ${MAX_PLAYERS}</span>
              </div>
              <div id="h-lobby-players" class="grid grid-cols-2 sm:grid-cols-3 gap-2"></div>
            </div>
            <div class="glass rounded-3xl p-5 fade-up">
              <h3 class="font-display font-bold mb-3">Настройки игры</h3>
              <div class="grid grid-cols-2 gap-3">
                <label class="col-span-2"><span class="block text-xs text-violet-300 mb-1">Пак вопросов</span>${sel('h-set-pack', 'packId', packOpts)}</label>
                <label><span class="block text-xs text-violet-300 mb-1">Раундов</span>${sel('h-set-rounds', 'rounds', [3, 4, 5, 6, 8, 10].map(n => `<option value="${n}">${n} + финал</option>`).join(''))}</label>
                <label><span class="block text-xs text-violet-300 mb-1">Ложь, сек</span>${sel('h-set-lie', 'lieSec', [30, 45, 60, 90].map(n => `<option value="${n}">${n}</option>`).join(''))}</label>
                <label class="col-span-2"><span class="block text-xs text-violet-300 mb-1">Голосование, сек</span>${sel('h-set-vote', 'voteSec', [20, 30, 45, 60].map(n => `<option value="${n}">${n}</option>`).join(''))}</label>
              </div>
              <button type="button" id="h-start-btn" onclick="window.hostStartGame()" class="mt-4 w-full py-4 rounded-2xl font-display font-black text-xl bg-gradient-to-r from-pink-500 via-fuchsia-500 to-violet-600 hover:brightness-110 neon-pink transition disabled:opacity-40 disabled:shadow-none">
                Начать игру ▶
              </button>
              <label class="mt-3 flex items-center justify-center gap-2 text-sm font-semibold cursor-pointer select-none">
                <input type="checkbox" id="h-set-play" onchange="window.hostTogglePlay(this.checked)" class="w-5 h-5 accent-pink-500" />
                🎮 Я тоже играю с этого устройства
              </label>
            </div>
          </div>
        </div>`;
    }

    if (st.phase === 'LIE') {
      return `
        <div class="flex flex-wrap items-center justify-center gap-2 mb-4">${roundBadge(st)} ${categoryBadge(q)}</div>
        <div class="glass rounded-3xl p-6 sm:p-10 text-center ${st.isFinal ? 'neon-pink' : ''} pop-in">
          <div class="font-display font-extrabold text-2xl sm:text-4xl leading-snug mb-6">${questionHtml(q, false)}</div>
          <div class="max-w-2xl mx-auto">${timerHtml(st.deadline, st.settings.lieSec, true)}</div>
          <div class="mt-4 text-violet-200">✍️ Впишите на телефонах правдоподобный бред!</div>
        </div>
        <div class="mt-4 glass rounded-3xl p-4">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm text-violet-300">Сдали ложь: <b id="h-progress" class="text-white"></b></div>
            <button type="button" onclick="window.hostSkip()" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-black/40 border border-violet-700 hover:border-pink-500">⏩ Хватит ждать</button>
          </div>
          <div id="h-status" class="flex flex-wrap gap-2"></div>
        </div>`;
    }

    if (st.phase === 'VOTE') {
      const letters = 'АБВГДЕЖЗИКЛМН';
      const opts = (st.options || []).map((o, i) => `
        <div class="glass rounded-2xl px-4 py-3 flex items-center gap-3 fade-up" style="animation-delay:${i * 0.08}s">
          <span class="w-9 h-9 shrink-0 rounded-xl bg-gradient-to-br from-pink-500 to-violet-600 flex items-center justify-center font-display font-black">${letters[i] || i + 1}</span>
          <span class="font-display font-extrabold text-lg sm:text-2xl">${escapeHtml(o.text)}</span>
        </div>`).join('');
      return `
        <div class="flex flex-wrap items-center justify-center gap-2 mb-4">${roundBadge(st)} ${categoryBadge(q)}</div>
        <div class="glass rounded-3xl p-5 sm:p-7 text-center mb-4">
          <div class="font-display font-extrabold text-xl sm:text-3xl leading-snug mb-4">${questionHtml(q, false)}</div>
          <div class="max-w-2xl mx-auto">${timerHtml(st.deadline, st.settings.voteSec, true)}</div>
          <div class="mt-3 text-violet-200">🕵️ Где правда? Голосуйте на телефонах — и ставьте 👍 самому смешному бреду</div>
        </div>
        <div class="grid sm:grid-cols-2 gap-3">${opts}</div>
        <div class="mt-4 glass rounded-3xl p-4">
          <div class="flex items-center justify-between mb-2">
            <div class="text-sm text-violet-300">Проголосовали: <b id="h-progress" class="text-white"></b></div>
            <button type="button" onclick="window.hostSkip()" class="px-3 py-1.5 rounded-lg text-xs font-semibold bg-black/40 border border-violet-700 hover:border-pink-500">⏩ Вскрываем!</button>
          </div>
          <div id="h-status" class="flex flex-wrap gap-2"></div>
        </div>`;
    }

    if (st.phase === 'REVEAL') {
      return `
        <div class="flex flex-wrap items-center justify-center gap-2 mb-4">${roundBadge(st)} ${categoryBadge(q)}</div>
        <div class="max-w-4xl mx-auto">${revealCardHtml(st, true)}</div>
        <div class="text-center mt-4">
          <button type="button" onclick="window.hostSkip()" class="px-4 py-2 rounded-xl text-sm font-semibold bg-black/40 border border-violet-700 hover:border-pink-500">⏭ Дальше</button>
        </div>`;
    }

    if (st.phase === 'SCORES') {
      const last = st.round >= st.totalRounds;
      const nextFinal = st.round + 1 === st.totalRounds;
      return `
        <div class="max-w-3xl mx-auto">
          <div class="text-center mb-4">
            <h2 class="font-display font-black text-3xl sm:text-4xl neon-title">Таблица лидеров</h2>
            <div class="text-violet-300 text-sm">После вопроса ${st.round} из ${st.totalRounds}</div>
          </div>
          <div class="glass rounded-3xl p-4 sm:p-5">${scoreboardHtml(st, true)}</div>
          <button type="button" onclick="window.hostNext()" class="mt-5 w-full py-4 rounded-2xl font-display font-black text-xl bg-gradient-to-r ${nextFinal ? 'from-orange-500 to-rose-600' : 'from-pink-500 to-violet-600'} hover:brightness-110 neon-pink transition">
            ${last ? 'Итоги игры 🏆' : (nextFinal ? 'ФИНАЛЬНЫЙ РАУНД 🔥 ×2' : 'Следующий вопрос ▶')}
          </button>
        </div>`;
    }

    if (st.phase === 'FINAL') {
      return `
        <div class="max-w-3xl mx-auto text-center">
          <h2 class="font-display font-black text-4xl sm:text-6xl neon-title mb-6 pop-in">Мастера бреда!</h2>
          ${podiumHtml(st, true)}
          <div class="mt-6 grid sm:grid-cols-2 gap-3">
            <button type="button" onclick="window.hostPlayAgain()" class="py-3.5 rounded-2xl font-display font-black text-lg bg-gradient-to-r from-pink-500 to-violet-600 hover:brightness-110 neon-pink">🔁 Сыграть ещё</button>
            <button type="button" onclick="window.hostCloseRoom()" class="py-3.5 rounded-2xl font-display font-bold text-lg bg-black/40 border border-violet-700 hover:border-rose-500">🚪 Закрыть комнату</button>
          </div>
        </div>`;
    }
    return '';
  }

  function hostUpdateDynamic(st) {
    const players = Object.values(st.players).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    const now = Date.now();

    if (st.phase === 'LOBBY') {
      const box = $('h-lobby-players');
      if (box) {
        box.innerHTML = players.length ? players.map(p => {
          const on = isPlayerOnline(p.id, now);
          const isHost = p.id === st.hostPid;
          return `<div class="flex items-center gap-2 bg-black/30 border ${isHost ? 'border-pink-500/70' : 'border-violet-800/60'} rounded-xl px-2.5 py-2 pop-in">
            <span class="text-2xl">${p.avatar}</span>
            <span class="flex-1 min-w-0 font-semibold text-sm truncate">${isHost ? '👑 ' : ''}${escapeHtml(p.name)}</span>
            <span class="w-2 h-2 rounded-full ${on ? 'bg-emerald-400' : 'bg-slate-500'}" title="${on ? 'На связи' : 'Нет связи'}"></span>
            ${isHost ? '' : `<button type="button" onclick="window.hostKick('${p.id}')" class="text-slate-400 hover:text-rose-400 text-xs" title="Удалить">✕</button>`}
          </div>`;
        }).join('') : '<div class="col-span-full text-sm text-violet-300/80 py-6 text-center">Пока никого… Отправьте друзьям ссылку или QR-код 👈</div>';
      }
      const cnt = $('h-count');
      if (cnt) cnt.textContent = `(${players.length})`;
      const btn = $('h-start-btn');
      if (btn) {
        btn.disabled = players.length < MIN_PLAYERS;
        btn.textContent = players.length < MIN_PLAYERS ? `Ждём игроков (${players.length}/${MIN_PLAYERS})` : `Начать игру ▶ (${players.length})`;
      }
      const setVal = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = String(v); };
      setVal('h-set-pack', st.settings.packId);
      setVal('h-set-rounds', st.settings.rounds);
      setVal('h-set-lie', st.settings.lieSec);
      setVal('h-set-vote', st.settings.voteSec);
      const play = $('h-set-play');
      if (play) play.checked = hostIsPlaying();
    }

    if (st.phase === 'LIE' || st.phase === 'VOTE') {
      const done = (p) => st.phase === 'LIE' ? !!st.secret.lies[p.id] : !!st.secret.votes[p.id];
      const box = $('h-status');
      if (box) {
        box.innerHTML = players.map(p => {
          const ok = done(p);
          const on = isPlayerOnline(p.id, now);
          return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-sm font-semibold border ${ok ? 'bg-emerald-500/20 border-emerald-400' : 'bg-black/30 border-violet-800'} ${on ? '' : 'opacity-50'}">
            <span class="text-lg">${p.avatar}</span>${escapeHtml(p.name)} ${ok ? '✅' : (on ? '<span class="animate-pulse">✍️</span>' : '📴')}</span>`;
        }).join('');
      }
      const prog = $('h-progress');
      if (prog) prog.textContent = `${players.filter(done).length} / ${players.length}`;
    }
  }

  // Полоса управления комнатой над пультом, когда ведущий играет сам
  function hostControlsHtml(st) {
    const players = Object.values(st.players);
    const wrap = (inner) => `<div class="glass rounded-2xl px-3 py-2.5 flex items-center justify-between gap-2 text-sm border-pink-500/40">${inner}</div>`;
    const crown = '<span class="font-semibold text-pink-300">👑 Ведущий</span>';
    const smallBtn = (label) => `<button type="button" onclick="window.hostSkip()" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-black/40 border border-violet-700 hover:border-pink-500 whitespace-nowrap">${label}</button>`;
    const bigBtn = (onclick, label, cls) => `<button type="button" onclick="${onclick}" class="w-full py-3.5 rounded-2xl font-display font-black text-lg ${cls} hover:brightness-110 transition">${label}</button>`;

    if (st.phase === 'LIE') {
      return wrap(`${crown}<span class="text-violet-200">Сдали ложь: <b>${players.filter(p => p.hasLie).length}/${players.length}</b></span>${smallBtn('⏩ Хватит ждать')}`);
    }
    if (st.phase === 'VOTE') {
      return wrap(`${crown}<span class="text-violet-200">Голосов: <b>${players.filter(p => p.hasVote).length}/${players.length}</b></span>${smallBtn('⏩ Вскрываем!')}`);
    }
    if (st.phase === 'REVEAL') {
      return wrap(`${crown}<span class="text-violet-200">Вскрытие</span>${smallBtn('⏭ Дальше')}`);
    }
    if (st.phase === 'SCORES') {
      const last = st.round >= st.totalRounds;
      const nextFinal = st.round + 1 === st.totalRounds;
      return bigBtn('window.hostNext()', last ? 'Итоги игры 🏆' : (nextFinal ? 'ФИНАЛЬНЫЙ РАУНД 🔥 ×2' : 'Следующий вопрос ▶'),
        `bg-gradient-to-r ${nextFinal ? 'from-orange-500 to-rose-600' : 'from-pink-500 to-violet-600'} neon-pink`);
    }
    if (st.phase === 'FINAL') {
      return `<div class="grid grid-cols-2 gap-2">
        ${bigBtn('window.hostPlayAgain()', '🔁 Ещё раз', 'bg-gradient-to-r from-pink-500 to-violet-600 neon-pink')}
        ${bigBtn('window.hostCloseRoom()', '🚪 Закрыть', 'bg-black/40 border border-violet-700')}
      </div>`;
    }
    return '';
  }

  function playRevealSound(st) {
    const rv = st.reveal;
    if (!rv) return;
    const cur = rv.steps[rv.step];
    Sound.drumroll();
    setTimeout(() => (cur.kind === 'truth' ? Sound.fanfare() : Sound.fail()), 1100);
  }

  // ===========================================================================
  // ИГРОК: подключение
  // ===========================================================================
  // Выбор аватара есть в обеих карточках лобби; выбор синхронизируется
  function renderAvatarPicker() {
    const saved = lstore.get('bred_last_avatar');
    myAvatar = AVATARS.includes(saved) ? saved : AVATARS[randInt(AVATARS.length)];
    lstore.set('bred_last_avatar', myAvatar);
    ['join-avatars', 'create-avatars'].forEach(id => {
      const box = $(id);
      box.innerHTML = AVATARS.map(a => `
        <label class="avatar-pick cursor-pointer">
          <input type="radio" name="${id}" value="${a}" class="sr-only" ${a === myAvatar ? 'checked' : ''} />
          <span class="flex items-center justify-center aspect-square rounded-xl bg-black/40 border border-violet-800 text-xl sm:text-2xl transition">${a}</span>
        </label>`).join('');
      box.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => {
        myAvatar = inp.value;
        lstore.set('bred_last_avatar', myAvatar);
        document.querySelectorAll(`#join-avatars input, #create-avatars input`).forEach(o => { o.checked = o.value === myAvatar; });
        Sound.pop();
      }));
    });
  }

  window.startPlayerSession = function () {
    const name = sanitizeName($('join-name').value);
    const code = normalizeRoomCode($('join-code').value);
    if (code.length < ROOM_CODE_LEN) {
      showToast('Введите 4-символьный код комнаты', 'warn');
      $('join-code').focus();
      return;
    }
    if (!name) {
      showToast('Введите ваше имя!', 'warn');
      $('join-name').focus();
      return;
    }
    lstore.set('bred_last_name', name);
    enterPlayerMode(code, name, myAvatar);
  };

  function enterPlayerMode(code, name, avatar) {
    teardownNet();
    stopTick();
    mpRole = 'player';
    roomCode = code;
    myName = name;
    myAvatar = avatar || myAvatar;

    knownSession = null;
    lastStateV = -1;
    lastHostContact = 0;
    lastJoinSentAt = 0;
    lastPingAt = 0;
    actionQueue = [];
    inFlight = null;
    playerHalted = null;
    local = loadLocal(code);
    gameState = freshGameState({ roomCode: code });

    sstore.set(PLAYER_SAVE_KEY, JSON.stringify({ room: code, name, avatar: myAvatar }));

    $('lobby-select').classList.add('hidden');
    $('host-view').classList.add('hidden');
    $('player-view').classList.remove('hidden');
    $('player-stage').dataset.key = '';
    $('host-stage').innerHTML = '';
    $('host-stage').dataset.key = '';
    $('pl-name').textContent = name;
    $('pl-avatar').textContent = myAvatar;
    $('pl-room').textContent = `Комната ${code}`;

    setupBroadcast();
    setupMqtt();
    sendJoin();
    startTick(playerTick, 1000);
    renderPlayer();
  }

  // Свои лжи/голоса храним в sessionStorage, чтобы перезагрузка вкладки их не теряла
  function saveLocal() {
    sstore.set('bred_local_v1', JSON.stringify({ room: roomCode, lies: local.lies, votes: local.votes, likes: local.likes }));
  }

  function loadLocal(code) {
    const l = freshLocal();
    try {
      const saved = JSON.parse(sstore.get('bred_local_v1') || 'null');
      if (saved && saved.room === code) {
        l.lies = saved.lies || {};
        l.votes = saved.votes || {};
        l.likes = saved.likes || {};
      }
    } catch (e) {}
    return l;
  }

  function sendToHost(msg) {
    msg.room = roomCode;
    msg.playerId = myPlayerId;
    if (net.bc) {
      try { net.bc.postMessage(msg); } catch (e) {}
    }
    mqttPublish(topicFor('to_host'), msg, { qos: 1 });
  }

  function sendJoin() {
    if (mpRole !== 'player' || playerHalted) return;
    lastJoinSentAt = Date.now();
    sendToHost({ type: 'PLAYER_JOIN', name: myName, avatar: myAvatar, key: myKey });
  }

  window.manualReconnectPlayer = function () {
    if (mpRole !== 'player') return;
    showToast('Переподключение…', 'info');
    reconnectTransports();
    sendJoin();
    if (inFlight) inFlight.sentAt = 0;
    renderPlayerConn();
  };

  window.playerLeave = function () {
    if (mpRole !== 'player') return;
    if (!playerHalted && !confirm('Выйти из комнаты?')) return;
    if (!playerHalted) sendToHost({ type: 'PLAYER_LEAVE' });
    sstore.del(PLAYER_SAVE_KEY);
    stopTick();
    teardownNet(600);
    mpRole = null;
    roomCode = null;
    gameState = freshGameState();
    window.history.replaceState(null, '', window.location.pathname);
    showLobbySelect();
  };

  function playerTick() {
    if (mpRole !== 'player' || playerHalted) return;
    const now = Date.now();
    const me = gameState.players[myPlayerId];
    if (!me && now - lastJoinSentAt > 2500) sendJoin();
    if (me && now - lastPingAt > PLAYER_PING_MS) {
      lastPingAt = now;
      sendToHost({ type: 'PING' });
    }
    pumpActionQueue();
    renderPlayerConn();
  }

  function playerHandleMessage(data) {
    if (playerHalted) return;
    if (data.type === 'STATE_SYNC') {
      const st = data.state;
      if (!st || st.roomCode !== roomCode || typeof st.v !== 'number' || !st.players) return;
      if (knownSession && st.sessionId !== knownSession.id) {
        // Состояние другой сессии принимаем, только если она новее (ведущий пересоздал комнату)
        if ((st.createdAt || 0) <= knownSession.createdAt) return;
        lastStateV = -1;
        local = freshLocal();
        saveLocal();
      }
      knownSession = { id: st.sessionId, createdAt: st.createdAt || 0 };
      lastHostContact = Date.now();
      if (typeof st.hostNow === 'number') clockOffset = st.hostNow - Date.now();
      // Отвечаем на пульс ведущего: в фоновых вкладках таймеры замедлены, а входящие сообщения — нет
      if (st.players[myPlayerId] && Date.now() - lastPingAt > PLAYER_PING_MS) {
        lastPingAt = Date.now();
        sendToHost({ type: 'PING' });
      }
      if (st.v <= lastStateV) {
        renderPlayerConn();
        return;
      }
      lastStateV = st.v;
      gameState = st;
      onPlayerStateApplied();
    } else if (data.type === 'ROOM_CLOSED') {
      if (knownSession && data.sessionId === knownSession.id) {
        haltPlayer('closed');
      } else if (!knownSession) {
        $('pl-conn-info').textContent = 'Комната с этим кодом закрыта или ещё не создана. Ждём ведущего…';
      }
    }
  }

  function onPlayerStateApplied() {
    if ((gameState.kicked || []).includes(myPlayerId)) {
      haltPlayer('kicked');
      return;
    }
    const st = gameState;
    const me = st.players[myPlayerId];
    if (!me && Date.now() - lastJoinSentAt > 1000) sendJoin();

    if (me) {
      // Ведущий отклонил ложь (совпала с правдой)
      if (local.knownRejects === null) local.knownRejects = me.rejects || 0;
      if ((me.rejects || 0) > local.knownRejects) {
        local.knownRejects = me.rejects;
        if (local.pendingLie === st.stage) {
          local.pendingLie = null;
          delete local.lies[st.stage];
          local.lieError = TRUTH_HIT_MSG;
          saveLocal();
          Sound.fail();
        }
      }
    }

    if (local.lastStage !== st.stage) {
      if (local.lastStage !== null) {
        actionQueue = actionQueue.filter(a => a.stage === st.stage);
        if (st.phase === 'LIE') Sound.start();
        if (st.phase === 'VOTE') Sound.submit();
        if (st.phase === 'FINAL') Sound.fanfare();
      }
      local.lastStage = st.stage;
      local.lieError = '';
      local.pendingLie = null;
      local.pendingVote = null;
    }
    if (st.phase === 'REVEAL' && st.reveal) {
      const stepKey = st.stage + ':' + st.reveal.step;
      if (local.lastRevealStep !== stepKey) {
        local.lastRevealStep = stepKey;
        playRevealSound(st);
      }
    }
    pumpActionQueue();

    // Ведущий подтвердил действие, но не применил его (например, фаза уже сменилась) — разблокируем экран
    const idle = !inFlight && !actionQueue.length;
    if (me && idle && local.pendingLie === st.stage && !me.hasLie) {
      local.pendingLie = null;
      delete local.lies[st.stage];
      if (!local.lieError) local.lieError = 'Ответ не принят — попробуй ещё раз';
      saveLocal();
    }
    if (me && idle && local.pendingVote === st.stage && !me.hasVote) {
      local.pendingVote = null;
      delete local.votes[st.stage];
      saveLocal();
    }
    renderPlayer();
  }

  function haltPlayer(reason) {
    playerHalted = reason;
    stopTick();
    teardownNet();
    sstore.del(PLAYER_SAVE_KEY);
    actionQueue = [];
    inFlight = null;
    renderPlayer();
  }

  // ===========================================================================
  // ИГРОК: надёжная отправка действий (по одному, с подтверждением)
  // ===========================================================================
  function enqueueAction(action) {
    if (mpRole !== 'player' || playerHalted) return false;
    if (!gameState.players[myPlayerId]) {
      showToast('Ещё не подключены к ведущему — подождите секунду', 'warn');
      return false;
    }
    action.stage = gameState.stage;
    actionQueue.push(action);
    pumpActionQueue();
    return true;
  }

  function pumpActionQueue() {
    const me = gameState.players[myPlayerId];
    if (!me) return;
    const acked = me.lastSeq || 0;
    if (inFlight && acked >= inFlight.seq) inFlight = null;
    if (inFlight) {
      if (Date.now() - inFlight.sentAt > ACTION_RETRY_MS) {
        inFlight.sentAt = Date.now();
        sendToHost(inFlight.msg);
      }
    } else {
      actionQueue = actionQueue.filter(a => a.stage === gameState.stage);
      const next = actionQueue.shift();
      if (next) {
        const seq = acked + 1;
        const msg = { type: 'PLAYER_ACTION', seq, ...next };
        inFlight = { seq, msg, sentAt: Date.now() };
        sendToHost(msg);
      }
    }
    const pend = $('pl-pending');
    if (pend) pend.classList.toggle('hidden', !inFlight && !actionQueue.length);
  }

  function isMyOption(o) {
    return (o.marks || []).includes(hash8(myKey + ':' + o.oid));
  }

  // Состояние глазами игрока: у ведущего-игрока — публичная версия его собственного состояния
  function viewState() {
    return mpRole === 'host' ? buildPublicState() : gameState;
  }

  // Ведущий-игрок применяет свои действия сразу, остальные шлют их ведущему
  function sendAction(action) {
    if (mpRole === 'host') {
      const p = gameState.players[myPlayerId];
      if (!p || myPlayerId !== gameState.hostPid) return false;
      if (action.kind === 'lie') applyLie(p, action);
      else if (action.kind === 'vote') applyVote(p, action.oid);
      else if (action.kind === 'like') applyLike(p, action.oid);
      scheduleBroadcast();
      return true;
    }
    return enqueueAction(action);
  }

  function rerender(forceFrame) {
    if (mpRole === 'host') renderHost(forceFrame);
    else renderPlayer(forceFrame);
  }

  window.playerSubmitLie = function () {
    const st = viewState();
    const me = st.players[myPlayerId];
    if (st.phase !== 'LIE' || !me || me.hasLie || local.pendingLie === st.stage) return;
    const input = $('p-lie-input');
    const text = cleanLie(input ? input.value : '');
    const q = currentQuestion();
    if (!text) {
      showToast('Впиши свой вариант!', 'warn');
      return;
    }
    if (isTooCloseToTruth(text, q)) {
      local.lieError = TRUTH_HIT_MSG;
      Sound.fail();
      rerender(true);
      return;
    }
    if (!sendAction({ kind: 'lie', text })) return;
    local.lies[st.stage] = { text, auto: false };
    local.pendingLie = st.stage;
    local.lieError = '';
    saveLocal();
    Sound.submit();
    rerender();
  };

  window.playerAutoLie = function () {
    const st = viewState();
    const me = st.players[myPlayerId];
    const q = currentQuestion();
    if (st.phase !== 'LIE' || !me || me.hasLie || local.pendingLie === st.stage || !q) return;
    const text = q.fakeLies[randInt(q.fakeLies.length)];
    if (!sendAction({ kind: 'lie', text, auto: true })) return;
    local.lies[st.stage] = { text, auto: true };
    local.pendingLie = st.stage;
    local.lieError = '';
    saveLocal();
    Sound.submit();
    rerender();
  };

  window.playerVote = function (oid) {
    const st = viewState();
    const me = st.players[myPlayerId];
    if (st.phase !== 'VOTE' || !me || me.hasVote || local.pendingVote === st.stage) return;
    const o = (st.options || []).find(x => x.oid === oid);
    if (!o || isMyOption(o)) return;
    if (!sendAction({ kind: 'vote', oid })) return;
    local.votes[st.stage] = oid;
    local.pendingVote = st.stage;
    saveLocal();
    Sound.pop();
    rerender();
  };

  window.playerLike = function (oid) {
    const st = viewState();
    const me = st.players[myPlayerId];
    if (st.phase !== 'VOTE' || !me || me.liked || local.likes[st.stage]) return;
    const o = (st.options || []).find(x => x.oid === oid);
    if (!o || isMyOption(o)) return;
    if (!sendAction({ kind: 'like', oid })) return;
    local.likes[st.stage] = oid;
    saveLocal();
    Sound.pop();
    rerender();
  };

  // ===========================================================================
  // ОТРИСОВКА: игрок
  // ===========================================================================
  function renderPlayerConn() {
    if (mpRole !== 'player') return;
    const mq = mqttConnectedCount();
    const synced = lastStateV >= 0;
    const fresh = synced && Date.now() - lastHostContact < OFFLINE_AFTER_MS;
    let dotCls = 'bg-amber-400 animate-pulse';
    let text = 'Подключение к ведущему…';
    if (playerHalted) {
      dotCls = 'bg-rose-500';
      text = 'Отключено';
    } else if (fresh) {
      dotCls = 'bg-emerald-400';
      text = 'Связь с ведущим есть';
    } else if (synced) {
      dotCls = 'bg-rose-500 animate-pulse';
      text = `Ведущий не отвечает ${Math.round((Date.now() - lastHostContact) / 1000)} с…`;
    }
    $('pl-conn-dot').className = `w-2 h-2 rounded-full shrink-0 ${dotCls}`;
    $('pl-conn-info').textContent = `${text} • серверы ${mq}/${MQTT_BROKERS.length}`;
  }

  function playerViewKey(st, me) {
    if (playerHalted) return 'HALT:' + playerHalted;
    if (!me) return 'WAIT:' + (Object.keys(st.players).length >= MAX_PLAYERS && lastStateV >= 0 ? 'full' : 'conn');
    if (st.phase === 'LOBBY') return 'LOBBY';
    if (st.phase === 'LIE') {
      return `LIE:${st.stage}:${me.hasLie ? 'ok' : (local.pendingLie === st.stage ? 'pending' : 'input')}`;
    }
    if (st.phase === 'VOTE') {
      const vote = me.hasVote ? 'ok' : (local.pendingVote === st.stage ? 'pending' : '-');
      const like = me.liked ? 'ok' : (local.likes[st.stage] ? 'pending' : '-');
      return `VOTE:${st.stage}:${vote}:${like}`;
    }
    if (st.phase === 'REVEAL') return `REVEAL:${st.stage}:${st.reveal ? st.reveal.step : 0}`;
    return `${st.phase}:${st.stage}`;
  }

  function renderPlayer(forceFrame) {
    if (mpRole !== 'player') return;
    renderPlayerConn();
    const st = gameState;
    const me = st.players[myPlayerId];
    if (me) {
      $('pl-avatar').textContent = me.avatar;
      $('pl-name').textContent = me.name;
      $('pl-score').textContent = fmt(me.score);
    }
    paintPlayerPanel($('player-stage'), st, me, forceFrame);
  }

  // Пульт игрока; общий для обычного игрока и ведущего, который играет сам
  function paintPlayerPanel(stageEl, st, me, forceFrame) {
    const key = playerViewKey(st, me);
    if (forceFrame || stageEl.dataset.key !== key) {
      // Не теряем введённый текст, если экран ввода перерисовывается
      const typed = $('p-lie-input') ? $('p-lie-input').value : null;
      stageEl.dataset.key = key;
      stageEl.innerHTML = playerFrame(st, me);
      const inp = $('p-lie-input');
      if (inp) {
        if (typed !== null) inp.value = typed;
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') window.playerSubmitLie(); });
        inp.addEventListener('input', () => {
          const err = $('p-lie-error');
          if (err && local.lieError) { local.lieError = ''; err.classList.add('hidden'); }
        });
      }
    }
    playerUpdateDynamic(st, me);
  }

  function playerFrame(st, me) {
    const q = currentQuestion();

    if (playerHalted) {
      const msg = playerHalted === 'kicked' ? 'Ведущий удалил вас из комнаты.' : 'Ведущий закрыл комнату. Спасибо за игру!';
      return `<div class="glass rounded-3xl p-6 text-center pop-in">
        <div class="text-5xl mb-3">${playerHalted === 'kicked' ? '🚫' : '👋'}</div>
        <div class="font-display font-bold text-lg mb-4">${msg}</div>
        <button type="button" onclick="window.playerLeave()" class="w-full py-3 rounded-2xl font-bold bg-gradient-to-r from-pink-500 to-violet-600">На главную</button>
      </div>`;
    }

    if (!me) {
      const full = Object.keys(st.players).length >= MAX_PLAYERS && lastStateV >= 0;
      return `<div class="glass rounded-3xl p-8 text-center">
        <div class="text-5xl mb-3 ${full ? '' : 'animate-bounce'}">${full ? '😔' : '📡'}</div>
        <div class="font-display font-bold text-lg">${full ? 'Комната заполнена' : 'Подключаемся к ведущему…'}</div>
        <div class="text-sm text-violet-300 mt-2">${full ? `В игре уже ${MAX_PLAYERS} игроков.` : 'Если долго не подключается — проверьте код комнаты или нажмите ↻.'}</div>
      </div>`;
    }

    if (st.phase === 'LOBBY') {
      return `<div class="glass rounded-3xl p-6 text-center pop-in">
        <div class="text-6xl mb-2">${me.avatar}</div>
        <div class="font-display font-black text-2xl mb-1">Ты в игре!</div>
        <div class="text-sm text-violet-300 mb-4">Ждём, пока ведущий начнёт. Смотри на общий экран 📺</div>
        <div id="p-lobby-players" class="flex flex-wrap justify-center gap-1.5"></div>
      </div>`;
    }

    if (st.phase === 'LIE') {
      const done = me.hasLie || local.pendingLie === st.stage;
      const head = `<div class="flex flex-wrap items-center justify-center gap-2 mb-3">${roundBadge(st)} ${categoryBadge(q)}</div>
        <div class="glass rounded-3xl p-5 mb-3">
          <div class="font-display font-extrabold text-lg leading-snug text-center mb-4">${questionHtml(q, false)}</div>
          ${timerHtml(st.deadline, st.settings.lieSec, false)}
        </div>`;
      if (!done) {
        return `${head}
          <div class="glass rounded-3xl p-5">
            <label class="block text-sm font-semibold text-violet-200 mb-2">Твой правдоподобный бред:</label>
            <input id="p-lie-input" maxlength="${LIE_MAX_LEN}" autocomplete="off" placeholder="Впиши то, во что поверят…" class="w-full bg-black/40 border-2 border-violet-600 rounded-2xl px-4 py-3.5 text-lg focus:outline-none focus:border-pink-500" />
            <div id="p-lie-error" class="${local.lieError ? '' : 'hidden'} mt-3 rounded-2xl bg-amber-400/15 border border-amber-400 text-amber-100 text-sm font-semibold p-3 shake">${escapeHtml(local.lieError)}</div>
            <button type="button" onclick="window.playerSubmitLie()" class="mt-3 w-full py-3.5 rounded-2xl font-display font-black text-lg bg-gradient-to-r from-pink-500 to-violet-600 hover:brightness-110 neon-pink">Отправить ложь ✍️</button>
            <button type="button" onclick="window.playerAutoLie()" class="mt-2 w-full py-2.5 rounded-2xl font-semibold text-sm bg-black/40 border border-violet-700 hover:border-cyan-400">🎲 Придумать за меня <span class="text-amber-300">(−50% очков за обман)</span></button>
          </div>`;
      }
      const mine = local.lies[st.stage];
      const pending = !me.hasLie;
      return `${head}
        <div class="glass rounded-3xl p-5 text-center pop-in">
          <div class="text-4xl mb-1">${pending ? '⏳' : '✅'}</div>
          <div class="font-display font-bold text-lg">${pending ? 'Отправляем…' : 'Ложь принята!'}</div>
          ${mine ? `<div class="mt-2 text-xl font-display font-black text-pink-300">«${escapeHtml(displayCase(mine.text))}»</div>
            ${mine.auto ? '<div class="text-xs text-amber-300 mt-1">🎲 Придумано игрой — очки за обман ×0,5</div>' : ''}`
            : '<div class="mt-2 text-sm text-violet-300">Время вышло — игра придумала ложь за тебя 🤖</div>'}
          <div class="mt-4 text-sm text-violet-300">Ждём остальных:</div>
          <div id="p-progress" class="mt-2 flex flex-wrap justify-center gap-1.5"></div>
        </div>`;
    }

    if (st.phase === 'VOTE') {
      const voted = me.hasVote || local.pendingVote === st.stage;
      const liked = me.liked || !!local.likes[st.stage];
      const myVote = local.votes[st.stage];
      const myLike = local.likes[st.stage];
      const opts = (st.options || []).map(o => {
        const mine = isMyOption(o);
        const chosen = myVote === o.oid;
        const likedThis = myLike === o.oid;
        return `<div class="flex gap-2">
          <button type="button" onclick="window.playerVote('${o.oid}')" ${mine || voted ? 'disabled' : ''}
            class="flex-1 text-left px-4 py-3.5 rounded-2xl font-display font-extrabold text-lg border-2 transition
            ${chosen ? 'bg-gradient-to-r from-cyan-500 to-violet-600 border-cyan-300 neon-cyan' : (mine ? 'bg-black/20 border-dashed border-violet-800 text-violet-400' : 'bg-black/40 border-violet-700 hover:border-cyan-400')}
            ${voted && !chosen && !mine ? 'opacity-60' : ''}">
            ${escapeHtml(o.text)} ${mine ? '<span class="block text-[11px] font-sans font-semibold">📝 это твой бред</span>' : ''}${chosen ? '<span class="block text-[11px] font-sans font-semibold">✅ твой выбор</span>' : ''}
          </button>
          <button type="button" onclick="window.playerLike('${o.oid}')" ${mine || liked ? 'disabled' : ''} title="Лайк за лучший бред"
            class="w-14 shrink-0 rounded-2xl border-2 text-xl transition ${likedThis ? 'bg-pink-500/40 border-pink-400' : 'bg-black/40 border-violet-800 hover:border-pink-400'} ${(mine || (liked && !likedThis)) ? 'opacity-30' : ''}">👍</button>
        </div>`;
      }).join('');
      return `<div class="flex flex-wrap items-center justify-center gap-2 mb-3">${roundBadge(st)} ${categoryBadge(q)}</div>
        <div class="glass rounded-3xl p-5 mb-3">
          <div class="font-display font-extrabold text-base leading-snug text-center mb-3">${questionHtml(q, false)}</div>
          ${timerHtml(st.deadline, st.settings.voteSec, false)}
        </div>
        <div class="text-center text-sm font-semibold mb-2 ${voted ? 'text-emerald-300' : 'text-violet-200'}">${voted ? (me.hasVote ? '✅ Голос принят! Можешь поставить 👍 смешному бреду' : '⏳ Отправляем голос…') : '🕵️ Где правда? Нажми на вариант'}</div>
        <div class="space-y-2">${opts}</div>
        ${liked ? '<div class="text-center text-xs text-pink-300 mt-2">👍 Лайк отправлен (+100 автору)</div>' : '<div class="text-center text-xs text-violet-400 mt-2">👍 — один лайк за самый смешной бред (+100 автору)</div>'}`;
    }

    if (st.phase === 'REVEAL') {
      return `<div class="flex flex-wrap items-center justify-center gap-2 mb-3">${roundBadge(st)}</div>${revealCardHtml(st, false)}`;
    }

    if (st.phase === 'SCORES') {
      const d = (st.lastDeltas || {})[myPlayerId];
      return `<div class="glass rounded-3xl p-5 text-center mb-3 pop-in">
          <div class="text-sm text-violet-300">За этот вопрос</div>
          <div class="font-display font-black text-4xl ${d ? 'text-emerald-400' : 'text-violet-300'}">${d ? '+' + fmt(d.total) : '0'}</div>
          ${d ? `<div class="text-xs text-violet-200 mt-1">${d.parts.map(escapeHtml).join(' • ')}</div>` : '<div class="text-xs text-violet-300 mt-1">В следующий раз повезёт! 🍀</div>'}
        </div>
        <div class="glass rounded-3xl p-4">${scoreboardHtml(st, false, myPlayerId)}</div>
        ${mpRole === 'host' ? '' : `<div class="text-center text-xs text-violet-300 mt-3">Ведущий скоро запустит ${st.round + 1 === st.totalRounds ? 'ФИНАЛ 🔥' : (st.round >= st.totalRounds ? 'итоги 🏆' : 'следующий вопрос')}</div>`}`;
    }

    if (st.phase === 'FINAL') {
      const place = sortedPlayers(st).findIndex(p => p.id === myPlayerId) + 1;
      return `<div class="text-center">
        <h2 class="font-display font-black text-3xl neon-title mb-1 pop-in">Игра окончена!</h2>
        <div class="text-violet-200 mb-4">Ты на <b class="text-yellow-300">${place}-м</b> месте</div>
        <div class="glass rounded-3xl p-4">${podiumHtml(st, false)}</div>
        ${mpRole === 'host' ? '' : '<div class="text-xs text-violet-300 mt-3">Ведущий может запустить новую партию — оставайся в комнате</div>'}
      </div>`;
    }
    return '';
  }

  function playerUpdateDynamic(st, me) {
    if (!me || playerHalted) return;
    const players = Object.values(st.players).sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
    const lobby = $('p-lobby-players');
    if (lobby) lobby.innerHTML = players.map(p => playerChip(p, p.id === myPlayerId ? 'border-pink-400' : '')).join('');
    const prog = $('p-progress');
    if (prog) {
      prog.innerHTML = players.map(p => `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border ${p.hasLie ? 'bg-emerald-500/20 border-emerald-400' : 'bg-black/30 border-violet-800'}">${p.avatar} ${p.hasLie ? '✅' : '✍️'}</span>`).join('');
    }
  }

  // ===========================================================================
  // КАТАЛОГ
  // ===========================================================================
  let catalogPack = -1;

  window.filterCatalog = function (packId) {
    catalogPack = packId;
    renderCatalog();
  };

  function renderCatalog() {
    $('catalog-count').textContent = `${PACKS.length} паков • ${ALL_Q.length} вопросов • ответы спрятаны под спойлером`;
    const btn = (id, label) => `<button type="button" onclick="window.filterCatalog(${id})" class="px-3 py-1.5 rounded-xl text-xs font-bold transition ${catalogPack === id ? 'bg-gradient-to-r from-pink-500 to-violet-600 text-white shadow' : 'bg-black/40 border border-violet-800 text-violet-200 hover:border-pink-500'}">${label}</button>`;
    $('catalog-packs').innerHTML = btn(-1, `Все (${ALL_Q.length})`) + PACKS.map(p => btn(p.id, `${p.emoji} ${escapeHtml(p.title)}`)).join('');
    const term = normText($('catalog-search').value);
    const list = ALL_Q.filter(q => (catalogPack === -1 || q.packId === catalogPack) &&
      (!term || normText(q.questionText + ' ' + q.category).includes(term)));
    $('catalog-grid').innerHTML = list.length ? list.map(q => {
      const pack = PACKS.find(p => p.id === q.packId);
      return `<div class="glass rounded-2xl p-4 flex flex-col">
        <div class="flex items-center justify-between gap-2 mb-2 text-[11px]">
          <span class="px-2 py-0.5 rounded-full bg-violet-900/70 border border-violet-700">${pack.emoji} Пак ${pack.id} • #${q.id.slice(-2)}</span>
          <span class="text-violet-300">${escapeHtml(q.category)}</span>
        </div>
        <div class="font-semibold text-sm leading-snug mb-3 flex-1">${questionHtml(q, false)}</div>
        <details class="group">
          <summary class="cursor-pointer select-none text-xs font-bold text-pink-300 hover:text-pink-200">👀 Показать ответ</summary>
          <div class="mt-2 text-sm space-y-1.5">
            <div><span class="text-violet-300">Правда:</span> <b class="text-emerald-300">${escapeHtml(q.answer)}</b></div>
            <div class="text-xs"><span class="text-violet-300">Засчитывается также:</span> ${q.synonyms.map(escapeHtml).join(', ')}</div>
            <div class="text-xs"><span class="text-violet-300">Ложь от игры:</span> ${q.fakeLies.map(escapeHtml).join(' • ')}</div>
            <div class="text-xs text-violet-100/80 bg-black/30 rounded-lg p-2">💡 ${escapeHtml(q.explanation)}</div>
          </div>
        </details>
      </div>`;
    }).join('') : '<div class="col-span-full text-center text-violet-300 py-10">Ничего не найдено 🤷</div>';
  }

  $('catalog-search').addEventListener('input', renderCatalog);

  // ===========================================================================
  // ЛОББИ
  // ===========================================================================
  function showLobbySelect() {
    $('lobby-select').classList.remove('hidden');
    $('host-view').classList.add('hidden');
    $('player-view').classList.add('hidden');
  }

  window.showHostCardAgain = function () {
    $('lobby-host-card').classList.remove('hidden');
    $('lobby-cards').classList.add('md:grid-cols-2');
    $('btn-show-host-card').classList.add('hidden');
    renderResumeBox();
  };

  function renderResumeBox() {
    const box = $('lobby-resume-box');
    const saved = loadHostSession();
    if (!saved || $('lobby-host-card').classList.contains('hidden')) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    const st = saved.state;
    const phaseNames = { LOBBY: 'лобби', LIE: 'ввод лжи', VOTE: 'голосование', REVEAL: 'вскрытие', SCORES: 'таблица лидеров', FINAL: 'финал' };
    box.classList.remove('hidden');
    box.innerHTML = `<div class="glass rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 border-amber-400/50">
      <div class="text-sm">
        <div class="font-bold">🔄 Незакрытая комната <span class="text-yellow-300 font-display font-black tracking-widest">${escapeHtml(st.roomCode)}</span></div>
        <div class="text-violet-300 text-xs">Игроков: ${Object.keys(st.players || {}).length} • этап: ${phaseNames[st.phase] || st.phase}</div>
      </div>
      <div class="flex gap-2">
        <button type="button" onclick="window.resumeHostSession()" class="px-4 py-2 rounded-xl text-sm font-bold bg-gradient-to-r from-amber-400 to-orange-500 text-slate-950">Продолжить</button>
        <button type="button" onclick="window.discardHostSession()" class="px-3 py-2 rounded-xl text-sm font-semibold bg-black/40 border border-violet-700 hover:border-rose-500">Удалить</button>
      </div>
    </div>`;
  }

  // ===========================================================================
  // ИНИЦИАЛИЗАЦИЯ
  // ===========================================================================
  renderSoundButton();
  window.switchMode('online');
  $('create-pack').innerHTML = [`<option value="0">🎲 Все паки вперемешку (${ALL_Q.length})</option>`]
    .concat(PACKS.map(p => `<option value="${p.id}">${p.emoji} ${escapeHtml(p.title)} (${p.questions.length})</option>`)).join('');
  renderAvatarPicker();
  renderResumeBox();

  const lastName = lstore.get('bred_last_name');
  if (lastName) {
    $('join-name').value = lastName;
    $('create-name').value = lastName;
  }
  $('create-play').addEventListener('change', (ev) => {
    $('create-play-box').classList.toggle('hidden', !ev.target.checked);
  });
  $('join-code').addEventListener('input', (ev) => {
    ev.target.value = normalizeRoomCode(ev.target.value);
  });
  ['join-name', 'join-code'].forEach(id => {
    $(id).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') window.startPlayerSession(); });
  });

  const params = new URLSearchParams(window.location.search);
  const invitedRoom = normalizeRoomCode(params.get('room'));
  let savedPlayer = null;
  try { savedPlayer = JSON.parse(sstore.get(PLAYER_SAVE_KEY) || 'null'); } catch (e) {}

  if (savedPlayer && savedPlayer.room && savedPlayer.name && (!invitedRoom || invitedRoom === savedPlayer.room)) {
    // Перезагрузка вкладки игрока — автоматически возвращаемся в игру
    enterPlayerMode(savedPlayer.room, savedPlayer.name, savedPlayer.avatar);
  } else if (invitedRoom) {
    $('join-code').value = invitedRoom;
    $('lobby-heading').textContent = `Приглашение в комнату ${invitedRoom}`;
    $('lobby-sub').textContent = 'Выбери имя и аватар — и вперёд сочинять бред!';
    $('lobby-host-card').classList.add('hidden');
    $('lobby-cards').classList.remove('md:grid-cols-2');
    $('btn-show-host-card').classList.remove('hidden');
    renderResumeBox();
    if (params.get('test') === '1') {
      // Тестовый игрок из кнопки «🧪 Тест-игрок» заходит сам
      const testName = 'Тестер ' + randomString(3, '0123456789');
      enterPlayerMode(invitedRoom, testName, AVATARS[randInt(AVATARS.length)]);
    } else {
      $('join-name').focus();
    }
  }
})();
