'use strict';
// SFTP de FRAP: gestor de archivos tipo FileZilla sobre los servidores SSH guardados.
// Usa el binario `sftp` del sistema en modo batch (`-b -`, comandos por stdin). Sin dependencias npm.
//
// Seguridad:
//   - Host, usuario, puerto y llave se validan como en ssh (validateHost) y el destino va tras `--`.
//   - La contraseña la entrega askpass. Ojo: `sftp -b` le agrega `-oBatchMode=yes` a ssh, que desactiva
//     askpass; como ssh se queda con el PRIMER valor de cada opción, `-o BatchMode=no` va antes de `-b`.
//   - Las rutas van escapadas con "\" (sin comillas): sftp no las parte en espacios ni expande comodines.
//     Sin saltos de línea (cada línea es un comando). Las remotas son absolutas: nunca parecen opciones.

const { spawn } = require('child_process');
const { validateHost } = require('./ssh');

/** Argumentos de `sftp` (modo batch, comandos por stdin). opts: { sshBin, connectTimeout } */
function sftpArgs(c, opts = {}) {
  validateHost(c);
  const a = [];
  if (opts.sshBin) a.push('-S', opts.sshBin);
  a.push('-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', `ConnectTimeout=${opts.connectTimeout || 15}`);
  if (c.port) a.push('-P', c.port);
  if (c.key) a.push('-i', c.key, '-o', 'IdentitiesOnly=yes');
  // con contraseña: BatchMode=no ANTES de -b (si no, sftp fuerza BatchMode=yes y askpass no se usa)
  if (c.password) a.push('-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1');
  a.push('-b', '-', '--', `${c.user}@${c.host}`);
  return a;
}

/** Escapa una ruta para una línea de comandos de sftp (espacios, comillas, "\" y comodines). */
function quote(p) {
  const s = String(p == null ? '' : p);
  if (!s || /[\r\n\0]/.test(s)) throw new Error('Ruta inválida');
  return s.replace(/[\\\s"'*?[\]#]/g, (ch) => `\\${ch}`);
}

/** Ruta remota: absoluta y sin saltos de línea. Devuelve la ruta normalizada (sin "/" final, salvo la raíz). */
function remotePath(p) {
  const s = String(p == null ? '' : p);
  if (!s.startsWith('/') || /[\r\n\0]/.test(s)) throw new Error(`Ruta remota inválida: ${s || '(vacía)'}`);
  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

const LS_RE = /^([bcdlps-])[-rwxsStTl]{9}\S*\s+\S+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s(.*)$/;

/** Interpreta la salida de `ls -la` de sftp: [{name, dir, link, size, mtime, perm, owner}] (sin "." ni ".."). */
function parseLs(out) {
  const entries = [];
  for (const line of String(out).split('\n')) {
    const m = line.match(LS_RE);
    if (!m) continue;
    const name = m[6];
    if (name === '.' || name === '..' || !name) continue;
    entries.push({
      name,
      dir: m[1] === 'd',
      link: m[1] === 'l',
      size: Number(m[4]),
      mtime: m[5].replace(/\s+/g, ' '),
      perm: line.slice(0, 10),
      owner: m[2],
    });
  }
  return entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
}

/** Primera línea de error útil de sftp/ssh (sin avisos ni eco de comandos). */
function sftpError(stderr, code) {
  const lines = String(stderr).split('\n').map((l) => l.trim())
    .filter((l) => l && !/^Warning: Permanently added/.test(l) && !/^sftp>/.test(l) && l !== 'Connection closed');
  return lines.pop() || `sftp terminó con código ${code}`;
}

/**
 * Ejecuta comandos sftp (una línea cada uno). Para en el primer error (modo batch).
 * opts: { env, sshBin, timeoutMs = 30000 (0 = sin límite), onSpawn(child) }
 * Devuelve {code, stdout, stderr, ms, timedOut, killed}.
 */
function runSftp(c, lines, opts = {}) {
  const args = sftpArgs(c, { sshBin: opts.sshBin });
  const timeoutMs = opts.timeoutMs == null ? 30000 : opts.timeoutMs;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const p = spawn('sftp', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env || {}) } });
    let out = '';
    let err = '';
    let timedOut = false;
    p.stdout.on('data', (d) => { if (out.length < 8 * 1024 * 1024) out += d; });
    p.stderr.on('data', (d) => { if (err.length < 1024 * 1024) err += d; });
    const t = timeoutMs ? setTimeout(() => { timedOut = true; p.kill('SIGTERM'); }, timeoutMs) : null;
    p.on('error', (e) => { clearTimeout(t); reject(new Error(e.code === 'ENOENT' ? 'No se encontró el cliente sftp en el sistema' : e.message)); });
    p.on('close', (code, signal) => {
      clearTimeout(t);
      resolve({ code: code == null ? 255 : code, stdout: out, stderr: err, ms: Date.now() - started, timedOut, killed: !!signal && !timedOut });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(`${lines.join('\n')}\n`);
    if (opts.onSpawn) opts.onSpawn(p);
  });
}

module.exports = { sftpArgs, quote, remotePath, parseLs, sftpError, runSftp };
