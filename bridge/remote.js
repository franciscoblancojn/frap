'use strict';
// Módulo «Remoto»: usar FRAP desde el celular escaneando un QR. Es una puerta aparte del bridge (excepción a la regla de
// "solo 127.0.0.1"), apagada por defecto, que solo existe mientras el usuario la enciende en el panel izquierdo:
//   - modo «local»: escucha en la IP de la Wi-Fi (http://<ip>:<puerto>/m);
//   - modo «remoto»: escucha en 127.0.0.1 y la publica un túnel (tunnels.js: cloudflared / localhost.run / ngrok).
// Cada encendido crea una clave nueva (va en el QR, en el fragmento #k=… para que no viaje en la URL); apagar la invalida
// y desconecta a todos. Cada celular se identifica con un id al azar que guarda su navegador. No entra directo: queda
// «esperando aprobación» hasta que el administrador lo acepta en la laptop (vale mientras siga encendido); se puede
// sacar (ahora) o bloquear (para siempre). Se apaga sola tras N minutos sin uso (por defecto 5).
// El celular solo puede lo de la IA en las sesiones que ya existen: ver la conversación, escribirle, aprobar permisos,
// interrumpir, ver lo que corre en segundo plano y los Mensajes. No crea, cierra ni edita carpetas, secciones,
// sesiones ni módulos; nada de shell, BD, SSH ni archivos sueltos (lista blanca en `handle`).
// Solo librería estándar de Node.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const ws = require('./ws');

const PAGE = path.join(__dirname, 'remote-page.html');
const AGENT_KINDS = new Set(['claude', 'codex', 'opencode']);
const DEFAULT_PORT = process.env.FRAP_REMOTE_PORT != null ? Number(process.env.FRAP_REMOTE_PORT) : 7790;
const FORCE_HOST = process.env.FRAP_REMOTE_HOST || ''; // tests: solo 127.0.0.1

let deps = null; // {frapHome, srcDir, sessions(), sessionInfo(s), attach(sid), write(sid, data), transcript(conv, cwd, since), taskOutput(file), messages, readState(), tunnels, notify(ev)}
const R = {
  on: false, mode: 'local', key: null, server: null, port: 0, url: null, host: null, status: 'off', error: null, reason: null,
  startedAt: 0, lastActivity: 0, timer: null, clients: new Map(), // id → {conn, device, since, last, watch: Set, pending}
  approved: new Set(), // dispositivos aprobados en este encendido (al apagar o sacarlos, se vuelve a pedir)
};

