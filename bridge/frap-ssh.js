#!/usr/bin/env node
'use strict';
// frap-ssh: ejecutar comandos en los servidores SSH configurados en FRAP.
// Pensado para agentes (claude, codex, opencode): solo ve los servidores activos con
// "Uso por IA" encendido y nunca muestra contraseñas. No abre sesiones interactivas.
//
//   node bridge/frap-ssh.js list
//   node bridge/frap-ssh.js <id> "comando" [--timeout S]
//   echo "comando" | node bridge/frap-ssh.js <id> -

const path = require('path');
const os = require('os');
const ssh = require('./ssh');

const FRAP_HOME = process.env.FRAP_HOME || path.join(os.homedir(), '.config', 'frap');
const ENV_FILE = process.env.FRAP_SSH_ENV_FILE || path.join(FRAP_HOME, 'ssh.env');

const USAGE = `frap-ssh — ejecutar comandos en los servidores SSH de FRAP

Uso:
  frap-ssh list                         servidores disponibles (sin contraseñas)
  frap-ssh <id> "comando"               ejecuta el comando y muestra su salida
  echo "comando" | frap-ssh <id> -      comando desde stdin

Opciones:
  --timeout S   segundos máximos (por defecto 60, máximo 600)

Sin terminal interactiva: no uses comandos que esperen entrada (sudo con contraseña, vim, top…).
Servidores: ${ENV_FILE}`;

function fail(msg, code = 1) {
  process.stderr.write(`frap-ssh: ${msg}\n`);
  process.exit(code);
}

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main() {
  const args = process.argv.slice(2);
  let timeout = 60;
  const ti = args.indexOf('--timeout');
  if (ti !== -1) {
    timeout = Math.max(1, Math.min(Number(args[ti + 1]) || 60, 600));
    args.splice(ti, 2);
  }
  if (!args.length || args[0] === '-h' || args[0] === '--help') { console.log(USAGE); return; }

  const all = ssh.loadHosts(ENV_FILE);
  const hosts = all.filter((h) => h.enabled && h.ai);
  if (args[0] === 'list') {
    if (!hosts.length) fail(all.length
      ? 'ningún servidor está habilitado para agentes. El usuario puede activar "Uso por IA" en FRAP → panel "SSH".'
      : `no hay servidores configurados (${ENV_FILE}). Agrégalos desde FRAP → panel "SSH".`);
    const rows = hosts.map((h) => [h.id, h.name, `${h.user}@${h.host}${h.port ? ':' + h.port : ''}`]);
    const w = [0, 1, 2].map((i) => Math.max(['id', 'nombre', 'destino'][i].length, ...rows.map((r) => r[i].length)));
    const line = (r) => r.map((v, i) => v.padEnd(w[i])).join(' | ').trimEnd();
    console.log([line(['id', 'nombre', 'destino']), w.map((n) => '-'.repeat(n)).join('-+-'), ...rows.map(line)].join('\n'));
    return;
  }

  const id = args[0].toLowerCase();
  const h = hosts.find((x) => x.id === id);
  if (!h) {
    const blocked = all.find((x) => x.id === id);
    if (blocked) fail(!blocked.enabled
      ? `el servidor "${id}" está desactivado en FRAP.`
      : `el servidor "${id}" no está habilitado para agentes (el usuario desactivó "Uso por IA" en FRAP). No intentes acceder por otra vía.`);
    fail(`no existe el servidor "${id}". Usa: frap-ssh list`);
  }
  const command = args[1] === '-' ? await readStdin() : args.slice(1).join(' ');
  if (!command.trim()) fail('falta el comando. Ejemplo: frap-ssh <id> "uptime"');

  const r = await ssh.runRemote(h, command, { timeoutMs: timeout * 1000, env: ssh.askpassEnv(h, FRAP_HOME, ENV_FILE) });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.timedOut) fail(`se canceló tras ${timeout} s (usa --timeout)`, 124);
  if (r.code === 255) {
    const hint = ssh.sshHint(r.stderr);
    if (hint) process.stderr.write(`frap-ssh: ${hint}\n`);
  }
  process.exit(r.code);
}

main().catch((e) => fail(e.message));
