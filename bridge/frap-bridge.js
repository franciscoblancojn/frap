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
const { StringDecoder } = require('string_decoder');
const ws = require('./ws');

const VERSION = '1.0.0';
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

// ---------- sesiones PTY ----------
const sessions = new Map();
const clients = new Set();
let seq = 0;

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) c.send(s);
}
function sessionInfo(s) {
  return {
    sid: s.sid, pid: s.proc.pid, meta: s.meta, created: s.created,
    lastOutput: s.lastOutput, alive: s.alive, exitCode: s.exitCode,
  };
}

function createSession({ cwd, cols = 100, rows = 30, meta = {}, init = '', cmd } = {}) {
  const dir = safePath(cwd || HOME);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`No es un directorio: ${dir}`);
  const shell = process.env.SHELL || '/bin/bash';
  const command = Array.isArray(cmd) && cmd.length ? cmd : [shell];
  const sid = `s${++seq}-${crypto.randomBytes(3).toString('hex')}`;
  const proc = spawn(PYTHON, [PTY_HELPER, ...command], {
    cwd: dir,
    env: childEnv({
      TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'frap',
      FRAP_ROWS: String(rows), FRAP_COLS: String(cols), FRAP_SESSION: sid,
    }),
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const s = {
    sid, proc, meta: { ...meta, cwd: dir }, created: Date.now(), lastOutput: 0,
    alive: true, exitCode: null, chunks: [], size: 0, pending: '', timer: null,
    decoder: new StringDecoder('utf8'), ctl: proc.stdio[3],
  };
  sessions.set(sid, s);

  const flush = () => {
    s.timer = null;
    if (!s.pending) return;
    const d = s.pending;
    s.pending = '';
    broadcast({ ev: 'out', sid, d });
  };
  const onOut = (buf) => {
    const d = s.decoder.write(buf);
    if (!d) return;
    s.lastOutput = Date.now();
    s.chunks.push(d);
    s.size += d.length;
    while (s.size > BUFFER_MAX && s.chunks.length > 1) s.size -= s.chunks.shift().length;
    s.pending += d;
    if (!s.timer) s.timer = setTimeout(flush, 4);
    if (init && !s.initSent) {
      s.initSent = true;
      setTimeout(() => write(s, init + '\r'), 120);
    }
  };
  proc.stdout.on('data', onOut);
  proc.stderr.on('data', onOut);
  if (init) setTimeout(() => { if (!s.initSent) { s.initSent = true; write(s, init + '\r'); } }, 1500);
  proc.on('error', (e) => onOut(Buffer.from(`\r\n[frap] error al iniciar PTY: ${e.message}\r\n`)));
  proc.on('exit', (code) => {
    flush();
    s.alive = false;
    s.exitCode = code;
    broadcast({ ev: 'exit', sid, code });
    setTimeout(() => sessions.delete(sid), 10_000);
  });
  if (s.ctl) s.ctl.on('error', () => {});
  proc.stdin.on('error', () => {});
  broadcast({ ev: 'sessions' });
  return sessionInfo(s);
}
function getSession(sid) {
  const s = sessions.get(sid);
  if (!s) throw new Error(`Sesión no encontrada: ${sid}`);
  return s;
}
function write(s, data) {
  if (s.alive && s.proc.stdin.writable) s.proc.stdin.write(data);
}

// ---------- estado persistente de la UI ----------
const STATE_FILE = path.join(FRAP_HOME, 'state.json');

// ---------- operaciones RPC ----------
const ops = {
  hello: () => ({
    version: VERSION, home: HOME, fsRoot: FS_ROOT, shell: process.env.SHELL || '/bin/bash',
    platform: process.platform, hostname: os.hostname(),
    tools: { claude: which('claude'), codex: which('codex'), opencode: which('opencode') },
  }),
  'sessions.list': () => [...sessions.values()].map(sessionInfo),
  'session.create': (p) => createSession(p),
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
    if (s.alive && s.ctl && s.ctl.writable) s.ctl.write(`R ${rows | 0} ${cols | 0}\n`);
    return true;
  },
  'session.meta': ({ sid, meta }) => {
    const s = getSession(sid);
    Object.assign(s.meta, meta || {});
    broadcast({ ev: 'sessions' });
    return sessionInfo(s);
  },
  'session.kill': ({ sid }) => {
    const s = getSession(sid);
    if (s.alive) s.proc.kill('SIGTERM');
    else sessions.delete(sid);
    return true;
  },
  ps: async () => {
    const rows = await psTable();
    const out = {};
    for (const s of sessions.values()) {
      if (!s.alive) continue;
      // descendants del helper python: [shell, ...hijos]
      out[s.sid] = descendants(rows, s.proc.pid);
    }
    return out;
  },
  'proc.kill': ({ pid, signal = 'SIGTERM' }) => {
    return psTable().then((rows) => {
      const allowed = new Set();
      for (const s of sessions.values()) for (const r of descendants(rows, s.proc.pid)) allowed.add(r.pid);
      if (!allowed.has(Number(pid))) throw new Error('Solo se pueden matar procesos de sesiones FRAP');
      process.kill(Number(pid), signal);
      return true;
    });
  },
  'fs.list': ({ path: p, dirsOnly = true, hidden = false }) => {
    const dir = safePath(p);
    const ents = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => hidden || !e.name.startsWith('.'))
      .map((e) => {
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) { try { isDir = fs.statSync(path.join(dir, e.name)).isDirectory(); } catch (_) { /* roto */ } }
        return { name: e.name, dir: isDir };
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
const server = http.createServer((req, res) => {
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

function shutdown() {
  for (const s of sessions.values()) if (s.alive) s.proc.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  const page = path.resolve(__dirname, '..', 'src', 'index.html');
  const url = `file://${page}#port=${PORT}&token=${TOKEN}`;
  if (process.env.FRAP_QUIET !== '1') {
    console.log(`FRAP bridge v${VERSION} escuchando en ws://${HOST}:${PORT}`);
    console.log(`Abre en el navegador:\n  ${url}`);
  }
  if (process.send) process.send({ ready: true, port: server.address().port });
  if (argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
  }
});
server.on('error', (e) => {
  console.error(`No se pudo iniciar el bridge: ${e.message}`);
  process.exit(1);
});
