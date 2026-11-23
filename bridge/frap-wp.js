#!/usr/bin/env node
'use strict';
// CLI para agentes (skill frap-wordpress): sitios WordPress conectados en FRAP con el plugin frap-wordpress.
// Solo ve las conexiones con ENABLED=1 y AI=1. Los permisos los pone el token en el propio sitio (por defecto,
// solo lectura). Nunca imprime el token.
// Uso:
//   node frap-wp.js list
//   node frap-wp.js <id> info
//   node frap-wp.js <id> get <recurso>[/<id>] [clave=valor …]
//   node frap-wp.js <id> create <recurso> '<json>' | -
//   node frap-wp.js <id> update <recurso>/<id> '<json>' | -
//   node frap-wp.js <id> delete <recurso>/<id> [force=true]

const fs = require('fs');
const os = require('os');
const path = require('path');
const wp = require('./wordpress');

const FRAP_HOME = process.env.FRAP_HOME || path.join(os.homedir(), '.config', 'frap');
const ENV_FILE = path.join(FRAP_HOME, 'wordpress.env');
const USAGE = `Uso:
  frap-wp list
  frap-wp <id> info
  frap-wp <id> get <recurso>[/<id>] [clave=valor …]     (p. ej. search=hola per_page=5 _fields=id,title)
  frap-wp <id> create <recurso> '<json>'                 ("-" lee el JSON de stdin)
  frap-wp <id> update <recurso>/<id> '<json>'
  frap-wp <id> delete <recurso>/<id> [force=true]`;

const usable = () => wp.loadSites(ENV_FILE).filter((s) => s.enabled && s.ai && s.token);

function site(id) {
  const all = wp.loadSites(ENV_FILE);
  const s = all.find((x) => x.id === id);
  if (!s) throw new Error(`No existe la conexión "${id}". Disponibles: ${usable().map((x) => x.id).join(', ') || '(ninguna)'}`);
  if (!s.enabled) throw new Error(`La conexión "${id}" está apagada en FRAP: pídele al usuario que la active.`);
  if (!s.ai) throw new Error(`La conexión "${id}" no tiene "Uso por IA" en FRAP: pídele al usuario que lo active.`);
  if (!s.token) throw new Error(`La conexión "${id}" no tiene token.`);
  return s;
}

function parseQuery(args) {
  const q = {};
  for (const a of args) {
    const m = a.match(/^--?([A-Za-z_][\w]*)=(.*)$/) || a.match(/^([A-Za-z_][\w]*)=(.*)$/);
    if (!m) throw new Error(`Parámetro inválido: ${a} (se espera clave=valor)`);
    q[m[1]] = m[2];
  }
  return q;
}

function readJson(arg) {
  const text = arg === '-' ? fs.readFileSync(0, 'utf8') : arg;
  if (text == null || text === '') throw new Error('Falta el JSON con los campos');
  try { return JSON.parse(text); } catch (e) { throw new Error(`JSON inválido: ${e.message}`); }
}

function print(r) {
  if (r.total != null) console.error(`# ${r.total} en total${r.totalPages > 1 ? `, ${r.totalPages} páginas` : ''} · ${r.ms} ms`);
  console.log(JSON.stringify(r.data, null, 2));
}

async function main(argv) {
  const [first, cmd, target, ...rest] = argv;
  if (!first || first === 'help' || first === '--help') { console.log(USAGE); return; }
  if (first === 'list') {
    const list = usable();
    if (!list.length) { console.log(`Sin sitios disponibles (activos y con "IA") en ${ENV_FILE}`); return; }
    for (const s of list) console.log(`${s.id}\t${s.name}\t${s.url}`);
    return;
  }
  const s = site(first);
  if (!cmd || cmd === 'info') {
    const i = await wp.info(s);
    const allowed = Object.entries(i.resources || {}).map(([k, r]) => `  ${k.padEnd(20)} ${r.allowed.length ? r.allowed.join(', ') : '—'}${r.available.length > r.allowed.length ? `   (no permitido: ${r.available.filter((a) => !r.allowed.includes(a)).join(', ')})` : ''}`);
    const left = Math.max(0, i.token.expires - i.now);
    console.log(`${i.name} — ${i.site}
WordPress ${i.wordpress}${i.woocommerce ? ` · WooCommerce ${i.woocommerce}` : ''} · plugin frap-wordpress ${i.plugin}
Token «${i.token.name}»: vence en ${Math.floor(left / 3600)} h ${Math.floor((left % 3600) / 60)} min
Permisos (recurso: acciones):
${allowed.join('\n')}`);
    return;
  }
  const ops = { get: 'GET', create: 'POST', update: 'PUT', delete: 'DELETE' };
  if (!ops[cmd]) throw new Error(USAGE);
  if (!target) throw new Error(`Falta el recurso.\n${USAGE}`);
  const p = wp.checkPath(target);
  const hasId = /\/\d+$/.test(p);
  if ((cmd === 'update' || cmd === 'delete') && !hasId) throw new Error(`${cmd} necesita <recurso>/<id>`);
  if (cmd === 'create' && hasId) throw new Error('create va sin id: <recurso>');
  let query = {};
  let body;
  if (cmd === 'create' || cmd === 'update') {
    body = readJson(rest[0]);
    query = parseQuery(rest.slice(1));
  } else {
    query = parseQuery(rest);
  }
  const r = await wp.request(s, ops[cmd], p, { query, body });
  if (r.status >= 400) throw wp.apiError(r);
  print(r);
}

main(process.argv.slice(2)).catch((e) => { console.error(e.status ? `Error ${e.status}: ${e.message}` : e.message); process.exitCode = 1; });
