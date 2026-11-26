'use strict';
// Módulo "Pendientes": tareas locales (como las issues, pero solo en local) en local/pendientes/pendientes.json.
// Cada pendiente: {id, title, descripcion, icon, priority, estado, depends: [ids], session: {sid, projectId, cwd,
// title, kind, agent, icon, person}, created, updated}. Salen ordenados: primero lo que no espera a nada, por prioridad y antigüedad;
// lo que depende de otro pendiente sin hacer va después de él (bloqueado); lo hecho al final.
// La IA los crea con frap-todo.js (skill frap-pendientes) desde su sesión, que queda vinculada (la detecta como
// frap-team quien): así desde el panel izquierdo se vuelve a esa sesión con su carpeta. Solo librería estándar.

const fs = require('fs');
const path = require('path');
const { parsePriority, PRIORITIES } = require('./issues');

const LOCAL_DIR = path.resolve(process.env.FRAP_LOCAL || path.join(__dirname, '..', 'local'));
const TODO_DIR = path.join(LOCAL_DIR, 'pendientes');
const TODO_FILE = path.join(TODO_DIR, 'pendientes.json');
const CLI = path.join(__dirname, 'frap-todo.js');
const ESTADOS = ['pendiente', 'en curso', 'bloqueado', 'hecho'];
const PRIO_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

