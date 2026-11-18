// Сервер игровой сессии: запускается внутри приложения мастера.
// Раздаёт интерфейс (игроки могут зайти и из браузера) и синхронизирует стол по WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/json',
};
const SIDES = [4, 6, 8, 10, 12, 20, 100];
const MAX_LOG = 300;
const MAX_DICE = 30;
const TG = require('./src/tplgeom.cjs');
const GR = require('./src/grid.cjs');

function createServer({ port = 7777, staticDir, saveFile = null, resume = false }) {
  const gmToken = crypto.randomBytes(16).toString('hex');
  const players = new Map(); // clientId -> player
  const log = [];
  const newScene = (id, name, o = {}) => ({ id, name, maps: {}, tokens: {}, scale: 1.5, grid: GR.normGrid(o.grid), terrain: GR.EMPTY_TERRAIN(), combat: { on: false, round: 1, turn: null }, mode: 'free', portals: {}, fog: { on: false, ops: [] }, ...(o.extra || {}) });
  const campaign = { name: 'Новая кампания', active: 's1', scenes: { s1: newScene('s1', 'Сцена 1') } };
  let cont = null; // открытая добыча или лавка
  let vote = null; // голосование за отдых
  // ---- свои 3D-модели (.glb) ----
  const models = new Map(); let modelsSize = 0; const MAX_MODEL = 15 * 1024 * 1024, MAX_MODELS = 120 * 1024 * 1024;
  const modelList = () => [...models].map(([id, m]) => ({ id, name: m.name, by: m.by, size: m.buf.length }));
  // ---- музыка ----
  const tracks = new Map(); // id -> {name, mime, buf}
  const aud = { layers: {}, now: null }; // now: {id, loop, vol, t0}
  let tracksSize = 0; const MAX_AUDIO = 80 * 1024 * 1024;
  let soundAt = null;
  const assetDir = saveFile ? saveFile + '.files' : null;
  const putAsset = (id, meta, buf) => { if (!assetDir) return; try { fs.mkdirSync(assetDir, { recursive: true }); fs.writeFileSync(path.join(assetDir, id + '.bin'), buf); fs.writeFileSync(path.join(assetDir, id + '.json'), JSON.stringify(meta)); } catch {} };
  const delAsset = (id) => { if (!assetDir) return; for (const e of ['.bin', '.json']) try { fs.unlinkSync(path.join(assetDir, id + e)); } catch {} };
  const audioView = () => ({ layers: aud.layers, now: aud.now ? { id: aud.now.id, loop: aud.now.loop, vol: aud.now.vol, pos: (Date.now() - aud.now.t0) / 1000 } : null, tracks: [...tracks].map(([id, t]) => ({ id, name: t.name, size: t.buf.length })) });
  const voteView = () => (vote ? { id: vote.id, kind: vote.kind, byName: vote.byName, byId: vote.byId, yes: vote.yes.size, no: vote.no.size, total: vote.voters.size, ends: vote.ends } : null);
  const voteEnd = (why) => {
    if (!vote) return; const v = vote; vote = null; clearTimeout(v.timer);
    const ok = why === 'force' || (why !== 'cancel' && v.yes.size > v.no.size && v.yes.size > 0);
    broadcast({ t: 'vote', vote: null, result: why === 'cancel' ? 'cancel' : ok ? 'ok' : 'no', kind: v.kind });
    if (ok) each((p) => { if (p.role !== 'gm') send(p.ws, { t: 'rest', kind: v.kind }); });
    pushEntry({ t: 'system', text: why === 'cancel' ? 'Голосование за отдых отменено' : ok ? `Группа отдыхает (${v.kind === 'short' ? 'короткий' : 'длинный'} отдых): за ${v.yes.size}, против ${v.no.size}` : `Отдых не принят: за ${v.yes.size}, против ${v.no.size}` });
  };
  const voteCheck = () => { if (!vote) return; const t = vote.voters.size; if (vote.yes.size * 2 > t) voteEnd('yes'); else if (vote.no.size * 2 >= t) voteEnd('no'); else if (vote.yes.size + vote.no.size >= t) voteEnd('end'); else broadcast({ t: 'vote', vote: voteView() }); };
  const cleanItem = (i) => ({ id: String(i.id || '').slice(0, 20), name: String(i.name || '').slice(0, 80), qty: lim(i.qty, 1, 9999), w: lim(i.w, 0, 9999), cat: ['weapon', 'armor', 'potion', 'scroll', 'misc'].includes(i.cat) ? i.cat : 'misc', icon: String(i.icon || 'backpack').replace(/[^a-z0-9-]/g, '').slice(0, 24), slot: String(i.slot || '').replace(/[^a-z0-9]/g, '').slice(0, 10), eq: '', desc: String(i.desc || '').slice(0, 600), rar: String(i.rar || '').slice(0, 24) });
  const cleanCoins = (c) => ({ pp: lim(c?.pp, 0, 1e6), gp: lim(c?.gp, 0, 1e7), ep: lim(c?.ep, 0, 1e6), sp: lim(c?.sp, 0, 1e7), cp: lim(c?.cp, 0, 1e7) });
  let scene = campaign.scenes.s1, curId = 's1'; // сцена, с которой работает текущее сообщение
  const COND = ['blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious', 'exhaustion', 'concentrating'];
  const gridH = () => GR.make(scene.grid);
  const turnOrder = () => Object.values(scene.tokens).filter((t) => t.init !== undefined && t.init !== null).sort((a, b) => b.init - a.init || (b.initMod || 0) - (a.initMod || 0) || (a.id < b.id ? -1 : 1));
  const sizeOf = (t) => (t.kind === 'chip' ? Math.max(1, Math.min(4, Math.round(t.size || 1))) : 1);
  const snapTok = (t) => { const [x, z] = gridH().snap(t.x, t.z, sizeOf(t)); t.x = x; t.z = z; };
  const viewId = (p) => (p.role === 'gm' ? campaign.active : (campaign.scenes[p.at] ? p.at : campaign.active));
  const sceneOf = (p) => campaign.scenes[viewId(p)];
  const withScene = (sc, fn) => { const ps = scene, pi = curId; scene = sc; curId = sc.id; try { return fn(); } finally { scene = ps; curId = pi; } };
  const sceneList = () => Object.values(campaign.scenes).map((x) => ({ id: x.id, name: x.name, maps: Object.keys(x.maps).length, tokens: Object.keys(x.tokens).length, portals: Object.keys(x.portals).length, sound: !!x.sound }));
  const forPlayer = (sc, p) => (p.role === 'gm' ? sc : { ...sc, portals: Object.fromEntries(Object.entries(sc.portals).filter(([, v]) => !v.hidden)) });
  const fullScene = (p) => ({ scene: forPlayer(sceneOf(p), p), scenes: p.role === 'gm' ? sceneList() : [], active: viewId(p), campaignName: campaign.name });
  const CLASSES = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'];
  const lim = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
  const hex = (c, d) => (/^#[0-9a-f]{6}$/i.test(c) ? c : d);
  let nextEntry = 1;

  // ---- сохранение стола в файл (карты, фигуры, журнал, места игроков) ----
  if (saveFile && resume) {
    try {
      const d = JSON.parse(fs.readFileSync(saveFile, 'utf8'));
      if (d && d.campaign && d.campaign.scenes && d.campaign.scenes[d.campaign.active]) {
        campaign.name = String(d.campaign.name || campaign.name); campaign.scenes = d.campaign.scenes; campaign.active = d.campaign.active;
      }
      for (const c of Object.values(campaign.scenes)) {
        const base = newScene(c.id, c.name);
        for (const k of Object.keys(base)) if (c[k] === undefined) c[k] = base[k];
        c.grid = GR.normGrid(c.grid); c.terrain = GR.normTerrain(c.terrain);
        if (!c.combat || !c.combat.on) c.combat = { on: false, round: 1, turn: null };
        c.mode = c.mode === 'turns' ? 'turns' : 'free';
        for (const t of Object.values(c.tokens)) withScene(c, () => snapTok(t));
      }
      scene = campaign.scenes[campaign.active]; curId = campaign.active;
      if (d.cont && d.cont.id) cont = d.cont;
      if (d.aud) { aud.layers = d.aud.layers || {}; aud.now = d.aud.now ? { ...d.aud.now, t0: Date.now() } : null; }
      for (const e of d.log || []) log.push(e);
      nextEntry = (log.length ? Math.max(...log.map((e) => e.id || 0)) : 0) + 1;
      for (const p of d.players || []) players.set(p.clientId, { id: p.id, clientId: p.clientId, name: p.name, color: p.color, role: 'player', character: p.character || null, at: p.at, ws: null, online: false });
    } catch {}
  }
  if (assetDir && resume) {
    try {
      for (const f of fs.readdirSync(assetDir)) {
        if (!f.endsWith('.json')) continue; const id = f.slice(0, -5);
        const meta = JSON.parse(fs.readFileSync(path.join(assetDir, f), 'utf8')), buf = fs.readFileSync(path.join(assetDir, id + '.bin'));
        if (meta.kind === 'audio') { tracks.set(id, { name: meta.name, mime: meta.mime, buf }); tracksSize += buf.length; }
        else if (meta.kind === 'model') { models.set(id, { name: meta.name, by: meta.by || '', buf }); modelsSize += buf.length; }
      }
    } catch {}
  }
  if (aud.now && !tracks.has(aud.now.id)) aud.now = null;
  if (scene.sound && !Object.keys(aud.layers).length && !aud.now) { aud.layers = { ...(scene.sound.layers || {}) }; aud.now = scene.sound.now && tracks.has(scene.sound.now.id) ? { ...scene.sound.now, t0: Date.now() } : null; }
  soundAt = scene.id;
  let saveTimer = null, dirty = false;
  function save() {
    dirty = true;
    if (!saveFile) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 1500);
  }
  function flush() {
    if (!saveFile) return;
    clearTimeout(saveTimer); saveTimer = null;
    const data = {
      v: 4, savedAt: Date.now(), campaign, log, cont, aud: { layers: aud.layers, now: aud.now ? { id: aud.now.id, loop: aud.now.loop, vol: aud.now.vol } : null },
      players: [...players.values()].filter((p) => p.role !== 'gm').map((p) => ({ id: p.id, clientId: p.clientId, name: p.name, color: p.color, character: p.character, at: p.at })),
    };
    try {
      fs.mkdirSync(path.dirname(saveFile), { recursive: true });
      fs.writeFileSync(saveFile + '.tmp', JSON.stringify(data));
      try { if (fs.existsSync(saveFile)) fs.copyFileSync(saveFile, saveFile + '.bak'); } catch {}
      fs.renameSync(saveFile + '.tmp', saveFile);
      dirty = false;
    } catch {}
  }

  const autosave = saveFile ? setInterval(() => { if (dirty) flush(); }, 20000) : null; if (autosave && autosave.unref) autosave.unref();
  const httpServer = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    if (u.pathname === '/model' && req.method === 'PUT') {
      const who = players.get(u.searchParams.get('cid') || '');
      if (!who) { res.writeHead(403); return res.end(); }
      const chunks = []; let n = 0, bad = false;
      req.on('data', (c) => { n += c.length; if (n > MAX_MODEL || n + modelsSize > MAX_MODELS) { if (!bad) { bad = true; res.writeHead(413); res.end(); } req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (bad) return;
        const buf = Buffer.concat(chunks);
        if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') { res.writeHead(415); return res.end(); }
        const id = 'm' + crypto.randomBytes(5).toString('hex');
        const md = { name: String(u.searchParams.get('name') || 'модель').slice(0, 40), by: who.name || '', buf }; models.set(id, md); modelsSize += buf.length; putAsset(id, { kind: 'model', name: md.name, by: md.by }, buf);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id }));
        broadcast({ t: 'models', list: modelList() });
      });
      return;
    }
    if (u.pathname.startsWith('/model/')) {
      const m = models.get(u.pathname.slice(7)); if (!m) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': m.buf.length, 'Cache-Control': 'max-age=86400' }); return res.end(m.buf);
    }
    if (u.pathname === '/audio' && req.method === 'PUT') {
      if (u.searchParams.get('token') !== gmToken) { res.writeHead(403); return res.end(); }
      const chunks = []; let n = 0, bad = false;
      req.on('data', (c) => { n += c.length; if (n + tracksSize > MAX_AUDIO) { bad = true; res.writeHead(413); res.end(); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (bad) return;
        const id = 'a' + crypto.randomBytes(5).toString('hex'), buf = Buffer.concat(chunks);
        const tr = { name: String(u.searchParams.get('name') || 'трек').slice(0, 60), mime: String(req.headers['content-type'] || 'audio/mpeg').slice(0, 40), buf }; tracks.set(id, tr); tracksSize += buf.length; putAsset(id, { kind: 'audio', name: tr.name, mime: tr.mime }, buf);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id }));
        broadcast({ t: 'audio', audio: audioView() });
      });
      return;
    }
    if (u.pathname.startsWith('/audio/')) {
      const tr = tracks.get(u.pathname.slice(7)); if (!tr) { res.writeHead(404); return res.end(); }
      const total = tr.buf.length, rg = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (rg) { const a = rg[1] ? +rg[1] : 0, b = rg[2] ? Math.min(+rg[2], total - 1) : total - 1; res.writeHead(206, { 'Content-Type': tr.mime, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 }); return res.end(tr.buf.subarray(a, b + 1)); }
      res.writeHead(200, { 'Content-Type': tr.mime, 'Accept-Ranges': 'bytes', 'Content-Length': total }); return res.end(tr.buf);
    }
    let rel = decodeURIComponent((req.url || '/').split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(staticDir, rel));
    if (!file.startsWith(path.normalize(staticDir))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });


  // ---- переходы между сценами ----
  const sendPortals = (sc) => withScene(sc, () => { each((p) => { if (viewId(p) === sc.id) send(p.ws, { t: 'portals', portals: forPlayer(sc, p).portals }); }); save(); });
  function freeSpot(sc, near) {
    return withScene(sc, () => {
      const H = gridH(), busy = new Set(Object.values(sc.tokens).map((t) => GR.key(...H.cellOf(t.x, t.z))));
      const start = H.cellOf(near ? near[0] : 0, near ? near[1] : 0), seen = new Set([GR.key(...start)]), q = [start];
      for (let i = 0; i < q.length && i < 400; i++) {
        const c = q[i], k = GR.key(c[0], c[1]);
        if (!busy.has(k) && sc.terrain.cells[k] !== 'b') return H.center(c[0], c[1]);
        for (const [a, b] of H.neighbors(c[0], c[1])) { const nk = GR.key(a, b); if (!seen.has(nk)) { seen.add(nk); q.push([a, b]); } }
      }
      return near || [0, 0];
    });
  }
  // переносит игрока вместе с его фигуркой в другую сцену; остальные в старой сцене видят, как фигурка уходит
  function movePlayer(p, toId, pos) {
    const to = campaign.scenes[toId]; if (!to) return;
    const from = campaign.scenes[viewId(p)];
    let proto = null;
    if (from) withScene(from, () => { for (const t of Object.values(from.tokens)) if (t.owner === p.id && t.kind === 'mini') { proto = t; delete from.tokens[t.id]; sbc({ t: 'tok:del', id: t.id }); } });
    p.at = toId;
    if (proto) {
      const [x, z] = freeSpot(to, pos);
      const n = { ...proto, id: crypto.randomBytes(5).toString('hex'), x, z, used: 0, init: null };
      withScene(to, () => { snapTok(n); to.tokens[n.id] = n; });
      withScene(to, () => { each((q) => { if (q !== p && viewId(q) === toId) send(q.ws, { t: 'tok', token: n }); }); });
    }
    send(p.ws, { t: 'scene:set', ...fullScene(p) });
    save();
  }
  // мастер переходит в сцену (all=true: ведёт за собой всех игроков)
  function applySceneSound(sc) {
    if (soundAt === sc.id) return; soundAt = sc.id;
    const so = sc.sound; if (!so) return;
    aud.layers = { ...(so.layers || {}) };
    aud.now = so.now && tracks.has(so.now.id) ? { id: so.now.id, loop: !!so.now.loop, vol: so.now.vol ?? 1, t0: Date.now() } : null;
    broadcast({ t: 'audio', audio: audioView() });
  }
  function gotoScene(id, all) {
    campaign.active = id;
    if (all) for (const p of players.values()) if (p.role !== 'gm' && p.at !== id) movePlayer(p, id);
    scene = campaign.scenes[id]; curId = id;
    each((p) => { if (p.role === 'gm') send(p.ws, { t: 'scene:set', ...fullScene(p) }); });
    sendPlayers(); if (all) applySceneSound(scene); save();
  }

  const wss = new WebSocketServer({ server: httpServer, maxPayload: 40 * 1024 * 1024 });

  const pub = (p) => ({ id: p.id, name: p.name, color: p.color, role: p.role, online: p.online, character: p.character, at: p.role === 'gm' ? null : viewId(p) });
  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const each = (fn) => { for (const p of players.values()) if (p.ws) fn(p); };
  const broadcast = (msg) => { each((p) => send(p.ws, msg)); if (msg.t !== 'players') save(); };
  const sbc = (msg) => { each((p) => { if (viewId(p) === curId) send(p.ws, msg); }); save(); };
  const toGm = (msg) => { each((p) => { if (p.role === 'gm') send(p.ws, msg); }); save(); };
  const sendPlayers = () => broadcast({ t: 'players', players: [...players.values()].map(pub) });
  const visibleTo = (entry, p) => !entry.hidden || p.role === 'gm' || entry.from === p.id;

  function pushEntry(entry) {
    entry.id = nextEntry++;
    entry.ts = Date.now();
    log.push(entry);
    if (log.length > MAX_LOG) log.shift();
    each((p) => { if (visibleTo(entry, p)) send(p.ws, { t: 'entry', entry }); });
    save();
  }

  function doRoll(p, m) {
    const groups = Array.isArray(m.dice) ? m.dice : [];
    const dice = [];
    for (const g of groups) {
      const sides = Number(g.sides), count = Math.floor(Number(g.count));
      if (!SIDES.includes(sides) || !(count >= 1)) continue;
      for (let i = 0; i < count && dice.length < MAX_DICE; i++) dice.push({ sides, value: crypto.randomInt(1, sides + 1) });
    }
    let mod = Math.round(Number(m.mod) || 0);
    mod = Math.max(-999, Math.min(999, mod));
    if (!dice.length && !mod) return;
    let mode = m.mode === 'adv' || m.mode === 'dis' ? m.mode : 'normal';
    const d20 = dice.findIndex((d) => d.sides === 20);
    if (mode !== 'normal' && d20 >= 0 && dice.length < MAX_DICE + 1) {
      const extra = { sides: 20, value: crypto.randomInt(1, 21) };
      dice.splice(d20 + 1, 0, extra);
      const a = dice[d20];
      const dropFirst = mode === 'adv' ? a.value < extra.value : a.value > extra.value;
      (dropFirst ? a : extra).dropped = true;
    } else mode = 'normal';
    const total = dice.reduce((s, d) => s + (d.dropped ? 0 : d.value), 0) + mod;
    pushEntry({
      t: 'roll', from: p.id, name: p.name, color: p.color, role: p.role,
      charName: String(m.charName || '').slice(0, 60), label: String(m.label || '').slice(0, 80),
      dice, mod, total, mode, hidden: !!m.hidden && p.role === 'gm',
      seed: crypto.randomInt(1, 2 ** 31),
    });
  }

  wss.on('connection', (ws) => {
    let me = null;
    const onMsg = (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (/^(cont|item|xp|audio|char|rest|tpl|model)/.test(String(m.t))) setTimeout(save, 50);

      if (m.t === 'hello') {
        const clientId = String(m.clientId || '').slice(0, 64);
        if (!clientId) return send(ws, { t: 'error', text: 'Нет идентификатора клиента' });
        let p = players.get(clientId);
        if (!p) {
          p = { id: crypto.randomBytes(4).toString('hex'), clientId, role: 'player', character: null };
          players.set(clientId, p);
        } else if (p.ws && p.ws !== ws) { try { p.ws.close(4001, 'replaced'); } catch {} }
        p.name = String(m.name || 'Игрок').trim().slice(0, 24) || 'Игрок';
        p.color = /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : '#b8862f';
        if (m.token && m.token === gmToken) p.role = 'gm';
        if (m.character !== undefined) p.character = m.character || null;
        if (!campaign.scenes[p.at]) p.at = campaign.active;
        p.ws = ws; p.online = true; me = p;
        if (cont) setTimeout(() => send(ws, { t: 'cont', cont }), 50);
        if (vote) setTimeout(() => send(ws, { t: 'vote', vote: voteView() }), 60);
        setTimeout(() => send(ws, { t: 'audio', audio: audioView() }), 80);
        setTimeout(() => send(ws, { t: 'models', list: modelList() }), 90);
        send(ws, { t: 'welcome', id: p.id, role: p.role, players: [...players.values()].map(pub), log: log.filter((e) => visibleTo(e, p)), ...fullScene(p) });
        sendPlayers();
        pushEntry({ t: 'system', text: `${p.name} ${p.role === 'gm' ? 'открывает стол' : 'садится за стол'}` });
        return;
      }
      if (!me) return;
      scene = sceneOf(me); curId = scene.id;

      if (m.t === 'roll') doRoll(me, m);
      else if (m.t === 'chat') {
        const text = String(m.text || '').trim().slice(0, 600);
        if (text) pushEntry({ t: 'chat', from: me.id, name: me.name, color: me.color, role: me.role, text });
      } else if (m.t === 'char') {
        me.character = m.character || null;
        sendPlayers(); save();
      } else if (m.t === 'map:add' && me.role === 'gm') {
        const mp = m.map;
        if (!mp || typeof mp.src !== 'string' || !mp.src.startsWith('data:image/') || mp.src.length > 36e6 || Object.keys(scene.maps).length >= 8) return;
        const map = { id: crypto.randomBytes(6).toString('hex'), src: mp.src, w: lim(mp.w, 1, 20000), h: lim(mp.h, 1, 20000), x: lim(mp.x, -40, 40), z: lim(mp.z, -26, 26), size: 30, locked: false };
        scene.maps[map.id] = map;
        sbc({ t: 'map', map });
      } else if (m.t === 'map:upd' && me.role === 'gm') {
        const map = scene.maps[m.id]; if (!map) return;
        if (m.x !== undefined) map.x = lim(m.x, -40, 40);
        if (m.z !== undefined) map.z = lim(m.z, -26, 26);
        if (m.size !== undefined) map.size = lim(m.size, 4, 120);
        if (m.locked !== undefined) map.locked = !!m.locked;
        sbc({ t: 'map:upd', id: map.id, x: map.x, z: map.z, size: map.size, locked: map.locked });
      } else if (m.t === 'map:del' && me.role === 'gm') {
        if (scene.maps[m.id]) { delete scene.maps[m.id]; sbc({ t: 'map:del', id: m.id }); }
      } else if (m.t === 'scale' && me.role === 'gm') {
        scene.scale = lim(m.v, 0.3, 3);
        sbc({ t: 'scale', v: scene.scale });
      } else if (m.t === 'tpl:add' && m.tpl) {
        const T = m.tpl; if (!['cone', 'sphere', 'line', 'cube'].includes(T.shape)) return;
        scene.templates = scene.templates || {};
        if (Object.keys(scene.templates).length >= 40) { const first = Object.keys(scene.templates)[0]; delete scene.templates[first]; sbc({ t: 'tpl:del', ids: [first] }); }
        const tpl = { id: crypto.randomBytes(4).toString('hex'), owner: me.id, shape: T.shape, x: lim(T.x, -60, 60), z: lim(T.z, -40, 40), rot: lim(T.rot, -7, 7), ft: lim(Math.round(T.ft / 5) * 5, 5, 300), name: String(T.name || '').slice(0, 30), color: me.color };
        tpl.save = String(T.save || '').slice(0, 24); tpl.dc = lim(T.dc, 0, 40);
        scene.templates[tpl.id] = tpl; sbc({ t: 'tpl', tpl });
        if (tpl.name) {
          const hit = TG.hits(tpl, scene.tokens, scene.grid).filter((k) => !k.hidden || me.role === 'gm');
          const names = hit.map((k) => k.name || (k.kind === 'chip' ? 'Фишка' : 'Миниатюра'));
          pushEntry({ t: 'system', text: `${me.name}: «${tpl.name}» (${tpl.shape === 'sphere' ? 'сфера' : tpl.shape === 'cone' ? 'конус' : tpl.shape === 'line' ? 'линия' : 'куб'} ${tpl.ft} фт.)${names.length ? ` — в области: ${names.join(', ')}` : ' — в области никого'}${tpl.save && names.length ? `. Спасбросок ${tpl.save}${tpl.dc ? ', СЛ ' + tpl.dc : ''}` : ''}` });
        }
      } else if (m.t === 'tpl:del') {
        const all = scene.templates || {}, ids = Object.keys(all).filter((id) => (m.all && me.role === 'gm') || (m.mine && all[id].owner === me.id) || (m.id && String(m.id) === id && (me.role === 'gm' || all[id].owner === me.id)));
        for (const id of ids) delete all[id]; if (ids.length) sbc({ t: 'tpl:del', ids });
      } else if (m.t === 'ping') {
        const now = Date.now(); if (now - (me.lastPing || 0) < 400) return; me.lastPing = now;
        sbc({ t: 'ping', x: lim(m.x, -40, 40), z: lim(m.z, -26, 26), color: me.color, name: me.name });
      } else if (String(m.t).startsWith('fog:') && me.role === 'gm') {
        const f = scene.fog || (scene.fog = { on: false, ops: [] });
        if (m.t === 'fog:set') f.on = !!m.on;
        else if (m.t === 'fog:add' && Array.isArray(m.r) && m.r.length === 4) {
          const r = m.r.map((v, i) => lim(v, i % 2 ? -26 : -40, i % 2 ? 26 : 40));
          f.ops.push({ r: [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])], reveal: !!m.reveal });
          if (f.ops.length > 500) f.ops.splice(0, f.ops.length - 500);
          f.on = true;
        } else if (m.t === 'fog:clear') { f.ops = []; f.on = true; }
        else if (m.t === 'fog:all') { f.ops = [{ r: [-40, -26, 40, 26], reveal: true }]; }
        else return;
        sbc({ t: 'fog', fog: f });
      } else if ((m.t === 'show:send' || m.t === 'show:hide') && me.role === 'gm') {
        if (m.t === 'show:hide') { each((p) => send(p.ws, { t: 'show:hide', id: String(m.id || '').slice(0, 20) })); }
        else {
          const k = m.kind === 'speech' ? 'speech' : 'handout';
          const it = { t: 'show', id: crypto.randomBytes(5).toString('hex'), kind: k, title: String(m.title || '').slice(0, 80), text: String(m.text || '').slice(0, 4000), icon: String(m.icon || '').slice(0, 2),
            img: typeof m.img === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(m.img) && m.img.length < 700000 ? m.img : '' };
          const ids = Array.isArray(m.to) ? new Set(m.to.map(String)) : null;
          each((p) => { if (p.role === 'gm' || !ids || ids.has(p.id)) send(p.ws, it); });
          if (k === 'handout') pushEntry({ t: 'system', text: `Мастер показывает игрокам: «${it.title || 'материал'}»${ids ? ' (избранным)' : ''}` });
        }
      } else if (m.t === 'xp:give' && me.role === 'gm') {
        const ids = Array.isArray(m.to) ? new Set(m.to.map(String)) : null;
        const xp = Math.max(0, Math.min(1000000, Math.floor(Number(m.xp) || 0))), lvl = Math.max(0, Math.min(5, Math.floor(Number(m.lvl) || 0)));
        if (xp || lvl) {
          each((p) => { if (p.role !== 'gm' && (!ids || ids.has(p.id))) send(p.ws, { t: 'xp', xp, lvl }); });
          pushEntry({ t: 'system', text: xp ? `Мастер выдаёт опыт: +${xp}` : 'Мастер разрешает повысить уровень' });
        }
      } else if (m.t === 'item:give' && me.role === 'gm' && m.item && typeof m.item === 'object') {
        const ids = Array.isArray(m.to) ? new Set(m.to.map(String)) : null, i = m.item;
        const item = { id: String(i.id || '').slice(0, 20), name: String(i.name || '').slice(0, 80), qty: lim(i.qty, 1, 9999), w: lim(i.w, 0, 9999), cat: ['weapon', 'armor', 'potion', 'scroll', 'misc'].includes(i.cat) ? i.cat : 'misc', icon: String(i.icon || 'backpack').replace(/[^a-z0-9-]/g, '').slice(0, 24), slot: String(i.slot || '').replace(/[^a-z0-9]/g, '').slice(0, 10), eq: '', desc: String(i.desc || '').slice(0, 600), rar: String(i.rar || '').slice(0, 24) };
        if (item.name) {
          each((p) => { if (p.role !== 'gm' && (!ids || ids.has(p.id))) send(p.ws, { t: 'item', item }); });
          pushEntry({ t: 'system', text: `Мастер выдаёт предмет: ${item.name}${item.qty > 1 ? ` ×${item.qty}` : ''}` });
        }
      } else if (m.t === 'cont:open' && me.role === 'gm' && m.cont) {
        const c = m.cont;
        cont = { id: crypto.randomBytes(4).toString('hex'), kind: c.kind === 'shop' ? 'shop' : 'loot', name: String(c.name || '').slice(0, 60) || (c.kind === 'shop' ? 'Лавка' : 'Добыча'), coins: cleanCoins(c.coins),
          items: (Array.isArray(c.items) ? c.items : []).slice(0, 60).map((x) => ({ item: cleanItem(x.item || {}), price: Math.max(0, Math.min(1e7, Number(x.price) || 0)), qty: lim(x.qty, 1, 9999) })).filter((x) => x.item.name) };
        broadcast({ t: 'cont', cont });
        pushEntry({ t: 'system', text: cont.kind === 'shop' ? `Мастер открывает лавку: ${cont.name}` : `Мастер выкладывает добычу: ${cont.name}` });
      } else if (m.t === 'cont:close' && me.role === 'gm') {
        cont = null; broadcast({ t: 'cont', cont: null });
      } else if (m.t === 'cont:take' && cont) {
        const row = cont.items[lim(m.idx, 0, 9999)], n = lim(m.n, 1, 9999);
        if (row && row.qty >= n) {
          row.qty -= n; if (row.qty <= 0) cont.items.splice(cont.items.indexOf(row), 1);
          send(me.ws, { t: 'cont:got', item: { ...row.item, qty: n }, n, price: cont.kind === 'shop' ? row.price : 0 });
          broadcast({ t: 'cont', cont });
          pushEntry({ t: 'system', text: `${me.name} ${cont.kind === 'shop' ? 'покупает' : 'берёт'}: ${row.item.name}${n > 1 ? ` ×${n}` : ''}` });
        } else send(me.ws, { t: 'cont:fail', why: 'Этого уже нет' });
      } else if (m.t === 'cont:coins' && cont && cont.kind === 'loot') {
        const c = cont.coins; if (c.pp + c.gp + c.ep + c.sp + c.cp > 0) { send(me.ws, { t: 'cont:got', coins: c }); cont.coins = cleanCoins({}); broadcast({ t: 'cont', cont }); pushEntry({ t: 'system', text: `${me.name} забирает монеты из добычи` }); }
      } else if (m.t === 'cont:drop' && m.item) {
        const it = cleanItem(m.item); it.qty = lim(m.item.qty, 1, 9999);
        if (cont && cont.kind === 'shop') send(me.ws, { t: 'cont:got', item: it, n: it.qty, price: 0, back: true });
        else if (it.name) {
          if (!cont) cont = { id: crypto.randomBytes(4).toString('hex'), kind: 'loot', name: 'Брошенные вещи', coins: cleanCoins({}), items: [] };
          const ex = cont.items.find((x) => x.item.name === it.name);
          if (ex) ex.qty += it.qty; else if (cont.items.length < 60) cont.items.push({ item: it, price: 0, qty: it.qty }); else { send(me.ws, { t: 'cont:got', item: it, n: it.qty, price: 0, back: true }); return; }
          broadcast({ t: 'cont', cont });
          pushEntry({ t: 'system', text: `${me.name} кладёт на землю: ${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}` });
        }
      } else if (m.t === 'cont:sell' && m.item) {
        const it = cleanItem(m.item); it.qty = lim(m.item.qty, 1, 9999); it.eq = '';
        if (!cont || cont.kind !== 'shop' || !it.name || cont.items.length >= 60 && !cont.items.find((x) => x.item.name === it.name)) { send(me.ws, { t: 'cont:got', item: it, n: it.qty, price: 0, back: true, coinsBack: lim(m.price, 0, 100000) / 2 * it.qty }); return; }
        const ex = cont.items.find((x) => x.item.name === it.name);
        if (ex) ex.qty += it.qty; else cont.items.push({ item: it, price: lim(m.price, 0, 100000), qty: it.qty });
        broadcast({ t: 'cont', cont });
        pushEntry({ t: 'system', text: `${me.name} продаёт торговцу: ${it.name}${it.qty > 1 ? ` ×${it.qty}` : ''}` });
      } else if (m.t === 'trade:offer' && m.to) {
        const tp = [...players.values()].find((x) => x.id === String(m.to));
        const id = String(m.id || '').slice(0, 20);
        if (!tp || !tp.ws || tp.id === me.id) send(me.ws, { t: 'trade:res', id, ok: false, why: 'Игрок не в сети' });
        else send(tp.ws, { t: 'trade', id, from: me.id, fromName: me.character?.name || me.name, items: (Array.isArray(m.items) ? m.items : []).slice(0, 30).map((x) => { const i = cleanItem(x); i.qty = lim(x.qty, 1, 9999); return i; }).filter((x) => x.name), coins: cleanCoins(m.coins), note: String(m.note || '').slice(0, 200) });
      } else if (m.t === 'trade:reply' && m.to) {
        const tp = [...players.values()].find((x) => x.id === String(m.to));
        if (tp?.ws) send(tp.ws, { t: 'trade:res', id: String(m.id || '').slice(0, 20), ok: !!m.ok, from: me.id, fromName: me.character?.name || me.name });
        if (m.ok) pushEntry({ t: 'system', text: `${me.character?.name || me.name} принимает обмен` });
      } else if (m.t === 'audio:set' && me.role === 'gm') {
        const a = m.audio || {};
        if (a.layers && typeof a.layers === 'object') { const L = {}; for (const k of Object.keys(a.layers).slice(0, 20)) { const v = Number(a.layers[k]); if (v > 0) L[String(k).slice(0, 20)] = Math.min(1, v); } aud.layers = L; }
        if ('now' in a) { const n = a.now; aud.now = n && tracks.has(n.id) ? { id: n.id, loop: !!n.loop, vol: Math.max(0, Math.min(1, Number(n.vol) || 1)), t0: Date.now() } : null; }
        if (a.fx) broadcast({ t: 'audio:fx', fx: String(a.fx).slice(0, 12) });
        broadcast({ t: 'audio', audio: audioView() });
      } else if (m.t === 'audio:bind' && me.role === 'gm') {
        const c = campaign.scenes[String(m.id || campaign.active)]; if (!c) return;
        c.sound = m.clear ? null : { layers: { ...aud.layers }, now: aud.now ? { id: aud.now.id, loop: aud.now.loop, vol: aud.now.vol } : null };
        save(); toGm({ t: 'scene:list', scenes: sceneList(), active: campaign.active, campaignName: campaign.name });
      } else if (m.t === 'model:del' && me.role === 'gm') {
        const md = models.get(String(m.id)); if (md) { modelsSize -= md.buf.length; models.delete(String(m.id)); delAsset(String(m.id)); for (const t of Object.values(scene.tokens)) if (t.model === String(m.id)) t.model = ''; broadcast({ t: 'models', list: modelList() }); sbc({ t: 'tokens:set', tokens: scene.tokens }); save(); }
      } else if (m.t === 'audio:del' && me.role === 'gm') {
        const tr = tracks.get(String(m.id)); if (tr) { tracksSize -= tr.buf.length; tracks.delete(String(m.id)); delAsset(String(m.id)); for (const c of Object.values(campaign.scenes)) if (c.sound?.now?.id === String(m.id)) c.sound.now = null; save(); if (aud.now?.id === String(m.id)) aud.now = null; broadcast({ t: 'audio', audio: audioView() }); }
      } else if (m.t === 'vote:rest') {
        if (vote) return send(me.ws, { t: 'cont:fail', why: 'Голосование уже идёт' });
        const voters = new Set([...players.values()].filter((x) => x.role !== 'gm' && x.ws).map((x) => x.id));
        if (!voters.size) return;
        vote = { id: crypto.randomBytes(3).toString('hex'), kind: m.kind === 'short' ? 'short' : 'long', byName: me.character?.name || me.name, byId: me.id, voters, yes: new Set(), no: new Set(), ends: Date.now() + 90000 };
        if (voters.has(me.id)) vote.yes.add(me.id);
        vote.timer = setTimeout(() => voteEnd('end'), 90000);
        pushEntry({ t: 'system', text: `${vote.byName} предлагает ${vote.kind === 'short' ? 'короткий' : 'длинный'} отдых — голосуем` });
        voteCheck(); if (vote) broadcast({ t: 'vote', vote: voteView() });
      } else if (m.t === 'vote:cast' && vote && String(m.id) === vote.id && vote.voters.has(me.id)) {
        vote.yes.delete(me.id); vote.no.delete(me.id); (m.yes ? vote.yes : vote.no).add(me.id); voteCheck();
      } else if (m.t === 'vote:end' && me.role === 'gm' && vote) {
        voteEnd(m.force ? 'force' : 'cancel');
      } else if (m.t === 'rest:call' && me.role === 'gm') {
        const kind = m.kind === 'short' ? 'short' : 'long';
        each((p) => { if (p.role !== 'gm') send(p.ws, { t: 'rest', kind }); });
        pushEntry({ t: 'system', text: kind === 'short' ? 'Мастер объявляет короткий отдых' : 'Мастер объявляет длинный отдых' });
      } else if (m.t === 'tok:add' && m.token) {
        const src = m.token, kind = src.kind === 'chip' && me.role === 'gm' ? 'chip' : 'mini';
        let tok = kind === 'mini' && me.role !== 'gm' ? Object.values(scene.tokens).find((x) => x.owner === me.id && x.kind === 'mini') : null;
        if (!tok) {
          if (Object.keys(scene.tokens).length >= 200) return;
          tok = { id: crypto.randomBytes(5).toString('hex'), owner: me.id, kind, x: lim(src.x, -40, 40), z: lim(src.z, -26, 26), rot: 0, used: 0 };
          scene.tokens[tok.id] = tok;
        }
        tok.size = kind === 'chip' ? Math.max(1, Math.min(4, Math.round(Number(src.size) || 1))) : 1;
        tok.speed = lim(Math.round((Number(src.speed) || 30) / 5) * 5, 0, 300);
        snapTok(tok);
        tok.cls = CLASSES.includes(src.cls) ? src.cls : 'fighter';
        tok.model = kind === 'mini' && typeof src.model === 'string' && models.has(src.model) ? src.model : '';
        tok.icon = String(src.icon || '☠').slice(0, 2);
        tok.img = kind === 'chip' && typeof src.img === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(src.img) && src.img.length < 45000 ? src.img : '';
        tok.name = String(src.name || '').slice(0, 30);
        if (me.role === 'gm') tok.hidden = !!src.hidden;
        tok.num = lim(src.num, 0, 99);
        tok.color = hex(src.color, me.color);
        if (src.hpMax !== undefined) { tok.hpMax = lim(Math.round(src.hpMax), 0, 9999); tok.hp = lim(Math.round(src.hp ?? src.hpMax), -999, 9999); }
        tok.ac = src.ac !== undefined ? lim(Math.round(src.ac), 0, 40) : tok.ac;
        tok.initMod = lim(Math.round(src.initMod || 0), -10, 20);
        if (kind === 'chip' && me.role === 'gm') tok.xp = lim(Math.round(src.xp || 0), 0, 200000);
        if (!Array.isArray(tok.cond)) tok.cond = [];
        sbc({ t: 'tok', token: tok });
      } else if (m.t === 'tok:upd') {
        const tok = scene.tokens[m.id];
        if (!tok || (me.role !== 'gm' && tok.owner !== me.id)) return;
        if (me.role !== 'gm' && scene.combat.on && scene.combat.turn !== tok.id && (m.x !== undefined || m.z !== undefined)) {
          send(me.ws, { t: 'toast', text: 'Сейчас не ваш ход' }); send(me.ws, { t: 'tok', token: tok }); return;
        }
        if (m.x !== undefined) tok.x = lim(m.x, -40, 40);
        if (m.z !== undefined) tok.z = lim(m.z, -26, 26);
        if (m.rot !== undefined) tok.rot = lim(m.rot, -1000, 1000);
        if (m.speed !== undefined) tok.speed = lim(Math.round(Number(m.speed) / 5) * 5, 0, 300);
        if (m.used !== undefined) tok.used = lim(m.used, 0, 2000);
        if (m.hidden !== undefined && me.role === 'gm') tok.hidden = !!m.hidden;
        if (m.size !== undefined && tok.kind === 'chip') tok.size = Math.max(1, Math.min(4, Math.round(Number(m.size) || 1)));
        if (m.hp !== undefined) tok.hp = lim(Math.round(m.hp), -999, 9999);
        if (m.hpMax !== undefined) tok.hpMax = lim(Math.round(m.hpMax), 0, 9999);
        if (m.init !== undefined) tok.init = m.init === null ? null : lim(Math.round(m.init), -20, 60);
        if (Array.isArray(m.cond)) tok.cond = [...new Set(m.cond.filter((c) => COND.includes(c)))];
        if (m.x !== undefined || m.z !== undefined || m.size !== undefined) snapTok(tok);
        sbc({ t: 'tok', token: tok });
      } else if (m.t === 'tok:del') {
        const tok = scene.tokens[m.id];
        if (!tok || (me.role !== 'gm' && tok.owner !== me.id)) return;
        if (scene.combat.on && scene.combat.turn === m.id) { const ord = turnOrder(), i = ord.findIndex((t) => t.id === m.id); const nx = ord[(i + 1) % ord.length]; scene.combat.turn = nx && nx.id !== m.id ? nx.id : null; if (!scene.combat.turn) scene.combat = { on: false, round: 1, turn: null }; }
        delete scene.tokens[m.id];
        sbc({ t: 'tok:del', id: m.id }); if (scene.combat.turn !== null || !scene.combat.on) sbc({ t: 'combat', combat: scene.combat, tokens: scene.tokens });
      } else if (m.t === 'grid:set' && me.role === 'gm') {
        const old = scene.grid, g = GR.normGrid({ ...old, ...(m.grid || {}) });
        if (g.type !== old.type || (g.type === 'hex' && g.orient !== old.orient)) scene.terrain = GR.EMPTY_TERRAIN();
        scene.grid = g;
        for (const t of Object.values(scene.tokens)) snapTok(t);
        sbc({ t: 'grid', grid: scene.grid, terrain: scene.terrain, tokens: scene.tokens });
      } else if (m.t === 'terrain:paint' && me.role === 'gm') {
        const cells = [], edges = [];
        for (const [k, v] of (Array.isArray(m.cells) ? m.cells : []).slice(0, 400)) {
          if (!/^-?\d+,-?\d+$/.test(k)) continue;
          if (v === 'd' || v === 'b') scene.terrain.cells[k] = v; else delete scene.terrain.cells[k];
          cells.push([k, v === 'd' || v === 'b' ? v : null]);
        }
        for (const [k, v] of (Array.isArray(m.edges) ? m.edges : []).slice(0, 400)) {
          if (!/^-?\d+,-?\d+\|-?\d+,-?\d+$/.test(k)) continue;
          if (typeof v === 'string' && v.length === 1 && 'whdo'.includes(v)) scene.terrain.edges[k] = v; else delete scene.terrain.edges[k];
          edges.push([k, typeof v === 'string' && v.length === 1 && 'whdo'.includes(v) ? v : null]);
        }
        if (Object.keys(scene.terrain.cells).length > 6000 || Object.keys(scene.terrain.edges).length > 6000) return;
        sbc({ t: 'terrain:patch', cells, edges });
      } else if (m.t === 'terrain:clear' && me.role === 'gm') {
        scene.terrain = GR.EMPTY_TERRAIN();
        sbc({ t: 'terrain:set', terrain: scene.terrain });
      } else if (m.t === 'moves:reset' && me.role === 'gm') {
        for (const t of Object.values(scene.tokens)) t.used = 0;
        sbc({ t: 'tokens:set', tokens: scene.tokens });
      } else if (m.t === 'combat:start' && me.role === 'gm') {
        const c = scene.combat; c.on = true; c.round = 1; c.prevMode = scene.mode; scene.mode = 'turns';
        const dMod = (t) => { if (t.initMod !== undefined && t.kind === 'chip') return t.initMod; const ch = [...players.values()].find((p) => p.id === t.owner)?.character; return ch && ch.abilities ? Math.floor((ch.abilities.dex - 10) / 2) + (Number(ch.initBonus) || 0) : (t.initMod || 0); };
        const rolls = [];
        for (const t of Object.values(scene.tokens)) {
          t.used = 0;
          if (t.init === undefined || t.init === null) { if (m.only === 'set') continue; const r = 1 + Math.floor(Math.random() * 20); t.init = r + dMod(t); rolls.push(`${t.name || (t.kind === 'mini' ? 'Герой' : 'Фишка')}${t.num ? ' ' + t.num : ''} ${t.init}`); }
        }
        const ord = turnOrder(); c.turn = ord.length ? ord[0].id : null;
        sbc({ t: 'combat', combat: c, tokens: scene.tokens, mode: scene.mode });
        pushEntry({ t: 'system', text: `Бой начался. Инициатива: ${rolls.join(', ') || 'задана вручную'}` });
      } else if (m.t === 'combat:next' || m.t === 'combat:prev') {
        const c = scene.combat; if (!c.on) return;
        const cur = scene.tokens[c.turn];
        if (me.role !== 'gm' && !(m.t === 'combat:next' && cur && cur.owner === me.id)) return;
        const ord = turnOrder(); if (!ord.length) return;
        let i = ord.findIndex((t) => t.id === c.turn);
        for (let n = 0; n < ord.length; n++) {
          i += m.t === 'combat:next' ? 1 : -1;
          if (i >= ord.length) { i = 0; c.round++; } else if (i < 0) { i = ord.length - 1; c.round = Math.max(1, c.round - 1); }
          if (!(ord[i].kind === 'chip' && ord[i].hpMax > 0 && ord[i].hp <= 0)) break;
        }
        const t = ord[i]; c.turn = t.id; t.used = 0;
        sbc({ t: 'combat', combat: c, tokens: scene.tokens });
        pushEntry({ t: 'system', text: `Раунд ${c.round}: ходит ${t.name || (t.kind === 'mini' ? 'герой' : 'фишка')}${t.num ? ' ' + t.num : ''}` });
      } else if (m.t === 'combat:end' && me.role === 'gm') {
        if (scene.combat.prevMode) scene.mode = scene.combat.prevMode;
        scene.combat = { on: false, round: 1, turn: null };
        for (const t of Object.values(scene.tokens)) t.init = null;
        sbc({ t: 'combat', combat: scene.combat, tokens: scene.tokens, mode: scene.mode });
        pushEntry({ t: 'system', text: 'Бой окончен' });
      } else if (m.t === 'scene:add' && me.role === 'gm') {
        if (Object.keys(campaign.scenes).length >= 30) return;
        const id = 's' + crypto.randomBytes(4).toString('hex');
        campaign.scenes[id] = newScene(id, String(m.name || '').trim().slice(0, 40) || `Сцена ${Object.keys(campaign.scenes).length + 1}`, { grid: { ...scene.grid, ox: 0, oz: 0 } });
        campaign.scenes[id].scale = scene.scale;
        gotoScene(id, m.all !== false);
      } else if (m.t === 'scene:switch' && me.role === 'gm') {
        if (!campaign.scenes[m.id]) return;
        gotoScene(m.id, m.all !== false);
      } else if (m.t === 'scene:gather' && me.role === 'gm') {
        // позвать всех игроков в сцену, на которую смотрит мастер
        for (const p of players.values()) if (p.role !== 'gm' && p.at !== campaign.active) movePlayer(p, campaign.active);
        applySceneSound(campaign.scenes[campaign.active]);
        toGm({ t: 'scene:list', scenes: sceneList(), active: campaign.active, campaignName: campaign.name }); sendPlayers();
      } else if (m.t === 'scene:rename' && me.role === 'gm') {
        const c = campaign.scenes[m.id]; if (!c) return;
        c.name = String(m.name || '').trim().slice(0, 40) || c.name; save();
        toGm({ t: 'scene:list', scenes: sceneList(), active: campaign.active, campaignName: campaign.name });
      } else if (m.t === 'scene:dup' && me.role === 'gm') {
        const c = campaign.scenes[m.id]; if (!c || Object.keys(campaign.scenes).length >= 30) return;
        const id = 's' + crypto.randomBytes(4).toString('hex');
        const maps = {}, tokens = {};
        for (const mp of Object.values(c.maps)) { const n = { ...mp, id: crypto.randomBytes(6).toString('hex') }; maps[n.id] = n; }
        for (const t of Object.values(c.tokens)) if (t.kind !== 'mini') { const n = { ...t, id: crypto.randomBytes(5).toString('hex') }; tokens[n.id] = n; }
        const portals = {}; for (const pt of Object.values(c.portals)) { const n = { ...pt, id: crypto.randomBytes(4).toString('hex') }; portals[n.id] = n; }
        campaign.scenes[id] = { ...newScene(id, (c.name + ' (копия)').slice(0, 40), { grid: c.grid }), maps, tokens, scale: c.scale, terrain: JSON.parse(JSON.stringify(c.terrain || GR.EMPTY_TERRAIN())), portals, mode: c.mode };
        save(); toGm({ t: 'scene:list', scenes: sceneList(), active: campaign.active, campaignName: campaign.name });
      } else if (m.t === 'scene:del' && me.role === 'gm') {
        const ids = Object.keys(campaign.scenes);
        if (ids.length < 2 || !campaign.scenes[m.id]) return;
        const fallback = ids.find((x) => x !== m.id);
        for (const p of players.values()) if (p.role !== 'gm' && p.at === m.id) movePlayer(p, fallback);
        if (m.id === campaign.active) { campaign.active = fallback; }
        delete campaign.scenes[m.id];
        for (const sc of Object.values(campaign.scenes)) for (const pt of Object.values(sc.portals)) if (pt.to === m.id) delete sc.portals[pt.id];
        save();
        each((p) => send(p.ws, { t: 'scene:set', ...fullScene(p) })); sendPlayers();
      } else if (m.t === 'campaign:rename' && me.role === 'gm') {
        campaign.name = String(m.name || '').trim().slice(0, 40) || campaign.name; save();
        toGm({ t: 'scene:list', scenes: sceneList(), active: campaign.active, campaignName: campaign.name });
      } else if (m.t === 'mode:set' && me.role === 'gm') {
        scene.mode = m.mode === 'turns' ? 'turns' : 'free';
        if (scene.mode === 'free') for (const t of Object.values(scene.tokens)) t.used = 0;
        sbc({ t: 'mode', mode: scene.mode, tokens: scene.tokens });
        pushEntry({ t: 'system', text: scene.mode === 'turns' ? 'Режим: по ходам' : 'Режим: свободное перемещение' });
      } else if (m.t === 'portal:add' && me.role === 'gm') {
        if (Object.keys(scene.portals).length >= 60) return;
        let to = String(m.to || '');
        if (to === 'new' || !campaign.scenes[to]) {
          if (Object.keys(campaign.scenes).length >= 30) return;
          to = 's' + crypto.randomBytes(4).toString('hex');
          campaign.scenes[to] = newScene(to, (String(m.name || '').trim() || 'Вход') + ': внутри', { grid: { ...scene.grid, ox: 0, oz: 0 } });
          campaign.scenes[to].scale = scene.scale;
        }
        const g = scene.grid, cell = g.type === 'none' ? 2 : g.size;
        const pt = { id: crypto.randomBytes(4).toString('hex'), name: String(m.name || '').trim().slice(0, 40) || 'Переход', x: lim(m.x, -60, 60), z: lim(m.z, -40, 40), w: lim(m.w, cell * 0.5, 80), h: lim(m.h, cell * 0.5, 80), to, locked: !!m.locked, note: String(m.note || '').slice(0, 200), hidden: !!m.hidden };
        // обратный переход: стоит в целевой сцене, игрок появляется рядом с ним
        const dst = campaign.scenes[to];
        if (m.back !== false && dst !== scene) {
          const dc = dst.grid.type === 'none' ? 2 : dst.grid.size, bw = Math.max(dc, 2 * dc), bx = 0, bz = 0;
          const back = { id: crypto.randomBytes(4).toString('hex'), name: ('Выход: ' + scene.name).slice(0, 40), x: bx, z: bz, w: bw, h: dc, to: scene.id, locked: false, note: '', hidden: false, tx: pt.x, tz: pt.z + pt.h / 2 + cell };
          dst.portals[back.id] = back;
          pt.tx = bx; pt.tz = bz + dc * 1.5;
        }
        scene.portals[pt.id] = pt;
        sendPortals(scene); toGm({ t: 'scene:list', scenes: sceneList(), active: campaign.active, campaignName: campaign.name });
      } else if (m.t === 'portal:upd' && me.role === 'gm') {
        const pt = scene.portals[m.id]; if (!pt) return;
        if (m.name !== undefined) pt.name = String(m.name).trim().slice(0, 40) || pt.name;
        if (m.locked !== undefined) pt.locked = !!m.locked;
        if (m.note !== undefined) pt.note = String(m.note).slice(0, 200);
        if (m.hidden !== undefined) pt.hidden = !!m.hidden;
        if (m.to !== undefined && campaign.scenes[m.to]) pt.to = m.to;
        if (m.x !== undefined) pt.x = lim(m.x, -60, 60);
        if (m.z !== undefined) pt.z = lim(m.z, -40, 40);
        if (m.w !== undefined) pt.w = lim(m.w, 0.5, 80);
        if (m.h !== undefined) pt.h = lim(m.h, 0.5, 80);
        if (m.locked !== undefined) pushEntry({ t: 'system', text: `«${pt.name}»: ${pt.locked ? 'закрыто' : 'открыто'}` });
        sendPortals(scene);
      } else if (m.t === 'portal:del' && me.role === 'gm') {
        if (scene.portals[m.id]) { delete scene.portals[m.id]; sendPortals(scene); }
      } else if (m.t === 'portal:use') {
        const pt = scene.portals[m.id]; if (!pt || me.role === 'gm') return;
        if (pt.hidden) return;
        const tok = Object.values(scene.tokens).find((x) => x.owner === me.id && x.kind === 'mini');
        const g = scene.grid, cell = g.type === 'none' ? 2 : g.size;
        if (!tok) return send(me.ws, { t: 'toast', text: 'Сначала поставьте свою фигурку на стол' });
        const dx = Math.max(0, Math.abs(tok.x - pt.x) - pt.w / 2), dz = Math.max(0, Math.abs(tok.z - pt.z) - pt.h / 2);
        if (Math.hypot(dx, dz) > cell * 1.6) return send(me.ws, { t: 'toast', text: `Подойдите ближе к «${pt.name}»` });
        if (pt.locked) {
          send(me.ws, { t: 'toast', text: `«${pt.name}» закрыто${pt.note ? ': ' + pt.note : ''}` });
          pushEntry({ t: 'system', text: `${me.name} пробует войти: «${pt.name}», но закрыто${pt.note ? ' (' + pt.note + ')' : ''}` });
          return;
        }
        const dst = campaign.scenes[pt.to]; if (!dst) return;
        movePlayer(me, dst.id, pt.tx !== undefined ? [pt.tx, pt.tz] : null);
        pushEntry({ t: 'system', text: `${me.name} входит: «${pt.name}»` });
        sendPlayers();
      } else if (m.t === 'kick' && me.role === 'gm') {
        for (const [cid, p] of players) {
          if (p.id === m.id && p.role !== 'gm') {
            send(p.ws, { t: 'kicked' });
            try { p.ws && p.ws.close(4002, 'kicked'); } catch {}
            players.delete(cid);
            for (const sc of Object.values(campaign.scenes)) withScene(sc, () => { for (const t of Object.values(sc.tokens)) if (t.owner === p.id) { delete sc.tokens[t.id]; sbc({ t: 'tok:del', id: t.id }); } });
            pushEntry({ t: 'system', text: `${p.name} покидает стол` });
          }
        }
        sendPlayers();
      }
    };
    ws.on('message', (raw) => { try { onMsg(raw); } catch (err) { console.error('ws message error:', err && err.message); } });
    ws.on('close', () => {
      if (me && me.ws === ws) { me.ws = null; me.online = false; sendPlayers(); }
    });
    ws.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '0.0.0.0', () => {
      resolve({
        port: httpServer.address().port,
        gmToken,
        flushNow: flush,
        close: () => new Promise((done) => {
          if (autosave) clearInterval(autosave);
          flush();
          for (const c of wss.clients) { try { c.terminate(); } catch {} }
          wss.close(() => httpServer.close(() => done()));
        }),
      });
    });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.argv[2]) || 7777;
  createServer({ port, staticDir: path.join(__dirname, 'dist') }).then((s) => {
    console.log(`Сервер запущен на порту ${s.port}. Токен мастера: ${s.gmToken}`);
  });
}