// ---------- configuración (FRAP_HOME/remote.json): modo, apagado automático, bloqueados y nombres ----------
const cfgFile = () => path.join(deps.frapHome, 'remote.json');
function loadCfg() {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch (_) { /* sin configurar */ }
  const autoOff = d.autoOff && typeof d.autoOff === 'object' ? d.autoOff : {};
  return {
    mode: d.mode === 'remote' ? 'remote' : 'local',
    autoOff: { on: autoOff.on !== false, minutes: Number(autoOff.minutes) > 0 ? Math.min(24 * 60, Number(autoOff.minutes)) : 5 },
    blocked: Array.isArray(d.blocked) ? d.blocked.filter((b) => b && /^[\w-]{8,64}$/.test(b.id)) : [],
    names: d.names && typeof d.names === 'object' ? d.names : {},
  };
}
function saveCfg(c) {
  fs.mkdirSync(deps.frapHome, { recursive: true, mode: 0o700 });
  const tmp = `${cfgFile()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, cfgFile());
}

function lanIp() {
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) all.push({ name, ip: a.address });
  }
  const priv = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  const pick = all.find((a) => priv(a.ip) && !/^(docker|br-|veth|virbr|tun|tailscale|zt)/.test(a.name)) || all.find((a) => priv(a.ip)) || all[0];
  return pick ? pick.ip : null;
}

function status() {
  const c = loadCfg();
  const name = (id, label) => c.names[id] || label;
  return {
    on: R.on, status: R.status, mode: R.on ? R.mode : c.mode, url: R.url, error: R.error, reason: R.reason, startedAt: R.startedAt,
    autoOff: c.autoOff, lastActivity: R.lastActivity,
    offAt: R.on && c.autoOff.on ? R.lastActivity + c.autoOff.minutes * 60000 : null,
    connected: [...R.clients.values()].filter((cl) => !cl.pending).map((cl) => ({ id: cl.device.id, label: cl.device.label, name: name(cl.device.id, cl.device.label), since: cl.since, last: cl.last, ip: cl.device.ip })),
    pending: [...R.clients.values()].filter((cl) => cl.pending).map((cl) => ({ ...cl.device, name: name(cl.device.id, cl.device.label), since: cl.since })),
    blocked: c.blocked.map((b) => ({ ...b, name: name(b.id, b.label) })),
    lan: lanIp(),
  };
}
const changed = () => { if (deps) deps.notify({ ev: 'remote', status: status() }); };

// ---------- encender / apagar ----------
async function start(opts = {}) {
  const c = loadCfg();
  if (opts.mode) c.mode = opts.mode === 'remote' ? 'remote' : 'local';
  if (opts.autoOff) c.autoOff = { on: opts.autoOff.on !== false, minutes: Number(opts.autoOff.minutes) > 0 ? Math.min(24 * 60, Number(opts.autoOff.minutes)) : c.autoOff.minutes };
  saveCfg(c);
  if (R.on) stop('reinicio', { silent: true });
  R.mode = c.mode;
  R.key = crypto.randomBytes(24).toString('base64url'); // clave nueva en cada encendido (la del QR)
  R.approved = new Set();
  R.error = null; R.reason = null; R.url = null; R.status = 'starting';
  R.on = true;
  R.startedAt = Date.now();
  R.lastActivity = Date.now();
  R.server = http.createServer(serveHttp);
  R.server.on('upgrade', onUpgrade);
  const host = opts.host || FORCE_HOST || (R.mode === 'local' ? '0.0.0.0' : '127.0.0.1');
  const listen = (port) => new Promise((res, rej) => { R.server.once('error', rej); R.server.listen(port, host, () => { R.server.removeAllListeners('error'); res(); }); });
  try {
    try { await listen(opts.port != null ? opts.port : R.mode === 'local' ? DEFAULT_PORT : 0); } catch (e) { if (e.code === 'EADDRINUSE') await listen(0); else throw e; }
    R.port = R.server.address().port;
    if (R.mode === 'local') {
      const ip = host !== '0.0.0.0' ? host : lanIp();
      if (!ip) throw new Error('No encontré la IP de la red Wi-Fi: ¿estás conectado a una red?');
      R.url = `http://${ip}:${R.port}/m#k=${R.key}`;
    } else {
      const t = await deps.tunnels.start({ id: 'frap-remote', name: 'Remoto (FRAP)', target: { port: R.port }, provider: opts.provider || 'auto', hostRewrite: false });
      let info = t;
      for (let i = 0; i < 120 && info.status === 'starting'; i++) { await new Promise((r) => setTimeout(r, 500)); info = deps.tunnels.list().find((x) => x.id === 'frap-remote') || info; if (!R.on) return status(); }
      if (info.status !== 'online' || !info.url) throw new Error(info.error || 'El túnel no dio una URL pública');
      R.url = `${info.url}/m#k=${R.key}`;
    }
    R.status = 'online';
    clearInterval(R.timer);
    R.timer = setInterval(checkIdle, Number(process.env.FRAP_REMOTE_TICK_MS) || 5000);
    if (R.timer.unref) R.timer.unref();
  } catch (e) {
    stop('error', { silent: true });
    R.error = e.message;
    changed();
    throw e;
  }
  changed();
  return status();
}
function stop(reason = 'apagado', { silent = false } = {}) {
  const wasOn = R.on;
  R.on = false;
  R.status = 'off';
  R.reason = wasOn ? reason : R.reason;
  clearInterval(R.timer);
  for (const cl of [...R.clients.values()]) bye(cl, reason === 'inactividad' ? 'El acceso remoto se apagó por inactividad.' : 'El acceso remoto se apagó en la laptop.');
  R.clients.clear();
  if (R.server) { try { R.server.close(); } catch (_) { /* ya cerrado */ } if (R.server.closeAllConnections) R.server.closeAllConnections(); R.server = null; }
  if (R.mode === 'remote' && deps && deps.tunnels) { try { deps.tunnels.stop('frap-remote'); } catch (_) { /* sin túnel */ } }
  R.key = null; R.url = null; R.port = 0; R.approved = new Set();
  if (!silent) changed();
  return status();
}
function checkIdle() {
  const c = loadCfg();
  if (R.on && c.autoOff.on && Date.now() - R.lastActivity > c.autoOff.minutes * 60000) stop('inactividad');
}
function config(opts = {}) {
  const c = loadCfg();
  if (opts.mode) c.mode = opts.mode === 'remote' ? 'remote' : 'local';
  if (opts.autoOff) c.autoOff = { on: opts.autoOff.on !== false, minutes: Number(opts.autoOff.minutes) > 0 ? Math.min(24 * 60, Number(opts.autoOff.minutes)) : c.autoOff.minutes };
  saveCfg(c);
  changed();
  return status();
}

