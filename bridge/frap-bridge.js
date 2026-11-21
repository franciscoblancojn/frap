#!/usr/bin/env node
'use strict';
// FRAP bridge: puente local entre src/index.html (abierto como file://) y el sistema.
// Sin dependencias: http + WebSocket propio (ws.js) + PTY vía Python (frap_pty.py).
//
//   node bridge/frap-bridge.js [--port 7681] [--open]
//
// Seguridad: solo escucha en 127.0.0.1, exige token (guardado en ~/.config/frap/token)
// y solo acepta Origin "null"/file:// (o los listados en FRAP_ALLOW_ORIGINS).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const net = require('net');
const { StringDecoder } = require('string_decoder');
const ws = require('./ws');
const db = require('./db');
const ssh = require('./ssh');
const sftp = require('./sftp');

const VERSION = '1.3.0';
const STARTED_AT = Date.now();
const HOME = os.homedir();

// ---------- opciones ----------
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}
const PORT = Number(arg('--port', process.env.FRAP_PORT || 7681));
const HOST = '127.0.0.1';
const FRAP_HOME = process.env.FRAP_HOME || path.join(HOME, '.config', 'frap');
const FS_ROOT = path.resolve(process.env.FRAP_FS_ROOT || HOME);
const ALLOW_ORIGINS = (process.env.FRAP_ALLOW_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const BUFFER_MAX = 400 * 1024; // caracteres de scrollback por sesión para re-adjuntar
const PTY_HELPER = path.join(__dirname, 'frap_pty.py');
const PYTHON = process.env.FRAP_PYTHON || 'python3';

fs.mkdirSync(FRAP_HOME, { recursive: true, mode: 0o700 });

// ---------- token ----------
const TOKEN_FILE = path.join(FRAP_HOME, 'token');
let TOKEN = process.env.FRAP_TOKEN || '';
if (!TOKEN) {
  try { TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (_) { /* nuevo */ }
  if (!TOKEN) {
    TOKEN = crypto.randomBytes(18).toString('base64url');
    fs.writeFileSync(TOKEN_FILE, TOKEN + '\n', { mode: 0o600 });
  }
}
function tokenOk(t) {
  const a = Buffer.from(String(t || ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function originOk(origin) {
  if (origin === undefined || origin === 'null' || origin.startsWith('file://')) return true;
  return ALLOW_ORIGINS.includes(origin);
}

// ---------- utilidades fs ----------
function expand(p) {
  if (!p) return HOME;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return path.resolve(p);
}
function safePath(p) {
  const abs = expand(p);
  if (abs !== FS_ROOT && !abs.startsWith(FS_ROOT + path.sep)) {
    throw new Error(`Ruta fuera de ${FS_ROOT}: ${abs}`);
  }
  return abs;
}
function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}
function readHead(p, n = 4096) {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(n);
    const r = fs.readSync(fd, b, 0, n, 0);
    fs.closeSync(fd);
    return b.subarray(0, r).toString('utf8');
  } catch (_) { return ''; }
}
function frontmatter(p) {
  const head = readHead(p);
  const m = head.match(/^---\s*\n([\s\S]*?)\n---/);
  const fm = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const mm = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
      if (mm) fm[mm[1]] = mm[2].replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}
function listMd(dir, recursive = false, prefix = '') {
  const out = [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && recursive) out.push(...listMd(full, true, prefix + e.name + ':'));
    else if (e.isFile() && e.name.endsWith('.md')) out.push({ name: prefix + e.name.slice(0, -3), path: full });
  }
  return out;
}
// Busca <dir>/**/SKILL.md (hasta 4 niveles; p. ej. ~/.claude/skills/synced/<id>/<skill>/).
function listSkills(dir, depth = 0) {
  const out = [];
  if (depth > 3) return out;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    if (!(e.isDirectory() || e.isSymbolicLink()) || e.name.startsWith('.')) continue;
    const sub = path.join(dir, e.name);
    const f = path.join(sub, 'SKILL.md');
    if (exists(f)) out.push({ name: e.name, path: f });
    else out.push(...listSkills(sub, depth + 1));
  }
  return out;
}

// Variables que marcan "estoy dentro de una sesión de Claude Code/Codex". Si el bridge
// se lanzó desde una de ellas, no deben heredarlas las terminales nuevas.
const SCRUB_ENV = /^(CLAUDECODE|CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SESSION_ID|SSE_PORT|EXECPATH)|CLAUDE_AGENT_SDK_VERSION|CODEX_(SANDBOX.*|THREAD_ID|SESSION_ID)|OPENCODE_(SESSION.*|SERVER.*))$/;
function childEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!SCRUB_ENV.test(k)) env[k] = v;
  return { ...env, ...extra };
}
function which(cmd) {
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(d, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* sigue */ }
  }
  return null;
}

// ---------- escaneo de configuración de agentes ----------
function scanConfig(folders) {
  const roots = [{ scope: 'user', base: HOME }];
  for (const f of folders || []) {
    const abs = expand(f);
    if (abs !== HOME && !roots.some((r) => r.base === abs)) roots.push({ scope: 'project', base: abs });
  }
  const res = { agents: [], skills: [], commands: [], hooks: [], memory: [] };
  const add = (kind, tool, scope, base, items) => {
    for (const it of items) {
      const fm = frontmatter(it.path);
      res[kind].push({ tool, scope, root: base, name: fm.name || it.name, description: fm.description || '', path: it.path });
    }
  };
  for (const { scope, base } of roots) {
    const c = path.join(base, '.claude');
    add('agents', 'claude', scope, base, listMd(path.join(c, 'agents')));
    add('commands', 'claude', scope, base, listMd(path.join(c, 'commands'), true));
    add('skills', 'claude', scope, base, listSkills(path.join(c, 'skills')));

    // opencode
    const oc = scope === 'user' ? path.join(HOME, '.config', 'opencode') : path.join(base, '.opencode');
    for (const d of ['agent', 'agents']) add('agents', 'opencode', scope, base, listMd(path.join(oc, d)));
    for (const d of ['command', 'commands']) add('commands', 'opencode', scope, base, listMd(path.join(oc, d)));

    // codex
    if (scope === 'user') {
      add('commands', 'codex', scope, base, listMd(path.join(HOME, '.codex', 'prompts')));
      add('skills', 'codex', scope, base, listSkills(path.join(HOME, '.codex', 'skills')));
    } else {
      add('skills', 'codex', scope, base, listSkills(path.join(base, '.agents', 'skills')));
    }

    // hooks (claude settings)
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = path.join(c, name);
      if (!exists(file)) continue;
      let json;
      try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
        res.hooks.push({ tool: 'claude', scope, root: base, file, event: '(JSON inválido)', matcher: '', command: e.message });
        continue;
      }
      for (const [event, groups] of Object.entries(json.hooks || {})) {
        for (const g of groups || []) {
          for (const h of g.hooks || []) {
            res.hooks.push({ tool: 'claude', scope, root: base, file, event, matcher: g.matcher || '*', command: h.command || h.type || '' });
          }
        }
      }
    }

    // memoria / instrucciones de sistema
    const mem = scope === 'user'
      ? [['claude', path.join(c, 'CLAUDE.md')], ['codex', path.join(HOME, '.codex', 'AGENTS.md')], ['opencode', path.join(oc, 'AGENTS.md')]]
      : [['claude', path.join(base, 'CLAUDE.md')], ['claude', path.join(base, 'CLAUDE.local.md')], ['codex', path.join(base, 'AGENTS.md')]];
    for (const [tool, p] of mem) {
      res.memory.push({ tool, scope, root: base, name: path.basename(p), path: p, exists: exists(p) });
    }
    // settings como "archivo de hooks" editable aunque no tenga hooks
    const settingsFile = path.join(c, 'settings.json');
    res.memory.push({ tool: 'claude', scope, root: base, name: '.claude/settings.json', path: settingsFile, exists: exists(settingsFile) });
  }
  return res;
}

