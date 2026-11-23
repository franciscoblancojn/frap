'use strict';
// Túneles (pestaña "Túneles" del panel derecho): compartir por una URL pública algo que corre en local
// (un puerto, una IP de la red o un archivo/carpeta), como los port forwarding de VS Code.
//
// Cada túnel = una "puerta" local del bridge (http en 127.0.0.1:<puerto al azar>) + un proveedor que la publica:
//   cloudflared (quick tunnel, https://*.trycloudflare.com), localhost.run (ssh, sin instalar nada) o ngrok.
// La puerta: contraseña opcional, reescribe el Host (Vite & cía. rechazan hosts desconocidos), sigue las
// redirecciones a localhost, opcionalmente reescribe las URLs localhost del contenido (WordPress), sirve
// archivos estáticos, pasa WebSockets (HMR) y cuenta visitas. Solo librería estándar de Node.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const FRAP_HOME = process.env.FRAP_HOME || path.join(os.homedir(), '.config', 'frap');
const BIN_DIR = path.join(FRAP_HOME, 'bin');
const PROVIDERS = {
  cloudflared: { name: 'Cloudflare (cloudflared)', bin: 'cloudflared' },
  localhostrun: { name: 'localhost.run (ssh)', bin: 'ssh' },
  ngrok: { name: 'ngrok', bin: 'ngrok' },
};
const URL_TIMEOUT = Number(process.env.FRAP_TUNNEL_TIMEOUT || 45000);
const tunnels = new Map(); // id -> túnel
let onChange = () => {};

function which(bin) {
  const dirs = [BIN_DIR, ...(process.env.PATH || '').split(path.delimiter)];
  for (const d of dirs) {
    if (!d) continue;
    const f = path.join(d, bin);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch (_) { /* sigue */ }
  }
  return null;
}
function providers() {
  return Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { name: p.name, path: which(p.bin) }]));
}
/** 'auto': cloudflared si está instalado (estable, sin límite), si no localhost.run por ssh, si no ngrok. */
function pickProvider(want) {
  const av = providers();
  if (want && want !== 'auto') {
    if (!PROVIDERS[want]) throw new Error(`Proveedor desconocido: ${want}`);
    if (!av[want].path) throw new Error(`${PROVIDERS[want].name} no está instalado`);
    return want;
  }
  const k = ['cloudflared', 'localhostrun', 'ngrok'].find((x) => av[x].path);
  if (!k) throw new Error('No hay ningún proveedor de túneles: instala cloudflared (o ssh)');
  return k;
}

// ---------- destino ----------
/** Normaliza el destino: {type:'url', url} (puerto o http(s)://host:puerto) o {type:'path', root, file}. */
function parseTarget(t) {
  if (!t || typeof t !== 'object') throw new Error('Falta el destino');
  if (t.type === 'path') {
    const abs = path.resolve(String(t.path || ''));
    const st = fs.statSync(abs);
    return st.isDirectory() ? { type: 'path', root: abs, file: null, label: abs } : { type: 'path', root: path.dirname(abs), file: path.basename(abs), label: abs };
  }
  let raw = String(t.url != null ? t.url : t.port || '').trim();
  if (/^\d+$/.test(raw)) raw = `http://localhost:${raw}`;
  else if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error(`Destino inválido: ${t.url || t.port}`); }
  if (!u.hostname) throw new Error(`Destino inválido: ${raw}`);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (!(port > 0 && port < 65536)) throw new Error('Puerto inválido');
  return { type: 'url', protocol: u.protocol, host: u.hostname, port, base: u.pathname.replace(/\/+$/, ''), label: `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}` };
}

// ---------- puerta local ----------
const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', pdf: 'application/pdf', wasm: 'application/wasm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', zip: 'application/zip',
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const AUTH_COOKIE = 'frap_tunnel';

