#!/usr/bin/env node
'use strict';
// frap-db: acceso de SOLO LECTURA a las bases de datos configuradas en FRAP.
// Pensado para agentes (claude, codex, opencode): nunca muestra contraseñas y no
// tiene ningún modo de escritura.
//
//   node bridge/frap-db.js list
//   node bridge/frap-db.js <id> --tables
//   node bridge/frap-db.js <id> --describe <tabla>
//   node bridge/frap-db.js <id> "SELECT …" [--json] [--limit N]
//   echo "SELECT …" | node bridge/frap-db.js <id> -

const path = require('path');
const os = require('os');
const db = require('./db');

const FRAP_HOME = process.env.FRAP_HOME || path.join(os.homedir(), '.config', 'frap');
const ENV_FILE = process.env.FRAP_DB_ENV || path.join(FRAP_HOME, 'databases.env');

const USAGE = `frap-db — consultas de SOLO LECTURA a las bases de datos de FRAP

Uso:
  frap-db list                          lista las conexiones (sin contraseñas)
  frap-db <id> --tables                 tablas y vistas
  frap-db <id> --describe <tabla>       columnas de una tabla
  frap-db <id> "SELECT …"               ejecuta una consulta
  echo "SELECT …" | frap-db <id> -      consulta desde stdin

Opciones:
  --json        salida JSON ({columns, rows, truncated})
  --limit N     máximo de filas (por defecto 200)

Solo se permite UNA sentencia de lectura (SELECT, WITH, SHOW, DESCRIBE, EXPLAIN…).
Conexiones: ${ENV_FILE}`;

function fail(msg, code = 1) {
  process.stderr.write(`frap-db: ${msg}\n`);
  process.exit(code);
}

function formatTable({ columns, rows }) {
  if (!columns.length) return '';
  const MAXW = 80;
  const cell = (v) => {
    if (v === null) return 'NULL';
    const s = String(v).replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
    return s.length > MAXW ? `${s.slice(0, MAXW - 1)}…` : s;
  };
  const data = rows.map((r) => columns.map((_, i) => cell(r[i])));
  const widths = columns.map((c, i) => Math.max(c.length, ...data.map((r) => r[i].length)));
  const line = (vals) => vals.map((v, i) => v.padEnd(widths[i])).join(' | ').trimEnd();
  return [line(columns), widths.map((w) => '-'.repeat(w)).join('-+-'), ...data.map(line)].join('\n');
}

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return undefined;
    const v = args[i + 1];
    args.splice(i, v !== undefined && !v.startsWith('--') ? 2 : 1);
    return v === undefined || v.startsWith('--') ? true : v;
  };
  const json = flag('--json') !== undefined;
  const limit = Number(flag('--limit')) || 200;
  const describe = flag('--describe');
  const tables = flag('--tables') !== undefined;

  if (!args.length || args[0] === '-h' || args[0] === '--help') { console.log(USAGE); return; }

  const all = db.loadConnections(ENV_FILE);
  // los agentes solo ven las conexiones activas y con "uso por IA" encendido
  const conns = all.filter((c) => c.enabled && c.ai);
  if (args[0] === 'list') {
    if (!conns.length) fail(all.length
      ? 'ninguna conexión está habilitada para agentes. El usuario puede activar "Uso por IA" en FRAP → panel "Bases de datos".'
      : `no hay conexiones configuradas (${ENV_FILE}). Agrégalas desde FRAP → panel "Bases de datos".`);
    const pub = conns.map((c) => ({
      id: c.id, nombre: c.name, motor: c.engine,
      destino: c.engine === 'sqlite' ? c.database : `${c.user}@${c.host}:${c.port || db.ENGINES[c.engine].port}/${c.database}`,
    }));
    console.log(json ? JSON.stringify(pub, null, 2) : formatTable({ columns: ['id', 'nombre', 'motor', 'destino'], rows: pub.map(Object.values) }));
    return;
  }

  const id = args[0].toLowerCase();
  const conn = conns.find((c) => c.id === id);
  if (!conn) {
    const blocked = all.find((c) => c.id === id);
    if (blocked) fail(!blocked.enabled
      ? `la conexión "${id}" está desactivada en FRAP.`
      : `la conexión "${id}" no está habilitada para agentes (el usuario desactivó "Uso por IA" en FRAP). No intentes acceder por otra vía.`);
    fail(`no existe la conexión "${id}". Usa: frap-db list`);
  }

  let sql;
  if (tables) sql = db.tablesSql(conn.engine);
  else if (describe) {
    if (describe === true) fail('falta el nombre de la tabla: --describe <tabla>');
    sql = db.describeSql(conn.engine, describe);
  } else if (args[1] === '-') sql = await readStdin();
  else sql = args.slice(1).join(' ');
  if (!sql || !sql.trim()) fail('falta la consulta. Ejemplo: frap-db <id> "SELECT * FROM tabla LIMIT 10"');

  // runQuery sin `write` aplica siempre el modo solo lectura (clasificador + motor)
  const res = await db.runQuery({ ...conn, uiWrite: false }, sql, { limit });
  if (json) {
    console.log(JSON.stringify({ columns: res.columns, rows: res.rows, rowCount: res.rowCount, truncated: res.truncated }));
    return;
  }
  if (!res.columns.length) { console.log('(sin filas)'); return; }
  console.log(formatTable(res));
  console.log(`\n(${res.rowCount} fila${res.rowCount === 1 ? '' : 's'}${res.truncated ? `, truncado a ${limit}: usa --limit o LIMIT` : ''} · ${res.ms} ms)`);
}

main().catch((e) => fail(e.message));
