#!/usr/bin/env node
'use strict';
// CLI para agentes (skill frap-alertas): mostrarle una alerta al usuario en FRAP, ahora o programada. Solo funciona si
// el usuario encendió el interruptor «IA» de la pestaña Alertas. La alerta queda vinculada a la sesión de FRAP donde
// corre la IA. Uso:
//   node frap-alert.js ya "<título>" [--desc …] [--bloquear] [--icono ✅] [--sin-sonido]
//   node frap-alert.js en <10m|90s|1h30m> "<título>" [opciones]
//   node frap-alert.js a-las <HH:MM> "<título>" [--fecha AAAA-MM-DD] [opciones]
//   node frap-alert.js diaria <HH:MM> "<título>" [--dias lun,mar,mie,jue,vie] [opciones]
//   node frap-alert.js list

const fs = require('fs');
const path = require('path');
const alerts = require('./alerts');
const team = require('./team');

const FRAP_HOME = alerts.defaultHome();
const USAGE = `Uso:
  frap-alert ya "<título>" [--desc …] [--bloquear] [--icono ✅] [--sin-sonido]
  frap-alert en <10m|90s|1h30m> "<título>" [opciones]
  frap-alert a-las <HH:MM> "<título>" [--fecha AAAA-MM-DD] [opciones]
  frap-alert diaria <HH:MM> "<título>" [--dias lun,mar,mie,jue,vie] [opciones]
  frap-alert list`;
const DAYS = { dom: 0, domingo: 0, lun: 1, lunes: 1, mar: 2, martes: 2, mie: 3, mié: 3, miercoles: 3, miércoles: 3, jue: 4, jueves: 4, vie: 5, viernes: 5, sab: 6, sáb: 6, sabado: 6, sábado: 6 };
const DAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

function parse(argv) {
  const pos = [];
  const opt = {};
  const flags = new Set(['--bloquear', '--sin-sonido']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) { opt[a.slice(2)] = true; continue; }
    if (a.startsWith('--')) { const v = argv[++i]; if (v == null) throw new Error(`Falta el valor de ${a}`); opt[a.slice(2)] = v; continue; }
    pos.push(a);
  }
  return { pos, opt };
}
function sessionLink() {
  const s = team.currentSession(FRAP_HOME);
  if (!s) return null;
  const m = s.meta || {};
  return { sid: s.sid, title: (m.named && m.title) || m.title || '', projectId: m.projectId || null, cwd: m.cwd || '', ...(m.icon ? { icon: m.icon } : {}) };
}
const base = (opt) => ({ desc: opt.desc || '', icon: opt.icono || '🤖', mode: opt.bloquear ? 'modal' : 'toast', sound: !opt['sin-sonido'], session: sessionLink() });

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }
  const { pos, opt } = parse(rest);
  if (cmd === 'list') {
    let st = {};
    try { st = JSON.parse(fs.readFileSync(path.join(FRAP_HOME, 'state.json'), 'utf8')); } catch (_) { /* sin estado */ }
    const list = Array.isArray(st.timers) ? st.timers : [];
    if (!list.length) { console.log('El usuario no tiene alertas.'); return; }
    for (const t of list) {
      const when = t.kind === 'repeat' ? `cada ${t.every} s` : t.kind === 'once' ? `una vez en ${t.every} s` : t.kind === 'at' ? `el ${t.date || ''} a las ${t.time}` : `todos los días${t.days && t.days.length ? ` (${t.days.map((d) => DAY_NAMES[d]).join(',')})` : ''} a las ${t.time}`;
      console.log(`${t.icon || '⏰'} ${t.title} · ${when} · ${t.enabled ? `próxima: ${t.nextAt ? new Date(t.nextAt).toLocaleString() : '?'}` : 'apagada'}`);
    }
    return;
  }
  let req;
  if (cmd === 'ya' || cmd === 'show' || cmd === 'ahora') {
    req = { action: 'show', title: pos.join(' '), ...base(opt) };
  } else if (cmd === 'en' || cmd === 'in') {
    const secs = alerts.parseDuration(pos[0]);
    if (!secs) throw new Error(`Duración inválida: ${pos[0] || '(falta)'} (p. ej. 10m, 90s, 1h30m)`);
    req = { action: 'create', title: pos.slice(1).join(' '), when: { kind: 'in', secs }, ...base(opt) };
  } else if (cmd === 'a-las' || cmd === 'at') {
    req = { action: 'create', title: pos.slice(1).join(' '), when: { kind: 'at', time: pos[0], ...(opt.fecha ? { date: opt.fecha } : {}) }, ...base(opt) };
  } else if (cmd === 'diaria' || cmd === 'daily') {
    const days = opt.dias ? String(opt.dias).toLowerCase().split(/[,\s]+/).filter(Boolean).map((d) => { if (!(d in DAYS)) throw new Error(`Día inválido: ${d} (lun, mar, mie, jue, vie, sab, dom)`); return DAYS[d]; }) : undefined;
    req = { action: 'create', title: pos.slice(1).join(' '), when: { kind: 'daily', time: pos[0], ...(days ? { days } : {}) }, ...base(opt) };
  } else throw new Error(USAGE);
  const a = alerts.enqueue(FRAP_HOME, req);
  const w = a.when;
  console.log(a.action === 'show'
    ? `Alerta enviada a FRAP: ${a.icon} ${a.title}`
    : `Alerta programada en FRAP: ${a.icon} ${a.title} · ${w.kind === 'in' ? `en ${w.secs} s` : w.kind === 'at' ? `a las ${w.time}${w.date ? ` del ${w.date}` : ''}` : `todos los días${w.days ? ` (${w.days.map((d) => DAY_NAMES[d]).join(',')})` : ''} a las ${w.time}`}`);
}

try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