function authOk(T, req) {
  if (!T.password) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
    const pass = dec.slice(dec.indexOf(':') + 1);
    if (safeEqual(pass, T.password)) return true;
  }
  const ck = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${AUTH_COOKIE}=`));
  return !!ck && safeEqual(ck.slice(AUTH_COOKIE.length + 1), T.cookie);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function countHit(T, req) {
  T.hits++;
  T.lastHit = Date.now();
  const ip = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  if (ip && T.visitors.size < 10000) T.visitors.add(ip);
  emit(T);
}

function serveStatic(T, req, res) {
  const tg = T.target;
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { res.writeHead(400); res.end('Ruta inválida'); return; }
  if (rel === '/' && tg.file) { res.writeHead(302, { location: `/${encodeURIComponent(tg.file)}` }); res.end(); return; }
  const abs = path.join(tg.root, rel);
  if (abs !== tg.root && !abs.startsWith(tg.root + path.sep)) { res.writeHead(403); res.end('Prohibido'); return; }
  // un archivo suelto: solo ese archivo y lo que esté en su carpeta (css, imágenes…)
  let st;
  try { st = fs.statSync(abs); } catch (_) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('No encontrado'); return; }
  if (path.basename(abs).startsWith('.') && abs !== tg.root) { res.writeHead(404); res.end('No encontrado'); return; } // nada de .env, .git…
  if (st.isDirectory()) {
    if (!rel.endsWith('/')) { res.writeHead(301, { location: `${req.url.split('?')[0]}/` }); res.end(); return; }
    const idx = path.join(abs, 'index.html');
    if (fs.existsSync(idx)) return sendFile(res, idx, req);
    const items = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(rel)}</title>`
      + '<style>body{font:15px system-ui;margin:24px;background:#0e1014;color:#d7dae0}a{color:#7aa2f7;text-decoration:none;display:block;padding:3px 0}</style>'
      + `<h3>${esc(rel)}</h3>${rel !== '/' ? '<a href="../">⬑ ..</a>' : ''}`
      + items.map((e) => `<a href="${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${e.isDirectory() ? '📁' : '📄'} ${esc(e.name)}</a>`).join(''));
    return;
  }
  sendFile(res, abs, req, st);
}
function sendFile(res, abs, req, st = fs.statSync(abs)) {
  const type = MIME[(path.extname(abs).slice(1) || '').toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) { // video/audio: pedir por partes
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(abs, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(abs).pipe(res);
}

/** Equipo local o red privada: ahí un https con certificado propio es lo normal (no se verifica). */
function isPrivateHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, ''); // IPv6 de una URL viene entre corchetes
  if (/^(localhost|.*\.localhost|.*\.local|.*\.test)$/i.test(h) || h === '::1') return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (!m) return h.includes(':') && /^(fc|fd|fe80)/i.test(h); // solo IPv6 privadas (no dominios como fcbarcelona.com)
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
const TEXTY = /^(text\/|application\/(json|javascript|xml|xhtml\+xml|ld\+json|manifest\+json)|image\/svg)/i;
function publicOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `https://${host}` : '';
}
function proxyHeaders(T, req) {
  const tg = T.target;
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('cf-')) out[k] = v;
  const pubHost = req.headers.host;
  if (T.hostRewrite) out.host = (tg.port === 80 && tg.protocol === 'http:') || (tg.port === 443 && tg.protocol === 'https:') ? tg.host : `${tg.host}:${tg.port}`;
  out['x-forwarded-host'] = req.headers['x-forwarded-host'] || pubHost;
  out['x-forwarded-proto'] = 'https';
  if (T.password) { delete out.authorization; }
  if (T.rewriteUrls) out['accept-encoding'] = 'identity'; // para poder reescribir el cuerpo
  return out;
}
/** Orígenes locales que se reemplazan por el público (Location y, si se pide, el contenido). */
function localOrigins(tg) {
  const hosts = new Set([tg.host]);
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(tg.host)) ['localhost', '127.0.0.1'].forEach((x) => hosts.add(x));
  const defPort = (tg.protocol === 'https:' && tg.port === 443) || (tg.protocol === 'http:' && tg.port === 80);
  const out = [];
  for (const hst of hosts) for (const proto of ['http:', 'https:']) {
    out.push(`${proto}//${hst}:${tg.port}`);
    if (defPort) out.push(`${proto}//${hst}`);
  }
  return out.sort((a, b) => b.length - a.length);
}
function rewriteOrigins(text, origins, pub) {
  let s = text;
  for (const o of origins) {
    s = s.split(o).join(pub);
    s = s.split(o.replace(/\//g, '\\/')).join(pub.replace(/\//g, '\\/')); // JSON escapado (WordPress)
  }
  return s;
}
function proxyHttp(T, req, res) {
  const tg = T.target;
  const mod = tg.protocol === 'https:' ? https : http;
  const pr = mod.request({
    host: tg.host, port: tg.port, method: req.method, path: tg.base + req.url, headers: proxyHeaders(T, req),
    rejectUnauthorized: !isPrivateHost(tg.host), // locales/red privada: certificado propio (https://localhost); remotos: se verifica
  }, (up) => {
    const headers = { ...up.headers };
    for (const k of HOP) delete headers[k];
    const pub = publicOrigin(req);
    const origins = localOrigins(tg);
    if (headers.location && pub) headers.location = rewriteOrigins(String(headers.location), origins, pub);
    const ct = String(headers['content-type'] || '');
    if (T.rewriteUrls && pub && TEXTY.test(ct) && !headers['content-encoding']) {
      const chunks = [];
      let size = 0;
      up.on('data', (c) => { size += c.length; if (size <= 20 * 1024 * 1024) chunks.push(c); });
      up.on('end', () => {
        const body = Buffer.from(rewriteOrigins(Buffer.concat(chunks).toString('utf8'), origins, pub));
        headers['content-length'] = body.length;
        res.writeHead(up.statusCode, up.statusMessage, headers);
        res.end(body);
      });
      return;
    }
    res.writeHead(up.statusCode, up.statusMessage, headers);
    up.pipe(res);
  });
  pr.on('error', (e) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;margin:40px;background:#0e1014;color:#d7dae0"><h2>No responde ${esc(tg.label)}</h2><p>El túnel funciona, pero el servidor local no contesta (${esc(e.code || e.message)}). ¿Está corriendo?</p>`);
  });
  req.pipe(pr);
}
function proxyUpgrade(T, req, socket, head) {
  const tg = T.target;
  const up = (tg.protocol === 'https:' ? tls : net).connect({ host: tg.host, port: tg.port, rejectUnauthorized: !isPrivateHost(tg.host), servername: net.isIP(tg.host) ? undefined : tg.host }, () => {
    const hdrs = proxyHeaders(T, req);
    hdrs.connection = 'Upgrade';
    hdrs.upgrade = req.headers.upgrade;
    delete hdrs['accept-encoding'];
    let raw = `${req.method} ${tg.base + req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(hdrs)) for (const val of [].concat(v)) raw += `${k}: ${val}\r\n`;
    up.write(`${raw}\r\n`);
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  const close = () => { socket.destroy(); up.destroy(); T.upgraded.delete(close); };
  T.upgraded.add(close); // al parar el túnel se cortan también los WebSocket abiertos
  up.on('error', close);
  up.on('close', close);
  socket.on('error', close);
  socket.on('close', close);
}
function makeGateway(T) {
  const srv = http.createServer((req, res) => {
    // ?frap_key=<clave>: deja una cookie y redirige sin la clave (para compartir un enlace que ya entra)
    if (T.password && req.url.includes('frap_key=')) {
      const u = new URL(req.url, 'http://x');
      if (safeEqual(u.searchParams.get('frap_key') || '', T.password)) {
        u.searchParams.delete('frap_key');
        res.writeHead(302, { location: u.pathname + (u.search || ''), 'set-cookie': `${AUTH_COOKIE}=${T.cookie}; Path=/; HttpOnly; Secure; SameSite=Lax` });
        res.end();
        return;
      }
    }
    if (!authOk(T, req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="FRAP", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
      res.end('Este túnel tiene contraseña (cualquier usuario).');
      return;
    }
    countHit(T, req);
    if (T.target.type === 'path') serveStatic(T, req, res);
    else proxyHttp(T, req, res);
  });
  srv.on('upgrade', (req, socket, head) => {
    if (!authOk(T, req) || T.target.type === 'path') { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    proxyUpgrade(T, req, socket, head);
  });
  srv.on('clientError', (e, socket) => socket.destroy());
  return srv;
}

// ---------- proveedor ----------
function providerCmd(kind, port) {
  const bin = which(PROVIDERS[kind].bin);
  const local = `http://127.0.0.1:${port}`;
  if (kind === 'cloudflared') return [bin, ['tunnel', '--no-autoupdate', '--url', local]];
  if (kind === 'ngrok') return [bin, ['http', local, '--log', 'stdout', '--log-format', 'json']];
  return [bin, ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${path.join(FRAP_HOME, 'tunnel_known_hosts')}`,
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes', '-o', 'PasswordAuthentication=no',
    '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run', '--', '--output', 'json']];
}
/** Busca la URL pública en lo que imprime el proveedor. */
function findUrl(kind, text) {
  if (kind === 'cloudflared') return (text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i) || [])[0] || null;
  if (kind === 'ngrok') return (text.match(/"url":"(https:\/\/[^"]+)"/) || [])[1] || null;
  for (const line of text.split('\n')) {
    try { const j = JSON.parse(line); if (j && j.data && j.data.address) return `https://${j.data.address}`; } catch (_) { /* no es JSON */ }
  }
  // respaldo: solo dominios de túnel (el banner de bienvenida menciona admin.localhost.run, que no lo es)
  return (text.match(/https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.lhr\.life/i) || [])[0] || null;
}

/** Línea JSON de localhost.run ({type, data: {message}}) → {text legible, warning?}; null si no es un evento. */
function providerEvent(line) {
  if (!line.trim().startsWith('{')) return null;
  let j;
  try { j = JSON.parse(line); } catch (_) { return null; }
  if (!j || typeof j.type !== 'string') return null;
  const kind = j.type.split('.').pop();
  const msg = String((j.data && (j.data.message || j.data.address)) || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)[0].trim();
  const out = { text: `[${kind}] ${msg}`.trim() };
  if (/throttl/i.test(kind)) out.warning = 'localhost.run está limitando la velocidad de este túnel (plan gratis): las páginas pesadas pueden no terminar de cargar. Instala cloudflared para quitar el límite.';
  return out;
}
function info(T) {
  return {
    id: T.id, name: T.name, provider: T.provider, providerName: PROVIDERS[T.provider].name, target: T.target.label, kind: T.target.type,
    status: T.status, url: T.url, error: T.error, warning: T.warning || null, startedAt: T.startedAt, hits: T.hits, visitors: T.visitors.size, lastHit: T.lastHit,
    localUrl: T.port ? `http://127.0.0.1:${T.port}` : null, password: !!T.password, log: T.log.slice(-15),
  };
}
function emit(T) {
  const now = Date.now();
  if (T.status === 'online' && T.lastEmit && now - T.lastEmit < 1000) { // visitas: como mucho un aviso por segundo
    if (!T.emitTimer) T.emitTimer = setTimeout(() => { T.emitTimer = null; T.lastEmit = Date.now(); onChange(info(T)); }, 1000);
    return;
  }
  T.lastEmit = now;
  onChange(info(T));
}

async function start(opts) {
  const id = String(opts.id || crypto.randomBytes(6).toString('hex'));
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error('id inválido');
  if (tunnels.has(id)) stop(id);
  const target = parseTarget(opts.target);
  const provider = pickProvider(opts.provider);
  const password = opts.password ? String(opts.password) : '';
  if (password.length > 200) throw new Error('Contraseña demasiado larga');
  const T = {
    id, name: String(opts.name || target.label).slice(0, 120), provider, target, password, cookie: crypto.randomBytes(18).toString('hex'),
    hostRewrite: opts.hostRewrite !== false, rewriteUrls: !!opts.rewriteUrls,
    status: 'starting', url: null, error: null, startedAt: Date.now(), hits: 0, visitors: new Set(), lastHit: 0, log: [], port: 0, upgraded: new Set(),
  };
  tunnels.set(id, T);
  T.server = makeGateway(T);
  await new Promise((res, rej) => { T.server.once('error', rej); T.server.listen(0, '127.0.0.1', res); });
  T.port = T.server.address().port;
  const [bin, args] = providerCmd(provider, T.port);
  T.proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SSH_ASKPASS: '', DISPLAY: '' } });
  let buf = '';
  const onData = (d) => {
    const s = d.toString();
    buf = (buf + s).slice(-20000);
    T.lineBuf = (T.lineBuf || '') + s;
    const lines = T.lineBuf.split(/\r?\n/);
    T.lineBuf = lines.pop().slice(-20000); // la última puede estar a medias (JSON partido entre trozos)
    for (const l of lines) {
      const ev = providerEvent(l);
      if (ev) {
        if (ev.warning && T.warning !== ev.warning) { T.warning = ev.warning; emit(T); }
        if (ev.text) T.log.push(ev.text);
        continue;
      }
      // ni el QR de localhost.run ni líneas enormes: texto legible
      const clean = l.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (clean && !/^[\s█▀▄]+$/.test(clean)) T.log.push(clean.length > 300 ? `${clean.slice(0, 300)}…` : clean);
    }
    if (T.log.length > 200) T.log.splice(0, T.log.length - 200);
    if (!T.url) {
      const u = findUrl(provider, buf);
      if (u) { T.url = u; T.status = 'online'; clearTimeout(T.timer); emit(T); }
    }
  };
  T.proc.stdout.on('data', onData);
  T.proc.stderr.on('data', onData);
  T.proc.on('error', (e) => { T.status = 'error'; T.error = e.message; emit(T); });
  T.proc.on('exit', (code) => {
    clearTimeout(T.timer);
    if (T.status === 'stopped') return;
    T.status = 'error';
    T.error = T.error || `El proveedor terminó (código ${code}). ${T.log.slice(-3).join(' · ')}`.trim();
    closeServer(T);
    emit(T);
  });
  T.timer = setTimeout(() => {
    if (T.url) return;
    T.error = `No llegó la URL pública en ${Math.round(URL_TIMEOUT / 1000)} s. ${T.log.slice(-3).join(' · ')}`;
    stop(id, 'error');
  }, URL_TIMEOUT);
  emit(T);
  return info(T);
}
function closeServer(T) {
  for (const close of [...T.upgraded]) close();
  if (T.server) { try { T.server.close(); } catch (_) { /* ya cerrado */ } if (T.server.closeAllConnections) T.server.closeAllConnections(); }
}
function stop(id, status = 'stopped') {
  const T = tunnels.get(id);
  if (!T) return { id, status: 'stopped' };
  T.status = status;
  clearTimeout(T.timer);
  if (T.proc && T.proc.exitCode == null) { try { T.proc.kill('SIGTERM'); } catch (_) { /* ya terminó */ } }
  closeServer(T);
  emit(T);
  if (status === 'stopped') tunnels.delete(id);
  return info(T);
}
function stopAll() { for (const id of [...tunnels.keys()]) stop(id); }
function list() { return [...tunnels.values()].map(info); }