// ---------- procesos ----------
function psTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,ppid=,etimes=,pcpu=,rss=,args='], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      const rows = [];
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
        if (m) rows.push({ pid: +m[1], ppid: +m[2], etime: +m[3], cpu: +m[4], rss: +m[5], args: m[6] });
      }
      resolve(rows);
    });
  });
}
function descendants(rows, rootPid) {
  const byParent = new Map();
  for (const r of rows) {
    if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
    byParent.get(r.ppid).push(r);
  }
  const out = [];
  const walk = (pid, depth) => {
    for (const c of byParent.get(pid) || []) {
      out.push({ ...c, depth });
      walk(c.pid, depth + 1);
    }
  };
  walk(rootPid, 0);
  return out;
}

// ---------- sesiones PTY (persistentes) ----------
// Cada terminal es un proceso frap_pty.py DESLIGADO del bridge, con su propio historial y un
// socket Unix privado. El bridge solo se conecta: si se reinicia o se cae, las terminales siguen
// vivas y al arrancar se reconecta a ellas (rediscoverSessions).
const sessions = new Map();
const clients = new Set();
const SOCK_DIR = path.join(
  process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : os.tmpdir(),
  `frap-${process.getuid ? process.getuid() : 'u'}-${crypto.createHash('sha1').update(path.resolve(FRAP_HOME)).digest('hex').slice(0, 8)}`
);
fs.mkdirSync(SOCK_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(SOCK_DIR, 0o700);
const sockPath = (sid) => path.join(SOCK_DIR, `${sid}.sock`);
const metaPath = (sid) => path.join(SOCK_DIR, `${sid}.json`);
// Avisos de agentes: un hook (p. ej. Stop/Notification de claude) escribe "done" o "waiting <mensaje>"
// en $FRAP_NOTIFY, y el bridge lo publica como evento `notice` para marcar la terminal en la UI.
const notifyPath = (sid) => path.join(SOCK_DIR, `${sid}.notify`);
const NOTICE_KINDS = new Set(['done', 'waiting']);

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) c.send(s);
}
function sessionInfo(s) {
  return {
    sid: s.sid, pid: s.pid, meta: s.meta, created: s.created,
    lastOutput: s.lastOutput, alive: s.alive, exitCode: s.exitCode, notice: s.notice || null,
  };
}
function saveMeta(s) {
  try {
    fs.writeFileSync(metaPath(s.sid), JSON.stringify({ sid: s.sid, pid: s.pid, meta: s.meta, created: s.created }), { mode: 0o600 });
  } catch (_) { /* sin disco: la sesión sigue funcionando */ }
}
function cleanupFiles(sid) {
  for (const f of [sockPath(sid), metaPath(sid), `${sockPath(sid)}.exit`, notifyPath(sid)]) fs.rmSync(f, { force: true });
}

/** Lee y consume el archivo de avisos de una sesión. */
function readNotice(sid) {
  const s = sessions.get(sid);
  const f = notifyPath(sid);
  let text = '';
  try {
    const tmp = `${f}.${process.pid}.read`;
    fs.renameSync(f, tmp); // atómico: lo que el hook escriba después va a un archivo nuevo
    text = fs.readFileSync(tmp, 'utf8').slice(-4096);
    fs.rmSync(tmp, { force: true });
  } catch (_) { return; }
  if (!s) return;
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!line) return;
  const [kind, ...rest] = line.split(' ');
  if (!NOTICE_KINDS.has(kind)) return;
  s.notice = { kind, msg: rest.join(' ').slice(0, 200), at: Date.now() };
  broadcast({ ev: 'notice', sid, notice: s.notice });
}
const noticeTimers = new Map();
function watchNotices() {
  try {
    fs.watch(SOCK_DIR, (_ev, file) => {
      if (!file || !file.endsWith('.notify')) return;
      const sid = file.slice(0, -'.notify'.length);
      clearTimeout(noticeTimers.get(sid));
      noticeTimers.set(sid, setTimeout(() => { noticeTimers.delete(sid); readNotice(sid); }, 40));
    });
  } catch (_) { /* sin inotify: no hay avisos */ }
  for (const f of fs.readdirSync(SOCK_DIR)) if (f.endsWith('.notify')) readNotice(f.slice(0, -'.notify'.length));
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function frame(kind, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'utf8');
  const head = Buffer.alloc(5);
  head.write(kind, 0, 'ascii');
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

function newSessionState(sid, pid, meta, created) {
  return {
    sid, pid, meta, created, lastOutput: 0, alive: true, exitCode: null,
    chunks: [], size: 0, pending: '', timer: null, decoder: new StringDecoder('utf8'), sock: null,
  };
}

function markExited(s, code) {
  if (!s.alive) return;
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if (s.pending) { broadcast({ ev: 'out', sid: s.sid, d: s.pending }); s.pending = ''; }
  s.alive = false;
  s.exitCode = code;
  broadcast({ ev: 'exit', sid: s.sid, code });
  cleanupFiles(s.sid);
  setTimeout(() => sessions.delete(s.sid), 10_000);
}

/** Conecta (o reconecta) el bridge al socket de una sesión. Resuelve cuando llega el historial. */
function connectSession(s) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(sockPath(s.sid));
    let buf = Buffer.alloc(0);
    let gotBacklog = false;
    sock.once('connect', () => { s.sock = sock; });
    sock.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 5) {
        const n = buf.readUInt32BE(1);
        if (buf.length < 5 + n) break;
        const kind = String.fromCharCode(buf[0]);
        const payload = buf.subarray(5, 5 + n);
        buf = buf.subarray(5 + n);
        if (kind === 'B') {
          // historial que guarda la sesión: reemplaza el del bridge (p. ej. tras reiniciarlo)
          const d = new StringDecoder('utf8').write(payload);
          s.chunks = d ? [d] : [];
          s.size = d.length;
          s.pending = '';
          // sesión recién creada: nadie ha visto aún esa salida, se emite como salida normal
          if (s.fresh && d) { s.lastOutput = Date.now(); broadcast({ ev: 'out', sid: s.sid, d }); }
          s.fresh = false;
          if (!gotBacklog) { gotBacklog = true; resolve(s); }
        } else if (kind === 'O') onSessionOutput(s, payload);
        else if (kind === 'X') markExited(s, Number(payload.toString()) || 0);
      }
    });
    sock.on('error', (e) => { if (!gotBacklog) reject(e); });
    sock.on('close', () => {
      if (s.sock === sock) s.sock = null;
      // cerró sin avisar: si el proceso ya no existe, la sesión terminó
      if (s.alive && !pidAlive(s.pid)) {
        let code = null;
        try { code = Number(fs.readFileSync(`${sockPath(s.sid)}.exit`, 'utf8')); } catch (_) { /* sin código */ }
        markExited(s, code);
      }
    });
  });
}

