'use strict';
// Módulo "Equipo": las personas con las que trabaja el usuario (nombre, ícono, rol, descripción) y a quién está
// asignada cada sesión de IA. El equipo vive en local/equipo/equipo.json (fuera de git, viaja en el zip de local/).
// La asignación va en la meta de la sesión (meta.person = id de la persona), que el bridge guarda en
// <SOCK_DIR>/<sid>.json. La IA la lee con frap-team.js: sube por su árbol de procesos hasta la terminal de FRAP que
// la contiene. Así, "genera un mensaje para Juan" respeta lo que Juan prefiere (su descripción).
// Solo librería estándar de Node.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const LOCAL_DIR = path.resolve(process.env.FRAP_LOCAL || path.join(__dirname, '..', 'local'));
const TEAM_DIR = path.join(LOCAL_DIR, 'equipo');
const TEAM_FILE = path.join(TEAM_DIR, 'equipo.json');
const CLI = path.join(__dirname, 'frap-team.js');
const ROLES = ['Jefe', 'Project manager', 'Desarrollador', 'QA', 'Diseño', 'Soporte', 'Cliente', 'Otro'];

/** Carpeta de las sesiones de FRAP (sockets y meta). La misma fórmula en el bridge y en los CLI. */
function sockDirFor(frapHome) {
  const base = process.env.XDG_RUNTIME_DIR && fs.existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : os.tmpdir();
  return path.join(base, `frap-${process.getuid ? process.getuid() : 'u'}-${crypto.createHash('sha1').update(path.resolve(frapHome)).digest('hex').slice(0, 8)}`);
}

const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'persona';

function load() {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(TEAM_FILE, 'utf8')); } catch (_) { /* sin equipo todavía */ }
  const people = (Array.isArray(d.people) ? d.people : []).filter((p) => p && p.id && p.name);
  return { people, roles: [...new Set([...ROLES, ...people.map((p) => p.role).filter(Boolean)])] };
}
function save(people) {
  fs.mkdirSync(TEAM_DIR, { recursive: true });
  const tmp = `${TEAM_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ people }, null, 2)}\n`);
  fs.renameSync(tmp, TEAM_FILE);
}
/** Crea o edita una persona. {id?, name, icon, role, descripcion} → la persona guardada. */
function upsert(input) {
  const p = input && typeof input === 'object' ? input : {};
  const name = String(p.name || '').trim().slice(0, 80);
  if (!name) throw new Error('El nombre es obligatorio');
  const role = String(p.role || 'Otro').trim().slice(0, 40) || 'Otro';
  const icon = String(p.icon || '👤').trim().slice(0, 8) || '👤';
  const descripcion = String(p.descripcion || '').slice(0, 4000);
  const color = /^#[0-9a-f]{6}$/i.test(String(p.color || '')) ? String(p.color).toLowerCase() : ''; // '' = el de su nombre
  const { people } = load();
  let person;
  if (p.id) {
    person = people.find((x) => x.id === p.id);
    if (!person) throw new Error(`No existe la persona ${p.id}`);
    Object.assign(person, { name, role, icon, descripcion, color });
  } else {
    const taken = new Set(people.map((x) => x.id));
    let id = slug(name);
    for (let i = 2; taken.has(id); i++) id = `${slug(name)}-${i}`;
    person = { id, name, role, icon, descripcion, color, created: new Date().toISOString() };
    people.push(person);
  }
  save(people);
  return person;
}
/** Importa personas (de un export .json) conservando su id: el mismo id se reemplaza. → {added, replaced} */
function importPeople(list) {
  const { people } = load();
  let added = 0;
  let replaced = 0;
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || !raw.name) continue;
    const id = slug(raw.id || raw.name);
    const person = {
      id,
      name: String(raw.name).trim().slice(0, 80),
      role: String(raw.role || 'Otro').trim().slice(0, 40) || 'Otro',
      icon: String(raw.icon || '👤').trim().slice(0, 8) || '👤',
      descripcion: String(raw.descripcion || '').slice(0, 4000),
      color: /^#[0-9a-f]{6}$/i.test(String(raw.color || '')) ? String(raw.color).toLowerCase() : '',
      created: raw.created || new Date().toISOString(),
    };
    const i = people.findIndex((x) => x.id === id);
    if (i >= 0) { people[i] = person; replaced++; } else { people.push(person); added++; }
  }
  save(people);
  return { added, replaced };
}
function remove(id) {
  const { people } = load();
  if (!people.some((x) => x.id === id)) throw new Error(`No existe la persona ${id}`);
  save(people.filter((x) => x.id !== id));
  return true;
}
/** Persona por id, o por nombre (sin tildes ni mayúsculas, también el primer nombre). */
function find(q) {
  const { people } = load();
  const s = slug(q);
  return people.find((p) => p.id === q) || people.find((p) => slug(p.name) === s) || people.find((p) => slug(p.name).split('-')[0] === s) || null;
}

