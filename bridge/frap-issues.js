#!/usr/bin/env node
'use strict';
// CLI para agentes (skill frap-issues): issues locales de FRAP en local/issues/<ID>/.
// Uso:
//   node frap-issues.js new <ID> ["Título"]   crea la carpeta desde las plantillas (si existe, se retoma)
//   node frap-issues.js list [--all]          issues activas (o todas) con su estado
//   node frap-issues.js path <ID>             carpeta de la issue
//   node frap-issues.js dir                   carpeta local/issues

const issues = require('./issues');

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'new') {
    const [id, ...title] = rest;
    if (!id) throw new Error('Uso: frap-issues new <ID> ["Título"]');
    const r = issues.createIssue(id, title.join(' '));
    console.log(r.created
      ? `Creada ${r.dir} (issue.md, changelog.md, status.md; final.md se crea al cerrar).`
      : `La issue ${r.id} ya existe: se retoma. Leer ${r.dir}/status.md y changelog.md.`);
    return;
  }
  if (cmd === 'list') {
    const all = rest.includes('--all');
    const { dir, issues: list } = issues.listIssues();
    const shown = list.filter((i) => all || !i.closed);
    if (!shown.length) { console.log(`Sin issues ${all ? '' : 'activas '}en ${dir}`); return; }
    for (const i of shown) {
      console.log(`${i.id}\t${i.closed ? 'cerrada' : 'activa'}\t${i.estado || '—'}${i.pending ? `\t📤 ${i.pending} por enviar` : ''}\t${i.title}`);
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
  console.log('Uso: frap-issues new <ID> ["Título"] | list [--all] | path <ID> | dir');
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
}

try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
