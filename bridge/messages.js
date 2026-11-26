'use strict';
// Módulo "Mensajes": los mensajes que la IA redacta para otras personas (para enviarlos por WhatsApp, Slack, correo…)
// y los de pull requests (pedir review, avisar que se aprobó, comentar, pedir cambios, mergear). Viven en
// local/mensajes/mensajes.json (fuera de git, viajan en el zip de local/). Cada mensaje:
//   {id, tipo: 'persona'|'pr', titulo, texto, para, person, pr: {url, accion, numero} | null,
//    session: {sid, projectId, cwd, title, kind, agent, icon, person} | null, estado: 'pendiente'|'enviado',
//    created, updated, sentAt}
// `para` es el nombre a quien va; `person` su id en el Equipo si existe. La IA los guarda con frap-msg.js (skill
// frap-mensajes) desde su sesión, que queda vinculada. El usuario los ve, filtra, edita y copia en la pestaña Mensajes del panel derecho.
// Solo librería estándar de Node.

const fs = require('fs');
const path = require('path');
const team = require('./team');

const LOCAL_DIR = path.resolve(process.env.FRAP_LOCAL || path.join(__dirname, '..', 'local'));
const MSG_DIR = path.join(LOCAL_DIR, 'mensajes');
const MSG_FILE = path.join(MSG_DIR, 'mensajes.json');
const CLI = path.join(__dirname, 'frap-msg.js');
const TIPOS = ['persona', 'pr'];
const ESTADOS = ['pendiente', 'enviado'];
// qué pide o avisa un mensaje de PR
const PR_ACCIONES = [
  ['review', '👀', 'Pedir review'],
  ['aprobado', '✅', 'Aprobado'],
  ['cambios', '✏️', 'Pedir cambios'],
  ['comentario', '💬', 'Comentario'],
  ['merge', '🔀', 'Merge'],
  ['nuevo', '🆕', 'PR nuevo'],
];
const PR_KEYS = PR_ACCIONES.map((a) => a[0]);

function loadRaw() {
  try { const d = JSON.parse(fs.readFileSync(MSG_FILE, 'utf8')); return Array.isArray(d.mensajes) ? d.mensajes.filter((m) => m && m.id != null && m.texto) : []; } catch (_) { return []; }
}
function saveRaw(mensajes) {
  fs.mkdirSync(MSG_DIR, { recursive: true });
  const tmp = `${MSG_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify({ mensajes }, null, 2)}\n`);
  fs.renameSync(tmp, MSG_FILE);
}

const norm = (s) => String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
function normTipo(t) {
  const s = norm(t);
  if (!s || /^(persona|mensaje|msg|person)/.test(s)) return 'persona';
  if (/^(pr|pull|mr|merge request)/.test(s)) return 'pr';
  throw new Error(`Tipo inválido: ${t} (persona o pr)`);
}
function normEstado(e) {
  const s = norm(e);
  if (!s || /^(pend|por enviar|nuevo|borrador)/.test(s)) return 'pendiente';
  if (/^(envi|sent|hecho|listo)/.test(s)) return 'enviado';
  throw new Error(`Estado inválido: ${e} (pendiente o enviado)`);
}
function normAccion(a) {
  const s = norm(a);
  if (!s) return 'review';
  if (/^(review|revis|pedir review|rev)/.test(s)) return 'review';
  if (/^(aprob|approv|lgtm)/.test(s)) return 'aprobado';
  if (/^(cambio|change|request|solicit)/.test(s)) return 'cambios';
  if (/^(coment|comment|nota)/.test(s)) return 'comentario';
  if (/^(merge|mergead|fusion)/.test(s)) return 'merge';
  if (/^(nuevo|new|crear|abrir|open)/.test(s)) return 'nuevo';
  throw new Error(`Acción de PR inválida: ${a} (${PR_KEYS.join(', ')})`);
}
/** Número del PR/MR a partir de su URL (GitHub, GitLab, Bitbucket). */
function prNumber(url) {
  const m = String(url).match(/\/pull\/(\d+)|\/merge_requests\/(\d+)|\/pull-requests\/(\d+)/);
  return m ? Number(m[1] || m[2] || m[3]) : null;
}
function normUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  let p;
  try { p = new URL(s); } catch (_) { throw new Error(`URL del PR inválida: ${u}`); }
  if (!/^https?:$/.test(p.protocol)) throw new Error('La URL del PR debe ser http o https');
  return p.toString();
}
/** Persona destinataria: por id o nombre del Equipo; si no está, se guarda el nombre tal cual. → {para, person} */
function resolvePara(para, person) {
  if (person) { const p = team.load().people.find((x) => x.id === person); if (p) return { para: p.name, person: p.id }; }
  const name = String(para || '').trim().slice(0, 80);
  if (!name) return { para: '', person: '' };
  const p = team.find(name);
  return p ? { para: p.name, person: p.id } : { para: name, person: '' };
}
function normSession(s) {
  if (!s || typeof s !== 'object' || !(s.sid || s.cwd)) return null;
  return {
    sid: String(s.sid || ''), projectId: s.projectId ? String(s.projectId) : null, cwd: String(s.cwd || ''),
    title: String(s.title || '').slice(0, 120), kind: String(s.kind || 'claude'),
    ...(s.agent && s.agent.session ? { agent: { tool: String(s.agent.tool || 'claude'), session: String(s.agent.session) } } : {}),
    ...(s.icon ? { icon: String(s.icon).slice(0, 16) } : {}), ...(s.person ? { person: String(s.person).slice(0, 60) } : {}),
  };
}

