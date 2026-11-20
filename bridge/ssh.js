'use strict';
// Servidores SSH de FRAP: almacenamiento en .env (0600) y armado de la línea de `ssh`.
// Sin dependencias npm. Lo usan el bridge (panel SSH, terminales) y el CLI para agentes (frap-ssh.js).
//
// La contraseña nunca va en argv ni en el entorno de la terminal: ssh la pide a SSH_ASKPASS
// (bridge/frap-askpass.js), que la lee del .env por id en el momento.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseEnvValue, quoteEnvValue, isOff, slugify } = require('./db');

const FIELDS = ['NAME', 'HOST', 'PORT', 'USER', 'PASSWORD', 'KEY', 'DIR', 'ENABLED', 'AI'];
const KEY_RE = new RegExp(`^FRAP_SSH_([A-Z0-9_]+?)_(${FIELDS.join('|')})$`);
const ASKPASS_JS = path.join(__dirname, 'frap-askpass.js');
// host: nombre, IPv4 o IPv6; usuario: sin espacios. Ninguno puede empezar por "-" (inyección de opciones).
const HOST_RE = /^[A-Za-z0-9_.:[\]%-]+$/;
const USER_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.@\\$-]*$/;

/** Lee el .env y devuelve [{id, name, host, port, user, password, key, dir, enabled, ai}]. */
function loadHosts(envFile) {
  let text = '';
  try { text = fs.readFileSync(envFile, 'utf8'); } catch (_) { return []; }
  const byId = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    const k = m[1].match(KEY_RE);
    if (!k) continue;
    const id = k[1].toLowerCase();
    if (!byId.has(id)) byId.set(id, { id });
    byId.get(id)[k[2]] = parseEnvValue(m[2]);
  }
  return [...byId.values()].map((c) => ({
    id: c.id,
    name: c.NAME || c.id,
    host: c.HOST || '',
    port: c.PORT || '',
    user: c.USER || '',
    password: c.PASSWORD || '',
    key: c.KEY || '',
    dir: c.DIR || '',
    enabled: !isOff(c.ENABLED),
    ai: !isOff(c.AI),
  }));
}

function saveHosts(envFile, hosts, cliPath) {
  const lines = [
    '# FRAP — servidores SSH.',
    '# Se gestiona desde FRAP (panel "SSH"); se puede editar a mano.',
    '# Los agentes (claude, codex, opencode) usan solo los que tienen ENABLED=1 y AI=1, a través de:',
    `#   node ${cliPath || 'bridge/frap-ssh.js'} <id> "comando"`,
    '# Contiene contraseñas: no lo subas a git ni lo compartas.',
    '',
  ];
  for (const c of hosts) {
    const p = `FRAP_SSH_${c.id.toUpperCase()}_`;
    lines.push(`# --- ${c.name} — id: ${c.id}`);
    lines.push(`${p}NAME=${quoteEnvValue(c.name)}`);
    lines.push(`${p}HOST=${quoteEnvValue(c.host)}`);
    lines.push(`${p}PORT=${quoteEnvValue(c.port)}`);
    lines.push(`${p}USER=${quoteEnvValue(c.user)}`);
    lines.push(`${p}PASSWORD=${quoteEnvValue(c.password)}`);
    lines.push(`${p}KEY=${quoteEnvValue(c.key)}`);
    lines.push(`${p}DIR=${quoteEnvValue(c.dir || '')}`);
    lines.push(`${p}ENABLED=${c.enabled === false ? 0 : 1}`);
    lines.push(`${p}AI=${c.ai === false ? 0 : 1}`);
    lines.push('');
  }
  fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
  const tmp = `${envFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, envFile);
  fs.chmodSync(envFile, 0o600);
}

/** Sin contraseña: lo que puede ver la UI. */
function publicHost(c) {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: !!password };
}

/** Valida host, usuario y puerto (se usan como argumentos de ssh). */
function validateHost(c) {
  if (!c.host || !HOST_RE.test(c.host) || c.host.startsWith('-')) throw new Error('Host inválido');
  if (!c.user || !USER_RE.test(c.user)) throw new Error('Usuario inválido');
  if (c.port && !/^\d{1,5}$/.test(c.port)) throw new Error('Puerto inválido');
  if (c.key && c.key.startsWith('-')) throw new Error('Ruta de llave inválida');
  if (c.dir) checkDir(c.dir);
}

/** Ruta inicial: absoluta ("/srv/app") o en el home ("~", "~/app"); sin saltos de línea. */
function checkDir(d) {
  const s = String(d);
  if (!(s.startsWith('/') || s === '~' || s.startsWith('~/')) || /[\r\n\0]/.test(s) || s.length > 1024) {
    throw new Error('Ruta inicial inválida: usa una ruta absoluta (/var/www) o del home (~/app)');
  }
  return s;
}

/** Comilla simple para sh: 'a'\''b'. */
function shQuote(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }

/** Comando remoto que entra a la ruta inicial y abre la shell de login del usuario. */
function startDirCommand(dir) {
  const d = checkDir(dir);
  const target = d === '~' ? '~' : d.startsWith('~/') ? `~/${shQuote(d.slice(2))}` : shQuote(d);
  return `cd ${target} || echo "FRAP: no se pudo entrar a la ruta inicial"; exec "\${SHELL:-/bin/sh}" -l`;
}

/**
 * Argumentos de `ssh` para el servidor `c`.
 * opts: { command?: string (ejecuta y sale), batch?: bool (sin preguntas), connectTimeout?: s }
 * Sin `command` y con `c.dir`, entra a esa ruta y abre la shell de login.
 */
function sshArgs(c, opts = {}) {
  validateHost(c);
  const a = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30'];
  if (c.port) a.push('-p', c.port);
  if (c.key) a.push('-i', c.key, '-o', 'IdentitiesOnly=yes');
  if (c.password) a.push('-o', 'NumberOfPasswordPrompts=1');
  else if (opts.batch) a.push('-o', 'BatchMode=yes');
  if (opts.connectTimeout) a.push('-o', `ConnectTimeout=${opts.connectTimeout}`);
  if (opts.command != null) a.push('-T');
  // interactivo con ruta inicial: terminal forzada (-t) y `cd` antes de la shell
  const start = opts.command == null && c.dir && c.dir !== '~' ? startDirCommand(c.dir) : null;
  if (start) a.push('-t');
  a.push('--', `${c.user}@${c.host}`);
  if (opts.command != null) a.push(opts.command);
  else if (start) a.push(start);
  return a;
}

/**
 * Script askpass ejecutable (ssh no acepta argumentos en SSH_ASKPASS): un envoltorio sh en
 * FRAP_HOME que llama a frap-askpass.js con el mismo node.
 */
function askpassPath(frapHome) {
  const f = path.join(frapHome, 'askpass.sh');
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const body = `#!/bin/sh\nexec ${q(process.execPath)} ${q(ASKPASS_JS)} "$@"\n`;
  let cur = null;
  try { cur = fs.readFileSync(f, 'utf8'); } catch (_) { /* no existe */ }
  if (cur !== body) {
    fs.mkdirSync(frapHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, body, { mode: 0o700 });
  }
  fs.chmodSync(f, 0o700);
  return f;
}

