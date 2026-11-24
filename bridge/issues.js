'use strict';
// Módulo interno "Gestión de issues": carpeta local/ de FRAP (ignorada en git) con local/issues/<ID>/
// (issue.md, changelog.md, status.md, final.md), la skill frap-issues para las IA y zip de local/ para exportar.
// Solo librería estándar de Node.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const LOCAL_DIR = path.resolve(process.env.FRAP_LOCAL || path.join(__dirname, '..', 'local'));
const ISSUES_DIR = path.join(LOCAL_DIR, 'issues');
const CLI = path.join(__dirname, 'frap-issues.js');
const ID_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const exists = (p) => { try { fs.accessSync(p); return true; } catch (_) { return false; } };

// ---------- plantillas (iguales en espíritu a las de _linear) ----------
const TEMPLATES = {
  'issue.md': `# {{ID}} — {{TITULO}}

> Copia fiel de la issue en el tracker (Linear). No resumir ni reescribir.
> Copiada: {{FECHA}}

- **URL:**
- **Estado:**
- **Prioridad:**
- **Proyecto:**
- **Equipo:**
- **Asignado a:**
- **Etiquetas:**
- **Fecha límite:**
- **Creada / actualizada:**
- **Padre / sub-issues / relaciones:**

## Descripción

<!-- pegar aquí la descripción completa, tal cual -->

## Comentarios

<!-- pegar aquí los comentarios (autor, fecha, texto) -->
`,
  'changelog.md': `# Changelog — {{ID}}

> Bitácora del desarrollo. La entrada más reciente va arriba. No se borran entradas.

<!--
Formato de cada entrada:

## AAAA-MM-DD HH:MM — Título corto
- **Repo / archivos:**
- **Qué:**
- **Por qué:**
- **Commits / PR:**
-->

## {{FECHA}} — Issue tomada
- Se crea la carpeta de la issue en FRAP (local/issues/{{ID}}).
`,
  'status.md': `# Estado — {{ID}}

- **Estado general:** En curso
- **Última actualización:** {{FECHA}}

## ✅ Listos

## 🔄 En proceso

## ⏳ Pendientes

## 🚧 Bloqueos
_Ninguno._

## 📤 Por enviar a Linear
<!-- comentarios y cambios de estado pendientes: se envían al cerrar la issue o al final de la jornada -->
`,
};
const FINAL_TEMPLATE = `# Cierre — {{ID}}

- **Fecha de cierre:**
- **Comentario en Linear:**
- **Estado final en Linear:**

## Comentario enviado

<!-- el comentario exactamente como se envió a Linear -->
`;

