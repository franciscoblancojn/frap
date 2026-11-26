'use strict';
// Alertas pedidas por la IA (módulo Alertas, antes "Temporizador"). Las alertas viven en el estado de la UI
// (state.timers); la IA no lo toca: con frap-alert.js deja una petición en FRAP_HOME/alerts/inbox/<id>.json y el bridge
// la entrega a la UI ({ev: 'alert'}), que la muestra ya o la programa. Solo si el usuario encendió el interruptor «IA»
// de la pestaña Alertas (FRAP_HOME/alerts/ai.json); apagado, el CLI se niega y la skill frap-alertas se quita.
// Solo librería estándar de Node.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CLI = path.join(__dirname, 'frap-alert.js');
const dirFor = (frapHome) => path.join(frapHome, 'alerts');
const inboxFor = (frapHome) => path.join(dirFor(frapHome), 'inbox');
const flagFor = (frapHome) => path.join(dirFor(frapHome), 'ai.json');

/** {ai: interruptor «IA», module: pestaña Alertas encendida}. La IA puede usarlas si ambos están encendidos. */
function readFlag(frapHome) {
  try { const d = JSON.parse(fs.readFileSync(flagFor(frapHome), 'utf8')); return { ai: d.ai === true, module: d.module !== false }; } catch (_) { return { ai: false, module: true }; }
}
const aiAllowed = (frapHome) => { const f = readFlag(frapHome); return f.ai && f.module; };
function setFlag(frapHome, patch) {
  const f = { ...readFlag(frapHome), ...patch };
  fs.mkdirSync(dirFor(frapHome), { recursive: true, mode: 0o700 });
  fs.writeFileSync(flagFor(frapHome), `${JSON.stringify({ ai: !!f.ai, module: f.module !== false })}\n`);
  return { ai: !!f.ai, module: f.module !== false };
}

/** "10m", "90s", "1h30m", "2 h", "45" (minutos) → segundos, o null. */
function parseDuration(s) {
  const t = String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 60);
  const re = /(\d+(?:\.\d+)?)(h|hr|hora|horas|m|min|mins|minuto|minutos|s|seg|segundo|segundos)/g;
  let total = 0;
  let used = '';
  let m;
  while ((m = re.exec(t))) { used += m[0]; const n = Number(m[1]); total += /^h/.test(m[2]) ? n * 3600 : /^m/.test(m[2]) ? n * 60 : n; }
  return used === t && total > 0 ? Math.round(total) : null;
}
/** "15:30" / "9:05" / "3pm" → "HH:MM", o null. */
function parseClock(s) {
  const t = String(s || '').trim().toLowerCase();
  let m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return `${m[1].padStart(2, '0')}:${m[2]}`;
  m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && (!m[2] || Number(m[2]) < 60)) {
    const hh = (Number(m[1]) % 12) + (m[3] === 'pm' ? 12 : 0);
    return `${String(hh).padStart(2, '0')}:${m[2] || '00'}`;
  }
  return null;
}

/**
 * Valida una petición de la IA. {action: 'show'|'create', title, desc, icon, mode: 'toast'|'modal', sound,
 * when: {kind: 'in', secs} | {kind: 'at', time: 'HH:MM', date?: 'AAAA-MM-DD'} | {kind: 'daily', time, days?: [0-6]},
 * session} → la petición normalizada.
 */