// ---------- dispositivos ----------
function bye(cl, reason) {
  try { cl.conn.send(JSON.stringify({ ev: 'bye', reason })); } catch (_) { /* cerrado */ }
  setTimeout(() => { try { cl.conn.close(); } catch (_) { /* cerrado */ } }, 50);
}
function kick(id) {
  const cl = R.clients.get(id);
  R.approved.delete(id); // la próxima vez hay que aprobarlo otra vez
  if (cl) { bye(cl, cl.pending ? 'La laptop no aprobó tu conexión.' : 'La laptop te desconectó. Escanea el QR otra vez para volver a entrar.'); R.clients.delete(id); }
  changed();
  return status();
}
function block(id) {
  const c = loadCfg();
  const cl = R.clients.get(id);
  if (!c.blocked.some((b) => b.id === id)) c.blocked.push({ id, label: cl ? cl.device.label : 'Dispositivo', at: new Date().toISOString() });
  saveCfg(c);
  R.approved.delete(id);
  if (cl) { bye(cl, 'Este dispositivo está bloqueado en la laptop.'); R.clients.delete(id); }
  changed();
  return status();
}
/** Aceptar a un dispositivo que espera aprobación: entra y no se le vuelve a preguntar en este encendido. */
function approve(id) {
  const cl = R.clients.get(id);
  if (!cl || !cl.pending) throw new Error('Ese dispositivo ya no está esperando');
  cl.pending = false;
  R.approved.add(id);
  R.lastActivity = Date.now();
  welcome(cl);
  changed();
  return status();
}
function welcome(cl) {
  cl.conn.send(JSON.stringify({ ev: 'hello', device: { id: cl.device.id, label: cl.device.label }, autoOff: loadCfg().autoOff }));
  if (deps) deps.notify({ ev: 'remote', status: status(), joined: { id: cl.device.id, label: cl.device.label, name: loadCfg().names[cl.device.id] || cl.device.label } });
}
function unblock(id) {
  const c = loadCfg();
  c.blocked = c.blocked.filter((b) => b.id !== id);
  saveCfg(c);
  changed();
  return status();
}
function rename(id, name) {
  const c = loadCfg();
  const n = String(name || '').trim().slice(0, 60);
  if (n) c.names[id] = n; else delete c.names[id];
  saveCfg(c);
  changed();
  return status();
}

