'use strict';
// Módulo "API" (tipo Postman): peticiones HTTP guardadas como archivos en local/api/, en carpetas.
//   local/api/_globales.json             variables globales      {"variables": {"clave": "valor"}}
//   local/api/<carpeta>/_carpeta.json    variables de la carpeta {"variables": {...}, "descripcion": "…"}
//   local/api/<carpeta>/<nombre>.req.json  la petición          {method, url, query, headers, body, descripcion}
//   local/api/<carpeta>/<nombre>.res.json  la última respuesta  (se guarda al enviarla)
// Las variables {{nombre}} se buscan en la carpeta de la petición, luego en sus carpetas padre y por último en las
// globales. Hay variables dinámicas: {{$timestamp}}, {{$isoDate}}, {{$uuid}}, {{$randomInt}}.
// La IA crea y ejecuta peticiones con frap-api.js (skill frap-api), en una carpeta con el ID de la issue o el nombre
// del proyecto: así quedan como recurso para el futuro. Solo librería estándar de Node.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { isPrivateHost } = require('./tunnels');

const LOCAL_DIR = path.resolve(process.env.FRAP_LOCAL || path.join(__dirname, '..', 'local'));
const API_DIR = path.join(LOCAL_DIR, 'api');
const CLI = path.join(__dirname, 'frap-api.js');
const GLOBALS = '_globales.json';
const FOLDER_META = '_carpeta.json';
const REQ_EXT = '.req.json';
const RES_EXT = '.res.json';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_MODES = ['none', 'json', 'text', 'urlencoded', 'form'];
const MAX_BODY = 10 * 1024 * 1024; // respuesta máxima que se lee
const MAX_SAVED = 2 * 1024 * 1024; // cuerpo máximo que se guarda en .res.json
const SECRET_RE = /token|secret|password|passwd|pass|clave|key|auth|bearer|cookie|session/i;

function ensureDir() { fs.mkdirSync(API_DIR, { recursive: true }); }

/** Ruta relativa segura dentro de local/api (carpetas y nombres sin "..", sin ocultos, sin "_" al inicio de un nombre de petición). */
function safeRel(rel, { allowRoot = false } = {}) {
  const r = String(rel == null ? '' : rel).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = r.split('/').filter(Boolean);
  if (!parts.length && !allowRoot) throw new Error('Falta la ruta');
  if (parts.some((p) => p === '..' || p === '.' || p.startsWith('.') || /[\0<>:"|?*]/.test(p))) throw new Error(`Ruta inválida: ${rel}`);
  const abs = parts.length ? path.join(API_DIR, ...parts) : API_DIR;
  if (abs !== API_DIR && !abs.startsWith(API_DIR + path.sep)) throw new Error(`Ruta inválida: ${rel}`);
  return { rel: parts.join('/'), abs, parts };
}
/** "carpeta/nombre" (con o sin .req.json) → rutas de la petición y su respuesta. */
function reqPaths(rel) {
  const base = String(rel || '').replace(/\.(req|res)\.json$/i, '');
  const { rel: r, abs, parts } = safeRel(base);
  if (parts[parts.length - 1].startsWith('_')) throw new Error('El nombre de una petición no puede empezar por "_"');
  return { rel: r, file: `${abs}${REQ_EXT}`, res: `${abs}${RES_EXT}`, dir: path.dirname(abs), folder: parts.slice(0, -1).join('/') };
}
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return def; } };
function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, f);
}

// ---------- normalización ----------
const kv = (list) => (Array.isArray(list) ? list : list && typeof list === 'object' ? Object.entries(list).map(([key, value]) => ({ key, value })) : [])
  .filter((x) => x && (String(x.key || '').trim() || String(x.value || '').trim()))
  .map((x) => ({ key: String(x.key || '').trim(), value: String(x.value == null ? '' : x.value), ...(x.off ? { off: true } : {}) }));