function onSessionOutput(s, buf) {
  const d = s.decoder.write(buf);
  if (!d) return;
  s.lastOutput = Date.now();
  s.chunks.push(d);
  s.size += d.length;
  while (s.size > BUFFER_MAX && s.chunks.length > 1) s.size -= s.chunks.shift().length;
  s.pending += d;
  if (!s.timer) {
    s.timer = setTimeout(() => {
      s.timer = null;
      if (!s.pending) return;
      const out = s.pending;
      s.pending = '';
      broadcast({ ev: 'out', sid: s.sid, d: out });
    }, 4);
  }
  if (s.init && !s.initSent) {
    s.initSent = true;
    setTimeout(() => write(s, s.init + '\r'), 120);
  }
}

async function waitForFile(p, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(p)) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

async function createSession({ cwd, cols = 100, rows = 30, meta = {}, init = '', cmd, env } = {}) {
  const dir = safePath(cwd || HOME);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`No es un directorio: ${dir}`);
  const shell = process.env.SHELL || '/bin/bash';
  const command = Array.isArray(cmd) && cmd.length ? cmd : [shell];
  const sid = `s${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const proc = spawn(PYTHON, [PTY_HELPER, '--sock', sockPath(sid), '--rows', String(rows | 0), '--cols', String(cols | 0), '--', ...command], {
    cwd: dir,
    detached: true, // sesión propia: no muere con el bridge
    stdio: 'ignore',
    env: childEnv({ ...(env || {}), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'frap', FRAP_SESSION: sid, FRAP_NOTIFY: notifyPath(sid) }),
  });
  proc.unref();
  const spawnErr = new Promise((_, reject) => proc.once('error', (e) => reject(new Error(`No se pudo iniciar la terminal: ${e.message}`))));
  const s = newSessionState(sid, proc.pid, { ...meta, cwd: dir }, Date.now());
  s.init = init;
  s.fresh = true;
  sessions.set(sid, s);
  saveMeta(s);
  try {
    const ok = await Promise.race([waitForFile(sockPath(sid), 5000), spawnErr]);
    if (!ok) throw new Error('La terminal no respondió (¿python3 instalado?)');
    await Promise.race([connectSession(s), spawnErr]);
  } catch (e) {
    sessions.delete(sid);
    try { process.kill(proc.pid, 'SIGTERM'); } catch (_) { /* ya no existe */ }
    cleanupFiles(sid);
    throw e;
  }
  if (init) setTimeout(() => { if (!s.initSent) { s.initSent = true; write(s, init + '\r'); } }, 1500);
  broadcast({ ev: 'sessions' });
  return sessionInfo(s);
}

/** Al arrancar: reconecta con las sesiones que siguen vivas de un bridge anterior. */
async function rediscoverSessions() {
  let files = [];
  try { files = fs.readdirSync(SOCK_DIR).filter((f) => f.endsWith('.json')); } catch (_) { return 0; }
  let n = 0;
  await Promise.all(files.map(async (f) => {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(SOCK_DIR, f), 'utf8')); } catch (_) { return; }
    if (!m || !m.sid || sessions.has(m.sid)) return;
    if (!fs.existsSync(sockPath(m.sid)) || !pidAlive(m.pid)) { cleanupFiles(m.sid); return; }
    const s = newSessionState(m.sid, m.pid, m.meta || {}, m.created || Date.now());
    s.initSent = true;
    sessions.set(m.sid, s);
    try {
      await Promise.race([connectSession(s), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
      n++;
    } catch (_) {
      sessions.delete(m.sid);
      if (!pidAlive(m.pid)) cleanupFiles(m.sid);
    }
  }));
  return n;
}

function getSession(sid) {
  const s = sessions.get(sid);
  if (!s) throw new Error(`Sesión no encontrada: ${sid}`);
  return s;
}
function write(s, data) {
  if (s.alive && s.sock && !s.sock.destroyed) s.sock.write(frame('I', String(data)));
}
function killSession(s) {
  if (!s.alive) return;
  if (s.sock && !s.sock.destroyed) s.sock.write(frame('K'));
  else { try { process.kill(s.pid, 'SIGTERM'); } catch (_) { /* ya no existe */ } }
}

// ---------- estado persistente de la UI ----------
const STATE_FILE = path.join(FRAP_HOME, 'state.json');

// ---------- git ----------
// Subcomandos que la vista Git puede ejecutar (el resto, desde una terminal).
const GIT_ALLOWED = new Set([
  'status', 'add', 'restore', 'reset', 'rm', 'mv', 'commit', 'checkout', 'switch', 'branch', 'merge',
  'log', 'show', 'diff', 'pull', 'push', 'fetch', 'stash', 'remote', 'rev-parse', 'tag', 'clean',
  'init', 'blame', 'shortlog', 'describe', 'cherry-pick', 'revert', 'ls-files',
]);

// ---------- bases de datos ----------
const DB_ENV = path.join(FRAP_HOME, 'databases.env');
const DB_CLI = path.join(__dirname, 'frap-db.js');
const SKILL_DIRS = {
  claude: () => path.join(HOME, '.claude', 'skills', 'frap-db'),
  codex: () => path.join(HOME, '.codex', 'skills', 'frap-db'),
};
function dbConns() { return db.loadConnections(DB_ENV); }
function dbConn(id) {
  const c = dbConns().find((x) => x.id === id);
  if (!c) throw new Error(`Conexión no encontrada: ${id}`);
  return c;
}
/** Valida y normaliza una conexión que viene de la UI. `password: null` = conservar la guardada. */
function dbNormalize(input, existing) {
  const engine = String(input.engine || '');
  if (!db.ENGINES[engine]) throw new Error(`Motor no soportado: ${engine}`);
  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre es obligatorio');
  const c = {
    id: existing ? existing.id : '',
    name, engine,
    host: String(input.host || '').trim(),
    port: String(input.port || '').trim(),
    user: String(input.user || '').trim(),
    password: input.password == null ? (existing ? existing.password : '') : String(input.password),
    database: String(input.database || '').trim(),
    uiWrite: input.uiWrite !== undefined ? !!input.uiWrite : existing ? !!existing.uiWrite : false, // false = "Solo lectura" (por defecto)
    enabled: input.enabled !== undefined ? input.enabled !== false : existing ? existing.enabled !== false : true,
    ai: input.ai !== undefined ? input.ai !== false : existing ? existing.ai !== false : true,
  };
  if (c.port && !/^\d{1,5}$/.test(c.port)) throw new Error('Puerto inválido');
  if (engine === 'sqlite') {
    if (!c.database) throw new Error('Indica la ruta del archivo SQLite');
    c.database = safePath(c.database);
  } else if (!c.user) throw new Error('El usuario es obligatorio');
  return c;
}
// ---------- ssh ----------
const SSH_ENV = path.join(FRAP_HOME, 'ssh.env');
const SSH_CLI = path.join(__dirname, 'frap-ssh.js');
// skill de notas: la IA guarda/lee contexto en NOTES.md de la carpeta (vista "Notas" de FRAP)
const NOTES_SKILL_DIRS = {
  claude: () => path.join(HOME, '.claude', 'skills', 'frap-notes'),
  codex: () => path.join(HOME, '.codex', 'skills', 'frap-notes'),
};
function notesSkillText() {
  return `---
name: frap-notes
description: Notas del proyecto en NOTES.md. Úsala cuando el usuario diga "guarda esto en notas", "anota", "agrégalo a las notas", "save this to notes" (escribir) o "lee las notas", "qué tenemos en notas", "revisa las notas", "read the notes" (leer). Es el lugar donde se guarda el contexto entre sesiones.
---