// puertos conocidos que no son web (DNS, ssh, correo, CUPS, bases de datos, cachés…)
const NOT_HTTP = new Set([21, 22, 25, 53, 110, 111, 143, 465, 587, 631, 993, 995, 1433, 1521, 3306, 5353, 5432, 6379, 11211, 27017, 33060]);
/** Servidores escuchando en este equipo (para "compartir" con un clic): [{port, host, pid, name, cmd, cwd}] */
function listening(exclude = []) {
  return new Promise((resolve) => {
    execFile('ss', ['-ltnpH'], { timeout: 5000 }, (err, out) => {
      if (err) { resolve([]); return; }
      const skip = new Set([...exclude, ...[...tunnels.values()].map((T) => T.port)]);
      const seen = new Map();
      for (const line of out.split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        const local = cols[3];
        const port = Number(local.slice(local.lastIndexOf(':') + 1));
        const host = local.slice(0, local.lastIndexOf(':')).replace(/^\[|\]$/g, '');
        if (!port || skip.has(port) || seen.has(port)) continue;
        if (/^fe80/i.test(host)) continue; // enlace local IPv6: no es un servidor para compartir
        if (NOT_HTTP.has(port)) continue;
        const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
        const pid = m ? Number(m[2]) : null;
        let cmd = '';
        let cwd = '';
        if (pid) {
          try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 200); } catch (_) { /* otro usuario */ }
          try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch (_) { /* otro usuario */ }
        }
        if (m && /^(claude|codex|opencode|cloudflared|ngrok|ssh)$/.test(m[1])) continue; // puertos internos de las IA y de los propios túneles
        if (/frap-bridge\.js|frap_pty\.py/.test(cmd)) continue; // FRAP mismo (otro bridge): nunca se ofrece compartirlo
        seen.set(port, { port, host, pid, name: m ? m[1] : '', cmd, cwd });
      }
      resolve([...seen.values()].sort((a, b) => a.port - b.port));
    });
  });
}

module.exports = {
  isPrivateHost, providerEvent, PROVIDERS, BIN_DIR, providers, pickProvider, parseTarget, start, stop, stopAll, list, listening, findUrl, localOrigins, rewriteOrigins,
  setOnChange: (fn) => { onChange = fn; },
};