/** Petición válida con todos sus campos (acepta formas cortas: headers como objeto, body como string u objeto). */
function normalizeReq(r) {
  const req = r && typeof r === 'object' ? r : {};
  const method = String(req.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`Método no soportado: ${req.method}`);
  let body = req.body;
  if (body == null || body === '') body = { mode: 'none' };
  else if (typeof body === 'string') body = { mode: /^\s*[[{]/.test(body) ? 'json' : 'text', text: body };
  else if (typeof body === 'object' && !body.mode) body = { mode: 'json', text: JSON.stringify(body, null, 2) };
  const mode = BODY_MODES.includes(body.mode) ? body.mode : 'none';
  return {
    method,
    url: String(req.url || '').trim(),
    query: kv(req.query),
    headers: kv(req.headers),
    body: { mode, text: mode === 'json' || mode === 'text' ? String(body.text == null ? '' : body.text) : '', form: mode === 'urlencoded' || mode === 'form' ? kv(body.form) : [] },
    descripcion: String(req.descripcion || req.description || ''),
  };
}

// ---------- árbol ----------
/** [{name, path, type: 'folder'|'request', method?, url?, children?}] ordenado: carpetas primero. */
function tree() {
  ensureDir();
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
    const out = [];
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const meta = readJson(path.join(dir, e.name, FOLDER_META), {});
        out.push({ name: e.name, path: r, type: 'folder', vars: Object.keys((meta && meta.variables) || {}).length, children: walk(path.join(dir, e.name), r) });
      } else if (e.isFile() && e.name.endsWith(REQ_EXT)) {
        const name = e.name.slice(0, -REQ_EXT.length);
        const q = readJson(path.join(dir, e.name), {});
        const hasRes = fs.existsSync(path.join(dir, `${name}${RES_EXT}`));
        out.push({ name, path: rel ? `${rel}/${name}` : name, type: 'request', method: String((q && q.method) || 'GET').toUpperCase(), url: String((q && q.url) || ''), hasRes });
      }
    }
    return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1));
  };
  return walk(API_DIR, '');
}

// ---------- peticiones ----------
function readReq(rel) {
  const p = reqPaths(rel);
  if (!fs.existsSync(p.file)) throw new Error(`No existe la petición ${p.rel}`);
  return { path: p.rel, request: normalizeReq(readJson(p.file, {})), response: readJson(p.res, null) };
}
function saveReq(rel, request, { create = false } = {}) {
  const p = reqPaths(rel);
  if (create && fs.existsSync(p.file)) throw new Error(`Ya existe la petición ${p.rel}`);
  const req = normalizeReq(request);
  writeJson(p.file, req);
  return { path: p.rel, request: req };
}
function mkdir(rel) {
  const { rel: r, abs, parts } = safeRel(rel);
  if (parts.some((x) => x.startsWith('_'))) throw new Error('El nombre de una carpeta no puede empezar por "_"');
  if (fs.existsSync(abs)) throw new Error(`Ya existe: ${r}`);
  fs.mkdirSync(abs, { recursive: true });
  return { path: r };
}
/** Renombra o mueve una petición (con su respuesta) o una carpeta. */
function rename(from, to, type) {
  if (type === 'folder') {
    const a = safeRel(from);
    const b = safeRel(to);
    if (!fs.existsSync(a.abs)) throw new Error(`No existe: ${a.rel}`);
    if (fs.existsSync(b.abs)) throw new Error(`Ya existe: ${b.rel}`);
    if (b.abs.startsWith(a.abs + path.sep)) throw new Error('No se puede mover una carpeta dentro de sí misma');
    fs.mkdirSync(path.dirname(b.abs), { recursive: true });
    fs.renameSync(a.abs, b.abs);
    return { path: b.rel };
  }
  const a = reqPaths(from);
  const b = reqPaths(to);
  if (!fs.existsSync(a.file)) throw new Error(`No existe la petición ${a.rel}`);
  if (fs.existsSync(b.file)) throw new Error(`Ya existe la petición ${b.rel}`);
  fs.mkdirSync(b.dir, { recursive: true });
  fs.renameSync(a.file, b.file);
  if (fs.existsSync(a.res)) fs.renameSync(a.res, b.res);
  return { path: b.rel };
}
/** Archivos a borrar de una petición o carpeta (el bridge los manda a la papelera). */
function targetsOf(rel, type) {
  if (type === 'folder') { const { abs } = safeRel(rel); return fs.existsSync(abs) ? [abs] : []; }
  const p = reqPaths(rel);
  return [p.file, p.res].filter((f) => fs.existsSync(f));
}

