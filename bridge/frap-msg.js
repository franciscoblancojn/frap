#!/usr/bin/env node
'use strict';
// CLI para agentes (skill frap-mensajes): mensajes para personas y de pull requests que el usuario ve en el panel
// izquierdo de FRAP (módulo Mensajes). Al crearlos quedan vinculados a la sesión de FRAP donde corre la IA.
// Uso:
//   node frap-msg.js add --para "<persona>" [--titulo …] --texto "<mensaje>" | --texto -   (stdin)
//   node frap-msg.js pr --url <url> [--accion review|aprobado|cambios|comentario|merge|nuevo] [--para …] [--titulo …] --texto …
//   node frap-msg.js list [--todos]
//   node frap-msg.js show <n>
//   node frap-msg.js edit <n> [--texto …] [--titulo …] [--para …] [--accion …] [--url …]
//   node frap-msg.js enviado <n> | pendiente <n>
//   node frap-msg.js import <archivo>     (un mensaje que quedó en un archivo …/mensajes/*.md)

const fs = require('fs');
const os = require('os');
const path = require('path');
const messages = require('./messages');
const team = require('./team');

const FRAP_HOME = process.env.FRAP_HOME || path.join(os.homedir(), '.config', 'frap');
const USAGE = `Uso:
  frap-msg add --para "<persona>" [--titulo …] --texto "<mensaje>"     (--texto - lo lee de stdin)
  frap-msg pr --url <url del PR> [--accion review|aprobado|cambios|comentario|merge|nuevo] [--para …] [--titulo …] --texto …
  frap-msg list [--todos]
  frap-msg show <n>
  frap-msg edit <n> [--texto …] [--titulo …] [--para …] [--accion …] [--url …]
  frap-msg enviado <n>    |    frap-msg pendiente <n>
  frap-msg import <archivo .md en mensajes/>   (un mensaje que quedó en un archivo)`;
const ACC = Object.fromEntries(messages.PR_ACCIONES.map(([k, ico, label]) => [k, `${ico} ${label}`]));

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--todos') { opt.todos = true; continue; }
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[++i]; if (v == null) throw new Error(`Falta el valor de ${a}`); opt[k] = v; continue; }
    pos.push(a);
  }
  return { pos, opt };
}
/** Sesión de FRAP donde corre la IA → para volver a ella y mostrar su ícono y su persona. */
function sessionLink() {
  const s = team.currentSession(FRAP_HOME);
  if (!s) return null;
  const m = s.meta || {};
  return { sid: s.sid, projectId: m.projectId || null, cwd: m.cwd || '', title: (m.named && m.title) || m.title || '', kind: m.kind || 'claude', ...(m.agent ? { agent: m.agent } : {}), ...(m.icon ? { icon: m.icon } : {}), ...(m.person ? { person: m.person } : {}) };
}
const texto = (opt) => (opt.texto === '-' ? fs.readFileSync(0, 'utf8') : opt.texto);
function fields(opt) {
  const f = {};
  if (opt.texto !== undefined) f.texto = texto(opt);
  if (opt.titulo !== undefined) f.titulo = opt.titulo;
  if (opt.para !== undefined) f.para = opt.para;
  if (opt.url !== undefined || opt.accion !== undefined) f.pr = { ...(opt.url !== undefined ? { url: opt.url } : {}), ...(opt.accion !== undefined ? { accion: opt.accion } : {}) };
  return f;
}
const line = (m) => `#${m.id}  ${m.tipo === 'pr' ? `${ACC[m.pr.accion] || '🔀'} PR${m.pr.numero ? ` #${m.pr.numero}` : ''}` : '✉'} ${m.titulo}${m.para ? `  → ${m.para}` : ''}  [${m.estado}]`;

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }
  const { pos, opt } = parse(rest);
  if (cmd === 'add' || cmd === 'pr') {
    if (opt.texto === undefined) throw new Error(`Falta --texto\n${USAGE}`);
    if (cmd === 'pr' && !opt.url) throw new Error(`Falta --url del PR\n${USAGE}`);
    const session = sessionLink();
    const m = messages.upsert({ ...fields(opt), tipo: cmd === 'pr' ? 'pr' : 'persona', session });
    console.log(`Guardado el mensaje #${m.id}${m.para ? ` para ${m.para}` : ''}: ${m.titulo}${session ? ` (sesión «${session.title || session.sid}»)` : ''}. El usuario lo ve en FRAP → Mensajes.`);
    return;
  }
  if (cmd === 'import') {
    const f = path.resolve(String(pos[0] || '').replace(/^~(?=\/)/, os.homedir()));
    if (!pos[0]) throw new Error(`Falta el archivo\n${USAGE}`);
    if (!messages.isMsgFile(f)) throw new Error('Solo archivos .md o .txt dentro de una carpeta mensajes/');
    const r = messages.importFile(f, fs.readFileSync(f, 'utf8'), sessionLink());
    console.log(`${r.created ? 'Importado' : 'Ya estaba'}: mensaje #${r.msg.id}${r.msg.para ? ` para ${r.msg.para}` : ''}${r.msg.pr ? ` (PR #${r.msg.pr.numero || '?'})` : ''}`);
    return;
  }
  if (cmd === 'list') {
    const all = messages.list().filter((m) => opt.todos || m.estado !== 'enviado');
    if (!all.length) { console.log(opt.todos ? 'Sin mensajes.' : 'Sin mensajes pendientes de enviar.'); return; }
    for (const m of all) console.log(line(m));
    return;
  }
  const n = Number(String(pos[0] || '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n < 1) throw new Error(`Falta el número del mensaje\n${USAGE}`);
  if (cmd === 'show') {
    const m = messages.list().find((x) => x.id === n);
    if (!m) throw new Error(`No existe el mensaje #${n}`);
    console.log(`${line(m)}${m.pr ? `\n${m.pr.url}` : ''}${m.session ? `\nSesión: ${m.session.title || m.session.sid}` : ''}\n\n${m.texto}`);
    return;
  }
  if (cmd === 'enviado' || cmd === 'pendiente') {
    const m = messages.upsert({ id: n, estado: cmd });
    console.log(`#${m.id} → ${m.estado}`);
    return;
  }
  if (cmd === 'edit') {
    const m = messages.upsert({ id: n, ...fields(opt) });
    console.log(`Actualizado el mensaje #${m.id}: ${m.titulo}`);
    return;
  }
  throw new Error(USAGE);
}

try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
