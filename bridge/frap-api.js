#!/usr/bin/env node
'use strict';
// CLI para agentes (skill frap-api): peticiones HTTP guardadas en local/api (módulo API de FRAP, como Postman).
// Uso:
//   node frap-api.js list [carpeta]
//   node frap-api.js new <carpeta>/<nombre> --method GET --url '{{base}}/x' [--header 'K: V'] [--query 'k=v']
//                        [--json '<json>' | --text '<texto>' | --form 'k=v' | --urlencoded 'k=v'] [--desc '…'] [--force]
//   node frap-api.js run <carpeta>/<nombre> [--var k=v] [--raw] [--headers] [--timeout 30]
//   node frap-api.js show <carpeta>/<nombre>
//   node frap-api.js vars [carpeta]
//   node frap-api.js set-var <carpeta|--global> k=v [k=v …]

const api = require('./api');

const USAGE = `Uso:
  frap-api list [carpeta]
  frap-api new <carpeta>/<nombre> --method GET --url '{{base}}/x' [--header 'K: V'] [--query 'k=v'] [--json '{…}' | --text '…' | --form 'k=v' | --urlencoded 'k=v'] [--desc '…'] [--force]
  frap-api run <carpeta>/<nombre> [--var k=v] [--raw] [--headers] [--timeout 30]
  frap-api show <carpeta>/<nombre>
  frap-api vars [carpeta]
  frap-api set-var <carpeta|--global> k=v [k=v …]`;

/** --clave valor (repetibles) y posicionales. */
function parseArgs(argv) {
  const pos = [];
  const opt = {};
  const flags = new Set(['--raw', '--headers', '--force', '--global']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) { opt[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[++i];
      if (v == null) throw new Error(`Falta el valor de ${a}`);
      (opt[k] = opt[k] || []).push(v);
      continue;
    }
    pos.push(a);
  }
  return { pos, opt };
}
const one = (o, k) => (o[k] ? o[k][o[k].length - 1] : undefined);
const pair = (s, sep) => { const i = s.indexOf(sep); if (i < 1) throw new Error(`Se espera clave${sep}valor: ${s}`); return { key: s.slice(0, i).trim(), value: s.slice(i + sep.length).trim() }; };

function printTree(nodes, depth = 0) {
  for (const n of nodes) {
    const pad = '  '.repeat(depth);
    if (n.type === 'folder') { console.log(`${pad}📁 ${n.name}/${n.vars ? `  (${n.vars} variable${n.vars === 1 ? '' : 's'})` : ''}`); printTree(n.children, depth + 1); }
    else console.log(`${pad}${n.method.padEnd(7)} ${n.path}   ${n.url}${n.hasRes ? '' : '   (sin ejecutar)'}`);
  }
}
function findFolder(nodes, rel) {
  for (const n of nodes) {
    if (n.type !== 'folder') continue;
    if (n.path === rel) return n;
    const f = findFolder(n.children, rel);
    if (f) return f;
  }
  return null;
}

