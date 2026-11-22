'use strict';
// Módulo interno "Scripts": local/scripts/<carpeta>/<script> (carpeta = ID de issue o un tema), con dos interruptores
// por script, como las bases de datos: «Usuario» (se puede ejecutar desde FRAP) y «IA» (la IA lo puede ejecutar con
// frap-scripts run). Los interruptores viven en local/scripts/.frap-scripts.json (viaja en el zip de local/).
// La skill frap-scripts le explica a las IA dónde crear los scripts y cómo ejecutarlos. Solo librería estándar.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LOCAL_DIR } = require('./issues');

const SCRIPTS_DIR = path.join(LOCAL_DIR, 'scripts');
const META = path.join(SCRIPTS_DIR, '.frap-scripts.json');
const CLI = path.join(__dirname, 'frap-scripts.js');
const SKIP_DIRS = new Set(['node_modules', 'salida', '.git', '__pycache__', '.venv', 'venv']);
const SCRIPT_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|py|sh|bash|php|rb|sql)$/i;
const NAME_RE = /^[\w][\w.-]*$/;
const exists = (p) => { try { fs.accessSync(p); return true; } catch (_) { return false; } };

function which(bin) {
  for (const d of (process.env.PATH || '').split(path.delimiter).concat([path.join(os.homedir(), '.bun', 'bin')])) {
    if (!d) continue;
    const f = path.join(d, bin);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch (_) { /* sigue */ }
  }
  return null;
}
/** Con qué se ejecuta según la extensión: {bin, args} o null (p. ej. .sql: se revisa y se corre a mano). */
function runnerFor(file) {
  const ext = (path.extname(file).slice(1) || '').toLowerCase();
  if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) return { bin: 'bun', args: [] };
  if (['js', 'mjs', 'cjs'].includes(ext)) return which('bun') ? { bin: 'bun', args: [] } : { bin: 'node', args: [] };
  if (ext === 'py') return { bin: 'python3', args: [] };
  if (ext === 'sh' || ext === 'bash') return { bin: 'bash', args: [] };
  if (ext === 'php') return { bin: 'php', args: [] };
  if (ext === 'rb') return { bin: 'ruby', args: [] };
  return null;
}

// ---------- metadatos (interruptores) ----------
function readMeta() {
  try {
    const m = JSON.parse(fs.readFileSync(META, 'utf8'));
    return { enabled: m.enabled !== false, scripts: m.scripts && typeof m.scripts === 'object' ? m.scripts : {} };
  } catch (_) { return { enabled: true, scripts: {} }; }
}
function writeMeta(m) {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  const tmp = `${META}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(m, null, 1)}\n`);
  fs.renameSync(tmp, META);
}
/** Ruta relativa segura dentro de local/scripts (sin .., sin absolutas, sin node_modules). */
function safeRel(rel) {
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = r.split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..' || p === '.' || p.startsWith('.') || SKIP_DIRS.has(p))) throw new Error(`Ruta de script inválida: ${rel}`);
  const abs = path.join(SCRIPTS_DIR, ...parts);
  if (!abs.startsWith(SCRIPTS_DIR + path.sep)) throw new Error(`Ruta de script inválida: ${rel}`);
  return { rel: parts.join('/'), abs };
}
const flagsOf = (m, rel) => ({ user: (m.scripts[rel] || {}).user !== false, ai: (m.scripts[rel] || {}).ai !== false });

/** Primera línea de comentario del archivo: su descripción. */
function describe(abs) {
  let head = '';
  try { const fd = fs.openSync(abs, 'r'); const b = Buffer.alloc(2048); const n = fs.readSync(fd, b, 0, 2048, 0); fs.closeSync(fd); head = b.subarray(0, n).toString('utf8'); } catch (_) { return ''; }
  for (const l of head.split('\n')) {
    const t = l.trim();
    if (!t || t.startsWith('#!') || /^(\/\*\*?|\*\/|<\?php|"""|''')$/.test(t)) continue;
    const m = /^(?:\/\/+|#+|--+|\*|\/\*\*?|""")\s?(.*?)\s*(\*\/)?$/.exec(t);
    if (!m) return '';
    if (m[1] && !/^(eslint|@ts-|-\*-|type:|import)/.test(m[1])) return m[1].slice(0, 200);
  }
  return '';
}

function listScripts() {
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  const m = readMeta();
  const scripts = [];
  const folders = [];
  const walk = (dir, rel, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || depth >= 3) continue;
        walk(abs, r, depth + 1);
      } else if (e.isFile() && SCRIPT_EXT.test(e.name)) {
        const st = fs.statSync(abs);
        const run = runnerFor(e.name);
        scripts.push({ path: r, abs, folder: rel || '', name: e.name, ext: path.extname(e.name).slice(1).toLowerCase(), runnable: !!run, runner: run ? run.bin : null, desc: describe(abs), size: st.size, mtime: st.mtimeMs, ...flagsOf(m, r) });
      }
    }
  };
  walk(SCRIPTS_DIR, '', 0);
  // carpetas de primer nivel (con cuántos archivos generados tienen en salida/)
  for (const e of fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    let salida = 0;
    try { salida = fs.readdirSync(path.join(SCRIPTS_DIR, e.name, 'salida')).filter((f) => !f.startsWith('.')).length; } catch (_) { /* no tiene */ }
    folders.push({ name: e.name, salida, mtime: fs.statSync(path.join(SCRIPTS_DIR, e.name)).mtimeMs });
  }
  // limpia interruptores de scripts que ya no existen
  const live = new Set(scripts.map((s) => s.path));
  const stale = Object.keys(m.scripts).filter((k) => !live.has(k));
  if (stale.length) { for (const k of stale) delete m.scripts[k]; writeMeta(m); }
  scripts.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { dir: SCRIPTS_DIR, enabled: m.enabled, scripts, folders: folders.sort((a, b) => b.mtime - a.mtime), bun: !!which('bun') };
}

