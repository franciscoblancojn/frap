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
const issues = require('./issues');
const tunnels = require('./tunnels');
const scripts = require('./scripts');
const wordpress = require('./wordpress');
const aveonline = require('./aveonline');
const apiReq = require('./api');
const team = require('./team');
const todos = require('./todos');

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
// Carpetas permitidas para fs.*: FS_ROOT ($HOME) y, además, las extra de FRAP_FS_EXTRA (separadas por ":") y
// del archivo FRAP_HOME/fs-roots (una por línea; lo edita la UI con fs.addRoot / fs.removeRoot), p. ej. /var/www.
// Nunca "/", carpetas del sistema ni carpetas genéricas (/var, /usr, /opt…): solo carpetas de proyectos.
const FS_ROOTS_FILE = path.join(FRAP_HOME, 'fs-roots');
const FS_FORBIDDEN_UNDER = ['/proc', '/sys', '/dev', '/boot', '/etc', '/root', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/usr', '/run', '/snap'];
const FS_FORBIDDEN_EXACT = ['/', '/var', '/opt', '/home', '/tmp', '/srv', '/mnt', '/media'];
/** Valida una carpeta extra: absoluta y que no sea del sistema. Devuelve la ruta normalizada o lanza. */
function checkExtraRoot(p) {
  const raw = String(p || '').trim();
  if (!raw.startsWith('/') && !raw.startsWith('~')) throw new Error('La carpeta debe ser una ruta absoluta (p. ej. /var/www)');
  const abs = expand(raw).replace(/\/+$/, '') || '/';
  const under = (r, base) => r === base || r.startsWith(base + '/');
  if (FS_FORBIDDEN_EXACT.includes(abs) || FS_FORBIDDEN_UNDER.some((b) => under(abs, b))) throw new Error(`No se permite ${abs}: elige la carpeta de tus proyectos (p. ej. /var/www)`);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch (_) { /* aún no existe: se valida la ruta tal cual */ }
  if (real !== abs && (FS_FORBIDDEN_EXACT.includes(real) || FS_FORBIDDEN_UNDER.some((b) => under(real, b)))) throw new Error(`No se permite ${abs} (apunta a ${real})`);
  return abs;
}
function readExtraRoots() {
  const out = [];
  const add = (p, source) => {
    try { const r = checkExtraRoot(p); if (r !== FS_ROOT && !out.some((x) => x.path === r)) out.push({ path: r, source }); } catch (_) { /* inválida: se ignora */ }
  };
  for (const p of (process.env.FRAP_FS_EXTRA || '').split(':')) if (p.trim()) add(p, 'env');
  let text = '';
  try { text = fs.readFileSync(FS_ROOTS_FILE, 'utf8'); } catch (_) { /* sin archivo */ }
  for (const line of text.split(/\r?\n/)) if (line.trim() && !line.trim().startsWith('#')) add(line, 'file');
  return out;
}
let fsExtra = readExtraRoots();
const fsRoots = () => [FS_ROOT, ...fsExtra.map((x) => x.path)];
const inAnyRoot = (abs, roots = fsRoots()) => roots.some((r) => abs === r || abs.startsWith(r === '/' ? '/' : r + path.sep));
function safePath(p) {
  const abs = expand(p);
  if (!inAnyRoot(abs)) {
    throw new Error(`Ruta fuera de ${fsRoots().join(', ')}: ${abs}`);
  }
  return abs;
}
function saveExtraRoots() {
  const lines = ['# Carpetas extra que FRAP puede abrir (además de tu carpeta personal). Una por línea.', ...fsExtra.filter((x) => x.source === 'file').map((x) => x.path), ''];
  const tmp = `${FS_ROOTS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, FS_ROOTS_FILE);
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
/** [{pid, sess}]: id de sesión de Unix de cada proceso (para cerrar todo lo que cuelga de una terminal). */
function psSessions() {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,sess='], { maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      resolve(out.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((x) => x.length === 2 && x[0] && x[1]).map(([pid, sess]) => ({ pid, sess })));
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
const SOCK_DIR = team.sockDirFor(FRAP_HOME); // misma fórmula que usan los CLI (frap-team quien) para encontrar su sesión
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
// ---------- pendientes: la IA los escribe con frap-todo (sin pasar por el bridge) → se avisa a la UI ----------
const todosMtimeNow = () => { try { return fs.statSync(todos.TODO_FILE).mtimeMs; } catch (_) { return 0; } }; // 0 = aún no existe
let todosMtime = todosMtimeNow();
setInterval(() => {
  const m = todosMtimeNow();
  if (m !== todosMtime) { todosMtime = m; broadcast({ ev: 'todos' }); }
}, 2000).unref();

// ---------- conversación de claude de cada terminal ----------
// Claude Code escribe ~/.claude/sessions/<pid>.json con el sessionId de cada proceso. Se busca el claude que corre
// dentro de cada terminal y se guarda en su meta (`agent: {tool, session}`): al reabrir las terminales tras reiniciar
// el equipo, cada una retoma SU conversación con `claude --resume <id>` (con --continue todas abrían la última de la carpeta).
const CLAUDE_SESSIONS_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'sessions');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function claudeSessionOf(pid) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, `${pid}.json`), 'utf8'));
    return m && Number(m.pid) === Number(pid) && UUID_RE.test(String(m.sessionId || '')) ? String(m.sessionId) : null;
  } catch (_) { return null; }
}
async function scanAgentSessions() {
  const live = [...sessions.values()].filter((s) => s.alive && !s.closing);
  if (!live.length) return;
  const rows = await psTable();
  let changed = false;
  for (const s of live) {
    let id = null;
    for (const r of descendants(rows, s.pid)) { id = claudeSessionOf(r.pid); if (id) break; }
    if (!id) continue; // sin claude ahora: se conserva la última conocida (sirve para retomarla)
    const cur = s.meta.agent;
    if (cur && cur.tool === 'claude' && cur.session === id) continue;
    s.meta.agent = { tool: 'claude', session: id };
    saveMeta(s);
    changed = true;
  }
  if (changed) broadcast({ ev: 'sessions' });
}
/**
 * Conversaciones de claude de una carpeta (~/.claude/projects/<carpeta con "-">/<id>.jsonl), las más recientes
 * primero: tema (primer mensaje del usuario o el resumen), último mensaje, issues mencionadas y si ya está abierta
 * en una terminal de FRAP. Se lee solo el principio y el final de cada archivo (pueden pesar decenas de MB).
 */
const CLAUDE_PROJECTS_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'projects');
function readSlice(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, start); return b.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}
function userText(j) {
  if (!j || j.type !== 'user' || !j.message) return '';
  const c = j.message.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x && x.type === 'text') || {}).text || '' : '';
  const s = String(t).trim();
  if (!s || /^(Base directory for this skill|<|\[Request interrupted|Caveat:)/.test(s)) return '';
  return s.replace(/\s+/g, ' ');
}
function claudeConversations(cwd, limit = 40) {
  const dir = path.join(CLAUDE_PROJECTS_DIR, path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && UUID_RE.test(f.slice(0, -6))); } catch (_) { return []; }
  const open = new Map();
  for (const s of sessions.values()) if (s.alive && s.meta.agent && s.meta.agent.session) open.set(s.meta.agent.session, { sid: s.sid, title: s.meta.title || '' });
  const list = files.map((f) => { const full = path.join(dir, f); const st = fs.statSync(full); return { id: f.slice(0, -6), file: full, mtime: st.mtimeMs, size: st.size }; })
    .sort((a, b) => b.mtime - a.mtime).slice(0, Math.min(200, Math.max(1, Number(limit) || 40)));
  const out = [];
  for (const c of list) {
    const HEAD = 512 * 1024;
    const head = readSlice(c.file, 0, Math.min(c.size, HEAD));
    const tail = c.size > HEAD ? readSlice(c.file, Math.max(0, c.size - 256 * 1024), 256 * 1024) : head;
    let first = '';
    let summary = '';
    let skill = '';
    let last = '';
    let userCount = 0;
    const issues = new Set();
    for (const l of head.split('\n')) {
      let j; try { j = JSON.parse(l); } catch (_) { continue; }
      if (j.type === 'summary' && j.summary && !summary) summary = String(j.summary);
      const raw = j.type === 'user' && j.message ? JSON.stringify(j.message.content).slice(0, 4000) : '';
      if (!skill) { const m = raw.match(/skills\/([\w.-]+)/); if (m && /Base directory for this skill/.test(raw)) skill = m[1]; }
      const t = userText(j);
      if (t) { userCount++; if (!first) first = t; }
      for (const m of (t.match(/\b[A-Z]{2,6}-\d{1,6}\b/g) || [])) issues.add(m);
    }
    let lastAi = '';
    for (const l of tail.split('\n')) {
      let j; try { j = JSON.parse(l); } catch (_) { continue; }
      const t = userText(j);
      if (t) last = t;
      if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) { const x = j.message.content.find((y) => y && y.type === 'text' && String(y.text).trim()); if (x) lastAi = String(x.text).replace(/\s+/g, ' ').trim(); }
    }
    if (!first && !summary && !last) continue; // vacía o solo interna
    for (const m of (`${last} ${lastAi}`.match(/\b[A-Z]{2,6}-\d{1,6}\b/g) || [])) issues.add(m);
    out.push({
      id: c.id, mtime: c.mtime, size: c.size, title: summary || (first || last).slice(0, 120), first: first.slice(0, 200), last: last.slice(0, 200), lastAi: lastAi.slice(0, 220),
      skill, issues: [...issues].slice(0, 6), open: open.get(c.id) || null,
    });
  }
  return out;
}
setInterval(() => { scanAgentSessions().catch(() => {}); }, Number(process.env.FRAP_AGENT_SCAN_MS) || 15000).unref();

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
      if (s.meta.closing) { s.closing = true; killSession(s, { escalate: true }); return; } // se estaba cerrando
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
const KILL_GRACE_MS = Number(process.env.FRAP_KILL_GRACE_MS) || 4000;
/**
 * Cierra una sesión: SIGHUP (lo manda frap_pty.py, como al cerrar una terminal). Con `escalate`, si a los
 * KILL_GRACE_MS sigue viva (claude, por ejemplo, captura SIGHUP y no termina), SIGTERM a todo su árbol de
 * procesos y, si aún sigue, SIGKILL. Así la ✕ cierra de verdad y la terminal no vuelve al recargar.
 */
function killSession(s, { escalate = false } = {}) {
  if (!s.alive) return;
  if (s.sock && !s.sock.destroyed) s.sock.write(frame('K'));
  else { try { process.kill(s.pid, 'SIGTERM'); } catch (_) { /* ya no existe */ } }
  if (!escalate) return;
  const signalTree = async (sig) => {
    if (!s.alive) return;
    const rows = await psTable();
    const tree = descendants(rows, s.pid);
    // la shell es líder de su sesión de Unix: los programas que quedaron huérfanos al morir ella (claude
    // capturando SIGHUP) ya no son sus hijos, pero siguen en esa sesión y con la terminal abierta
    const leaders = new Set(tree.filter((r) => r.depth === 0).map((r) => r.pid));
    const pids = new Set(tree.map((r) => r.pid));
    for (const r of await psSessions()) if (leaders.has(r.sess) && r.pid !== s.pid) pids.add(r.pid);
    for (const pid of pids) { try { process.kill(pid, sig); } catch (_) { /* ya no existe */ } }
  };
  setTimeout(() => signalTree('SIGTERM').then(() => setTimeout(() => signalTree('SIGKILL'), KILL_GRACE_MS / 2)), KILL_GRACE_MS).unref?.();
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
// ---------- integración WordPress ----------
const WP_ENV = path.join(FRAP_HOME, 'wordpress.env');
function wpSites() { return wordpress.loadSites(WP_ENV); }
/** Valida y normaliza una conexión de la UI. Token vacío o null al editar = conservar el guardado. */
function wpNormalize(input, existing, { allowNoToken = false, tokenHelp = 'créalo en WordPress → FRAP → Tokens' } = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('El nombre es obligatorio');
  const token = input.token == null || String(input.token).trim() === '' ? (existing ? existing.token : '') : String(input.token).trim();
  if (!token && !allowNoToken) throw new Error(`El token es obligatorio (${tokenHelp})`);
  if (token && (/\s/.test(token) || token.length > 200)) throw new Error('Token inválido');
  return {
    id: existing ? existing.id : '',
    name,
    url: wordpress.normalizeUrl(input.url),
    token,
    enabled: input.enabled !== undefined ? input.enabled !== false : existing ? existing.enabled !== false : true,
    ai: input.ai !== undefined ? input.ai !== false : existing ? existing.ai !== false : true,
  };
}
// ---------- integración Aveonline (revisión por token del plugin de envíos) ----------
const AVE_ENV = path.join(FRAP_HOME, 'aveonline.env');
function aveSites() { return aveonline.loadSites(AVE_ENV); }
const AVE_TOKEN_HELP = 'actívalo en la tienda: Aveonline → Revisión por token';
function aveNormalize(input, existing, opts = {}) { return wpNormalize(input, existing, { tokenHelp: AVE_TOKEN_HELP, ...opts }); }
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
// ---------- voz: transcripción local con whisper.cpp (módulo de voz del panel derecho) ----------
// La UI graba, arma un WAV 16 kHz mono y lo manda en base64; el bridge lo escribe en un tmpdir propio (0700),
// corre whisper.cpp y lo borra. Sin red: el binario y el modelo viven en FRAP_HOME/whisper
// (scripts/install-whisper.sh) o se indican con FRAP_WHISPER_BIN / FRAP_WHISPER_MODEL.
const WHISPER_DIR = path.join(FRAP_HOME, 'whisper');
const WHISPER_INSTALL = `bash ${path.resolve(__dirname, '..', 'scripts', 'install-whisper.sh')}`;
const VOICE_MAX_BYTES = 20 * 1024 * 1024; // ≈ 10 min de WAV 16 kHz mono 16 bits
function whisperBin() {
  if (process.env.FRAP_WHISPER_BIN) return process.env.FRAP_WHISPER_BIN;
  const local = path.join(WHISPER_DIR, 'whisper-cli');
  return exists(local) ? local : which('whisper-cli');
}
function whisperModel() {
  if (process.env.FRAP_WHISPER_MODEL) return process.env.FRAP_WHISPER_MODEL;
  let files = [];
  try { files = fs.readdirSync(WHISPER_DIR).filter((f) => /^ggml-[\w.-]+\.bin$/.test(f)); } catch (_) { return null; }
  const pref = ['small', 'base', 'medium', 'tiny'];
  files.sort((a, b) => {
    const r = (f) => { const i = pref.findIndex((m) => f.startsWith(`ggml-${m}`)); return i < 0 ? 99 : i; };
    return r(a) - r(b) || a.localeCompare(b);
  });
  return files.length ? path.join(WHISPER_DIR, files[0]) : null;
}
/** Texto de whisper.cpp con -nt: una línea por segmento; fuera las marcas como [BLANK_AUDIO] o [Música]. */
function cleanTranscript(out) {
  return String(out).split('\n').map((l) => l.replace(/\[[^\]]*\]/g, '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

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
// ---------- editor de código (vista "Código"): lista de archivos, búsqueda y papelera ----------
// Los archivos se leen/escriben con fs.read / fs.write (limitados a FS_ROOT como todo fs.*).
const CODE_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.next', '.nuxt', '.cache', '.idea', '.gradle', '.terraform', '.svelte-kit', '.mypy_cache', '.pytest_cache']);
const CODE_MAX_FILES = 20000;
const CODE_GIT_ENV = () => childEnv({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' });
/** execFile de git con argumentos fijos (sin pasar por la lista blanca de git.run: aquí no hay args del usuario salvo tras -e/--). */
function gitOut(dir, args, max = 16 * 1024 * 1024) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd: dir, timeout: 30000, maxBuffer: max, env: CODE_GIT_ENV() },
      (err, stdout) => resolve(err && !(typeof err.code === 'number' && err.code === 1) ? null : { code: err ? 1 : 0, stdout }));
  });
}
/** Archivos (rutas relativas) bajo dir: en un repo, los de git (respeta .gitignore); si no, recorriendo carpetas. */
async function codeFiles(dir) {
  const inRepo = await gitOut(dir, ['rev-parse', '--show-toplevel']);
  if (inRepo && inRepo.code === 0) {
    const r = await gitOut(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    if (r && r.code === 0) {
      const files = [...new Set(r.stdout.split('\0').filter(Boolean))].filter((f) => exists(path.join(dir, f)));
      return { files: files.slice(0, CODE_MAX_FILES), truncated: files.length > CODE_MAX_FILES, git: true };
    }
  }
  const files = [];
  const walk = async (rel) => {
    let ents;
    try { ents = await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (files.length >= CODE_MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!CODE_SKIP_DIRS.has(e.name)) await walk(r); } else if (e.isFile()) files.push(r);
    }
  };
  await walk('');
  return { files: files.sort(), truncated: files.length >= CODE_MAX_FILES, git: false };
}
/** Busca texto en los archivos de dir. Devuelve [{file, line, col, text}] (máx. `max`). */
async function codeSearch(dir, query, { regex = false, caseSensitive = false, max = 500 } = {}) {
  const out = [];
  const inRepo = await gitOut(dir, ['rev-parse', '--show-toplevel']);
  if (inRepo && inRepo.code === 0) {
    const args = ['grep', '-z', '-n', '--column', '-I', '--no-color', '--untracked', ...(caseSensitive ? [] : ['-i']), regex ? '-E' : '-F', '-e', query, '--'];
    const r = await gitOut(dir, args);
    if (r) {
      for (const ln of r.stdout.split('\n')) {
        if (!ln) continue;
        const [file, line, col, ...rest] = ln.split('\0');
        if (!file || !line) continue;
        out.push({ file, line: Number(line), col: Number(col) || 1, text: rest.join('\0').slice(0, 400) });
        if (out.length >= max) break;
      }
      return { results: out, truncated: out.length >= max };
    }
  }
  let re;
  try { re = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i'); } catch (e) { throw new Error(`Expresión regular inválida: ${e.message}`); }
  const { files } = await codeFiles(dir);
  for (const f of files) {
    let buf;
    try {
      const abs = path.join(dir, f);
      if ((await fs.promises.stat(abs)).size > 1024 * 1024) continue;
      buf = await fs.promises.readFile(abs);
    } catch (_) { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue; // binario
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      out.push({ file: f, line: i + 1, col: m.index + 1, text: lines[i].slice(0, 400) });
      if (out.length >= max) return { results: out, truncated: true };
    }
  }
  return { results: out, truncated: false };
}
/** Mueve a la papelera de freedesktop (~/.local/share/Trash): se puede recuperar desde el gestor de archivos. */
function moveToTrash(abs) {
  const trash = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'Trash');
  fs.mkdirSync(path.join(trash, 'files'), { recursive: true });
  fs.mkdirSync(path.join(trash, 'info'), { recursive: true });
  const base = path.basename(abs);
  let name = base;
  for (let i = 2; exists(path.join(trash, 'files', name)) || exists(path.join(trash, 'info', `${name}.trashinfo`)); i++) name = `${base}.${i}`;
  const info = path.join(trash, 'info', `${name}.trashinfo`);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  fs.writeFileSync(info, `[Trash Info]\nPath=${encodeURI(abs)}\nDeletionDate=${date}\n`);
  try { fs.renameSync(abs, path.join(trash, 'files', name)); } catch (e) {
    fs.rmSync(info, { force: true });
    throw new Error(e.code === 'EXDEV' ? 'No se puede mover a la papelera (está en otro disco)' : e.message);
  }
  return path.join(trash, 'files', name);
}

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
  const realRoots = fsRoots().map((r) => { try { return fs.realpathSync(r); } catch (_) { return r; } });
  const inRoot = (r) => inAnyRoot(r, realRoots);
  let st = null;
  try { st = fs.lstatSync(abs); } catch (_) { /* no existe */ }
  if (mustExist) {
    if (!st) throw new Error(`No existe: ${abs}`);
    if (!inRoot(fs.realpathSync(abs))) throw new Error(`Ruta fuera de las carpetas permitidas: ${abs}`);
  } else {
    if (st && st.isSymbolicLink()) throw new Error(`El destino es un enlace simbólico: ${abs}`);
    if (!inRoot(fs.realpathSync(path.dirname(abs)))) throw new Error(`Ruta fuera de las carpetas permitidas: ${abs}`);
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
    version: VERSION, home: HOME, fsRoot: FS_ROOT, fsRoots: fsRoots(), shell: process.env.SHELL || '/bin/bash',
    platform: process.platform, hostname: os.hostname(),
    tools: { claude: which('claude'), codex: which('codex'), opencode: which('opencode') },
    // la UI lo compara con lo que necesita para detectar un bridge viejo que sigue corriendo
    ops: Object.keys(ops),
    startedAt: STARTED_AT,
  }),
  'sessions.list': () => [...sessions.values()].filter((s) => !s.closing).map(sessionInfo), // las que se están cerrando ya no se muestran
  'session.create': (p) => createSession({ ...p, env: undefined }),
  'session.attach': ({ sid }) => {
    const s = getSession(sid);
    // `pending` ya está dentro de `chunks` y se emitirá como evento 'out' después de
    // esta respuesta: se excluye del snapshot para no duplicarlo.
    const all = s.chunks.join('');
    return { ...sessionInfo(s), buffer: all.slice(0, Math.max(0, all.length - s.pending.length)) };
  },
  'session.input': ({ sid, data }) => { write(getSession(sid), String(data)); return true; },
  // Botón "limpiar" de la terminal: vacía el historial del bridge y el de la sesión (frap_pty.py), para que la
  // salida borrada no vuelva al recargar la UI ni al reiniciar el bridge. Lo que aún no se emitió (`pending`) se queda.
  'session.clear': ({ sid }) => {
    const s = getSession(sid);
    s.chunks = s.pending ? [s.pending] : [];
    s.size = s.pending.length;
    if (s.sock && !s.sock.destroyed) s.sock.write(frame('C'));
    return true;
  },
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
    if (s.alive) {
      s.closing = true;
      s.meta.closing = true; // si el bridge se reinicia antes de que termine, el siguiente la sigue cerrando
      saveMeta(s);
      killSession(s, { escalate: true });
      broadcast({ ev: 'sessions' });
    } else sessions.delete(sid);
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
    return { path: dir, parent: fsRoots().includes(dir) ? null : path.dirname(dir), entries: ents };
  },
  /** Lee un archivo (≤ 2 MB). encoding 'base64': binarios (la vista previa de HTML incrusta así sus imágenes). */
  'fs.read': ({ path: p, encoding }) => {
    const f = safePath(p);
    const st = fs.statSync(f);
    if (st.size > 2 * 1024 * 1024) throw new Error('Archivo demasiado grande (>2MB)');
    if (encoding === 'base64') return { path: f, content: fs.readFileSync(f).toString('base64'), encoding: 'base64', mtime: st.mtimeMs };
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
  /** Carpetas que FRAP puede abrir: {main, extra: [{path, source: env|file, exists}], file} */
  'fs.roots': () => ({ main: FS_ROOT, extra: fsExtra.map((x) => ({ ...x, exists: exists(x.path) })), file: FS_ROOTS_FILE }),
  /** Permite una carpeta extra (p. ej. /var/www). Debe existir y no ser del sistema. */
  'fs.addRoot': ({ path: p }) => {
    const r = checkExtraRoot(p);
    let st = null;
    try { st = fs.statSync(r); } catch (_) { /* no existe */ }
    if (!st || !st.isDirectory()) throw new Error(`No existe la carpeta ${r}`);
    if (inAnyRoot(r)) return { path: r, already: true, roots: fsRoots() };
    fsExtra = [...fsExtra.filter((x) => !(x.path.startsWith(r + '/'))), { path: r, source: 'file' }];
    saveExtraRoots();
    fsExtra = readExtraRoots();
    return { path: r, already: false, roots: fsRoots() };
  },
  'fs.removeRoot': ({ path: p }) => {
    const r = String(p || '').replace(/\/+$/, '');
    const x = fsExtra.find((e) => e.path === r);
    if (!x) throw new Error(`No es una carpeta extra: ${r}`);
    if (x.source !== 'file') throw new Error(`${r} viene de FRAP_FS_EXTRA: quítala de esa variable`);
    fsExtra = fsExtra.filter((e) => e !== x);
    saveExtraRoots();
    fsExtra = readExtraRoots();
    return { roots: fsRoots() };
  },
  /** mtime/tamaño de varias rutas (el editor vigila así los archivos abiertos). [{path, exists, mtime, size, dir}] */
  'fs.stat': ({ paths }) => {
    if (!Array.isArray(paths) || paths.length > 500) throw new Error('paths debe ser una lista (máx. 500)');
    return paths.map((p) => {
      const abs = safePath(String(p));
      try { const st = fs.statSync(abs); return { path: abs, exists: true, mtime: st.mtimeMs, size: st.size, dir: st.isDirectory() }; } catch (_) { return { path: abs, exists: false }; }
    });
  },
  /** Crea una carpeta (y las intermedias). */
  'fs.mkdir': ({ path: p }) => {
    const d = safePath(p);
    if (exists(d)) throw new Error(`Ya existe: ${d}`);
    fs.mkdirSync(d, { recursive: true });
    return { path: d };
  },
  /** Renombra o mueve un archivo/carpeta (sin pisar uno existente). */
  'fs.rename': ({ from, to }) => {
    const a = safePath(from);
    const b = safePath(to);
    if (fsRoots().includes(a)) throw new Error('No se puede mover una carpeta raíz');
    if (!exists(a)) throw new Error(`No existe: ${a}`);
    if (exists(b)) throw new Error(`Ya existe: ${b}`);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    return { path: b };
  },
  /** Manda un archivo/carpeta a la papelera (no borra: se puede recuperar). */
  'fs.trash': ({ path: p }) => {
    const a = safePath(p);
    if (fsRoots().includes(a)) throw new Error('No se puede borrar una carpeta raíz');
    if (!exists(a)) throw new Error(`No existe: ${a}`);
    return { path: a, trashed: moveToTrash(a) };
  },
  /** Archivos de una carpeta (editor: Ctrl+P). {root, files: [relativas], truncated, git} */
  'code.files': async ({ root: r }) => {
    const dir = safePath(r);
    if (!fs.statSync(dir).isDirectory()) throw new Error(`No es una carpeta: ${dir}`);
    return { root: dir, ...(await codeFiles(dir)) };
  },
  /** Buscar en archivos (editor: Ctrl+Shift+F). {root, results: [{file, line, col, text}], truncated} */
  'code.search': async ({ root: r, query, regex = false, caseSensitive = false }) => {
    const dir = safePath(r);
    if (typeof query !== 'string' || !query || query.length > 500 || /\n/.test(query)) throw new Error('Búsqueda inválida');
    return { root: dir, ...(await codeSearch(dir, query, { regex: !!regex, caseSensitive: !!caseSensitive })) };
  },
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
  /** Motor de voz: {ready, bin, model, dir, install} (install = comando para instalarlo). */
  'voice.status': () => {
    const bin = whisperBin();
    const model = whisperModel();
    return { ready: !!(bin && model), bin, model, dir: WHISPER_DIR, install: WHISPER_INSTALL };
  },
  /** Transcribe un WAV (base64). lang: "es", "en"… o "auto". Devuelve {text, ms}. */
  'voice.transcribe': ({ audio, lang = 'es' } = {}) => {
    const bin = whisperBin();
    const model = whisperModel();
    if (!bin || !model) throw new Error(`Falta whisper.cpp o su modelo. Instálalo con: ${WHISPER_INSTALL}`);
    if (typeof audio !== 'string' || !audio) throw new Error('Sin audio');
    if (!/^(auto|[a-z]{2})$/.test(String(lang))) throw new Error('Idioma inválido');
    const buf = Buffer.from(audio, 'base64');
    if (buf.length > VOICE_MAX_BYTES) throw new Error('Audio demasiado largo (máximo ~10 min)');
    if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('El audio no es un WAV válido');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frap-voice-'));
    const file = path.join(dir, 'voz.wav');
    fs.writeFileSync(file, buf, { mode: 0o600 });
    const threads = String(Math.max(1, Math.min(4, Math.floor((os.cpus() || []).length / 2) || 1)));
    const started = Date.now();
    return new Promise((resolve, reject) => {
      execFile(bin, ['-m', model, '-f', file, '-l', String(lang), '-nt', '-np', '-t', threads], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (err) {
          const msg = err.killed ? 'La transcripción tardó demasiado' : (String(stderr).trim().split('\n').pop() || err.message);
          reject(new Error(`whisper.cpp: ${msg}`));
          return;
        }
        resolve({ text: cleanTranscript(stdout), ms: Date.now() - started });
      });
    });
  },
  // ----- túneles: compartir por URL pública un puerto, una IP local o un archivo/carpeta -----
  /** {providers: {cloudflared|localhostrun|ngrok: {name, path}}, tunnels: [...], binDir, install} */
  'tunnel.status': () => ({ providers: tunnels.providers(), tunnels: tunnels.list(), binDir: tunnels.BIN_DIR, install: `bash ${path.join(__dirname, '..', 'scripts', 'install-cloudflared.sh')}` }),
  /** Servidores escuchando en el equipo (sin el bridge ni sus puertas): [{port, host, pid, name, cmd, cwd}] */
  'tunnel.ports': () => tunnels.listening([server.address() && server.address().port]),
  /**
   * {id, name, target: {type:'url', url|port} | {type:'path', path}, provider: auto|cloudflared|localhostrun|ngrok,
   *  password?, hostRewrite?, rewriteUrls?}: arranca el túnel; la URL pública llega luego en el evento `tunnel`.
   */
  'tunnel.start': (o = {}) => {
    const t = o.target || {};
    const target = t.type === 'path' ? { type: 'path', path: safePath(t.path) } : { type: 'url', url: t.url, port: t.port };
    return tunnels.start({ ...o, target });
  },
  'tunnel.stop': ({ id }) => tunnels.stop(String(id || '')),
  // ----- módulo interno "Scripts": local/scripts/<carpeta>/ con interruptores Usuario / IA -----
  /** {dir, enabled, bun, scripts: [{path, abs, folder, name, ext, runnable, runner, desc, size, mtime, user, ai}], folders: [{name, salida}]} */
  // ----- integración WordPress (plugin frap-wordpress): URL + token por sitio en FRAP_HOME/wordpress.env -----
  /** {envFile, cli, skill, sites: [{id, name, url, enabled, ai, hasToken, tokenHint}]} (sin tokens) */
  'wp.list': () => ({ envFile: WP_ENV, cli: wordpress.CLI, skill: wordpress.skillStatus(), sites: wpSites().map(wordpress.publicSite) }),
  /** Crea o edita. `token: null` (o vacío al editar) = conservar el guardado. */
  'wp.save': ({ site }) => {
    const sites = wpSites();
    const existing = site && site.id ? sites.find((c) => c.id === site.id) : null;
    if (site && site.id && !existing) throw new Error(`Conexión no encontrada: ${site.id}`);
    const c = wpNormalize(site || {}, existing);
    if (existing) sites[sites.indexOf(existing)] = c;
    else { c.id = db.slugify(c.name, new Set(sites.map((x) => x.id))); sites.push(c); }
    wordpress.saveSites(WP_ENV, sites);
    return wordpress.publicSite(c);
  },
  /** Interruptores: `enabled` (activa) y/o `ai` (usable por agentes con frap-wp). */
  'wp.toggle': ({ id, enabled, ai }) => {
    const sites = wpSites();
    const c = sites.find((x) => x.id === id);
    if (!c) throw new Error(`Conexión no encontrada: ${id}`);
    if (enabled !== undefined) c.enabled = !!enabled;
    if (ai !== undefined) c.ai = !!ai;
    wordpress.saveSites(WP_ENV, sites);
    return wordpress.publicSite(c);
  },
  'wp.delete': ({ id }) => {
    const sites = wpSites();
    if (!sites.some((c) => c.id === id)) throw new Error(`Conexión no encontrada: ${id}`);
    wordpress.saveSites(WP_ENV, sites.filter((c) => c.id !== id));
    return true;
  },
  /** GET /info del plugin: de una conexión guardada (`id`) o de una sin guardar (`site`, para "Probar" en el formulario). */
  'wp.check': ({ id, site }) => {
    const existing = id ? wpSites().find((c) => c.id === id) : site && site.id ? wpSites().find((c) => c.id === site.id) : null;
    if (id && !existing) throw new Error(`Conexión no encontrada: ${id}`);
    return wordpress.info(site ? wpNormalize(site, existing) : existing);
  },
  /** Skill frap-wordpress: {claude, codex}: {installed, current, file} */
  'wp.skill': () => wordpress.skillStatus(),
  /** on=true la instala/actualiza; on=false la quita (módulo Integraciones apagado). {on, changed} */
  'wp.setSkill': ({ on }) => wordpress.setSkill(!!on),
  // ----- integración Aveonline (revisión por token, solo lectura): URL + token por tienda en FRAP_HOME/aveonline.env -----
  /** {envFile, cli, skill, sites: [{id, name, url, enabled, ai, hasToken, tokenHint}]} (sin tokens) */
  'ave.list': () => ({ envFile: AVE_ENV, cli: aveonline.CLI, skill: aveonline.skillStatus(), sites: aveSites().map(aveonline.publicSite) }),
  /** Crea o edita. `token: null` (o vacío al editar) = conservar el guardado. */
  'ave.save': ({ site }) => {
    const sites = aveSites();
    const existing = site && site.id ? sites.find((c) => c.id === site.id) : null;
    if (site && site.id && !existing) throw new Error(`Tienda no encontrada: ${site.id}`);
    const c = aveNormalize(site || {}, existing);
    if (existing) sites[sites.indexOf(existing)] = c;
    else { c.id = db.slugify(c.name, new Set(sites.map((x) => x.id))); sites.push(c); }
    aveonline.saveSites(AVE_ENV, sites);
    return aveonline.publicSite(c);
  },
  /**
   * «Pegar token»: texto como "pedido 16322 token … tienda http://…". Si la tienda (por URL, o `id`) ya existe le
   * cambia el token; si no, la crea con el nombre del dominio. El token nunca vuelve a la UI.
   * → {site, created, order}
   */
  'ave.paste': ({ text, id }) => {
    const parsed = aveonline.parsePaste(text);
    if (!parsed.token) throw new Error('No encontré el token en el texto (48 caracteres hex, después de "token")');
    const sites = aveSites();
    const existing = id ? sites.find((c) => c.id === id) : parsed.url ? sites.find((c) => aveonline.normalizeUrl(c.url) === parsed.url) : null;
    if (id && !existing) throw new Error(`Tienda no encontrada: ${id}`);
    if (!existing && !parsed.url) throw new Error('No encontré la URL de la tienda en el texto (o elige la tienda a la que va el token)');
    let c;
    if (existing) {
      c = aveNormalize({ ...existing, token: parsed.token }, existing);
      sites[sites.indexOf(existing)] = c;
    } else {
      const host = new URL(parsed.url).hostname.replace(/^www\./, '');
      c = aveNormalize({ name: host, url: parsed.url, token: parsed.token }, null);
      const label = host.split('.')[0];
      c.id = db.slugify(/^\d+$/.test(label) || !label ? 'tienda' : label, new Set(sites.map((x) => x.id))); // chp.com.co → chp; una IP → tienda
      sites.push(c);
    }
    aveonline.saveSites(AVE_ENV, sites);
    return { site: aveonline.publicSite(c), created: !existing, order: parsed.order || null };
  },
  /** Interruptores: `enabled` (activa) y/o `ai` (usable por agentes con frap-ave). */
  'ave.toggle': ({ id, enabled, ai }) => {
    const sites = aveSites();
    const c = sites.find((x) => x.id === id);
    if (!c) throw new Error(`Tienda no encontrada: ${id}`);
    if (enabled !== undefined) c.enabled = !!enabled;
    if (ai !== undefined) c.ai = !!ai;
    aveonline.saveSites(AVE_ENV, sites);
    return aveonline.publicSite(c);
  },
  'ave.delete': ({ id }) => {
    const sites = aveSites();
    if (!sites.some((c) => c.id === id)) throw new Error(`Tienda no encontrada: ${id}`);
    aveonline.saveSites(AVE_ENV, sites.filter((c) => c.id !== id));
    return true;
  },
  /** GET /review/info: de una tienda guardada (`id`) o de una sin guardar (`site`, para "Probar" en el formulario). */
  'ave.check': ({ id, site }) => {
    const existing = id ? aveSites().find((c) => c.id === id) : site && site.id ? aveSites().find((c) => c.id === site.id) : null;
    if (id && !existing) throw new Error(`Tienda no encontrada: ${id}`);
    const c = site ? aveNormalize(site, existing) : existing;
    if (!c.token) throw new Error('La tienda no tiene token');
    return aveonline.info(c);
  },
  /** Últimos pedidos de una tienda guardada (vista rápida en la UI; solo lectura). */
  'ave.orders': ({ id, query = {} }) => {
    const c = aveSites().find((x) => x.id === id);
    if (!c) throw new Error(`Tienda no encontrada: ${id}`);
    const q = {};
    for (const k of ['per_page', 'page', 'status', 'aveonline']) if (query[k] != null && /^[\w-]{1,30}$/.test(String(query[k]))) q[k] = String(query[k]);
    return aveonline.request(c, 'orders', { query: q }).then((r) => { if (r.status !== 200) throw aveonline.apiError(r); return r.data; });
  },
  'ave.skill': () => aveonline.skillStatus(),
  'ave.setSkill': ({ on }) => aveonline.setSkill(!!on),
  // ----- módulo API (peticiones HTTP tipo Postman en local/api) -----
  /** {dir, cli, skill, tree: [{name, path, type: folder|request, method?, url?, hasRes?, vars?, children?}]} */
  'api.tree': () => ({ dir: apiReq.API_DIR, cli: apiReq.CLI, skill: apiReq.skillStatus(), tree: apiReq.tree() }),
  /** {path, request, response} (la última respuesta guardada, o null) */
  'api.read': ({ path: p }) => apiReq.readReq(p),
  /** Guarda (crea con create=true) una petición. {path, request} */
  'api.save': ({ path: p, request, create }) => apiReq.saveReq(p, request, { create: !!create }),
  'api.mkdir': ({ path: p }) => apiReq.mkdir(p),
  /** Renombra o mueve una petición (con su respuesta) o una carpeta. type: request|folder */
  'api.rename': ({ from, to, type }) => apiReq.rename(from, to, type === 'folder' ? 'folder' : 'request'),
  /** A la papelera (se puede recuperar). */
  'api.delete': ({ path: p, type }) => {
    const files = apiReq.targetsOf(p, type === 'folder' ? 'folder' : 'request');
    if (!files.length) throw new Error(`No existe: ${p}`);
    for (const f of files) moveToTrash(f);
    return { trashed: files.length };
  },
  /** Variables de una carpeta ('' = globales) y, con `path`, las que ve esa petición (con su origen). */
  'api.vars': ({ folder = '', path: p }) => ({ ...apiReq.getVars(folder), ...(p != null ? { scope: apiReq.scopeVars(p) } : {}) }),
  'api.setVars': ({ folder = '', variables, descripcion }) => apiReq.setVars(folder, variables, descripcion),
  /** Envía una petición guardada (`path`) o la que se está editando (`request`, con su `path` para las variables). */
  'api.send': ({ path: p, request, vars, timeoutMs }) => apiReq.run(p, { request, vars, timeoutMs: Math.min(Number(timeoutMs) || 30000, 300000) }),
  'api.skill': () => apiReq.skillStatus(),
  'api.setSkill': ({ on }) => apiReq.setSkill(!!on),
  // ----- módulo Equipo: personas (local/equipo/equipo.json) y a quién está asignada cada sesión (meta.person) -----
  /** {file, cli, skill, roles, people: [{id, name, icon, role, descripcion}]} */
  'team.list': () => ({ file: team.TEAM_FILE, cli: team.CLI, skill: team.skillStatus(), ...team.load() }),
  /** Crea (sin id) o edita una persona. → la persona */
  'team.save': ({ person }) => team.upsert(person),
  /** Borra una persona y la quita de las sesiones asignadas a ella. */
  'team.delete': ({ id }) => {
    team.remove(id);
    for (const s of sessions.values()) if (s.meta.person === id) { delete s.meta.person; saveMeta(s); }
    broadcast({ ev: 'sessions' });
    return true;
  },
  /** Importa personas de un export .json (mismo id = se reemplaza). {added, replaced} */
  'team.import': ({ people }) => team.importPeople(people),
  'team.skill': () => team.skillStatus(),
  'team.setSkill': ({ on }) => team.setSkill(!!on),
  // ----- módulo Pendientes (local/pendientes/pendientes.json) -----
  /** {file, cli, skill, estados, todos: [… en orden, con n y blockedBy]} */
  'todos.list': () => ({ file: todos.TODO_FILE, cli: todos.CLI, skill: todos.skillStatus(), estados: todos.ESTADOS, todos: todos.list() }),
  /** Crea (sin id) o edita un pendiente. → el pendiente */
  'todos.save': ({ todo }) => { const t = todos.upsert(todo); broadcast({ ev: 'todos' }); return t; },
  'todos.delete': ({ id }) => { todos.remove(id); broadcast({ ev: 'todos' }); return true; },
  /** Conversaciones recientes de claude en una carpeta (para «Retomar conversación…»). */
  'claude.conversations': ({ cwd, limit }) => claudeConversations(safePath(cwd), limit),
  'todos.skill': () => todos.skillStatus(),
  'todos.setSkill': ({ on }) => todos.setSkill(!!on),
  'scripts.list': () => scripts.listScripts(),
  /** Cambia los interruptores de un script. {path, user?, ai?} → {path, user, ai} */
  'scripts.set': ({ path: p, user, ai }) => scripts.setFlags(p, { user, ai }),
  /** Crea local/scripts/<carpeta>/<nombre.ext> con cabecera. {path, desc?} → {path, abs, user, ai} */
  'scripts.create': ({ path: p, desc }) => scripts.createScript(p, desc),
  /** Línea para ejecutarlo en una terminal de FRAP (revisa el módulo y el interruptor «Usuario»). {cwd, line, rel} */
  'scripts.command': ({ path: p }) => {
    const c = scripts.commandFor(p, 'user');
    const q = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
    return { cwd: c.cwd, rel: c.rel, line: [c.bin, ...c.args].map(q).join(' ') };
  },
  'scripts.skill': () => scripts.skillStatus(),
  /** on: instala/actualiza la skill frap-scripts y habilita `frap-scripts run`; off: la quita y lo bloquea. */
  'scripts.setModule': ({ on }) => scripts.setModule(!!on),
  // ----- módulo interno "Gestión de issues": local/issues/<ID>/ de FRAP (fuera de git) -----
  /** {dir, local, issues: [{id, title, estado, url, updated, closed, pending, files}]} */
  'issues.list': () => issues.listIssues(),
  /** Crea local/issues/<ID>/ desde las plantillas (si existe no toca nada). {id, dir, created} */
  'issues.create': ({ id, title, priority, local }) => issues.createIssue(id, title, { priority, local: !!local }),
  /** Prioridad de una issue (formato de Linear en issue.md). */
  'issues.setPriority': ({ id, priority }) => issues.setPriority(id, priority),
  /** Copia carpetas de issues (<ID>/) de otra carpeta sin pisar las existentes. {from, copied, skipped} */
  'issues.importDir': ({ path: p }) => issues.importIssuesDir(safePath(p)),
  /** Skill frap-issues: {claude: {installed, current, file}, codex: {…}} */
  'issues.skill': () => issues.skillStatus(),
  /** on=true la instala/actualiza en claude y codex; on=false la quita. {on, changed: [archivos]} */
  'issues.setSkill': ({ on }) => issues.setSkill(!!on),
  /** Carpeta local/ completa como .zip en base64. {data, files, bytes} */
  'local.export': () => issues.exportLocal(),
  /** Restaura un .zip (base64) en local/; overwrite=false no pisa lo existente. {written, skipped, rejected} */
  'local.import': ({ data, overwrite = false }) => issues.importLocal(data, !!overwrite),
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
  'export.creds': ({ db: dbIds = [], ssh: sshIds = [], wp: wpIds = [], ave: aveIds = [], passphrase } = {}) => {
    const strip = (c) => { const { password, ...rest } = c; return rest; };
    const conns = dbConns().filter((c) => dbIds.includes(c.id));
    const hosts = sshHosts().filter((c) => sshIds.includes(c.id));
    const sites = wpSites().filter((c) => wpIds.includes(c.id));
    const stores = aveSites().filter((c) => aveIds.includes(c.id));
    const noToken = ({ token, ...rest }) => rest;
    const out = { db: conns.map(strip), ssh: hosts.map(strip), integrations: { wordpress: sites.map(noToken), aveonline: stores.map(noToken) } };
    if (passphrase) {
      if (String(passphrase).length < 6) throw new Error('La clave de cifrado debe tener al menos 6 caracteres');
      out.secrets = sealSecrets({
        db: Object.fromEntries(conns.filter((c) => c.password).map((c) => [c.id, c.password])),
        ssh: Object.fromEntries(hosts.filter((c) => c.password).map((c) => [c.id, c.password])),
        wp: Object.fromEntries(sites.filter((c) => c.token).map((c) => [c.id, c.token])),
        ave: Object.fromEntries(stores.filter((c) => c.token).map((c) => [c.id, c.token])),
      }, passphrase);
    }
    return out;
  },
  /**
   * Importa conexiones y servidores (mismo id = se reemplaza). Si traen `secrets`, hace falta
   * `passphrase`; sin ella se importan sin contraseña (o se conserva la que ya existía).
   */
  'import.creds': ({ db: inDb = [], ssh: inSsh = [], wp: inWp = [], ave: inAve = [], secrets, passphrase } = {}) => {
    const pw = secrets && passphrase != null && passphrase !== '' ? openSecrets(secrets, passphrase) : { db: {}, ssh: {} };
    const result = { db: 0, ssh: 0, wp: 0, ave: 0, errors: [] };
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
    // WordPress: sin la clave el token no viene; se conserva el que ya hubiera o queda sin token (se agrega en Editar)
    const sites = wpSites();
    for (const raw of inWp) {
      try {
        const id = db.slugify(String(raw.id || raw.name || ''), new Set()).slice(0, 60);
        const existing = sites.find((c) => c.id === id);
        const token = Object.prototype.hasOwnProperty.call(pw.wp || {}, raw.id) ? pw.wp[raw.id] : null;
        const c = wpNormalize({ ...raw, token }, existing || { id, token: '' }, { allowNoToken: true });
        c.id = id;
        if (existing) sites[sites.indexOf(existing)] = c; else sites.push(c);
        result.wp++;
      } catch (e) { result.errors.push(`WordPress ${raw.name || raw.id}: ${e.message}`); }
    }
    if (inWp.length) wordpress.saveSites(WP_ENV, sites);
    // Aveonline: igual que WordPress (sus tokens duran poco: lo normal es pegar uno nuevo tras importar)
    const stores = aveSites();
    for (const raw of inAve) {
      try {
        const id = db.slugify(String(raw.id || raw.name || ''), new Set()).slice(0, 60);
        const existing = stores.find((c) => c.id === id);
        const token = Object.prototype.hasOwnProperty.call(pw.ave || {}, raw.id) ? pw.ave[raw.id] : null;
        const c = aveNormalize({ ...raw, token }, existing || { id, token: '' }, { allowNoToken: true });
        c.id = id;
        if (existing) stores[stores.indexOf(existing)] = c; else stores.push(c);
        result.ave++;
      } catch (e) { result.errors.push(`Aveonline ${raw.name || raw.id}: ${e.message}`); }
    }
    if (inAve.length) aveonline.saveSites(AVE_ENV, stores);
    return result;
  },
  /**
   * Ejecuta `git <args>` en `cwd` (sin shell). Nunca lanza por código de salida distinto de 0:
   * devuelve {code, stdout, stderr} para que la UI muestre el error de git tal cual.
   */
  /**
   * Publicar versión desde la vista Git: `npm run push-v|deploy -- major|minor|patch` en el repo, sin terminal.
   * Solo esos dos scripts (y solo si existen en su package.json) y solo esos tres argumentos. La salida se emite
   * en vivo como eventos {ev: 'release', rid, d}; resuelve al terminar con {code, ms}. Sin stdin y sin pedir
   * credenciales (GIT_TERMINAL_PROMPT=0): si algo pide algo, falla en vez de quedarse colgado.
   */
  'git.release': ({ cwd, script, kind, rid }) => {
    const dir = safePath(cwd);
    if (!['push-v', 'deploy'].includes(script)) throw new Error('Script no permitido (solo push-v o deploy)');
    if (!['major', 'minor', 'patch'].includes(kind)) throw new Error('Tipo inválido (major, minor o patch)');
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (_) { throw new Error(`No hay package.json en ${dir}`); }
    if (!pkg.scripts || !pkg.scripts[script]) throw new Error(`El package.json no tiene el script "${script}"`);
    const id = String(rid || '').slice(0, 40);
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', script, '--', kind], {
        cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', npm_config_color: 'false', FORCE_COLOR: '0' },
      });
      const emit = (d) => broadcast({ ev: 'release', rid: id, d: d.toString('utf8') });
      child.stdout.on('data', emit);
      child.stderr.on('data', emit);
      const timer = setTimeout(() => { emit(Buffer.from('\n[FRAP] Tiempo agotado (15 min): se detiene.\n')); child.kill('SIGTERM'); }, 15 * 60 * 1000);
      child.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'No se encontró npm' : e.message)); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? 1 : code, ms: Date.now() - t0 }); });
    });
  },
  /**
   * Repos git dentro de las carpetas del proyecto (la carpeta puede no tener git pero sí una interna).
   * Busca carpetas con `.git` hasta `depth` niveles (máx. 4), sin entrar en dependencias ni en otros repos. → [rutas]
   */
  'git.findRepos': ({ paths = [], depth = 3 }) => {
    const max = Math.min(4, Math.max(0, Number(depth) || 0));
    const SKIP = new Set(['node_modules', 'vendor', 'libs', 'bower_components', 'dist', 'build', '.cache', '.next', '.nuxt', 'target', '__pycache__', '.venv', 'venv']);
    const out = [];
    const walk = (dir, d) => {
      if (out.length >= 60) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      if (ents.some((e) => e.name === '.git')) { if (!out.includes(dir)) out.push(dir); if (d > 0) return; } // un repo interno no se recorre (submódulos aparte)
      if (d >= max) return;
      for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) walk(path.join(dir, e.name), d + 1);
    };
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, 10)) walk(safePath(String(p)), 0);
    return out;
  },
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
  /**
   * Abre en el explorador de archivos del sistema: una carpeta tal cual; un archivo, su carpeta con él seleccionado
   * (FileManager1.ShowItems por D-Bus: Nautilus, Dolphin, Nemo…; si no hay, xdg-open de la carpeta). macOS: open / open -R.
   */
  'open.folder': async ({ path: p }) => {
    const abs = safePath(p);
    if (!exists(abs)) throw new Error(`No existe: ${abs}`);
    const isDir = fs.statSync(abs).isDirectory();
    const launch = (cmd, args) => new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', env: childEnv({}) });
      child.once('error', (e) => reject(new Error(e.code === 'ENOENT' ? `No se encontró "${cmd}" para abrir el explorador de archivos` : e.message)));
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    if (process.platform === 'darwin') {
      await launch('open', isDir ? [abs] : ['-R', abs]);
      return { opened: abs, how: 'open' };
    }
    if (!isDir) {
      const uri = `file://${abs.split('/').map((s) => encodeURIComponent(s).replace(/'/g, '%27')).join('/')}`;
      const ok = await new Promise((resolve) => execFile('gdbus', ['call', '--session', '--dest', 'org.freedesktop.FileManager1',
        '--object-path', '/org/freedesktop/FileManager1', '--method', 'org.freedesktop.FileManager1.ShowItems', `['${uri}']`, ''],
      { timeout: 4000, env: childEnv({}) }, (err) => resolve(!err)));
      if (ok) return { opened: abs, how: 'select' };
    }
    const dir = isDir ? abs : path.dirname(abs);
    await launch('xdg-open', [dir]);
    return { opened: dir, how: 'xdg-open' };
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
  tunnels.stopAll(); // los túneles no sobreviven al bridge (sus URLs públicas son de un solo uso)
  if (argv.includes('--kill-sessions')) for (const s of sessions.values()) killSession(s);
  for (const s of sessions.values()) if (s.sock) s.sock.end();
  setTimeout(() => {
    try { fs.rmdirSync(SOCK_DIR); } catch (_) { /* quedan terminales vivas: se conserva */ }
    process.exit(0);
  }, 50);
}
tunnels.setOnChange((t) => broadcast({ ev: 'tunnel', tunnel: t }));
process.on('exit', () => tunnels.stopAll());
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// primero se reconecta a las terminales que siguen vivas; luego acepta a la UI
let recovered = 0;
rediscoverSessions().then((n) => { recovered = n; }, () => {}).then(() => scanAgentSessions().catch(() => {})).then(watchNotices).then(() => server.listen(PORT, HOST, () => {
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