// ---------- HTTP: la página móvil y xterm (para leer los menús de claude) ----------
const SEC_HEADERS = {
  'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:",
};
function serveHttp(req, res) {
  const u = new URL(req.url, 'http://x');
  if (req.method !== 'GET') { res.writeHead(405, SEC_HEADERS); res.end(); return; }
  if (u.pathname === '/' || u.pathname === '/m') {
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(PAGE));
    return;
  }
  if (u.pathname === '/vendor/xterm.js') {
    res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=3600' });
    res.end(fs.readFileSync(path.join(deps.srcDir, 'vendor', 'xterm.js')));
    return;
  }
  res.writeHead(404, SEC_HEADERS);
  res.end('No encontrado');
}
const safeEqual = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function onUpgrade(req, socket, head) {
  const u = new URL(req.url, 'http://x');
  const origin = req.headers.origin || '';
  let originHost = '';
  try { originHost = new URL(origin).host; } catch (_) { /* sin Origin */ }
  // solo la propia página (mismo host que pidió el navegador, sea la IP local o el dominio del túnel)
  // en modo túnel la puerta solo escucha en 127.0.0.1 (le llega por el túnel, que anota el host público en x-forwarded-host)
  const okHosts = [req.headers.host].concat(R.mode === 'remote' && req.headers['x-forwarded-host'] ? [String(req.headers['x-forwarded-host']).split(',')[0].trim()] : []);
  if (!R.on || u.pathname !== '/ws' || !originHost || !okHosts.includes(originHost)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const conn = ws.upgrade(req, socket, head);
  let cl = null;
  const hello = setTimeout(() => { if (!cl) conn.close(); }, 8000);
  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!cl) {
      clearTimeout(hello);
      const d = msg && msg.device ? msg.device : {};
      const id = String(d.id || '');
      if (msg.op !== 'hello' || !safeEqual(msg.key, R.key)) { conn.send(JSON.stringify({ ev: 'bye', reason: 'Este QR ya no sirve: el acceso remoto se apagó o se volvió a encender. Escanea el QR nuevo.' })); setTimeout(() => conn.close(), 50); return; }
      if (!/^[\w-]{8,64}$/.test(id)) { conn.close(); return; }
      if (loadCfg().blocked.some((b) => b.id === id)) { conn.send(JSON.stringify({ ev: 'bye', reason: 'Este dispositivo está bloqueado en la laptop.' })); setTimeout(() => conn.close(), 50); return; }
      const prev = R.clients.get(id);
      if (prev) { try { prev.conn.close(); } catch (_) { /* cerrado */ } }
      const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, n);
      // IP real: en modo túnel la conexión viene de 127.0.0.1 y el túnel anota la del celular
      const fwd = R.mode === 'remote' ? String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
      const ip = fwd || String(socket.remoteAddress || '').replace(/^::ffff:/, '');
      const device = {
        id, label: str(d.label || 'Celular', 80), ip,
        ua: str(d.ua || req.headers['user-agent'], 300), model: str(d.model, 80), os: str(d.os, 80),
        lang: str(d.lang, 40), screen: str(d.screen, 40), tz: str(d.tz, 60),
      };
      cl = { conn, device, since: Date.now(), last: Date.now(), watch: new Set(), pending: !R.approved.has(id) };
      R.clients.set(id, cl);
      if (cl.pending) {
        // no entra hasta que el administrador lo apruebe en la laptop
        conn.send(JSON.stringify({ ev: 'pending', reason: 'El administrador tiene que aprobar tu conexión en la laptop.' }));
        if (deps) deps.notify({ ev: 'remote', status: status(), request: { ...device, name: loadCfg().names[id] || device.label, since: cl.since } });
        return;
      }
      R.lastActivity = Date.now();
      welcome(cl);
      return;
    }
    if (R.clients.get(cl.device.id) !== cl) return; // lo sacaron
    const reply = (ok, data) => { if (msg.id != null) conn.send(JSON.stringify(ok ? { re: msg.id, ok: true, data } : { re: msg.id, ok: false, error: data })); };
    Promise.resolve().then(() => handle(cl, msg.op, msg.args || {})).then((d) => reply(true, d), (e) => reply(false, e.message));
  });
  conn.on('close', () => {
    clearTimeout(hello);
    if (cl && R.clients.get(cl.device.id) === cl) { R.clients.delete(cl.device.id); changed(); }
  });
}