# Notas del proyecto (NOTES.md)

FRAP muestra y edita estas notas en su pestaña "Notas". El archivo es \`NOTES.md\` en la carpeta
raíz del proyecto: el directorio de trabajo con el que se abrió esta sesión (no una subcarpeta).

## Guardar ("guarda esto en notas", "anota…")

1. Si no existe, créalo con el título \`# Notas\`.
   Si la carpeta está en un repo git, agrega la línea \`/NOTES.md\` al \`.gitignore\` de esa misma
   carpeta (créalo si hace falta): es lo que hace FRAP por defecto, salvo que el usuario diga lo contrario.
   Solo al crearlo: si ya existía y no está ignorado, el usuario lo decidió así.
2. Agrega al FINAL una sección con fecha: \`## AAAA-MM-DD — <tema corto>\`.
3. Escribe lo que pidió el usuario o, si dice "esto", un resumen útil para retomar más tarde:
   contexto, decisiones y por qué, pendientes (\`- [ ]\`), comandos, rutas y datos clave.
   Markdown breve; sin secretos (contraseñas, tokens, llaves).
4. No borres ni reescribas lo que ya hay. Para corregir algo existente, pregunta antes.
5. Confirma en una línea qué guardaste.

## Leer ("lee las notas", "qué tenemos en notas"…)

Lee \`NOTES.md\` completo y úsalo como contexto. Si el usuario no pidió algo concreto, resume
en pocas líneas lo más importante y los pendientes. Si no existe, dilo y ofrece crearlo.
`;
}

const SSH_SKILL_DIRS = {
  claude: () => path.join(HOME, '.claude', 'skills', 'frap-ssh'),
  codex: () => path.join(HOME, '.codex', 'skills', 'frap-ssh'),
};
function sshHosts() { return ssh.loadHosts(SSH_ENV); }
function sshHost(id) {
  const c = sshHosts().find((x) => x.id === id);
  if (!c) throw new Error(`Servidor no encontrado: ${id}`);
  return c;
}

// ---------- SFTP (gestor de archivos) ----------
const sftpTransfers = new Map(); // tid -> proceso sftp en curso (para cancelar)
/** Ejecuta comandos sftp en un servidor activo; lanza un Error legible si falla. */
async function sftpRun(id, lines, { timeoutMs, tid } = {}) {
  const c = sshHost(id);
  if (!c.enabled) throw new Error(`El servidor "${c.name}" está desactivado. Actívalo en el panel SSH.`);
  const sshBin = which('ssh');
  if (!sshBin) throw new Error('No se encontró el cliente ssh en el sistema');
  const r = await sftp.runSftp(c, lines, {
    sshBin, timeoutMs, env: ssh.askpassEnv(c, FRAP_HOME, SSH_ENV),
    onSpawn: (child) => { if (tid) sftpTransfers.set(String(tid), child); },
  });
  if (tid) sftpTransfers.delete(String(tid));
  if (r.killed) throw new Error('Transferencia cancelada');
  if (r.timedOut) throw new Error(`Sin respuesta en ${Math.round(timeoutMs / 1000)} s: revisa la IP, la VPN o el firewall.`);
  if (r.code !== 0) {
    const msg = sftp.sftpError(r.stderr, r.code);
    const hint = ssh.sshHint(r.stderr);
    throw new Error(hint ? `${msg}\n→ ${hint}` : msg);
  }
  return r;
}
/** Ruta local para una transferencia: dentro de FRAP_FS_ROOT también tras resolver enlaces simbólicos. */
function sftpLocal(p, { mustExist }) {
  const abs = safePath(p);
  const realRoot = fs.realpathSync(FS_ROOT);
  const inRoot = (r) => r === realRoot || r.startsWith(realRoot + path.sep);
  let st = null;
  try { st = fs.lstatSync(abs); } catch (_) { /* no existe */ }
  if (mustExist) {
    if (!st) throw new Error(`No existe: ${abs}`);
    if (!inRoot(fs.realpathSync(abs))) throw new Error(`Ruta fuera de ${FS_ROOT}: ${abs}`);
  } else {
    if (st && st.isSymbolicLink()) throw new Error(`El destino es un enlace simbólico: ${abs}`);
    if (!inRoot(fs.realpathSync(path.dirname(abs)))) throw new Error(`Ruta fuera de ${FS_ROOT}: ${abs}`);
  }
  return { abs, dir: st ? st.isDirectory() : false };
}
/** Valida y normaliza un servidor que viene de la UI. `password: null` = conservar la guardada. */
function sshNormalize(input, existing) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre es obligatorio');
  const c = {
    id: existing ? existing.id : '',
    name,
    host: String(input.host || '').trim(),
    port: String(input.port || '').trim(),
    user: String(input.user || '').trim(),
    password: input.password == null ? (existing ? existing.password : '') : String(input.password),
    key: String(input.key || '').trim(),
    dir: String(input.dir == null ? (existing && existing.dir) || '' : input.dir).trim().replace(/(.)\/+$/, '$1'),
    enabled: input.enabled !== undefined ? input.enabled !== false : existing ? existing.enabled !== false : true,
    ai: input.ai !== undefined ? input.ai !== false : existing ? existing.ai !== false : false,
  };
  ssh.validateHost(c);
  if (c.key) c.key = safePath(c.key);
  return c;
}
function sshSkillText() {
  const cli = `node ${SSH_CLI}`;
  return `---
name: frap-ssh
description: Ejecutar comandos en los servidores SSH que el usuario habilitó para agentes en FRAP. Úsala cuando necesites revisar logs, procesos, archivos o el estado de un servidor remoto.
---

# Servidores SSH de FRAP

El usuario administra los servidores en FRAP y decide cuáles puede usar un agente. Accede **solo**
con este CLI, que nunca muestra contraseñas:

\`\`\`bash
${cli} list                         # servidores disponibles (id, destino)
${cli} <id> "uptime"                # ejecuta un comando y muestra su salida
${cli} <id> "tail -n 200 /var/log/syslog" --timeout 120
\`\`\`

Reglas:
- \`list\` muestra solo los servidores habilitados para agentes; los demás se rechazan. No intentes entrar por otra vía.
- Sin terminal interactiva: nada que espere entrada (sudo con contraseña, vim, less, top). Usa \`top -bn1\`, \`cat\`, \`tail\`.
- Por defecto solo lectura: inspecciona (ls, cat, tail, grep, ps, df, systemctl status…). **Antes de cualquier cambio** (reiniciar servicios, editar/borrar archivos, instalar paquetes, deploy) pide confirmación explícita al usuario.
- No leas, muestres ni copies el archivo de credenciales (${SSH_ENV}).
`;
}

