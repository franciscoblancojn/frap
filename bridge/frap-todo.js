#!/usr/bin/env node
'use strict';
// CLI para agentes (skill frap-pendientes): pendientes locales del usuario. Al crearlos quedan vinculados a la sesión
// de FRAP donde corre la IA (la detecta subiendo por sus procesos, como frap-team quien).
// Uso:
//   node frap-todo.js add "<nombre>" [--desc …] [--prioridad alta] [--icono 🔧] [--depende 3] [--estado pendiente]
//   node frap-todo.js list [--todos]
//   node frap-todo.js show <n>
//   node frap-todo.js estado <n> <pendiente|en curso|bloqueado|hecho>
//   node frap-todo.js edit <n> [--titulo …] [--desc …] [--prioridad …] [--icono …] [--depende …]

const os = require('os');
const path = require('path');
const todos = require('./todos');
const team = require('./team');

const FRAP_HOME = process.env.FRAP_HOME || path.join(os.homedir(), '.config', 'frap');
const USAGE = `Uso:
  frap-todo add "<nombre>" [--desc …] [--prioridad alta] [--icono 🔧] [--depende 3] [--estado pendiente]
  frap-todo list [--todos]
  frap-todo show <n>
  frap-todo estado <n> <pendiente|en curso|bloqueado|hecho>
  frap-todo edit <n> [--titulo …] [--desc …] [--prioridad …] [--icono …] [--depende …]`;
const PRIO = { urgent: '🔴 Urgente', high: '🟠 Alta', medium: '🟡 Media', low: '🔵 Baja', none: '⚪ Sin prioridad' };

function parse(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--todos') { opt.todos = true; continue; }
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[++i]; if (v == null) throw new Error(`Falta el valor de ${a}`); (opt[k] = opt[k] || []).push(v); continue; }
    pos.push(a);
  }
  return { pos, opt };
}
const last = (o, k) => (o[k] ? o[k][o[k].length - 1] : undefined);
const line = (t) => `#${t.id}  ${(PRIO[t.priority] || '').split(' ')[0]} ${t.icon ? `${t.icon} ` : ''}${t.title}  [${t.estado}${t.blockedBy && t.blockedBy.length ? ` · espera a #${t.blockedBy.join(', #')}` : ''}]`;
/** Sesión de FRAP donde corre la IA → datos para volver a ella desde el panel izquierdo. */
function sessionLink() {
  const s = team.currentSession(FRAP_HOME);
  if (!s) return null;
  const m = s.meta || {};
  return { sid: s.sid, projectId: m.projectId || null, cwd: m.cwd || '', title: (m.named && m.title) || m.title || '', kind: m.kind || 'claude', ...(m.agent ? { agent: m.agent } : {}) };
}
function fields(opt) {
  const f = {};
  if (opt.titulo) f.title = last(opt, 'titulo');
  if (opt.desc) f.descripcion = last(opt, 'desc');
  if (opt.prioridad) f.priority = last(opt, 'prioridad');
  if (opt.icono) f.icon = last(opt, 'icono');
  if (opt.estado) f.estado = last(opt, 'estado');
  if (opt.depende) f.depends = opt.depende.flatMap((d) => String(d).split(',')).map((d) => Number(String(d).replace(/^#/, '')));
  return f;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }
  const { pos, opt } = parse(rest);
  if (cmd === 'add') {
    const title = pos.join(' ').trim();
    if (!title) throw new Error(`Falta el nombre\n${USAGE}`);
    const session = sessionLink();
    const t = todos.upsert({ ...fields(opt), title, session });
    console.log(`Creado #${t.id}: ${t.title}${session ? ` (vinculado a la sesión «${session.title || session.sid}»)` : ' (sin sesión de FRAP: no se podrá volver a ella)'}`);
    return;
  }
  if (cmd === 'list') {
    const all = todos.list().filter((t) => opt.todos || t.estado !== 'hecho');
    if (!all.length) { console.log('Sin pendientes.'); return; }
    for (const t of all) console.log(line(t));
    return;
  }
  const n = Number(String(pos[0] || '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n < 1) throw new Error(`Falta el número del pendiente\n${USAGE}`);
  if (cmd === 'show') {
    const t = todos.list().find((x) => x.id === n);
    if (!t) throw new Error(`No existe el pendiente #${n}`);
    console.log(`${line(t)}\nPrioridad: ${PRIO[t.priority]}${t.depends && t.depends.length ? `\nDepende de: #${t.depends.join(', #')}` : ''}${t.session ? `\nSesión: ${t.session.title || t.session.sid} (${t.session.cwd})` : ''}\n${t.descripcion ? `\n${t.descripcion}` : ''}`);
    return;
  }
  if (cmd === 'estado') {
    const estado = pos.slice(1).join(' ');
    if (!estado) throw new Error('Falta el estado (pendiente, en curso, bloqueado, hecho)');
    const t = todos.upsert({ id: n, estado });
    console.log(`#${t.id} → ${t.estado}`);
    return;
  }
  if (cmd === 'edit') {
    const t = todos.upsert({ id: n, ...fields(opt) });
    console.log(`Actualizado #${t.id}: ${t.title}`);
    return;
  }
  throw new Error(USAGE);
}

try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
