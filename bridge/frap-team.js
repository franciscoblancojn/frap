#!/usr/bin/env node
'use strict';
// CLI para agentes (skill frap-equipo): el equipo del usuario y a quién está asignada esta sesión.
// Uso:
//   node frap-team.js quien          persona asignada a la sesión de FRAP donde corre (rol y descripción)
//   node frap-team.js list           el equipo, por rol
//   node frap-team.js show <nombre>  una persona (por nombre o id)

const os = require('os');
const path = require('path');
const team = require('./team');

const FRAP_HOME = process.env.FRAP_HOME || path.join(os.homedir(), '.config', 'frap');
const USAGE = 'Uso:\n  frap-team quien\n  frap-team list\n  frap-team show <nombre>';

const card = (p) => `${p.icon || '👤'} ${p.name} — ${p.role}${p.descripcion ? `\n${p.descripcion.split('\n').map((l) => `   ${l}`).join('\n')}` : ''}`;

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(USAGE); return; }
  const { people, roles } = team.load();
  if (cmd === 'quien' || cmd === 'who') {
    const s = team.currentSession(FRAP_HOME);
    if (!s) { console.log('Esta terminal no es una sesión de FRAP (no se puede saber a quién está asignada).'); return; }
    const id = s.meta && s.meta.person;
    const p = id && people.find((x) => x.id === id);
    if (!p) { console.log(`La sesión «${(s.meta && s.meta.title) || s.sid}» no está asignada a nadie del equipo.${people.length ? ' Equipo: frap-team list' : ''}`); return; }
    console.log(`Esta sesión está asignada a:\n${card(p)}`);
    return;
  }
  if (cmd === 'list') {
    if (!people.length) { console.log(`Sin equipo todavía (${team.TEAM_FILE}). El usuario lo crea en FRAP.`); return; }
    for (const r of roles) {
      const of = people.filter((p) => p.role === r);
      if (!of.length) continue;
      console.log(`## ${r}`);
      for (const p of of) console.log(card(p));
      console.log('');
    }
    return;
  }
  if (cmd === 'show') {
    const q = rest.join(' ').trim();
    if (!q) throw new Error('Falta el nombre');
    const p = team.find(q);
    if (!p) throw new Error(`No hay nadie llamado «${q}» en el equipo. Equipo: ${people.map((x) => x.name).join(', ') || '(vacío)'}`);
    console.log(card(p));
    return;
  }
  throw new Error(USAGE);
}

try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