function normalize(req) {
  const r = req && typeof req === 'object' ? req : {};
  const title = String(r.title || '').trim().slice(0, 120);
  if (!title) throw new Error('El título de la alerta es obligatorio');
  const out = {
    id: r.id || `ia-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    action: r.action === 'create' ? 'create' : 'show',
    title,
    desc: String(r.desc || '').slice(0, 1000),
    icon: String(r.icon || '🤖').trim().slice(0, 8) || '🤖',
    mode: r.mode === 'modal' ? 'modal' : 'toast',
    sound: r.sound !== false,
    at: new Date().toISOString(),
  };
  if (out.action === 'create') {
    const w = r.when || {};
    if (w.kind === 'in') {
      const secs = Number(w.secs);
      if (!(secs >= 1 && secs <= 7 * 86400)) throw new Error('La duración debe estar entre 1 segundo y 7 días');
      out.when = { kind: 'in', secs: Math.round(secs) };
    } else if (w.kind === 'at' || w.kind === 'daily') {
      const time = parseClock(w.time);
      if (!time) throw new Error(`Hora inválida: ${w.time} (HH:MM)`);
      out.when = { kind: w.kind, time };
      if (w.kind === 'at' && w.date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(w.date)) || Number.isNaN(Date.parse(`${w.date}T${time}:00`))) throw new Error(`Fecha inválida: ${w.date} (AAAA-MM-DD)`);
        out.when.date = String(w.date);
      }
      if (w.kind === 'daily' && Array.isArray(w.days) && w.days.length) {
        const days = [...new Set(w.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
        if (days.length) out.when.days = days;
      }
    } else throw new Error('Falta cuándo: en <duración>, a las <HH:MM> o todos los días a las <HH:MM>');
  }
  const s = r.session;
  if (s && typeof s === 'object' && s.sid) {
    out.session = { sid: String(s.sid), title: String(s.title || '').slice(0, 120), ...(s.icon ? { icon: String(s.icon).slice(0, 16) } : {}), ...(s.projectId ? { projectId: String(s.projectId) } : {}), cwd: String(s.cwd || '') };
  }
  return out;
}

/** La deja en la bandeja de entrada (escritura atómica). → la petición */
function enqueue(frapHome, req) {
  if (!aiAllowed(frapHome)) throw new Error('El usuario no permite alertas de la IA: se activa en FRAP → pestaña Alertas → interruptor «IA».');
  const a = normalize(req);
  const dir = inboxFor(frapHome);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${a.id}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(a));
  fs.renameSync(tmp, path.join(dir, `${a.id}.json`));
  return a;
}
/** Saca las peticiones de la bandeja (las borra). Descarta las inválidas y, si la IA no está permitida, todas. */
function drain(frapHome) {
  const dir = inboxFor(frapHome);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort(); } catch (_) { return []; }
  const ok = aiAllowed(frapHome);
  const out = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try { if (ok) out.push(normalize(JSON.parse(fs.readFileSync(p, 'utf8')))); } catch (_) { /* inválida: se descarta */ }
    try { fs.unlinkSync(p); } catch (_) { /* ya no está */ }
  }
  return out;
}

// ---------- skill frap-alertas ----------
const SKILL_MARK = 'frap-alertas (FRAP)';
function skillText() {
  const cli = `node ${CLI}`;
  return `---
name: frap-alertas
description: Mostrarle una alerta al usuario en FRAP (aviso en pantalla, con sonido) ahora, dentro de un rato o a una hora. Úsala cuando el usuario diga "avísame cuando termines", "recuérdame en 20 minutos…", "ponme una alerta a las 3", o cuando termines una tarea larga que él está esperando y te pidió aviso.
---

<!-- ${SKILL_MARK}: la instala y la quita FRAP con el interruptor «IA» de la pestaña Alertas -->

# Alertas de FRAP

\`\`\`bash
${cli} ya "<título>" [--desc "…"] [--bloquear] [--icono ✅] [--sin-sonido]      # mostrarla ahora
${cli} en <10m|90s|1h30m> "<título>" [--desc …] [--bloquear] [--icono …]        # dentro de un rato
${cli} a-las <15:30> "<título>" [--fecha AAAA-MM-DD] [--desc …] [--bloquear]    # a una hora (hoy, o mañana si ya pasó)
${cli} diaria <09:00> "<título>" [--dias lun,mar,mie,jue,vie] [--desc …]       # todos los días (o esos días) a esa hora
${cli} list                                                                      # las alertas que tiene el usuario
\`\`\`

\`--bloquear\` cubre la pantalla hasta que la atienda (para lo urgente); sin él es un aviso en la esquina.
La alerta queda vinculada a ESTA sesión: el usuario puede volver a ella desde el aviso.

## Reglas
- Solo cuando el usuario lo pida o cuando termines algo que él está esperando y te pidió aviso. No la uses para
  mensajes normales de tu respuesta.
- Título corto y claro (qué pasó o qué hacer); el detalle en \`--desc\`.
- Si responde que no permite alertas de la IA, díselo al usuario (se activa en FRAP → Alertas → «IA»); no insistas.
`;
}
const skill = require('./wordpress').skillManager('frap-alertas', SKILL_MARK, skillText);

module.exports = {
  CLI, dirFor, inboxFor, readFlag, aiAllowed, setFlag, parseDuration, parseClock, normalize, enqueue, drain,
  skillText, skillStatus: () => skill.status(), setSkill: (on) => skill.set(on),
  defaultHome: () => process.env.FRAP_HOME || path.join(os.homedir(), '.config', 'frap'),
};