/**
 * Entorno para que ssh obtenga la contraseña sin preguntar en la terminal.
 * `password` (opcional) se usa para probar una conexión aún no guardada.
 */
function askpassEnv(c, frapHome, envFile, password) {
  if (!c.password && !password) return {};
  const env = {
    SSH_ASKPASS: askpassPath(frapHome),
    SSH_ASKPASS_REQUIRE: 'force',
    FRAP_SSH_ID: c.id || '',
    FRAP_SSH_ENV: envFile,
  };
  if (password) env.FRAP_SSH_PASS = password;
  return env;
}

/** Pistas para errores comunes de ssh. */
function sshHint(stderr) {
  const s = String(stderr);
  if (/Permission denied/i.test(s)) return 'Usuario, contraseña o llave incorrectos (o el servidor no permite ese método de acceso).';
  if (/Connection timed out|Operation timed out/i.test(s)) return 'No hay respuesta: revisa la IP, la VPN o el firewall.';
  if (/Connection refused/i.test(s)) return 'El servidor rechaza la conexión: revisa el puerto o que sshd esté corriendo.';
  if (/Could not resolve hostname/i.test(s)) return 'No se resuelve el nombre del host.';
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) return 'La llave del servidor cambió respecto a ~/.ssh/known_hosts. Si es esperado, bórrala con: ssh-keygen -R <host>';
  if (/Host key verification failed/i.test(s)) return 'Falló la verificación de la llave del servidor (~/.ssh/known_hosts).';
  return '';
}

/**
 * Ejecuta un comando remoto sin terminal. Devuelve {code, stdout, stderr, ms, timedOut}.
 * opts: { timeoutMs = 60000, env, maxBytes = 5 MB }
 */
function runRemote(c, command, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  const maxBytes = opts.maxBytes || 5 * 1024 * 1024;
  const args = sshArgs(c, { command, batch: true, connectTimeout: Math.min(15, Math.ceil(timeoutMs / 1000)) });
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env || {}) } });
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let timedOut = false;
    const cap = (buf, d) => (buf.length < maxBytes ? Buffer.concat([buf, d]).subarray(0, maxBytes) : buf);
    p.stdout.on('data', (d) => { out = cap(out, d); });
    p.stderr.on('data', (d) => { err = cap(err, d); });
    const t = setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' ? 'No se encontró el cliente ssh en el sistema' : e.message)); });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code == null ? 255 : code, stdout: out.toString('utf8'), stderr: err.toString('utf8'), ms: Date.now() - started, timedOut });
    });
  });
}

module.exports = {
  loadHosts, saveHosts, publicHost, validateHost, checkDir, shQuote, startDirCommand, sshArgs, askpassPath, askpassEnv, sshHint, runRemote, slugify,
};