function normalize(input, prev) {
  const p = input && typeof input === 'object' ? input : {};
  const has = (k) => p[k] !== undefined;
  const texto = String(has('texto') ? p.texto : prev ? prev.texto : '').replace(/\s+$/, '').slice(0, 20000);
  if (!texto.trim()) throw new Error('El texto del mensaje es obligatorio');
  const tipo = has('tipo') ? normTipo(p.tipo) : prev ? prev.tipo : 'persona';
  const firstLine = texto.split('\n').find((l) => l.trim()) || '';
  const titulo = String(has('titulo') && String(p.titulo).trim() ? p.titulo : prev && prev.titulo ? prev.titulo : firstLine.replace(/^\s*(?:#{1,6}|>|[-*+])\s+/, '').replace(/\*\*|__|`|~~/g, '')).trim().slice(0, 200);
  const dest = has('para') || has('person') ? resolvePara(p.para, p.person) : prev ? { para: prev.para || '', person: prev.person || '' } : { para: '', person: '' };
  let pr = prev ? prev.pr || null : null;
  if (tipo === 'pr') {
    const src = p.pr && typeof p.pr === 'object' ? p.pr : {};
    const url = src.url !== undefined ? normUrl(src.url) : pr ? pr.url : '';
    if (!url) throw new Error('Un mensaje de PR necesita la URL del PR');
    const accion = src.accion !== undefined ? normAccion(src.accion) : pr ? pr.accion : 'review';
    pr = { url, accion, numero: prNumber(url) };
  } else pr = null;
  const estado = has('estado') ? normEstado(p.estado) : prev ? prev.estado : 'pendiente';
  return {
    tipo, titulo, texto, para: dest.para, person: dest.person, pr,
    session: has('session') ? normSession(p.session) : prev ? prev.session || null : null,
    estado,
  };
}

/** Lista: primero los pendientes (más nuevos arriba), luego los enviados (más recientes arriba). */
function list() {
  const all = loadRaw();
  const by = (k) => (a, b) => String(b[k] || '').localeCompare(String(a[k] || '')) || b.id - a.id;
  return [...all.filter((m) => m.estado !== 'enviado').sort(by('created')), ...all.filter((m) => m.estado === 'enviado').sort(by('sentAt'))];
}
/** Crea (sin id) o edita. → el mensaje */
function upsert(input) {
  const all = loadRaw();
  const now = new Date().toISOString();
  let m;
  if (input && input.id != null) {
    m = all.find((x) => x.id === Number(input.id));
    if (!m) throw new Error(`No existe el mensaje #${input.id}`);
    const was = m.estado;
    Object.assign(m, normalize(input, m), { updated: now });
    if (m.estado === 'enviado' && was !== 'enviado') m.sentAt = now;
    if (m.estado !== 'enviado') delete m.sentAt;
  } else {
    const id = all.reduce((mx, x) => Math.max(mx, x.id), 0) + 1;
    m = { id, ...normalize(input, null), created: now, updated: now };
    if (m.estado === 'enviado') m.sentAt = now;
    all.push(m);
  }
  saveRaw(all);
  return m;
}
function remove(id) {
  const all = loadRaw();
  const n = Number(id);
  if (!all.some((x) => x.id === n)) throw new Error(`No existe el mensaje #${id}`);
  saveRaw(all.filter((x) => x.id !== n));
  return true;
}

// ---------- skill frap-mensajes ----------
const SKILL_MARK = 'frap-mensajes (FRAP)';
function skillText() {
  const cli = `node ${CLI}`;
  return `---
name: frap-mensajes
description: Guardar en FRAP los mensajes que redactas para otra persona (WhatsApp, Slack, correo) y los de pull requests (pedir review, avisar aprobado, comentario, pedir cambios, merge), vinculados a esta sesión. Úsala SIEMPRE que el usuario pida un mensaje, respuesta o aviso para alguien ("dame el mensaje para Juan", "respóndele a mi jefe", "qué le digo al cliente") o un mensaje sobre un PR ("pásame el mensaje para pedir review", "avísale que lo aprobé").
---

<!-- ${SKILL_MARK}: la instala y la quita FRAP con el módulo Mensajes -->

# Mensajes de FRAP

El usuario ve los mensajes en FRAP (pestaña Mensajes del panel derecho): los filtra por persona y sesión, los edita,
los copia (con formato de WhatsApp) y los marca como enviados. Al guardarlos desde aquí quedan vinculados a ESTA sesión.

\`\`\`bash
${cli} add --para "<persona>" [--titulo "<tema corto>"] --texto "<mensaje>"        # mensaje para una persona
${cli} pr --url <url del PR> --accion review [--para "<persona>"] [--titulo …] --texto "<mensaje>"   # mensaje de un PR
${cli} list [--todos]          # pendientes de enviar (con --todos, también los enviados)
${cli} show <n>
${cli} edit <n> [--texto …] [--titulo …] [--para …] [--accion …] [--url …]
${cli} enviado <n>             # marcarlo como enviado (solo si el usuario dice que ya lo envió)
\`\`\`

Para textos largos o con comillas usa \`--texto -\` y pásalo por stdin (heredoc: \`<<'EOF' … EOF\`).
Acciones de PR: review (pedir revisión), aprobado, cambios (pedir cambios), comentario, merge, nuevo (avisar que se abrió).

## Reglas
- **Guarda cada mensaje con este CLI** (no en archivos sueltos) y muéstralo también en tu respuesta. Un mensaje por persona:
  si son para dos personas, dos \`add\`.
- El texto es **solo el mensaje**, listo para enviar: sin notas para el usuario, sin "Aquí tienes el mensaje". Markdown
  simple (**negrita**, listas); FRAP lo convierte al formato de WhatsApp al copiar.
- Antes de redactar para alguien, mira la skill frap-equipo (\`frap-team show <nombre>\`) y respeta su descripción.
- En los de PR incluye el enlace del PR en \`--url\` (FRAP muestra un botón para abrirlo) y di en el texto qué se pide.
- Si corriges un mensaje que ya guardaste, usa \`edit <n>\` en vez de crear otro.
- No guardes contraseñas ni tokens en los mensajes.
`;
}
const skill = require('./wordpress').skillManager('frap-mensajes', SKILL_MARK, skillText);

module.exports = {
  MSG_FILE, CLI, TIPOS, ESTADOS, PR_ACCIONES, list, upsert, remove, normAccion, prNumber,
  skillText, skillStatus: () => skill.status(), setSkill: (on) => skill.set(on),
};