// ---------- sesión de la IA que pregunta ----------
/** ppid de un proceso (Linux: /proc/<pid>/stat). */
function ppidOf(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]) || 0;
  } catch (_) { return 0; }
}
/**
 * Sesión de FRAP en la que corre este proceso: sube por los padres hasta un pid que sea el de una sesión
 * (el helper frap_pty.py). FRAP_SID manda si está definida. → {sid, pid, meta} o null.
 */
function currentSession(frapHome, startPid = process.pid) {
  const dir = sockDirFor(frapHome);
  let metas = [];
  try { metas = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; } }).filter(Boolean); } catch (_) { return null; }
  if (process.env.FRAP_SID) { const m = metas.find((x) => x.sid === process.env.FRAP_SID); if (m) return m; }
  const byPid = new Map(metas.map((m) => [Number(m.pid), m]));
  let pid = startPid;
  for (let i = 0; i < 40 && pid > 1; i++) {
    if (byPid.has(pid)) return byPid.get(pid);
    pid = ppidOf(pid);
  }
  return null;
}

// ---------- skill frap-equipo ----------
const SKILL_MARK = 'frap-equipo (FRAP)';
function skillText() {
  const cli = `node ${CLI}`;
  return `---
name: frap-equipo
description: El equipo del usuario en FRAP (jefe, project manager, desarrolladores, clientes…) y a quién está asignada esta sesión. Úsala SIEMPRE antes de redactar un mensaje, correo, comentario o respuesta para otra persona ("genera un mensaje para Juan", "respóndele a mi jefe", "qué le digo al cliente"), y cuando el usuario mencione a alguien del equipo por su nombre o su rol.
---

<!-- ${SKILL_MARK}: la instala y la quita FRAP con el módulo Equipo -->

# Equipo de FRAP

El usuario registra en FRAP a las personas con las que trabaja (nombre, rol y una descripción con lo que hay que
saber de cada una: cómo le gusta que le pidan las cosas, qué no hace, en qué idioma escribe…) y puede asignar cada
sesión de IA a una persona (p. ej. una sesión para todo lo que pide su jefe).

\`\`\`bash
${cli} quien            # persona asignada a ESTA sesión (rol y descripción), si hay
${cli} list             # todo el equipo, por rol
${cli} show <nombre>    # una persona (por nombre o id)
\`\`\`

## Reglas
- Antes de redactar algo para alguien, mira \`quien\` (si la sesión está asignada, lo normal es que el mensaje sea para
  esa persona) y \`show <nombre>\` si nombra a otra. Escribe para su rol y respeta **su descripción**.
- Si la descripción dice que no le gusta o no hace algo (p. ej. "no le gusta que le pidan cosas por ssh"), **no se lo
  pidas en el mensaje**: dile al usuario qué tendría que hacer él (o a quién pedírselo) y deja eso fuera del mensaje.
- El tono, el idioma y el nivel técnico dependen del rol: a un jefe o cliente, claro y sin jerga; a un desarrollador,
  con el detalle técnico necesario.
- No inventes personas ni datos: si la persona no está en el equipo, dilo y redacta neutro.
- La descripción es información privada del usuario: no la copies tal cual en el mensaje.
- **Guarda el mensaje en un archivo** listo para enviar (solo el texto del mensaje, sin notas para el usuario):
  \`<carpeta de la issue o del proyecto>/mensajes/AAAA-MM-DD-<persona>-<tema>.md\` (p. ej. \`local/issues/AVE-2507/mensajes/2026-11-25-andres-capacidad.md\`)
  y escribe su ruta completa en tu respuesta: FRAP muestra un botón «📋 Copiar mensaje para <persona>» debajo de la terminal.
`;
}
const skill = require('./wordpress').skillManager('frap-equipo', SKILL_MARK, skillText);

module.exports = {
  TEAM_FILE, CLI, ROLES, sockDirFor, load, upsert, importPeople, remove, find, currentSession, ppidOf,
  skillText, skillStatus: () => skill.status(), setSkill: (on) => skill.set(on),
};