// ---------- exportar / importar credenciales (BD y SSH) ----------
// Las contraseñas solo salen cifradas con una clave del usuario: scrypt + AES-256-GCM.
function sealSecrets(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { alg: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function openSecrets(sealed, passphrase) {
  if (!sealed || sealed.alg !== 'aes-256-gcm' || sealed.kdf !== 'scrypt') throw new Error('Formato de contraseñas cifradas no reconocido');
  try {
    const key = crypto.scryptSync(String(passphrase || ''), Buffer.from(sealed.salt, 'base64'), 32);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8'));
  } catch (_) {
    throw new Error('Clave incorrecta: no se pudieron descifrar las contraseñas');
  }
}

function skillText() {
  const cli = `node ${DB_CLI}`;
  return `---
name: frap-db
description: Consultar en SOLO LECTURA las bases de datos configuradas en FRAP (MySQL, PostgreSQL, SQLite). Úsala cuando necesites ver datos, tablas o esquemas de una base de datos del proyecto.
---

# Bases de datos de FRAP (solo lectura)

Las conexiones las administra el usuario en FRAP. Accede a ellas **solo** con este CLI,
que nunca muestra contraseñas y rechaza cualquier escritura:

\`\`\`bash
${cli} list                              # conexiones disponibles (id, motor, destino)
${cli} <id> --tables                     # tablas y vistas
${cli} <id> --describe <tabla>           # columnas
${cli} <id> "SELECT … LIMIT 50"          # consulta (salida en tabla)
${cli} <id> "SELECT …" --json --limit 500
\`\`\`

Reglas:
- \`list\` muestra solo las conexiones que el usuario habilitó para agentes; las demás se rechazan.
- Una sola sentencia de lectura por llamada (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN). INSERT/UPDATE/DELETE/DDL se rechazan.
- Usa siempre LIMIT y pide solo las columnas necesarias.
- No leas, muestres ni copies el archivo de credenciales (${DB_ENV}).
- Si necesitas modificar datos, propón el SQL al usuario para que lo ejecute él.
`;
}

// ---------- operaciones RPC ----------
const ops = {
  hello: () => ({
    version: VERSION, home: HOME, fsRoot: FS_ROOT, shell: process.env.SHELL || '/bin/bash',
    platform: process.platform, hostname: os.hostname(),
    tools: { claude: which('claude'), codex: which('codex'), opencode: which('opencode') },
    // la UI lo compara con lo que necesita para detectar un bridge viejo que sigue corriendo
    ops: Object.keys(ops),
    startedAt: STARTED_AT,
  }),
  'sessions.list': () => [...sessions.values()].map(sessionInfo),
  'session.create': (p) => createSession({ ...p, env: undefined }),
  'session.attach': ({ sid }) => {
    const s = getSession(sid);
    // `pending` ya está dentro de `chunks` y se emitirá como evento 'out' después de
    // esta respuesta: se excluye del snapshot para no duplicarlo.
    const all = s.chunks.join('');
    return { ...sessionInfo(s), buffer: all.slice(0, Math.max(0, all.length - s.pending.length)) };
  },
  'session.input': ({ sid, data }) => { write(getSession(sid), String(data)); return true; },
  'session.resize': ({ sid, cols, rows }) => {
    const s = getSession(sid);
    if (s.alive && s.sock && !s.sock.destroyed) s.sock.write(frame('R', `${rows | 0} ${cols | 0}`));
    return true;
  },
  'session.meta': ({ sid, meta }) => {
    const s = getSession(sid);
    Object.assign(s.meta, meta || {});
    saveMeta(s);
    broadcast({ ev: 'sessions' });
    return sessionInfo(s);
  },
  /** El usuario ya vio la terminal: se borra su aviso (done/waiting). */
  'session.seen': ({ sid }) => {
    const s = getSession(sid);
    if (s.notice) {
      s.notice = null;
      broadcast({ ev: 'notice', sid, notice: null });
    }
    return true;
  },
  'session.kill': ({ sid }) => {
    const s = getSession(sid);
    if (s.alive) killSession(s);
    else sessions.delete(sid);
    return true;
  },
  ps: async () => {
    const rows = await psTable();
    const out = {};
    for (const s of sessions.values()) {
      if (!s.alive) continue;
      // descendants del helper python: [shell, ...hijos]
      out[s.sid] = descendants(rows, s.pid);
    }
    return out;
  },
  'proc.kill': ({ pid, signal = 'SIGTERM' }) => {
    return psTable().then((rows) => {
      const allowed = new Set();
      for (const s of sessions.values()) for (const r of descendants(rows, s.pid)) allowed.add(r.pid);
      if (!allowed.has(Number(pid))) throw new Error('Solo se pueden matar procesos de sesiones FRAP');
      process.kill(Number(pid), signal);
      return true;
    });
  },
  'fs.list': ({ path: p, dirsOnly = true, hidden = false, details = false }) => {
    const dir = safePath(p);
    const ents = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => hidden || !e.name.startsWith('.'))
      .map((e) => {
        let isDir = e.isDirectory();
        let st = null;
        if (e.isSymbolicLink() || details) { try { st = fs.statSync(path.join(dir, e.name)); isDir = st.isDirectory(); } catch (_) { /* roto */ } }
        return details ? { name: e.name, dir: isDir, link: e.isSymbolicLink(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 } : { name: e.name, dir: isDir };
      })
      .filter((e) => !dirsOnly || e.dir)
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return { path: dir, parent: dir === FS_ROOT ? null : path.dirname(dir), entries: ents };
  },
  'fs.read': ({ path: p }) => {
    const f = safePath(p);
    const st = fs.statSync(f);
    if (st.size > 2 * 1024 * 1024) throw new Error('Archivo demasiado grande (>2MB)');
    return { path: f, content: fs.readFileSync(f, 'utf8'), mtime: st.mtimeMs };
  },
  'fs.write': ({ path: p, content }) => {
    const f = safePath(p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.frap-tmp-${process.pid}`;
    fs.writeFileSync(tmp, String(content));
    fs.renameSync(tmp, f);
    return { path: f, mtime: fs.statSync(f).mtimeMs };
  },
  'fs.exists': ({ path: p }) => exists(safePath(p)),
  'config.scan': ({ folders }) => scanConfig(folders),
  'db.list': () => ({
    envFile: DB_ENV,
    cli: DB_CLI,
    clients: { mysql: which('mysql'), postgres: which('psql'), sqlite: which('sqlite3') },
    skills: Object.fromEntries(Object.entries(SKILL_DIRS).map(([k, dir]) => [k, exists(path.join(dir(), 'SKILL.md'))])),
    conns: dbConns().map(db.publicConn),
  }),
  'db.save': ({ conn }) => {
    const conns = dbConns();
    const existing = conn && conn.id ? conns.find((c) => c.id === conn.id) : null;
    if (conn && conn.id && !existing) throw new Error(`Conexión no encontrada: ${conn.id}`);
    const c = dbNormalize(conn || {}, existing);
    if (existing) conns[conns.indexOf(existing)] = c;
    else {
      c.id = db.slugify(c.name, new Set(conns.map((x) => x.id)));
      conns.push(c);
    }
    db.saveConnections(DB_ENV, conns, DB_CLI);
    return db.publicConn(c);
  },
  /** Cambia solo los interruptores de una conexión: `enabled` (activa), `ai` (usable por agentes)
   *  y/o `uiWrite` (false = "Solo lectura"; true = la pestaña DB puede escribir, sin eliminaciones). */
  'db.toggle': ({ id, enabled, ai, uiWrite }) => {
    const conns = dbConns();
    const c = conns.find((x) => x.id === id);
    if (!c) throw new Error(`Conexión no encontrada: ${id}`);
    if (enabled !== undefined) c.enabled = !!enabled;
    if (ai !== undefined) c.ai = !!ai;
    if (uiWrite !== undefined) c.uiWrite = !!uiWrite;
    db.saveConnections(DB_ENV, conns, DB_CLI);
    return db.publicConn(c);
  },
  'db.delete': ({ id }) => {
    const conns = dbConns();
    if (!conns.some((c) => c.id === id)) throw new Error(`Conexión no encontrada: ${id}`);
    db.saveConnections(DB_ENV, conns.filter((c) => c.id !== id), DB_CLI);
    return true;
  },
  'db.test': async ({ id, conn }) => {
    const existing = id ? dbConn(id) : conn && conn.id ? dbConns().find((c) => c.id === conn.id) : null;
    const c = { ...(conn ? dbNormalize(conn, existing) : existing), enabled: true };
    const r = await db.runQuery(c, c.engine === 'mysql' ? 'SELECT VERSION() AS version' : c.engine === 'postgres' ? 'SELECT version()' : 'SELECT sqlite_version() AS version', { timeoutMs: 15000 });
    return { ms: r.ms, version: r.rows[0] ? r.rows[0][0] : '' };
  },
  /** Valida sin ejecutar. Lectura → {write:false}; escritura permitida (sin eliminaciones) → {write:true}; si no, error. */
  'db.check': ({ id, sql }) => {
    const c = dbConn(id);
    try { db.assertReadOnly(sql, c.engine); return { write: false }; } catch (e) { if (!c.uiWrite) throw e; }
    db.assertSafeWrite(sql, c.engine);
    return { write: true };
  },
  'db.query': ({ id, sql, write = false, limit = 1000 }) => db.runQuery(dbConn(id), sql, { write: !!write, limit }),
  'db.tables': async ({ id }) => {
    const c = dbConn(id);
    const r = await db.runQuery(c, db.tablesSql(c.engine), { limit: 5000 });
    return r.rows.map(([name, type]) => ({ name, view: /view/i.test(type || '') }));
  },
  'db.installSkill': ({ tools = ['claude', 'codex'] } = {}) => {
    const written = [];
    for (const t of tools) {
      if (!SKILL_DIRS[t]) continue;
      const f = path.join(SKILL_DIRS[t](), 'SKILL.md');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, skillText());
      written.push(f);
    }
    return written;
  },
  'ssh.list': () => ({
    envFile: SSH_ENV,
    cli: SSH_CLI,
    client: which('ssh'),
    skills: Object.fromEntries(Object.entries(SSH_SKILL_DIRS).map(([k, dir]) => [k, exists(path.join(dir(), 'SKILL.md'))])),
    hosts: sshHosts().map(ssh.publicHost),
  }),
  'ssh.save': ({ host }) => {
    const hosts = sshHosts();
    const existing = host && host.id ? hosts.find((c) => c.id === host.id) : null;
    if (host && host.id && !existing) throw new Error(`Servidor no encontrado: ${host.id}`);
    const c = sshNormalize(host || {}, existing);
    if (existing) hosts[hosts.indexOf(existing)] = c;
    else {
      c.id = ssh.slugify(c.name, new Set(hosts.map((x) => x.id)));
      hosts.push(c);
    }
    ssh.saveHosts(SSH_ENV, hosts, SSH_CLI);
    return ssh.publicHost(c);
  },
  'ssh.delete': ({ id }) => {
    const hosts = sshHosts();
    if (!hosts.some((c) => c.id === id)) throw new Error(`Servidor no encontrado: ${id}`);
    ssh.saveHosts(SSH_ENV, hosts.filter((c) => c.id !== id), SSH_CLI);
    return true;
  },
  /** Cambia solo los interruptores: `enabled` (activo) y/o `ai` (usable por agentes). */
  'ssh.toggle': ({ id, enabled, ai }) => {
    const hosts = sshHosts();
    const c = hosts.find((x) => x.id === id);
    if (!c) throw new Error(`Servidor no encontrado: ${id}`);
    if (enabled !== undefined) c.enabled = !!enabled;
    if (ai !== undefined) c.ai = !!ai;
    ssh.saveHosts(SSH_ENV, hosts, SSH_CLI);
    return ssh.publicHost(c);
  },
  /** Prueba un servidor guardado (`id`) o el formulario sin guardar (`host`). Funciona aunque esté desactivado. */
  'ssh.test': async ({ id, host }) => {
    const existing = id ? sshHost(id) : host && host.id ? sshHosts().find((c) => c.id === host.id) : null;
    const c = host ? sshNormalize(host, existing) : existing;
    const env = ssh.askpassEnv(c, FRAP_HOME, SSH_ENV, c.password || undefined);
    const r = await ssh.runRemote(c, 'echo FRAP_OK; uname -srn', { timeoutMs: 20000, env });
    if (r.timedOut) throw new Error('Sin respuesta en 20 s: revisa la IP, la VPN o el firewall.');
    if (r.code !== 0 || !r.stdout.includes('FRAP_OK')) {
      const msg = (r.stderr.trim().split('\n').filter((l) => !/^Warning: Permanently added/.test(l)).pop()) || `ssh terminó con código ${r.code}`;
      const hint = ssh.sshHint(r.stderr);
      throw new Error(hint ? `${msg}\n→ ${hint}` : msg);
    }
    return { ms: r.ms, system: r.stdout.split('FRAP_OK').pop().trim() };
  },
  /** Abre una terminal con `ssh` al servidor (la contraseña la entrega askpass). */
  'ssh.connect': ({ id, cwd, projectId, cols, rows }) => {
    const c = sshHost(id);
    if (!c.enabled) throw new Error(`El servidor "${c.name}" está desactivado. Actívalo en el panel SSH.`);
    return createSession({
      cwd: cwd || FS_ROOT, cols, rows,
      cmd: ['ssh', ...ssh.sshArgs(c)],
      env: ssh.askpassEnv(c, FRAP_HOME, SSH_ENV),
      meta: { projectId: projectId || null, kind: 'ssh', title: c.name, sshId: c.id },
    });
  },
  /**
   * Lista un directorio remoto (`path` absoluto). Sin `path`: la ruta inicial del servidor
   * (si no existe, la carpeta de inicio del usuario, con `startError`).
   */
  'sftp.list': async ({ id, path: p }) => {
    let lines = p ? [`cd ${sftp.quote(sftp.remotePath(p))}`] : [];
    let startError = '';
    const dir = p ? '' : sshHost(id).dir;
    if (dir && dir !== '~') lines = [`cd ${sftp.quote(dir.startsWith('~/') ? dir.slice(2) || '.' : sftp.remotePath(dir))}`];
    let r;
    try {
      r = await sftpRun(id, [...lines, 'pwd', 'ls -la'], { timeoutMs: 30000 });
    } catch (e) {
      if (!dir || dir === '~' || /desactivado|cancelada|Sin respuesta/.test(e.message)) throw e;
      startError = `No se pudo abrir la ruta inicial ${dir}: ${e.message}`;
      r = await sftpRun(id, ['pwd', 'ls -la'], { timeoutMs: 30000 });
    }
    const m = r.stdout.match(/^Remote working directory: (.*)$/m);
    const cwd = m ? m[1] : p || '/';
    return { path: cwd, parent: cwd === '/' ? null : sftp.remotePath(`${cwd}/..`), entries: sftp.parseLs(r.stdout), startError };
  },
  /** Descarga `remote` (archivo o carpeta) a la ruta local completa `local` (dentro de FRAP_FS_ROOT). */
  'sftp.get': async ({ id, remote, local, dir = false, tid }) => {
    const l = sftpLocal(local, { mustExist: false });
    await sftpRun(id, [`get ${dir ? '-R ' : ''}${sftp.quote(sftp.remotePath(remote))} ${sftp.quote(l.abs)}`], { timeoutMs: 0, tid });
    return { local: l.abs };
  },
  /** Sube `local` (archivo o carpeta dentro de FRAP_FS_ROOT) a la ruta remota completa `remote`. */
  'sftp.put': async ({ id, local, remote, tid }) => {
    const l = sftpLocal(local, { mustExist: true });
    await sftpRun(id, [`put ${l.dir ? '-R ' : ''}${sftp.quote(l.abs)} ${sftp.quote(sftp.remotePath(remote))}`], { timeoutMs: 0, tid });
    return { remote: sftp.remotePath(remote) };
  },
  'sftp.cancel': ({ tid }) => {
    const p = sftpTransfers.get(String(tid));
    if (!p) return false;
    p.kill('SIGTERM');
    return true;
  },
  'sftp.mkdir': async ({ id, path: p }) => {
    await sftpRun(id, [`mkdir ${sftp.quote(sftp.remotePath(p))}`]);
    return true;
  },
  'sftp.rename': async ({ id, from, to }) => {
    await sftpRun(id, [`rename ${sftp.quote(sftp.remotePath(from))} ${sftp.quote(sftp.remotePath(to))}`]);
    return true;
  },
  /** Borra un archivo, o una carpeta VACÍA (`dir: true`, rmdir). Nunca borra recursivamente. */
  'sftp.remove': async ({ id, path: p, dir = false }) => {
    const r = sftp.remotePath(p);
    if (r === '/') throw new Error('No se puede borrar la raíz');
    await sftpRun(id, [`${dir ? 'rmdir' : 'rm'} ${sftp.quote(r)}`]);
    return true;
  },
  /** ¿Está instalada la skill frap-notes? {claude, codex} */
  'notes.skill': () => Object.fromEntries(Object.entries(NOTES_SKILL_DIRS).map(([k, dir]) => [k, exists(path.join(dir(), 'SKILL.md'))])),
  'notes.installSkill': ({ tools = ['claude', 'codex'] } = {}) => {
    const written = [];
    for (const t of tools) {
      if (!NOTES_SKILL_DIRS[t]) continue;
      const f = path.join(NOTES_SKILL_DIRS[t](), 'SKILL.md');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, notesSkillText());
      written.push(f);
    }
    return written;
  },
  'ssh.installSkill': ({ tools = ['claude', 'codex'] } = {}) => {
    const written = [];
    for (const t of tools) {
      if (!SSH_SKILL_DIRS[t]) continue;
      const f = path.join(SSH_SKILL_DIRS[t](), 'SKILL.md');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, sshSkillText());
      written.push(f);
    }
    return written;
  },
  /**
   * Exporta conexiones de BD y servidores SSH elegidos. Sin `passphrase` no salen contraseñas;
   * con ella, van en `secrets` cifradas.
   */
  'export.creds': ({ db: dbIds = [], ssh: sshIds = [], passphrase } = {}) => {
    const strip = (c) => { const { password, ...rest } = c; return rest; };
    const conns = dbConns().filter((c) => dbIds.includes(c.id));
    const hosts = sshHosts().filter((c) => sshIds.includes(c.id));
    const out = { db: conns.map(strip), ssh: hosts.map(strip) };
    if (passphrase) {
      if (String(passphrase).length < 6) throw new Error('La clave de cifrado debe tener al menos 6 caracteres');
      out.secrets = sealSecrets({
        db: Object.fromEntries(conns.filter((c) => c.password).map((c) => [c.id, c.password])),
        ssh: Object.fromEntries(hosts.filter((c) => c.password).map((c) => [c.id, c.password])),
      }, passphrase);
    }
    return out;
  },
  /**
   * Importa conexiones y servidores (mismo id = se reemplaza). Si traen `secrets`, hace falta
   * `passphrase`; sin ella se importan sin contraseña (o se conserva la que ya existía).
   */
  'import.creds': ({ db: inDb = [], ssh: inSsh = [], secrets, passphrase } = {}) => {
    const pw = secrets && passphrase != null && passphrase !== '' ? openSecrets(secrets, passphrase) : { db: {}, ssh: {} };
    const result = { db: 0, ssh: 0, errors: [] };
    const conns = dbConns();
    for (const raw of inDb) {
      try {
        const id = db.slugify(String(raw.id || raw.name || ''), new Set()).slice(0, 60);
        const existing = conns.find((c) => c.id === id);
        const password = Object.prototype.hasOwnProperty.call(pw.db || {}, raw.id) ? pw.db[raw.id] : null;
        const c = dbNormalize({ ...raw, password }, existing || { id, password: '' });
        c.id = id;
        if (existing) conns[conns.indexOf(existing)] = c; else conns.push(c);
        result.db++;
      } catch (e) { result.errors.push(`BD ${raw.name || raw.id}: ${e.message}`); }
    }
    if (inDb.length) db.saveConnections(DB_ENV, conns, DB_CLI);
    const hosts = sshHosts();
    for (const raw of inSsh) {
      try {
        const id = db.slugify(String(raw.id || raw.name || ''), new Set()).slice(0, 60);
        const existing = hosts.find((c) => c.id === id);
        const password = Object.prototype.hasOwnProperty.call(pw.ssh || {}, raw.id) ? pw.ssh[raw.id] : null;
        const c = sshNormalize({ ...raw, password }, existing || { id, password: '' });
        c.id = id;
        if (existing) hosts[hosts.indexOf(existing)] = c; else hosts.push(c);
        result.ssh++;
      } catch (e) { result.errors.push(`SSH ${raw.name || raw.id}: ${e.message}`); }
    }
    if (inSsh.length) ssh.saveHosts(SSH_ENV, hosts, SSH_CLI);
    return result;
  },
  /**
   * Ejecuta `git <args>` en `cwd` (sin shell). Nunca lanza por código de salida distinto de 0:
   * devuelve {code, stdout, stderr} para que la UI muestre el error de git tal cual.
   */
  'git.run': ({ cwd, args }) => {
    const dir = safePath(cwd);
    if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string')) throw new Error('Argumentos de git inválidos');
    // opciones que permiten ejecutar comandos arbitrarios (-c core.sshCommand=…, --upload-pack=…)
    if (args.some((a) => /^--(exec|upload-pack|receive-pack)\b|^-c$|^--config-env|^-C$|^--git-dir|^--work-tree/.test(a))) {
      throw new Error('Opción de git no permitida desde la UI');
    }
    const sub = args.find((a) => !a.startsWith('-'));
    if (!GIT_ALLOWED.has(sub)) throw new Error(`Subcomando de git no permitido desde la UI: ${sub || '(ninguno)'}. Usa una terminal para eso.`);
    return new Promise((resolve, reject) => {
      execFile('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], {
        cwd: dir,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
        env: childEnv({
          GIT_TERMINAL_PROMPT: '0', // sin credenciales: falla en vez de colgarse esperando
          GIT_EDITOR: 'true', // merges/rebases no abren editor
          GIT_PAGER: 'cat',
          GIT_OPTIONAL_LOCKS: '0',
          SSH_ASKPASS_REQUIRE: 'never',
        }),
      }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') { reject(new Error('git no está instalado')); return; }
        if (err && err.killed) { reject(new Error('git tardó demasiado (¿pide credenciales? usa una terminal)')); return; }
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
      });
    });
  },
  /**
   * De una lista de rutas candidatas (detectadas en la salida de una terminal), devuelve las que
   * existen. Las relativas se resuelven contra `cwd` (la carpeta de la terminal).
   */
  'paths.check': ({ cwd, paths }) => {
    const base = cwd ? safePath(cwd) : HOME;
    const out = [];
    for (const raw of (Array.isArray(paths) ? paths : []).slice(0, 80)) {
      if (typeof raw !== 'string' || !raw || raw.length > 1024) continue;
      const p = raw.startsWith('~') ? expand(raw) : path.resolve(base, raw);
      let abs;
      try { abs = safePath(p); } catch (_) { continue; }
      try {
        const st = fs.statSync(abs);
        out.push({ input: raw, path: abs, dir: st.isDirectory() });
      } catch (_) { /* no existe */ }
    }
    return out;
  },
  /** Abre un archivo/carpeta en el editor (por defecto VS Code: `code -g ruta:línea:col`). */
  'open.editor': ({ path: p, line, col, editor = 'code' }) => {
    const abs = safePath(p);
    if (!exists(abs)) throw new Error(`No existe: ${abs}`);
    const [cmd, ...extra] = String(editor || 'code').trim().split(/\s+/);
    if (!cmd || /[;&|`$<>]/.test(editor)) throw new Error('Comando de editor inválido');
    const ln = Number(line) > 0 ? Math.floor(Number(line)) : 0;
    const cl = Number(col) > 0 ? Math.floor(Number(col)) : 0;
    // editores de la familia VS Code entienden --goto ruta:línea:columna
    const vscodeLike = /^(code|code-insiders|codium|vscodium|cursor|windsurf)$/.test(path.basename(cmd));
    const args = vscodeLike && ln ? [...extra, '--goto', `${abs}:${ln}${cl ? ':' + cl : ''}`] : [...extra, abs];
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: childEnv({}) });
      child.once('error', (e) => reject(new Error(e.code === 'ENOENT' ? `No se encontró el editor "${cmd}". Cámbialo en ⚙ Ajustes.` : e.message)));
      child.once('spawn', () => { child.unref(); resolve({ opened: abs, cmd: [cmd, ...args].join(' ') }); });
    });
  },
  /** Título/autor de un video (oEmbed público de YouTube, sin API key). */
  'music.ytInfo': async ({ id }) => {
    if (!/^[\w-]{11}$/.test(String(id || ''))) throw new Error('ID de video de YouTube inválido');
    const u = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(u, { signal: ctrl.signal });
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'El video no permite incrustarse' : r.status === 404 ? 'Video no encontrado' : `YouTube respondió ${r.status}`);
      const j = await r.json();
      return { title: String(j.title || ''), author: String(j.author_name || '') };
    } finally { clearTimeout(t); }
  },
  'state.get': () => {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (_) { return null; }
  },
  'state.set': ({ state }) => {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
    return true;
  },
};