function loadRaw() {
  try { const d = JSON.parse(fs.readFileSync(TODO_FILE, 'utf8')); return Array.isArray(d.todos) ? d.todos.filter((t) => t && t.id != null && t.title) : []; } catch (_) { return []; }
}
function saveRaw(todos) {
  fs.mkdirSync(TODO_DIR, { recursive: true });
  const tmp = `${TODO_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ todos }, null, 2)}\n`);
  fs.renameSync(tmp, TODO_FILE);
}
const normEstado = (e) => {
  const s = String(e || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (!s) return 'pendiente';
  if (/^(hech|done|termin|list|complet|ok)/.test(s)) return 'hecho';
  if (/^(en curso|curso|haciendo|doing|progreso|in progress|empezad)/.test(s)) return 'en curso';
  if (/^(bloq|block|esper)/.test(s)) return 'bloqueado';
  if (/^(pend|todo|por hacer|nuevo)/.test(s)) return 'pendiente';
  throw new Error(`Estado inválido: ${e} (pendiente, en curso, bloqueado, hecho)`);
};

/**
 * Lista ordenada. Cada uno con `blockedBy` (ids de sus dependencias sin hacer) y `n` (posición en el orden, desde 1).
 * Orden topológico: entre los que ya no esperan a nadie, primero el de mayor prioridad y luego el más antiguo.
 */
function list() {
  const todos = loadRaw();
  const byId = new Map(todos.map((t) => [t.id, t]));
  const done = (id) => { const t = byId.get(id); return !t || t.estado === 'hecho'; }; // una dependencia borrada no bloquea
  for (const t of todos) t.blockedBy = (t.depends || []).filter((d) => !done(d));
  const open = todos.filter((t) => t.estado !== 'hecho');
  const key = (t) => [PRIO_RANK[t.priority] ?? 4, t.created || ''];
  const cmp = (a, b) => { const [pa, ca] = key(a); const [pb, cb] = key(b); return pa - pb || String(ca).localeCompare(String(cb)) || a.id - b.id; };
  const out = [];
  const placed = new Set();
  while (out.length < open.length) {
    // listos: los que no esperan a ningún pendiente abierto aún sin colocar
    const ready = open.filter((t) => !placed.has(t.id) && t.blockedBy.every((d) => placed.has(d) || !open.some((o) => o.id === d)));
    const next = (ready.length ? ready : open.filter((t) => !placed.has(t.id))).sort(cmp)[0]; // ciclo: se rompe por prioridad
    out.push(next);
    placed.add(next.id);
  }
  const finished = todos.filter((t) => t.estado === 'hecho').sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  return [...out, ...finished].map((t, i) => ({ ...t, n: i + 1 }));
}

function normalize(input, prev, all) {
  const p = input && typeof input === 'object' ? input : {};
  const title = String(p.title != null ? p.title : prev ? prev.title : '').trim().slice(0, 200);
  if (!title) throw new Error('El nombre del pendiente es obligatorio');
  const priority = p.priority != null ? parsePriority(p.priority) : prev ? prev.priority : 'none';
  if (!priority) throw new Error(`Prioridad inválida: ${p.priority} (${PRIORITIES.map((x) => x.es).join(', ')})`);
  const depends = (p.depends != null ? (Array.isArray(p.depends) ? p.depends : [p.depends]) : prev ? prev.depends || [] : [])
    .map(Number).filter((d) => Number.isInteger(d) && d > 0 && (!prev || d !== prev.id));
  for (const d of depends) if (!all.some((t) => t.id === d)) throw new Error(`No existe el pendiente #${d} (dependencia)`);
  let session = prev ? prev.session || null : null;
  if (p.session !== undefined) {
    const s = p.session;
    session = s && typeof s === 'object' && (s.sid || s.cwd) ? {
      sid: String(s.sid || ''), projectId: s.projectId ? String(s.projectId) : null, cwd: String(s.cwd || ''),
      title: String(s.title || '').slice(0, 120), kind: String(s.kind || 'claude'),
      ...(s.icon ? { icon: String(s.icon).slice(0, 16) } : {}), ...(s.person ? { person: String(s.person).slice(0, 60) } : {}),
      ...(s.agent && s.agent.session ? { agent: { tool: String(s.agent.tool || 'claude'), session: String(s.agent.session) } } : {}),
    } : null;
  }
  return {
    title,
    descripcion: String(p.descripcion != null ? p.descripcion : prev ? prev.descripcion || '' : '').slice(0, 8000),
    icon: String(p.icon != null ? p.icon : prev ? prev.icon || '' : '').trim().slice(0, 8),
    priority,
    estado: p.estado != null ? normEstado(p.estado) : prev ? prev.estado : 'pendiente',
    depends: [...new Set(depends)],
    session,
  };
}
/** Crea (sin id) o edita un pendiente. → el pendiente */
function upsert(input) {
  const todos = loadRaw();
  const now = new Date().toISOString();
  let t;
  if (input && input.id != null) {
    t = todos.find((x) => x.id === Number(input.id));
    if (!t) throw new Error(`No existe el pendiente #${input.id}`);
    Object.assign(t, normalize(input, t, todos), { updated: now });
    // una dependencia no puede formar un ciclo
    const seen = new Set();
    const walk = (id) => { if (id === t.id) throw new Error('Esa dependencia formaría un ciclo'); if (seen.has(id)) return; seen.add(id); const d = todos.find((x) => x.id === id); for (const n of (d && d.depends) || []) walk(n); };
    for (const d of t.depends) walk(d);
  } else {
    const id = todos.reduce((m, x) => Math.max(m, x.id), 0) + 1;
    t = { id, ...normalize(input, null, todos), created: now, updated: now };
    todos.push(t);
  }
  saveRaw(todos);
  return t;
}
function remove(id) {
  const todos = loadRaw();
  const n = Number(id);
  if (!todos.some((x) => x.id === n)) throw new Error(`No existe el pendiente #${id}`);
  for (const t of todos) if ((t.depends || []).includes(n)) t.depends = t.depends.filter((d) => d !== n);
  saveRaw(todos.filter((x) => x.id !== n));
  return true;
}

// ---------- skill frap-pendientes ----------
const SKILL_MARK = 'frap-pendientes (FRAP)';
function skillText() {
  const cli = `node ${CLI}`;
  return `---
name: frap-pendientes
description: Pendientes locales del usuario en FRAP (lista de cosas por hacer con prioridad, estado y dependencias, vinculadas a la sesión de IA donde salieron). Úsala cuando el usuario diga "guárdalo como pendientes", "agrega eso a mis pendientes", "anota eso para hacer", "qué tengo pendiente", "marca como hecho el pendiente…", o cuando propongas una lista de pasos que él quiera guardar.
---

<!-- ${SKILL_MARK}: la instala y la quita FRAP con el módulo Pendientes -->

# Pendientes de FRAP

Son tareas del usuario (no issues de un tracker): se guardan en local y las ve en el panel izquierdo de FRAP, ordenadas,
con un botón para volver a la sesión de IA donde salieron. Al crearlas desde aquí quedan vinculadas a ESTA sesión.

\`\`\`bash
${cli} add "<nombre>" [--desc "…"] [--prioridad alta] [--icono 🔧] [--depende 3 --depende 4] [--estado pendiente]
${cli} list [--todos]                   # en orden (sin --todos, sin los hechos)
${cli} show <n>
${cli} estado <n> <pendiente|en curso|bloqueado|hecho>
${cli} edit <n> [--titulo …] [--desc …] [--prioridad …] [--icono …] [--depende …]
\`\`\`

Prioridad: urgente, alta, media, baja o sin prioridad (como en Linear). Estado: pendiente, en curso, bloqueado o hecho.

## Reglas
- Cuando el usuario pida guardar una lista como pendientes: **un pendiente por paso**, con nombre corto y accionable
  (empieza por un verbo), la descripción con el detalle necesario para retomarlo sin la conversación (archivos, comandos,
  criterio de listo) y la prioridad que corresponda. Si un paso necesita otro antes, usa \`--depende <n>\` (créalos en orden:
  \`add\` devuelve el número de cada uno).
- Antes de crear, mira \`list\` por si ya existe algo igual: no dupliques.
- Al terminar un pendiente en esta sesión, márcalo \`hecho\` (o \`en curso\` al empezarlo) y díselo al usuario.
- No guardes contraseñas ni tokens en la descripción.
`;
}
const skill = require('./wordpress').skillManager('frap-pendientes', SKILL_MARK, skillText);

module.exports = {
  TODO_FILE, CLI, ESTADOS, list, upsert, remove, normEstado,
  skillText, skillStatus: () => skill.status(), setSkill: (on) => skill.set(on),
};
