#!/usr/bin/env node
'use strict';
// CLI para agentes (skill frap-issues): issues locales de FRAP en local/issues/<ID>/.
// Uso:
//   node frap-issues.js new <ID> ["Título"] [--prioridad <p>]   crea la carpeta desde las plantillas (si existe, se retoma)
//   node frap-issues.js new LOCAL "Título" --prioridad <p>       issue local sin tracker: LOCAL-1, LOCAL-2…
//   node frap-issues.js priority <ID> <p>     cambia la prioridad (urgent|high|medium|low|none, o en español)
//   node frap-issues.js list [--all]          issues activas (o todas) por prioridad, con su estado
//   node frap-issues.js path <ID>             carpeta de la issue
//   node frap-issues.js dir                   carpeta local/issues

const issues = require('./issues');

function main(argv) {
  const [cmd, ...args] = argv;
  // --prioridad <p> / --priority <p> / --prioridad=<p>
  let priority;
  const rest = [];
  for (let k = 0; k < args.length; k++) {
    const m = args[k].match(/^--(?:prioridad|priority|p)(?:=(.*))?$/);
    if (m) priority = m[1] != null ? m[1] : args[++k];
    else rest.push(args[k]);
  }
  const label = (key) => (issues.PRIORITIES.find((p) => p.key === key) || {}).label;
  if (cmd === 'new') {
    const [id, ...title] = rest;
    if (!id) throw new Error('Uso: frap-issues new <ID|PREFIJO> ["Título"] [--prioridad urgent|high|medium|low|none]');
    const r = issues.createIssue(id, title.join(' '), { priority });
    console.log(r.created
      ? `Creada ${r.id} en ${r.dir} (issue.md, changelog.md, status.md; final.md se crea al cerrar). Prioridad: ${label(r.priority)}.`
      : `La issue ${r.id} ya existe: se retoma. Leer ${r.dir}/status.md y changelog.md.${priority ? ' (La prioridad no se cambió: usa "priority".)' : ''}`);
    return;
  }
  if (cmd === 'priority' || cmd === 'prioridad') {
    const [id, p] = rest;
    if (!id || p == null) throw new Error('Uso: frap-issues priority <ID> <urgent|high|medium|low|none>');
    const r = issues.setPriority(id, p);
    console.log(`${r.id}: prioridad ${r.label}`);
    return;
  }
  if (cmd === 'list') {
    const all = rest.includes('--all');
    const { dir, issues: list } = issues.listIssues();
    const order = issues.PRIORITIES.map((p) => p.key);
    const shown = list.filter((i) => all || !i.closed).sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority));
    if (!shown.length) { console.log(`Sin issues ${all ? '' : 'activas '}en ${dir}`); return; }
    for (const i of shown) {
      console.log(`${i.id}\t${label(i.priority)}\t${i.review ? 'en revisión' : i.closed ? 'cerrada' : 'activa'}\t${i.estado || '—'}${i.pending ? `\t📤 ${i.pending} por enviar` : ''}\t${i.title}`);
    }
    return;
  }
  if (cmd === 'path') {
    const id = String(rest[0] || '').toUpperCase();
    if (!issues.ID_RE.test(id)) throw new Error('Uso: frap-issues path <ID>');
    console.log(`${issues.ISSUES_DIR}/${id}`);
    return;
  }
  if (cmd === 'dir') { console.log(issues.ISSUES_DIR); return; }
  console.log('Uso: frap-issues new <ID|PREFIJO> ["Título"] [--prioridad <p>] | priority <ID> <p> | list [--all] | path <ID> | dir');
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
}

try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