// ---------- variables ----------
/** Variables de una carpeta ('' = globales). */
function getVars(folder) {
  const f = folder ? path.join(safeRel(folder).abs, FOLDER_META) : path.join(API_DIR, GLOBALS);
  const meta = readJson(f, {});
  return { folder: folder ? safeRel(folder).rel : '', variables: (meta && meta.variables) || {}, descripcion: (meta && meta.descripcion) || '' };
}
function setVars(folder, variables, descripcion) {
  const f = folder ? path.join(safeRel(folder).abs, FOLDER_META) : path.join(API_DIR, GLOBALS);
  if (folder) {
    const { parts } = safeRel(folder);
    if (parts.some((x) => x.startsWith('_'))) throw new Error('El nombre de una carpeta no puede empezar por "_"');
    fs.mkdirSync(path.dirname(f), { recursive: true }); // como `new`: la carpeta se crea si no existe
  }
  const vars = {};
  for (const [k, v] of Object.entries(variables || {})) {
    const key = String(k).trim();
    if (!key) continue;
    if (!/^[\w.-]+$/.test(key)) throw new Error(`Nombre de variable inválido: ${key} (letras, números, _ . -)`);
    vars[key] = String(v == null ? '' : v);
  }
  const prev = readJson(f, {}) || {};
  writeJson(f, { ...prev, variables: vars, ...(descripcion != null ? { descripcion: String(descripcion) } : {}) });
  return getVars(folder);
}
/** Variables que ve una petición: globales < carpetas (de la raíz a la suya) < extra. Con su origen. */
function scopeVars(reqRel, extra = {}) {
  const out = {};
  const from = {};
  const put = (vars, src) => { for (const [k, v] of Object.entries(vars || {})) { out[k] = v; from[k] = src; } };
  put(getVars('').variables, 'globales');
  const parts = reqRel ? reqPaths(reqRel).folder.split('/').filter(Boolean) : [];
  for (let i = 1; i <= parts.length; i++) { const f = parts.slice(0, i).join('/'); put(getVars(f).variables, f); }
  put(extra, 'línea de comandos');
  return { vars: out, from };
}
const DYNAMIC = {
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoDate: () => new Date().toISOString(),
  $uuid: () => crypto.randomUUID(),
  $randomInt: () => String(Math.floor(Math.random() * 1000)),
};
/** Reemplaza {{var}} (hasta 5 niveles: una variable puede usar otras). Devuelve el texto y las que faltan. */
function interpolate(text, vars, missing) {
  let s = String(text == null ? '' : text);
  for (let i = 0; i < 5 && /{{\s*[$\w.-]+\s*}}/.test(s); i++) {
    s = s.replace(/{{\s*([$\w.-]+)\s*}}/g, (m, k) => {
      if (DYNAMIC[k]) return DYNAMIC[k]();
      if (Object.prototype.hasOwnProperty.call(vars, k)) return vars[k];
      if (missing) missing.add(k);
      return m;
    });
  }
  return s;
}
/** Petición con las variables resueltas, lista para enviar. {url, method, headers, body, missing} */
function resolve(req, vars) {
  const missing = new Set();
  const I = (t) => interpolate(t, vars, missing);
  let url = I(req.url);
  if (!url) throw new Error('La petición no tiene URL');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  let u;
  try { u = new URL(url); } catch (_) { throw new Error(`URL inválida: ${url}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Solo se admiten URLs http y https');
  for (const q of req.query.filter((x) => !x.off && x.key)) u.searchParams.append(I(q.key), I(q.value));
  const headers = {};
  for (const h of req.headers.filter((x) => !x.off && x.key)) headers[I(h.key)] = I(h.value);
  let body = null;
  const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
  if (req.body.mode === 'json' || req.body.mode === 'text') {
    body = Buffer.from(I(req.body.text));
    if (!has('content-type')) headers['Content-Type'] = req.body.mode === 'json' ? 'application/json' : 'text/plain; charset=utf-8';
  } else if (req.body.mode === 'urlencoded') {
    const p = new URLSearchParams();
    for (const f of req.body.form.filter((x) => !x.off && x.key)) p.append(I(f.key), I(f.value));
    body = Buffer.from(p.toString());
    if (!has('content-type')) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (req.body.mode === 'form') {
    const boundary = `----frap${crypto.randomBytes(8).toString('hex')}`;
    const chunks = [];
    for (const f of req.body.form.filter((x) => !x.off && x.key)) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${I(f.key).replace(/"/g, '%22')}"\r\n\r\n${I(f.value)}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    body = Buffer.concat(chunks);
    headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
  }
  if (!has('user-agent')) headers['User-Agent'] = 'FRAP';
  if (!has('accept')) headers.Accept = '*/*';
  return { method: req.method, url: u.toString(), headers, body, missing: [...missing] };
}

// ---------- envío ----------
function isText(type) { return !type || /^text\/|json|xml|javascript|html|csv|x-www-form-urlencoded|graphql|yaml/i.test(type); }
/** Envía una petición resuelta. {status, statusText, ms, size, headers, body, encoding, truncated, url, redirects} */
function send(r, { timeoutMs = 30000, follow = true } = {}) {
  const t0 = Date.now();
  const redirects = [];
  const once = (url, method, body, headers, left) => new Promise((resolveP, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method, headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) },
      rejectUnauthorized: !isPrivateHost(u.hostname), timeout: timeoutMs,
    }, (res) => {
      if (follow && left > 0 && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        redirects.push({ status: res.statusCode, url: next });
        const keep = [307, 308].includes(res.statusCode);
        once(next, keep ? method : method === 'HEAD' ? 'HEAD' : 'GET', keep ? body : null, keep ? headers : Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-/i.test(k))), left - 1).then(resolveP, reject);
        return;
      }
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      try {
        if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      } catch (_) { stream = res; }
      const chunks = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (c) => {
        if (truncated) return;
        size += c.length;
        if (size > MAX_BODY) { truncated = true; req.destroy(); return; }
        chunks.push(c);
      });
      const done = () => {
        const buf = Buffer.concat(chunks);
        const type = String(res.headers['content-type'] || '');
        const text = isText(type) && !buf.slice(0, 4000).includes(0);
        resolveP({
          url, status: res.statusCode, statusText: res.statusMessage || '', ms: Date.now() - t0, size: buf.length,
          headers: res.headers, contentType: type, encoding: text ? 'utf8' : 'base64',
          body: text ? buf.toString('utf8') : buf.toString('base64'), truncated, redirects,
        });
      };
      stream.on('end', done);
      stream.on('error', (e) => (truncated ? done() : reject(e)));
      res.on('aborted', () => { if (truncated) done(); });
    });
    req.on('timeout', () => req.destroy(new Error(`Sin respuesta en ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', (e) => reject(new Error(e.code === 'ENOTFOUND' ? `No se encuentra el host (${u.hostname})` : e.code === 'ECONNREFUSED' ? `Conexión rechazada (${u.host})` : e.message)));
    if (body) req.write(body);
    req.end();
  });
  return once(r.url, r.method, r.body, r.headers, 5);
}
/**
 * Resuelve y envía una petición guardada (o `request` sin guardar, con la ruta para sus variables) y guarda la
 * respuesta en <nombre>.res.json. {request (resuelta, sin cuerpo binario), response, missing}
 */