// ---------- servidor ----------
// ---------- reproductor de YouTube ----------
// YouTube rechaza embeds desde file:// (error 153: sin Referer). Esta página se sirve en
// http://127.0.0.1:<puerto>/yt-player, se incrusta como iframe en la UI y hace de relé:
// UI --postMessage--> esta página --IFrame API--> YouTube. No usa el token ni el WebSocket
// (y el WS rechaza su Origin http), así que no da acceso al bridge.
const YT_PLAYER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>FRAP · YouTube</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#p{width:100%;height:100%}</style></head>
<body><div id="p"></div>
<script>
var player, ready = false, queued = [];
function send(m) { m.frap = 'yt'; parent.postMessage(m, '*'); }
function handle(m) {
  if (!ready) { queued.push(m); return; }
  switch (m.cmd) {
    case 'load': if (m.volume != null) player.setVolume(m.volume); player.loadVideoById(m.id); break;
    case 'play': player.playVideo(); break;
    case 'pause': player.pauseVideo(); break;
    case 'stop': player.stopVideo(); break;
    case 'seek': player.seekTo(m.time, true); break;
    case 'volume': player.setVolume(m.volume); break;
  }
}
window.onYouTubeIframeAPIReady = function () {
  player = new YT.Player('p', {
    width: '100%', height: '100%',
    playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: function () { ready = true; send({ type: 'ready' }); queued.splice(0).forEach(handle); },
      onStateChange: function (e) { var d = player.getVideoData() || {}; send({ type: 'state', state: e.data, title: d.title || '', videoId: d.video_id || '' }); },
      onError: function (e) { send({ type: 'error', code: e.data }); }
    }
  });
};
addEventListener('message', function (e) {
  if (e.source !== parent || !e.data || e.data.frap !== 'yt') return;
  handle(e.data);
});
setInterval(function () {
  if (ready && player.getCurrentTime) send({ type: 'time', time: player.getCurrentTime() || 0, duration: player.getDuration() || 0 });
}, 500);
var s = document.createElement('script');
s.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(s);
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/yt-player') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'cache-control': 'no-store',
    });
    res.end(YT_PLAYER_HTML);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ name: 'frap-bridge', version: VERSION }));
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const deny = (code, msg) => {
    socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`);
  };
  if (!originOk(req.headers.origin)) return deny(403, 'Forbidden origin');
  if (!tokenOk(url.searchParams.get('token'))) return deny(401, 'Unauthorized');
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') return deny(400, 'Bad Request');

  const conn = ws.upgrade(req, socket, head);
  clients.add(conn);
  conn.on('close', () => clients.delete(conn));
  conn.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    const fn = ops[msg.op];
    // input/resize son "fire and forget": sin id no se responde
    try {
      if (!fn) throw new Error(`Operación desconocida: ${msg.op}`);
      const data = await fn(msg.args || {});
      if (msg.id != null) conn.send(JSON.stringify({ re: msg.id, ok: true, data }));
    } catch (e) {
      if (msg.id != null) conn.send(JSON.stringify({ re: msg.id, ok: false, error: e.message }));
    }
  });
});

// Cerrar el bridge NO cierra las terminales (siguen vivas para el próximo bridge),
// salvo con --kill-sessions.
function shutdown() {
  if (argv.includes('--kill-sessions')) for (const s of sessions.values()) killSession(s);
  for (const s of sessions.values()) if (s.sock) s.sock.end();
  setTimeout(() => {
    try { fs.rmdirSync(SOCK_DIR); } catch (_) { /* quedan terminales vivas: se conserva */ }
    process.exit(0);
  }, 50);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// primero se reconecta a las terminales que siguen vivas; luego acepta a la UI
let recovered = 0;
rediscoverSessions().then((n) => { recovered = n; }, () => {}).then(watchNotices).then(() => server.listen(PORT, HOST, () => {
  const page = path.resolve(__dirname, '..', 'src', 'index.html');
  const url = `file://${page}#port=${PORT}&token=${TOKEN}`;
  if (process.env.FRAP_QUIET !== '1') {
    console.log(`FRAP bridge v${VERSION} escuchando en ws://${HOST}:${PORT}`);
    if (recovered) console.log(`Reconectado a ${recovered} terminal${recovered === 1 ? '' : 'es'} abierta${recovered === 1 ? '' : 's'}.`);
    console.log('Ctrl+C cierra el bridge; las terminales siguen vivas (usa --kill-sessions para cerrarlas también).');
    console.log(`Abre en el navegador:\n  ${url}`);
  }
  if (process.send) process.send({ ready: true, port: server.address().port });
  if (argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
  }
}));
server.on('error', (e) => {
  console.error(`No se pudo iniciar el bridge: ${e.message}`);
  process.exit(1);
});