function setFlags(rel, { user, ai } = {}) {
  const { rel: r, abs } = safeRel(rel);
  if (!exists(abs)) throw new Error(`No existe el script: ${r}`);
  const m = readMeta();
  const cur = m.scripts[r] || {};
  if (user != null) cur.user = !!user;
  if (ai != null) cur.ai = !!ai;
  m.scripts[r] = cur;
  writeMeta(m);
  return { path: r, ...flagsOf(m, r) };
}
function setEnabled(on) {
  const m = readMeta();
  m.enabled = !!on;
  writeMeta(m);
  return m.enabled;
}

const HEADER = {
  ts: (d) => `// ${d}\n// Genera: (qué archivos deja en salida/, si deja alguno)\n// Uso (desde local/scripts): frap-scripts run {{REL}} [args]\n\n`,
  js: (d) => `// ${d}\n// Genera: (qué archivos deja en salida/, si deja alguno)\n// Uso (desde local/scripts): frap-scripts run {{REL}} [args]\n\n`,
  py: (d) => `# ${d}\n# Genera: (qué archivos deja en salida/, si deja alguno)\n# Uso (desde local/scripts): frap-scripts run {{REL}} [args]\n\n`,
  sh: (d) => `#!/usr/bin/env bash\n# ${d}\n# Genera: (qué archivos deja en salida/, si deja alguno)\n# Uso (desde local/scripts): frap-scripts run {{REL}} [args]\nset -euo pipefail\n\n`,
  php: (d) => `<?php\n// ${d}\n// Genera: (qué archivos deja en salida/, si deja alguno)\n// Uso (desde local/scripts): frap-scripts run {{REL}} [args]\n\n`,
  sql: (d) => `-- ${d}\n-- Revisar antes de ejecutar a mano.\n\n`,
};
/** Crea local/scripts/<carpeta>/<nombre> con una cabecera (qué hace, qué genera, cómo se ejecuta). */
function createScript(rel, desc = '', content = null) {
  const { rel: r, abs } = safeRel(rel);
  if (!NAME_RE.test(path.basename(r)) || !SCRIPT_EXT.test(r)) throw new Error('Nombre inválido: usa letras, números, guiones y una extensión (.ts, .js, .py, .sh, .php, .sql)');
  if (exists(abs)) throw new Error(`Ya existe: ${r}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const ext = path.extname(r).slice(1).toLowerCase();
  const d = String(desc || 'Qué hace este script.').replace(/[\r\n]+/g, ' ').trim().slice(0, 200);
  const tpl = HEADER[ext] || HEADER[{ tsx: 'ts', mts: 'ts', cts: 'ts', mjs: 'js', cjs: 'js', bash: 'sh', rb: 'py' }[ext]] || HEADER.js;
  fs.writeFileSync(abs, content != null ? String(content) : tpl(d).replace('{{REL}}', r), { mode: ext === 'sh' || ext === 'bash' ? 0o755 : 0o644 });
  const m = readMeta();
  m.scripts[r] = { user: true, ai: true };
  writeMeta(m);
  return { path: r, abs, ...flagsOf(m, r) };
}
/** Comando para ejecutar un script. who: 'user' (FRAP) o 'ai' (frap-scripts run). Revisa el módulo y su interruptor. */
function commandFor(rel, who) {
  const { rel: r, abs } = safeRel(rel);
  if (!exists(abs)) throw new Error(`No existe el script: ${r}`);
  const m = readMeta();
  if (!m.enabled) throw new Error('El módulo Scripts está apagado en FRAP (Ajustes → Módulos)');
  const f = flagsOf(m, r);
  if (who === 'ai' && !f.ai) throw new Error(`El script ${r} no está habilitado para la IA. Pídele al usuario que active «IA» en la pestaña Scripts de FRAP.`);
  if (who === 'user' && !f.user) throw new Error(`El script ${r} está deshabilitado para ejecutarlo desde FRAP (interruptor «Usuario»).`);
  const run = runnerFor(r);
  if (!run) throw new Error(`${r}: este tipo de archivo no se ejecuta (revísalo y córrelo a mano)`);
  const bin = run.bin === 'bun' ? which('bun') || 'bun' : run.bin;
  return { cwd: SCRIPTS_DIR, bin, args: [...run.args, r], rel: r };
}

// ---------- skill frap-scripts ----------
const SKILL_DIRS = {
  claude: () => path.join(os.homedir(), '.claude', 'skills', 'frap-scripts'),
  codex: () => path.join(os.homedir(), '.codex', 'skills', 'frap-scripts'),
};
function skillText() {
  return `---
name: frap-scripts
description: Scripts locales gestionados por FRAP. Úsala siempre que el usuario pida un script (sacar datos, un CSV, un .sql de corrección, probar una API, automatizar algo) o pida ejecutar uno existente. Los scripts se crean en la carpeta local de FRAP, no en los repos, y se ejecutan con frap-scripts run (respeta el interruptor «IA» de cada script).
---

# Scripts en FRAP

Los scripts viven en \`${SCRIPTS_DIR}/<carpeta>/\` (fuera de git). FRAP los muestra en su pestaña "Scripts",
donde el usuario los edita, los ejecuta y decide con dos interruptores quién puede ejecutarlos: «Usuario» y «IA».

- **Carpeta:** el identificador de la issue si el script es de una (\`AVE-1630/\`); si no, un tema corto en kebab-case
  (\`bia-whatsapp-utm/\`). Lo generado (csv, sql, json, txt) va en \`<carpeta>/salida/\`.
- **Utilidades compartidas** en la raíz de \`${SCRIPTS_DIR}\` (p. ej. \`conexion.ts\`, \`select.ts\`, \`package.json\`): se reutilizan
  e importan con rutas relativas (\`../conexion.ts\`). Las reglas del workspace (CLAUDE.md) mandan sobre conexiones y bases de datos.

Herramienta: \`node ${CLI}\`
- \`new <carpeta>/<nombre.ext> ["qué hace"]\` crea el archivo con su cabecera y lo registra (interruptores encendidos).
  Luego se escribe el código en ese archivo.
- \`run <carpeta>/<script> [args…]\` lo ejecuta desde \`${SCRIPTS_DIR}\` (bun para .ts/.js, python3, bash, php).
- \`list\` muestra los scripts con sus interruptores.

## Reglas
1. **Crear siempre con \`new\`** dentro de \`${SCRIPTS_DIR}/<carpeta>/\`, nunca en el repo ni en la carpeta de la issue.
2. Nombres numerados y descriptivos (\`1-leads-con-telefono.ts\`, \`2-corregir-urls.ts\`), con un comentario al inicio:
   qué hace, qué genera y cómo se ejecuta (la cabecera de \`new\` ya trae el formato).
3. **Ejecutar siempre con \`run\`**, nunca llamando a bun/node/python directamente. Si \`run\` responde que el script
   no está habilitado para la IA (o que el módulo está apagado), **no lo ejecutes de otra forma**: díselo al usuario
   para que lo active en la pestaña Scripts de FRAP, o pídele que lo ejecute él.
4. Los scripts **no escriben en bases de datos**: consultan en solo lectura. Si hace falta corregir datos, generan un
   \`.sql\` en \`salida/\` para revisarlo y ejecutarlo a mano.
5. Si el script es de una issue, anótalo en su changelog: script, qué consultó, cuántas filas o qué resultado y qué se hizo con él.
6. Sin secretos en los scripts: las credenciales salen de FRAP (\`conexion.ts\`, frap-db, frap-ssh). Datos personales solo en \`salida/\`.
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
/** on: instala/actualiza la skill y enciende el módulo para la CLI; off: la quita y apaga `run`. */
function setModule(on) {
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
    } else if (cur != null && /^name: frap-scripts$/m.test(cur)) {
      fs.rmSync(f, { force: true });
      try { fs.rmdirSync(dir); } catch (_) { /* tenía más archivos */ }
      changed.push(f);
    }
  }
  if (readMeta().enabled !== !!on) setEnabled(on);
  return { on: !!on, changed };
}

module.exports = { SCRIPTS_DIR, META, runnerFor, listScripts, setFlags, setEnabled, createScript, commandFor, skillText, skillStatus, setModule, describe, safeRel };