async function run(rel, { request, vars: extra, timeoutMs, save = true } = {}) {
  const p = rel ? reqPaths(rel) : null;
  const req = normalizeReq(request || (p && readJson(p.file, null)) || (() => { throw new Error(`No existe la petición ${rel}`); })());
  const { vars } = scopeVars(p ? p.rel : '', extra);
  const r = resolve(req, vars);
  let response;
  try {
    response = await send(r, { timeoutMs });
  } catch (e) {
    response = { error: e.message, ms: 0, url: r.url };
  }
  const sent = { method: r.method, url: r.url, headers: r.headers, body: r.body && r.body.length < 200000 && !/multipart/i.test(r.headers['Content-Type'] || '') ? r.body.toString('utf8') : r.body ? `[${r.body.length} bytes]` : null };
  const saved = { at: new Date().toISOString(), request: sent, ...response, ...(response.body && response.body.length > MAX_SAVED ? { body: response.body.slice(0, MAX_SAVED), truncated: true } : {}) };
  if (save && p) writeJson(p.res, saved);
  return { path: p ? p.rel : null, request: sent, response, missing: r.missing };
}

/** Oculta valores de variables con nombre sensible (para mostrarlas a la IA). */
const maskVars = (vars) => Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, SECRET_RE.test(k) && v ? `•••${String(v).slice(-3)}` : v]));