// ---------- prioridad (misma escala y formato que Linear, venga o no de Linear) ----------
// En issue.md es la línea «- **Prioridad:** High». Se escribe siempre con la etiqueta de Linear.
const PRIORITIES = [
  { key: 'urgent', label: 'Urgent', es: 'Urgente', linear: 1 },
  { key: 'high', label: 'High', es: 'Alta', linear: 2 },
  { key: 'medium', label: 'Medium', es: 'Media', linear: 3 },
  { key: 'low', label: 'Low', es: 'Baja', linear: 4 },
  { key: 'none', label: 'No priority', es: 'Sin prioridad', linear: 0 },
];
const PRIORITY_ALIASES = {
  urgent: ['urgent', 'urgente', '1', 'p1', 'p0', 'critica', 'crítica'],
  high: ['high', 'alta', '2', 'p2'],
  medium: ['medium', 'media', 'normal', '3', 'p3'],
  low: ['low', 'baja', '4', 'p4'],
  none: ['none', 'no priority', 'sin prioridad', 'ninguna', '0', '—', '-', ''],
};
/** Clave de prioridad (urgent/high/medium/low/none) desde texto en inglés, español o el número de Linear; null si no se reconoce. */
function parsePriority(v) {
  const t = String(v == null ? '' : v).toLowerCase().replace(/[*_`]/g, '').replace(/\s*\(.*\)\s*$/, '').trim();
  for (const [k, al] of Object.entries(PRIORITY_ALIASES)) if (al.includes(t)) return k;
  return null;
}
const priorityInfo = (key) => PRIORITIES.find((p) => p.key === key) || PRIORITIES[4];
const PRIORITY_LINE = /^([ \t]*[-*][ \t]+\*\*Prioridad:\*\*)[ \t]*(.*)$/m;
function priorityOf(issueMd) {
  const m = issueMd.match(PRIORITY_LINE);
  return (m && parsePriority(m[2])) || 'none';
}
/** Cambia (o agrega) la línea de prioridad de issue.md, con la etiqueta de Linear. */
function setPriority(rawId, value) {
  const id = checkId(rawId);
  const key = parsePriority(value);
  if (!key) throw new Error(`Prioridad inválida: ${value} (usa urgent, high, medium, low o none)`);
  const file = path.join(ISSUES_DIR, id, 'issue.md');
  if (!exists(file)) throw new Error(`No existe ${id}/issue.md`);
  const label = priorityInfo(key).label;
  let md = fs.readFileSync(file, 'utf8');
  if (PRIORITY_LINE.test(md)) md = md.replace(PRIORITY_LINE, (_, a) => `${a} ${label}`);
  else if (/^[ \t]*[-*][ \t]+\*\*Estado:\*\*.*$/m.test(md)) md = md.replace(/^([ \t]*[-*][ \t]+\*\*Estado:\*\*.*)$/m, `$1\n- **Prioridad:** ${label}`);
  else md = md.replace(/^(#[^\n]*\n)/, `$1\n- **Prioridad:** ${label}\n`) || md;
  if (!PRIORITY_LINE.test(md)) md = `- **Prioridad:** ${label}\n\n${md}`;
  fs.writeFileSync(file, md);
  return { id, priority: key, label };
}
/** Siguiente identificador libre para issues sin tracker: LOCAL-1, LOCAL-2… */
function nextId(prefix = 'LOCAL') {
  const pre = String(prefix).toUpperCase();
  if (!/^[A-Z][A-Z0-9]*$/.test(pre)) throw new Error(`Prefijo inválido: ${prefix}`);
  ensureLocal();
  let max = 0;
  for (const n of fs.readdirSync(ISSUES_DIR)) { const m = n.match(new RegExp(`^${pre}-(\\d+)$`)); if (m) max = Math.max(max, Number(m[1])); }
  return `${pre}-${max + 1}`;
}

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fill(t, id, title, date) {
  return t.replace(/\{\{ID\}\}/g, id).replace(/\{\{TITULO\}\}/g, title || '').replace(/\{\{FECHA\}\}/g, date);
}
/** local/.gitignore propio: aunque la carpeta se copie a otro repo, no se sube. */
function ensureLocal() {
  fs.mkdirSync(ISSUES_DIR, { recursive: true });
  const gi = path.join(LOCAL_DIR, '.gitignore');
  if (!exists(gi)) fs.writeFileSync(gi, '# carpeta local de FRAP: no se versiona\n*\n');
}
function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error(`Identificador inválido: ${id} (se espera algo como AVE-303)`);
  return id.toUpperCase();
}

/**
 * Crea local/issues/<ID>/ con las plantillas. Si ya existe, no toca nada (se retoma).
 * Si `rawId` es solo un prefijo (p. ej. LOCAL) se numera solo y la issue es local (sin tracker).
 * `priority` (urgent/high/medium/low/none, o su nombre en español) se escribe en issue.md con el formato de Linear.
 */
function createIssue(rawId, title = '', { priority, local } = {}) {
  let key = null;
  if (priority != null && priority !== '') {
    key = parsePriority(priority);
    if (!key) throw new Error(`Prioridad inválida: ${priority} (usa urgent, high, medium, low o none)`);
  }
  const auto = typeof rawId === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(rawId.trim());
  const id = auto ? nextId(rawId.trim()) : checkId(rawId);
  ensureLocal();
  const dir = path.join(ISSUES_DIR, id);
  if (exists(dir)) return { id, dir, created: false };
  fs.mkdirSync(dir, { recursive: true });
  const date = now();
  const t = String(title || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  for (const [f, tpl] of Object.entries(TEMPLATES)) {
    let txt = fill(tpl, id, t, date);
    if (f === 'issue.md' && (auto || local)) {
      txt = txt.replace(/^> Copia fiel[^\n]*\n> Copiada: ([^\n]*)$/m, '> Issue local (sin tracker): se redacta aquí con el mismo formato.\n> Creada: $1')
        .replace(/^- \*\*URL:\*\*$/m, '- **URL:** —')
        .replace(/^- \*\*Estado:\*\*$/m, '- **Estado:** Backlog')
        .replace(/^<!-- pegar aquí la descripción completa, tal cual -->$/m, '<!-- qué hay que hacer, por qué y cómo se sabe que está listo -->');
    }
    fs.writeFileSync(path.join(dir, f), txt);
  }
  if (key || auto || local) setPriority(id, key || 'none');
  return { id, dir, created: true, priority: key || 'none' };
}

/** Sección "## 📤 Por enviar…" de status.md: cuántos ítems quedan pendientes de enviar al tracker. */
function pendingCount(status) {
  const m = status.match(/^##\s*📤[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  if (!m) return 0;
  return m[1].replace(/<!--[\s\S]*?-->/g, '').split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l) && !/^\s*[-*]\s+\[x\]/i.test(l)).length;
}
const CLOSED_RE = /termin|done|cerrad|cancel|✅|❌|descartad/i;
// "In Review" en Linear: ya entregada, falta la aprobación. En local cuenta como cerrada (estado «en revisión»)
const REVIEW_RE = /\bin[\s-]?review\b|\ben revisi[oó]n\b|🔎\s*revisi[oó]n/i;

function readIssue(id) {
  const dir = path.join(ISSUES_DIR, id);
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch (_) { return ''; } };
  const issue = read('issue.md');
  const status = read('status.md');
  const head = (issue.match(/^#\s+(.+)$/m) || [])[1] || '';
  const title = head.replace(new RegExp(`^${id.replace(/[-]/g, '\\-')}\\s*[—–-]\\s*`, 'i'), '').trim();
  const estado = ((status.match(/\*\*Estado general:\*\*\s*(.+)/) || [])[1] || '').trim();
  const url = ((issue.match(/\*\*URL:\*\*\s*(\S+)/) || [])[1] || '').trim();
  const priority = priorityOf(issue);
  let updated = 0;
  let files = [];
  try {
    files = fs.readdirSync(dir);
    for (const f of files) { try { updated = Math.max(updated, fs.statSync(path.join(dir, f)).mtimeMs); } catch (_) { /* nada */ } }
  } catch (_) { /* nada */ }
  const hasFinal = files.includes('final.md');
  const review = REVIEW_RE.test(estado);
  return { id, dir, title, estado, priority, url: /^https?:\/\//.test(url) ? url : '', updated, hasFinal, review, closed: hasFinal || review || CLOSED_RE.test(estado), pending: pendingCount(status), files: files.filter((f) => f.endsWith('.md')) };
}
function listIssues() {
  ensureLocal();
  const ids = fs.readdirSync(ISSUES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_')).map((e) => e.name);
  return { dir: ISSUES_DIR, local: LOCAL_DIR, issues: ids.map(readIssue).sort((a, b) => b.updated - a.updated) };
}

/** Copia carpetas de issues de otro lugar (p. ej. un harness viejo) sin pisar las que ya existen. */
function importIssuesDir(src) {
  ensureLocal();
  const st = fs.statSync(src);
  if (!st.isDirectory()) throw new Error(`No es una carpeta: ${src}`);
  // se acepta la carpeta "issues" o la que la contiene
  const base = exists(path.join(src, 'issues')) && fs.statSync(path.join(src, 'issues')).isDirectory() && !ID_RE.test(path.basename(src)) ? path.join(src, 'issues') : src;
  const copied = [];
  const skipped = [];
  for (const e of fs.readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
    const dest = path.join(ISSUES_DIR, e.name.toUpperCase());
    if (exists(dest)) { skipped.push(e.name); continue; }
    fs.cpSync(path.join(base, e.name), dest, { recursive: true, dereference: false, filter: (s) => !fs.lstatSync(s).isSymbolicLink() });
    copied.push(e.name);
  }
  return { from: base, copied, skipped };
}

// ---------- zip (sin dependencias: deflate de zlib + CRC32 propio) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(ms) {
  const d = new Date(ms);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
const ZIP_MAX = 200 * 1024 * 1024;
/** entries: [{name, data: Buffer, mtime}] → Buffer .zip */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const comp = zlib.deflateRawSync(raw);
    const useDeflate = comp.length < raw.length;
    const body = useDeflate ? comp : raw;
    const crc = crc32(raw);
    const { time, date } = dosTime(e.mtime || Date.now());
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
/** Buffer .zip → [{name, data}] (sin carpetas). Solo "stored" y "deflate". */
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('No es un archivo .zip válido');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Zip dañado (directorio central)');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('Zip dañado (cabecera local)');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const body = buf.subarray(start, start + csize);
    total += usize;
    if (total > ZIP_MAX) throw new Error('El zip es demasiado grande (>200 MB descomprimido)');
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = zlib.inflateRawSync(body, { maxOutputLength: Math.max(usize, 1) });
    else throw new Error(`Compresión no soportada en ${name} (método ${method})`);
    out.push({ name, data });
  }
  return out;
}
/** Ruta segura dentro de local/: sin absolutas, sin "..", con o sin el prefijo "local/". */
function safeEntry(name) {
  const parts = name.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (parts[0] === 'local') parts.shift();
  if (!parts.length || parts.some((s) => s === '..') || /^[a-z]:$/i.test(parts[0])) return null;
  const abs = path.join(LOCAL_DIR, ...parts);
  return abs.startsWith(LOCAL_DIR + path.sep) ? abs : null;
}
/** Todo local/ en un .zip (entradas "local/…"). */
function exportLocal() {
  ensureLocal();
  const entries = [];
  let total = 0;
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs, r); } // dependencias: se reinstalan (bun install)
      else if (e.isFile()) {
        const st = fs.statSync(abs);
        total += st.size;
        if (total > ZIP_MAX) throw new Error('La carpeta local pasa de 200 MB: no se puede exportar como zip');
        entries.push({ name: `local/${r}`, data: fs.readFileSync(abs), mtime: st.mtimeMs });
      }
    }
  };
  walk(LOCAL_DIR, '');
  const buf = zip(entries);
  return { data: buf.toString('base64'), files: entries.length, bytes: buf.length };
}
/** Restaura un zip en local/. overwrite=false: los archivos que ya existen no se tocan. */
function importLocal(b64, overwrite = false) {
  if (typeof b64 !== 'string' || !b64) throw new Error('Falta el contenido del zip');
  const entries = unzip(Buffer.from(b64, 'base64'));
  ensureLocal();
  const written = [];
  const skipped = [];
  const rejected = [];
  for (const e of entries) {
    const abs = safeEntry(e.name);
    if (!abs) { rejected.push(e.name); continue; }
    if (exists(abs) && !overwrite) { skipped.push(path.relative(LOCAL_DIR, abs)); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, e.data);
    written.push(path.relative(LOCAL_DIR, abs));
  }
  return { written: written.length, skipped: skipped.length, rejected };
}

// ---------- skill frap-issues ----------
const SKILL_DIRS = {
  claude: () => path.join(os.homedir(), '.claude', 'skills', 'frap-issues'),
  codex: () => path.join(os.homedir(), '.codex', 'skills', 'frap-issues'),
};
function skillText() {
  return `---
name: frap-issues
description: Gestión local de issues (Linear u otro tracker) con FRAP. Úsala siempre que el usuario trabaje una issue o tarea por su identificador (p. ej. AVE-303, ENG-12) o diga "toma la issue", "trabaja en AVE-…", "retoma", "cómo va la issue", "cierra la issue", "fin de jornada" o "sincroniza con Linear". La issue se baja y se gestiona en local; al tracker solo se envían comentarios y cambios de estado al cerrarla o al final de la jornada.
---

# Gestión de issues en FRAP

Toda issue que se trabaje se documenta en la carpeta local de FRAP, **no** en el repo del proyecto:

\`\`\`
${ISSUES_DIR}/<ID>/
├── issue.md       ← copia fiel de la issue del tracker
├── changelog.md   ← bitácora del desarrollo (la más reciente arriba)
├── status.md      ← estado vivo: listos / en proceso / pendientes / bloqueos / por enviar
└── final.md       ← solo al cerrar: el comentario enviado al tracker

${path.join(LOCAL_DIR, 'scripts')}/<ID>/   ← scripts propios de la issue; lo generado en <ID>/salida/
\`\`\`

\`${LOCAL_DIR}\` está fuera de git (FRAP la ignora): ahí también pueden ir otras cosas locales.
FRAP muestra estas issues en su pestaña "Issues". No se empieza a escribir código de una issue sin su carpeta.

Herramienta: \`node ${CLI}\`
- \`new <ID> ["Título"] [--prioridad <p>]\` crea la carpeta desde las plantillas (si existe, se retoma).
- \`new LOCAL "Título" --prioridad <p>\` crea una issue **local, sin tracker**, con el siguiente número libre (LOCAL-1, LOCAL-2…). Otro prefijo sin número también vale (p. ej. \`new INT "…"\` → INT-1).
- \`priority <ID> <p>\` cambia la prioridad.
- \`list [--all]\` lista las issues (activas por defecto) por prioridad, con su estado.
- \`path <ID>\` imprime la carpeta de la issue.

## 1. Tomar la issue
1. \`node ${CLI} new <ID> "Título"\`. Si ya existía, se retoma: leer \`status.md\` y \`changelog.md\` antes de hacer nada.
2. Traer la issue del tracker (en Linear: \`get_issue\` con relaciones y \`list_comments\`) y pegarla en \`issue.md\` **sin resumir ni reescribir**: título, metadatos, URL, descripción completa en markdown tal cual, relaciones y comentarios. Si cambia en el tracker durante el trabajo, se actualiza \`issue.md\` y se anota en el changelog.
3. Llenar \`status.md\` con el plan inicial: los pasos derivados de la issue, todos en «Pendientes».
4. Si aplica pasarla a «In Progress» en el tracker, **preguntar antes**; si el usuario prefiere esperar, anotarlo en «📤 Por enviar a Linear».
5. Rama: en cada repo que se toque, \`git checkout -b LINEAR-<ID>\` desde la rama principal actualizada (o la convención que indique el repo). Si ya existe, cambiar a ella. Anotar en \`status.md\` y el changelog qué rama se usa en qué repo.

## Prioridad
Toda issue tiene prioridad, con la escala y el formato de Linear, venga o no de Linear. Va en \`issue.md\` en la línea \`- **Prioridad:** <valor>\` y FRAP agrupa las issues por ella.

| Valor | Cuándo |
|---|---|
| \`Urgent\` | Producción caída o con datos/dinero en riesgo, seguridad, o algo que bloquea a otros hoy. |
| \`High\` | Importante y con fecha cercana; afecta a clientes o desbloquea otro trabajo. |
| \`Medium\` | Trabajo normal planificado. |
| \`Low\` | Mejora o deuda sin urgencia. |
| \`No priority\` | Sin clasificar todavía. |

- Si viene de Linear: se copia **tal cual** la de Linear (\`priority\` 1 = Urgent, 2 = High, 3 = Medium, 4 = Low, 0 = No priority). No se cambia en Linear sin que el usuario lo pida.
- Si se crea en local (sin tracker): se clasifica al crearla con \`--prioridad\`. Si el usuario no la dijo, se propone una con la tabla de arriba, se dice cuál y por qué, y se usa \`priority <ID> <p>\` si la corrige.
- Al cambiar la prioridad se anota en el changelog (de cuál a cuál y por qué). Si la issue es de Linear y el cambio debe llegar allá, se agrega a «📤 Por enviar a Linear».
- \`<p>\` acepta \`urgent|high|medium|low|none\` o \`urgente|alta|media|baja|sin prioridad\`; siempre se escribe en inglés como en Linear.

## 2. Mientras se trabaja
- **No se escribe en el tracker mientras se trabaja** (ni comentarios ni cambios de estado). Lo que haya que comunicar se anota en la sección «📤 Por enviar a Linear» de \`status.md\` (un ítem por comentario o cambio de estado).
- \`changelog.md\`: entrada nueva por cada avance significativo (hallazgo, decisión, cambio de código, prueba, despliegue), con fecha y hora \`AAAA-MM-DD HH:MM\`, repo y archivos, qué y por qué, commits/PR. Las entradas se agregan arriba y no se borran ni se reescriben: lo equivocado se corrige con una entrada nueva.
- \`status.md\`: se actualiza cada vez que un paso cambia de estado (Pendientes → En proceso → Listos), con «Última actualización». Los bloqueos van con qué se necesita y de quién.
- Actualizar ambos en el momento en que pasa el avance, no al final de la sesión.

## 3. Cerrar la issue
1. Redactar el comentario de cierre (qué se hizo, dónde, cómo se verificó, qué queda fuera) junto con lo pendiente de «📤 Por enviar a Linear», y **mostrárselo al usuario antes de enviarlo**.
2. Enviarlo (en Linear, \`save_comment\`) y, si el usuario lo aprueba, cambiar el estado.
3. Crear \`final.md\` con el comentario exactamente como se envió, la fecha y el enlace.
4. \`status.md\`: «Estado general: Terminada» (o Cancelada), pasos resueltos o justificados y «📤 Por enviar» vacía. Cerrar el changelog con la entrada de cierre.

**In Review:** si en Linear queda en revisión (entregada, falta la aprobación), escribe «**Estado general:** In Review en Linear — <qué falta>». FRAP la cuenta como **cerrada** (filtro «Cerradas», con la marca 👀 In Review) y \`list\` ya no la muestra entre las activas. Si después la reabren, cambia el estado a «En curso».

## 4. Fin de jornada ("fin de jornada", "sincroniza con Linear")
1. Revisar las issues activas (\`node ${CLI} list\`) y su «📤 Por enviar a Linear».
2. Armar por issue un comentario breve del avance del día y los cambios de estado pendientes, y **mostrar todo junto al usuario** antes de enviar nada.
3. Enviar lo aprobado, vaciar esos ítems de «📤 Por enviar» y anotar en el changelog de cada issue qué se envió.

## Peticiones HTTP de una issue
- Con la skill frap-api (módulo API de FRAP), en la carpeta \`${path.join(LOCAL_DIR, 'api')}/<ID>/\`: quedan guardadas (con su última respuesta) para revisarlas o repetirlas más adelante. Anótalas en el changelog.

## Scripts de una issue
- Van en \`${path.join(LOCAL_DIR, 'scripts')}/<ID>/\` (no en la carpeta de la issue ni en los repos), numerados y descriptivos, con un comentario al inicio (qué hace, qué genera, cómo se ejecuta). Lo generado va en \`<ID>/salida/\`.
- Se crean con \`frap-scripts new <ID>/<nombre.ext>\` y se ejecutan con \`frap-scripts run <ID>/<script>\` (skill frap-scripts: respeta el interruptor «IA» de cada script; si está apagado, se le pide al usuario). Las utilidades compartidas de \`${path.join(LOCAL_DIR, 'scripts')}\` (p. ej. \`conexion.ts\`, \`select.ts\`) se reutilizan. Las reglas propias del workspace (CLAUDE.md del repo o del workspace) mandan.
- No escriben en bases de datos: si hace falta corregir datos, generan un \`.sql\` para revisarlo y ejecutarlo a mano.
- Servidores y bases de datos solo por FRAP (skills frap-ssh y frap-db, solo lectura en BD).

## Reglas
- Carpeta: \`${ISSUES_DIR}/<ID>\`, solo el identificador en mayúsculas.
- Fechas \`AAAA-MM-DD HH:MM\` (hora local).
- Sin secretos, tokens ni datos personales reales en estos archivos: referenciarlos por nombre.
- Idioma: español.
`;
}
function skillStatus() {
  const text = skillText();
  return Object.fromEntries(Object.entries(SKILL_DIRS).map(([k, d]) => {
    const f = path.join(d(), 'SKILL.md');
    let cur = null;
    try { cur = fs.readFileSync(f, 'utf8'); } catch (_) { /* no está */ }
    return [k, { installed: cur != null, current: cur === text, file: f }];
  }));
}
/** on=true: instala/actualiza la skill en claude y codex. on=false: la quita (solo si es la de FRAP). */
function setSkill(on) {
  const text = skillText();
  const changed = [];
  for (const d of Object.values(SKILL_DIRS)) {
    const dir = d();
    const f = path.join(dir, 'SKILL.md');
    let cur = null;
    try { cur = fs.readFileSync(f, 'utf8'); } catch (_) { /* no está */ }
    if (on) {
      if (cur === text) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, text);
      changed.push(f);
    } else if (cur != null && /^name: frap-issues$/m.test(cur)) {
      fs.rmSync(f, { force: true });
      try { fs.rmdirSync(dir); } catch (_) { /* tenía más archivos: se deja */ }
      changed.push(f);
    }
  }
  return { on: !!on, changed };
}

module.exports = {
  LOCAL_DIR, ISSUES_DIR, ID_RE, FINAL_TEMPLATE,
  PRIORITIES, parsePriority, setPriority, nextId,
  createIssue, listIssues, readIssue, importIssuesDir, exportLocal, importLocal,
  zip, unzip, crc32, skillText, skillStatus, setSkill, pendingCount,
};