// ---------- lo que puede pedir el celular (lista blanca) ----------
const USER_OPS = new Set(['input', 'watch', 'msgSave', 'state']); // las que cuentan como uso (para el apagado automático)
function agentSession(sid) {
  const s = deps.sessions().find((x) => x.sid === sid && !x.closing);
  if (!s) throw new Error('Esa sesión ya no existe');
  const m = s.meta || {};
  if (!AGENT_KINDS.has(m.kind) && !(m.agent && m.agent.tool)) throw new Error('Desde el celular solo se usan las sesiones de IA');
  return s;
}
function handle(cl, op, a) {
  if (cl.pending) throw new Error('Esperando que el administrador apruebe tu conexión');
  cl.last = Date.now();
  if (USER_OPS.has(op) && (op !== 'state' || a.user)) R.lastActivity = Date.now();
  switch (op) {
    case 'ping': return { offAt: status().offAt };
    case 'state': {
      const st = deps.readState();
      const people = deps.people();
      const sessions = deps.sessions().filter((s) => !s.closing).map((s) => {
        const info = deps.sessionInfo(s);
        const m = info.meta || {};
        const p = m.person ? people.find((x) => x.id === m.person) : null;
        return {
          sid: info.sid, projectId: m.projectId || null, kind: m.kind || 'shell', title: (m.named && m.title) || m.title || m.kind || info.sid,
          icon: m.icon || '', person: p ? { name: p.name, icon: p.icon || '👤', color: p.color || '' } : null,
          agent: AGENT_KINDS.has(m.kind) || !!(m.agent && m.agent.tool), alive: info.alive !== false,
          busy: info.alive !== false && Date.now() - (info.lastOutput || 0) < 1500, notice: info.notice || null,
        };
      });
      return {
        sections: (Array.isArray(st.sections) ? st.sections : []).map((x) => ({ id: x.id, title: x.title, icon: x.icon, projects: x.projects || null })),
        projects: (Array.isArray(st.projects) ? st.projects : []).map((p) => ({ id: p.id, name: p.name, folders: p.folders || [] })),
        sessions,
      };
    }
    case 'watch': {
      const s = agentSession(String(a.sid || ''));
      cl.watch.clear();
      cl.watch.add(s.sid);
      return { buffer: deps.attach(s.sid), cols: s.cols || 120, rows: s.rows || 40, info: deps.sessionInfo(s) };
    }
    case 'unwatch': cl.watch.clear(); return true;
    case 'input': {
      const s = agentSession(String(a.sid || ''));
      const data = String(a.data == null ? '' : a.data);
      if (!data || data.length > 20000) throw new Error('Texto vacío o demasiado largo');
      if (s.alive === false) throw new Error('La sesión terminó');
      deps.write(s.sid, data);
      return true;
    }
    case 'transcript': {
      const s = agentSession(String(a.sid || ''));
      const m = s.meta || {};
      const conv = m.agent && m.agent.session;
      if (!conv) return { file: null, size: 0, next: 0, truncated: false, items: [], waiting: true };
      return deps.transcript(conv, m.cwd || '', Number.isInteger(a.since) ? a.since : undefined);
    }
    case 'taskOutput': return deps.taskOutput(String(a.file || ''));
    case 'msgs': return { mensajes: deps.messages.list() };
    case 'msgSave': {
      // solo marcar enviado / pendiente y «copiado»
      const id = Number(a.id);
      const patch = { id };
      if (a.estado !== undefined) patch.estado = a.estado === 'enviado' ? 'enviado' : 'pendiente';
      if (a.copiedAt !== undefined) patch.copiedAt = a.copiedAt ? new Date().toISOString() : null;
      const m = deps.messages.upsert(patch);
      deps.notify({ ev: 'msgs' });
      return m;
    }
    default: throw new Error(`Acción no permitida desde el celular: ${op}`);
  }
}
/** Eventos del bridge que interesan al celular: salida de la sesión que mira y cambios en las sesiones/mensajes. */
function forward(msg) {
  if (!R.on || !R.clients.size || !msg || !msg.ev) return;
  for (const cl of R.clients.values()) {
    if (cl.pending) continue;
    if (msg.ev === 'out' || msg.ev === 'exit') { if (cl.watch.has(msg.sid)) cl.conn.send(JSON.stringify(msg)); }
    else if (msg.ev === 'sessions' || msg.ev === 'notice' || msg.ev === 'msgs') cl.conn.send(JSON.stringify({ ev: msg.ev, sid: msg.sid }));
  }
}

module.exports = {
  init: (d) => { deps = d; }, status, start, stop, config, kick, block, unblock, approve, rename, forward, handle, lanIp,
  _state: R,
};