// ---------- skill frap-api ----------
const SKILL_MARK = 'frap-api (FRAP)';
function skillText() {
  const cli = `node ${CLI}`;
  return `---
name: frap-api
description: Peticiones HTTP guardadas en FRAP (módulo API, como Postman): crear, ejecutar y reutilizar peticiones a APIs, HTML, JSON, webhooks, etc. Úsala siempre que vayas a hacer una petición HTTP en una issue, un script o una tarea (en vez de curl suelto), para que quede guardada como recurso.
---

<!-- ${SKILL_MARK}: la instala y la quita FRAP con el módulo API -->

# Peticiones de FRAP (módulo API)

Las peticiones viven en \`${API_DIR}\` (carpeta local de FRAP, fuera de git; se exporta en el zip de local/).
El usuario las ve y las ejecuta en FRAP (pestaña API del panel central). Úsalas con este CLI:

\`\`\`bash
${cli} list [carpeta]                                        # árbol de carpetas y peticiones
${cli} new <carpeta>/<nombre> --method GET --url '{{base}}/users' [--header 'Accept: application/json'] [--query 'page=1'] [--json '{"a":1}' | --text '…' | --form 'k=v'] [--desc '…']
${cli} run <carpeta>/<nombre> [--var clave=valor] [--raw] [--headers]   # la envía, guarda la respuesta y la muestra
${cli} show <carpeta>/<nombre>                               # la petición (sin resolver) y su última respuesta
${cli} vars [carpeta]                                        # variables (sin carpeta: globales); las sensibles salen ocultas
${cli} set-var <carpeta|--global> clave=valor [clave=valor …]
\`\`\`

## Dónde guardar
- Si trabajas una issue (skill frap-issues): en la carpeta con su ID, p. ej. \`AVE-2445/cotizar-pedido\`.
- Si no: en la carpeta con el nombre del proyecto o repo en el que estás, p. ej. \`aveonline-connect-shopify/webhook-orden\`.
- Nombres cortos y descriptivos en minúsculas con guiones. Antes de crear una, mira \`list\` por si ya existe y reutilízala.

## Variables
- \`{{nombre}}\` en URL, parámetros, cabeceras y cuerpo. Se buscan en la carpeta de la petición, luego en sus carpetas padre y por último en las globales.
- Pon la URL base y los tokens en variables de la carpeta (\`set-var AVE-2445 base=https://api.x.com token=…\`), no repetidos en cada petición.
- Dinámicas: \`{{$timestamp}}\`, \`{{$isoDate}}\`, \`{{$uuid}}\`, \`{{$randomInt}}\`.

## Reglas
- **Peticiones que cambian datos** (POST, PUT, PATCH, DELETE contra algo que no sea local o de pruebas): muéstrale al usuario qué vas a enviar y espera su visto bueno, salvo que él mismo lo haya pedido.
- No muestres tokens ni contraseñas en tus respuestas; el CLI ya oculta las variables con nombre sensible.
- Si trabajas una issue, anota en su changelog qué petición creaste o ejecutaste (ruta en local/api y resultado).
`;
}
const skill = require('./wordpress').skillManager('frap-api', SKILL_MARK, skillText);
const skillStatus = () => skill.status();
const setSkill = (on) => skill.set(on);

module.exports = {
  API_DIR, CLI, METHODS, BODY_MODES, REQ_EXT, RES_EXT,
  safeRel, reqPaths, normalizeReq, tree, readReq, saveReq, mkdir, rename, targetsOf,
  getVars, setVars, scopeVars, interpolate, resolve, send, run, maskVars,
  skillText, skillStatus, setSkill,
};