function printResponse(r, { raw, headers }) {
  const res = r.response;
  console.error(`${r.request.method} ${r.request.url}`);
  if (r.missing.length) console.error(`⚠ Variables sin definir: ${r.missing.join(', ')}`);
  if (res.error) { console.error(`✗ ${res.error}`); process.exitCode = 1; return; }
  console.error(`→ ${res.status} ${res.statusText} · ${res.ms} ms · ${res.size} bytes${res.contentType ? ` · ${res.contentType}` : ''}${res.redirects && res.redirects.length ? ` · ${res.redirects.length} redirección(es)` : ''}${res.truncated ? ' · TRUNCADA' : ''}`);
  if (headers) for (const [k, v] of Object.entries(res.headers || {})) console.error(`  ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  if (res.encoding === 'base64') { console.log(`[binario: ${res.size} bytes, ${res.contentType || 'sin tipo'}]`); }
  else if (!raw && /json/i.test(res.contentType || '')) { try { console.log(JSON.stringify(JSON.parse(res.body), null, 2)); } catch (_) { console.log(res.body); } }
  else console.log(res.body);
  if (res.status >= 400) process.exitCode = 2;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }
  const { pos, opt } = parseArgs(rest);
  if (cmd === 'list') {
    const t = api.tree();
    const nodes = pos[0] ? (findFolder(t, api.safeRel(pos[0]).rel) || { children: [] }).children : t;
    if (!nodes.length) { console.log(`Sin peticiones${pos[0] ? ` en ${pos[0]}` : ''} (${api.API_DIR})`); return; }
    printTree(nodes);
    return;
  }
  if (cmd === 'new') {
    if (!pos[0]) throw new Error(`Falta <carpeta>/<nombre>\n${USAGE}`);
    if (!one(opt, 'url')) throw new Error('Falta --url');
    const req = {
      method: one(opt, 'method') || 'GET',
      url: one(opt, 'url'),
      headers: (opt.header || []).map((h) => pair(h, ':')),
      query: (opt.query || []).map((q) => pair(q, '=')),
      descripcion: one(opt, 'desc') || '',
    };
    if (opt.json) { const t = one(opt, 'json'); try { JSON.parse(t.replace(/{{\s*[$\w.-]+\s*}}/g, '0')); } catch (e) { throw new Error(`--json no es JSON válido: ${e.message}`); } req.body = { mode: 'json', text: t }; }
    else if (opt.text) req.body = { mode: 'text', text: one(opt, 'text') };
    else if (opt.form) req.body = { mode: 'form', form: opt.form.map((f) => pair(f, '=')) };
    else if (opt.urlencoded) req.body = { mode: 'urlencoded', form: opt.urlencoded.map((f) => pair(f, '=')) };
    const r = api.saveReq(pos[0], req, { create: !opt.force });
    console.log(`Creada ${r.path} (${r.request.method} ${r.request.url}). Ejecútala con: frap-api run ${r.path}`);
    return;
  }
  if (cmd === 'run') {
    if (!pos[0]) throw new Error(`Falta <carpeta>/<nombre>\n${USAGE}`);
    const vars = Object.fromEntries((opt.var || []).map((v) => { const p = pair(v, '='); return [p.key, p.value]; }));
    const timeout = Number(one(opt, 'timeout')) || 30;
    const r = await api.run(pos[0], { vars, timeoutMs: timeout * 1000 });
    printResponse(r, { raw: opt.raw, headers: opt.headers });
    return;
  }
  if (cmd === 'show') {
    if (!pos[0]) throw new Error(`Falta <carpeta>/<nombre>\n${USAGE}`);
    const r = api.readReq(pos[0]);
    console.log(JSON.stringify(r.request, null, 2));
    if (r.response) console.error(`\nÚltima respuesta (${r.response.at}): ${r.response.error ? `✗ ${r.response.error}` : `${r.response.status} ${r.response.statusText} · ${r.response.ms} ms · ${r.response.size} bytes`}`);
    else console.error('\nSin ejecutar todavía.');
    return;
  }
  if (cmd === 'vars') {
    const v = api.getVars(pos[0] || '');
    const masked = api.maskVars(v.variables);
    console.error(`# Variables ${v.folder ? `de ${v.folder}` : 'globales'}`);
    if (!Object.keys(masked).length) { console.log('(ninguna)'); return; }
    for (const [k, val] of Object.entries(masked)) console.log(`${k}=${val}`);
    return;
  }
  if (cmd === 'set-var') {
    const folder = opt.global ? '' : pos.shift();
    if (folder == null) throw new Error('Indica la carpeta o --global');
    if (!pos.length) throw new Error('Faltan las variables (clave=valor)');
    const cur = api.getVars(folder).variables;
    for (const p of pos.map((x) => pair(x, '='))) cur[p.key] = p.value;
    const r = api.setVars(folder, cur);
    console.log(`Variables ${r.folder ? `de ${r.folder}` : 'globales'}: ${Object.keys(r.variables).join(', ')}`);
    return;
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
