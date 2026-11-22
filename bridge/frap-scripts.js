#!/usr/bin/env node
'use strict';
// CLI para agentes (skill frap-scripts): scripts locales de FRAP en local/scripts/<carpeta>/.
// Uso:
//   node frap-scripts.js new <carpeta>/<nombre.ext> ["qué hace"]   crea el script con su cabecera y lo registra
//   node frap-scripts.js run <carpeta>/<script> [args…]             lo ejecuta (solo si su interruptor «IA» está activo)
//   node frap-scripts.js list                                       scripts con sus interruptores
//   node frap-scripts.js dir                                        carpeta local/scripts

const { spawn } = require('child_process');
const scripts = require('./scripts');

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'new') {
    const [rel, ...desc] = rest;
    if (!rel) throw new Error('Uso: frap-scripts new <carpeta>/<nombre.ext> ["qué hace"]');
    const r = scripts.createScript(rel, desc.join(' '));
    console.log(`Creado ${r.abs} (Usuario e IA habilitados). Escribe el código ahí y ejecútalo con: frap-scripts run ${r.path}`);
    return;
  }
  if (cmd === 'run') {
    const [rel, ...args] = rest;
    if (!rel) throw new Error('Uso: frap-scripts run <carpeta>/<script> [args…]');
    const c = scripts.commandFor(rel, 'ai');
    const child = spawn(c.bin, [...c.args, ...args], { cwd: c.cwd, stdio: 'inherit' });
    child.on('error', (e) => { console.error(e.code === 'ENOENT' ? `No se encontró "${c.bin}" para ejecutar ${c.rel}` : e.message); process.exitCode = 127; });
    child.on('exit', (code, sig) => { process.exitCode = code != null ? code : sig ? 1 : 0; });
    return;
  }
  if (cmd === 'list') {
    const { dir, enabled, scripts: list } = scripts.listScripts();
    if (!enabled) console.log('⚠ El módulo Scripts está apagado en FRAP: run no ejecuta nada.');
    if (!list.length) { console.log(`Sin scripts en ${dir}`); return; }
    for (const s of list) console.log(`${s.path}\tusuario:${s.user ? 'sí' : 'no'}\tIA:${s.ai ? 'sí' : 'no'}${s.runnable ? '' : '\t(no ejecutable)'}${s.desc ? `\t${s.desc}` : ''}`);
    return;
  }
  if (cmd === 'dir') { console.log(scripts.SCRIPTS_DIR); return; }
  console.log('Uso: frap-scripts new <carpeta>/<nombre.ext> ["qué hace"] | run <carpeta>/<script> [args…] | list | dir');
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
}

try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
