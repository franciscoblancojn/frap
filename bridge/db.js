'use strict';
// Conexiones a bases de datos de FRAP: almacenamiento en .env + ejecución vía clientes del
// sistema (mysql, psql, sqlite3). Sin dependencias npm. Lo usan el bridge (pestaña DB) y
// el CLI de solo lectura para agentes (frap-db.js).
//
// Solo lectura = defensa en capas:
//   1. Clasificador: una sola sentencia, que empiece por SELECT/WITH/SHOW/DESCRIBE/EXPLAIN…
//      y sin palabras clave de escritura.
//   2. Motor: MySQL `START TRANSACTION READ ONLY` + ROLLBACK; PostgreSQL
//      `default_transaction_read_only=on`; SQLite `-readonly -safe`.
//   3. (Recomendado) un usuario de BD con permisos solo SELECT.
//
// Escritura (solo la pestaña DB de la UI, y solo si la conexión tiene "Solo lectura" desactivado,
// UI_WRITE=1): assertSafeWrite permite INSERT/UPDATE/CREATE/ALTER pero nunca eliminaciones
// (DELETE, DROP, TRUNCATE…) ni rutinas/metacomandos que podrían esconderlas.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ENGINES = {
  mysql: { label: 'MySQL / MariaDB', client: 'mysql', port: 3306 },
  postgres: { label: 'PostgreSQL', client: 'psql', port: 5432 },
  sqlite: { label: 'SQLite', client: 'sqlite3', port: null },
};
const FIELDS = ['NAME', 'ENGINE', 'HOST', 'PORT', 'USER', 'PASSWORD', 'DATABASE', 'UI_WRITE', 'ENABLED', 'AI'];
const KEY_RE = new RegExp(`^FRAP_DB_([A-Z0-9_]+?)_(${FIELDS.join('|')})$`);
const NULL_MARK = '␀FRAP_NULL␀';
const MAX_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// .env
// ---------------------------------------------------------------------------
function parseEnvValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, '');
}
function quoteEnvValue(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

const isOff = (v) => v != null && /^(0|false|no|off)$/i.test(String(v).trim());

/**
 * Lee el .env y devuelve [{id, name, engine, host, port, user, password, database, uiWrite, enabled, ai}].
 * `enabled` (activa) y `ai` (usable por agentes) valen true si faltan: así las conexiones viejas siguen igual.
 */
function loadConnections(envFile) {
  let text = '';
  try { text = fs.readFileSync(envFile, 'utf8'); } catch (_) { return []; }
  const byId = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue;
    const k = m[1].match(KEY_RE);
    if (!k) continue;
    const id = k[1].toLowerCase();
    if (!byId.has(id)) byId.set(id, { id });
    byId.get(id)[k[2]] = parseEnvValue(m[2]);
  }
  return [...byId.values()].map((c) => ({
    id: c.id,
    name: c.NAME || c.id,
    engine: ENGINES[c.ENGINE] ? c.ENGINE : 'mysql',
    host: c.HOST || '',
    port: c.PORT || '',
    user: c.USER || '',
    password: c.PASSWORD || '',
    database: c.DATABASE || '',
    uiWrite: c.UI_WRITE === '1' || c.UI_WRITE === 'true',
    enabled: !isOff(c.ENABLED),
    ai: !isOff(c.AI),
  }));
}

function saveConnections(envFile, conns, cliPath) {
  const lines = [
    '# FRAP — conexiones a bases de datos.',
    '# Se gestiona desde FRAP (panel "Bases de datos"); se puede editar a mano.',
    '# Los agentes (claude, codex, opencode) usan SOLO EN LECTURA las que tienen ENABLED=1 y AI=1, a través de:',
    `#   node ${cliPath || 'bridge/frap-db.js'} <id> "SELECT …"`,
    '# Contiene contraseñas: no lo subas a git ni lo compartas.',
    '',
  ];
  for (const c of conns) {
    const p = `FRAP_DB_${c.id.toUpperCase()}_`;
    lines.push(`# --- ${c.name} (${c.engine}) — id: ${c.id}`);
    lines.push(`${p}NAME=${quoteEnvValue(c.name)}`);
    lines.push(`${p}ENGINE=${c.engine}`);
    if (c.engine !== 'sqlite') {
      lines.push(`${p}HOST=${quoteEnvValue(c.host)}`);
      lines.push(`${p}PORT=${quoteEnvValue(c.port)}`);
      lines.push(`${p}USER=${quoteEnvValue(c.user)}`);
      lines.push(`${p}PASSWORD=${quoteEnvValue(c.password)}`);
    }
    lines.push(`${p}DATABASE=${quoteEnvValue(c.database)}`);
    lines.push(`${p}UI_WRITE=${c.uiWrite ? 1 : 0}`);
    lines.push(`${p}ENABLED=${c.enabled === false ? 0 : 1}`);
    lines.push(`${p}AI=${c.ai === false ? 0 : 1}`);
    lines.push('');
  }
  fs.mkdirSync(path.dirname(envFile), { recursive: true, mode: 0o700 });
  const tmp = `${envFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, envFile);
  fs.chmodSync(envFile, 0o600);
}

function slugify(name, taken) {
  let base = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'db';
  if (/^\d/.test(base)) base = `db_${base}`;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}_${i}`;
  return id;
}

/** Sin contraseña: lo que puede ver la UI. */
function publicConn(c) {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: !!password };
}

// ---------------------------------------------------------------------------
// Clasificador de SQL (solo lectura)
// ---------------------------------------------------------------------------
/**
 * Divide en sentencias quitando comentarios. Devuelve [{text, masked}]:
 *   text   = sentencia con literales intactos (para ejecutar)
 *   masked = igual pero con el contenido de literales/identificadores citados vaciado
 *            (para buscar palabras clave sin falsos positivos).
 */
function splitSql(sql, engine) {
  const out = [];
  let text = '';
  let masked = '';
  let i = 0;
  const n = sql.length;
  const push = () => {
    if (text.trim()) out.push({ text: text.trim(), masked: masked.trim() });
    text = '';
    masked = '';
  };
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if ((c === '-' && d === '-') || (c === '#' && engine === 'mysql')) {
      while (i < n && sql[i] !== '\n') i++;
      text += ' ';
      masked += ' ';
      continue;
    }
    if (c === '/' && d === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      text += ' ';
      masked += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      const backslash = engine === 'mysql' || (c === "'" && /[eE]$/.test(text));
      while (j < n) {
        if (backslash && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      text += sql.slice(i, j + 1);
      masked += c + c;
      i = j + 1;
      continue;
    }
    if (c === '$' && engine === 'postgres') {
      const tag = sql.slice(i).match(/^\$[A-Za-z_]*\$/);
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const j = end === -1 ? n : end + tag[0].length;
        text += sql.slice(i, j);
        masked += "''";
        i = j;
        continue;
      }
    }
    if (c === ';') { push(); i++; continue; }
    text += c;
    masked += c;
    i++;
  }
  push();
  return out;
}

const RO_START = {
  mysql: ['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'TABLE', 'VALUES'],
  postgres: ['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'TABLE', 'VALUES'],
  sqlite: ['SELECT', 'WITH', 'EXPLAIN', 'PRAGMA', 'VALUES'],
};
const RO_FORBIDDEN = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|RENAME|CALL|COPY|ATTACH|DETACH|VACUUM|REINDEX|HANDLER|LOAD|OUTFILE|DUMPFILE)\b/i;
const RO_FUNCS = /\b(SET_CONFIG|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|PG_RELOAD_CONF|PG_READ_FILE|PG_READ_BINARY_FILE|PG_LS_DIR|LO_IMPORT|LO_EXPORT|DBLINK\w*|LOAD_FILE|SYS_EXEC|SYS_EVAL|LOAD_EXTENSION|WRITEFILE|READFILE|EDIT)\s*\(/i;

/** Lanza Error si la consulta no es una única sentencia de lectura. Devuelve el texto a ejecutar. */
function assertReadOnly(sql, engine) {
  const stmts = splitSql(String(sql || ''), engine);
  if (!stmts.length) throw new Error('Consulta vacía');
  if (stmts.length > 1) throw new Error('Solo lectura: se permite una sola sentencia por consulta');
  const { text, masked } = stmts[0];
  // los clientes interpretan metacomandos: `\! cmd` en mysql/psql, `.shell` en sqlite3
  if (engine !== 'sqlite' && masked.includes('\\')) throw new Error('Solo lectura: no se permiten metacomandos con "\\" fuera de literales');
  if (engine === 'sqlite' && /^\s*\./m.test(masked)) throw new Error('Solo lectura: no se permiten comandos "." de sqlite3');
  const kw = ((masked.match(/^[\s(]*([A-Za-z]+)/) || [])[1] || '').toUpperCase();
  if (!RO_START[engine].includes(kw)) {
    throw new Error(`Solo lectura: "${kw || '?'}" no está permitido. Usa ${RO_START[engine].join(', ')}.`);
  }
  const bad = masked.match(RO_FORBIDDEN);
  if (bad) throw new Error(`Solo lectura: la palabra clave ${bad[1].toUpperCase()} no está permitida`);
  const fn = masked.match(RO_FUNCS);
  if (fn) throw new Error(`Solo lectura: la función ${fn[1].toUpperCase()}() no está permitida`);
  if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b|\bLOCK\s+IN\s+SHARE\s+MODE\b/i.test(masked)) {
    throw new Error('Solo lectura: no se permiten bloqueos (FOR UPDATE / FOR SHARE)');
  }
  if (engine === 'sqlite' && kw === 'PRAGMA' && masked.includes('=')) {
    throw new Error('Solo lectura: no se permite asignar PRAGMAs');
  }
  return text;
}

// ---------------------------------------------------------------------------
// Clasificador de escritura sin eliminaciones (conexiones con "Solo lectura" desactivado)
// ---------------------------------------------------------------------------
const WR_START = ['INSERT', 'UPDATE', 'CREATE', 'ALTER'];
// eliminaciones (incluye ALTER … DROP COLUMN, DROP/TRUNCATE PARTITION, DISCARD TABLESPACE, REPLACE INTO)
const WR_DELETE = /\b(DELETE|DROP|TRUNCATE|DISCARD|PURGE)\b/i;
// escribir archivos en el servidor (… INTO OUTFILE). CALL, LOAD, COPY, GRANT… no están en WR_START.
const WR_FORBIDDEN = /\b(OUTFILE|DUMPFILE)\b/i;
// CREATE/ALTER de objetos con cuerpo o código (se mira solo la cabecera: una columna "event" sí vale)
const WR_ROUTINES = /^\s*(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:DEFINER\s*=\s*\S+\s+)?(?:SQL\s+SECURITY\s+\w+\s+)?(?:(?:TEMP|TEMPORARY|CONSTRAINT|AGGREGATE|TRUSTED|PROCEDURAL|EVENT)\s+)*(FUNCTION|PROCEDURE|TRIGGER|RULE|EVENT|EXTENSION|SERVER|LANGUAGE|PUBLICATION|SUBSCRIPTION|ROUTINE|OPERATOR|CAST|TRANSFORM)\b/i;

/**
 * Lanza Error si alguna sentencia no es una escritura permitida. Acepta varias sentencias
 * (cada una se revisa) y también lecturas. Devuelve el texto a ejecutar (sin comentarios).
 */
function assertSafeWrite(sql, engine) {
  const stmts = splitSql(String(sql || ''), engine);
  if (!stmts.length) throw new Error('Consulta vacía');
  for (const { masked } of stmts) {
    if (engine !== 'sqlite' && masked.includes('\\')) throw new Error('Escritura: no se permiten metacomandos con "\\" fuera de literales');
    if (engine === 'sqlite' && /^\s*\./m.test(masked)) throw new Error('Escritura: no se permiten comandos "." de sqlite3');
    const kw = ((masked.match(/^[\s(]*([A-Za-z]+)/) || [])[1] || '').toUpperCase();
    if (RO_START[engine].includes(kw)) {
      try { assertReadOnly(masked, engine); } catch (e) { throw new Error(e.message.replace(/^Solo lectura:/, 'Escritura:')); }
      continue;
    }
    if (!WR_START.includes(kw)) {
      throw new Error(`Escritura: "${kw || '?'}" no está permitido. Usa ${WR_START.join(', ')} (o una lectura).`);
    }
    // "ON DELETE CASCADE/SET NULL…" de una clave foránea no elimina nada al crearla
    const del = masked.replace(/\bON\s+DELETE\b/gi, ' ').match(WR_DELETE);
    if (del) throw new Error(`Escritura: no se permiten eliminaciones (${del[1].toUpperCase()})`);
    const bad = masked.match(WR_FORBIDDEN);
    if (bad) throw new Error(`Escritura: la palabra clave ${bad[1].toUpperCase()} no está permitida`);
    const r = masked.match(WR_ROUTINES);
    if (r) throw new Error(`Escritura: no se permite ${kw} ${r[1].toUpperCase()} (podría esconder eliminaciones)`);
    const fn = masked.match(RO_FUNCS);
    if (fn) throw new Error(`Escritura: la función ${fn[1].toUpperCase()}() no está permitida`);
    if (engine === 'sqlite' && masked.includes('=') && /\bPRAGMA\b/i.test(masked)) throw new Error('Escritura: no se permite asignar PRAGMAs');
  }
  return stmts.map((x) => x.text).join(';\n');
}

// ---------------------------------------------------------------------------
// Parsers de salida
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let any = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; any = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; any = true; i++; continue; }
    if (c === '\r' && text[i + 1] === '\n') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; any = false; i++; continue; }
    field += c; any = true; i++;
  }
  if (any || field) { row.push(field); rows.push(row); }
  return rows;
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return XML_ENT[e] != null ? XML_ENT[e] : m;
});

/** Salida `mysql --xml`: usa el último <resultset> con filas (o el último si ninguno tiene). */
function parseMysqlXml(xml) {
  const sets = [...xml.matchAll(/<resultset\b[^>]*>([\s\S]*?)<\/resultset>/g)].map((m) => m[1]);
  if (!sets.length) return null;
  const body = [...sets].reverse().find((s) => /<row>/.test(s)) || sets[sets.length - 1];
  const columns = [];
  const rows = [];
  for (const r of body.matchAll(/<row>([\s\S]*?)<\/row>/g)) {
    const row = [];
    let idx = 0;
    for (const f of r[1].matchAll(/<field name="([^"]*)"(\s+xsi:nil="true"\s*\/>|>([\s\S]*?)<\/field>)/g)) {
      if (rows.length === 0) columns.push(unxml(f[1]));
      row[idx++] = f[3] === undefined ? null : unxml(f[3]);
    }
    rows.push(row);
  }
  return { columns, rows };
}

function fromCsv(out) {
  const recs = parseCsv(out);
  if (!recs.length) return { columns: [], rows: [] };
  const [columns, ...rows] = recs;
  return { columns, rows: rows.map((r) => r.map((v) => (v === NULL_MARK ? null : v))) };
}

// ---------------------------------------------------------------------------
// Pistas para errores de conexión frecuentes
// ---------------------------------------------------------------------------
function connectionHint(text) {
  const privateIp = /\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+/.test(text);
  if (/\(110\)|timed out|timeout expired|Connection timed out/i.test(text)) {
    return 'El servidor no respondió (timeout): revisa el host y el puerto' +
      (privateIp ? ', y que la VPN esté encendida (es una IP interna)' : '; si la base de datos está en una red interna, usa su IP interna y enciende la VPN') +
      '. Un firewall también puede bloquear el puerto.';
  }
  if (/\(111\)|Connection refused/i.test(text)) return 'El host responde pero no hay nada escuchando en ese puerto: revisa el puerto (MySQL 3306, PostgreSQL 5432) o que el servidor acepte conexiones remotas.';
  if (/\(2\)|\(-2\)|Unknown (MySQL server )?host|could not translate host name|Name or service not known/i.test(text)) return 'No se pudo resolver el nombre del host: revisa que esté bien escrito (o usa la IP).';
  const denied = text.match(/Access denied for user '([^']*)'@'([^']*)'/i);
  if (denied && denied[2] && denied[2] !== 'localhost') {
    const ip = denied[2];
    const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip);
    if (!isPrivate && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      // te conectas por internet: no conviene habilitar IPs públicas (cambian y exponen el servidor)
      return `El servidor te ve con tu IP pública ${ip}: te estás conectando por internet. Si el servidor es de la red de la empresa, ` +
        'usa su IP interna (p. ej. 192.168.x.x) con la VPN encendida y habilita el usuario para la IP con que llega la VPN. ' +
        'No habilites IPs públicas: cambian y dejan la base de datos expuesta.';
    }
    return `El servidor te ve llegando desde ${ip}. O la contraseña no coincide, o el usuario solo existe para 'localhost' (típico si te funciona en phpMyAdmin): ` +
      `pide que lo habiliten para esa IP ('${denied[1]}'@'${ip}') o usa un túnel SSH al servidor.`;
  }
  if (/ERROR 1045|password authentication failed|Access denied for user/i.test(text)) return 'Usuario o contraseña incorrectos, o el usuario no tiene permiso para conectarse desde tu IP.';
  if (/ERROR 1049|database ".*" does not exist|Unknown database/i.test(text)) return 'La base de datos no existe: revisa el nombre (en MySQL puedes dejarlo vacío).';
  if (/ERROR 2059|caching_sha2_password|authentication plugin/i.test(text)) return 'El servidor usa un método de autenticación que tu cliente mysql no soporta.';
  return '';
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------
function runClient(cmd, args, { env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { reject(e); return; }
    const chunks = [];
    let size = 0;
    let truncatedBytes = false;
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (truncatedBytes) return;
      size += d.length;
      chunks.push(d);
      if (size > MAX_BYTES) { truncatedBytes = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', (d) => { if (err.length < 64 * 1024) err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error(`No se encontró el cliente "${cmd}". Instálalo para usar este motor.`) : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let out = Buffer.concat(chunks).toString('utf8');
      if (truncatedBytes) {
        // corta en el último salto de línea para no romper la última fila
        out = out.slice(0, out.lastIndexOf('\n') + 1);
        resolve({ out, err, truncatedBytes });
        return;
      }
      if (timedOut) { reject(new Error(`La consulta superó el tiempo límite (${Math.round(timeoutMs / 1000)} s)`)); return; }
      if (code !== 0) {
        const msg = err.split('\n').filter((l) => l.trim() && !/Using a password on the command line/.test(l)).join('\n').trim();
        const text = msg || `${cmd} terminó con código ${code}`;
        const hint = connectionHint(text);
        reject(new Error(hint ? `${text}\n→ ${hint}` : text));
        return;
      }
      resolve({ out, err, truncatedBytes });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

/**
 * Ejecuta `sql` en la conexión `conn`.
 * opts: { write = false, limit = 1000, timeoutMs = 60000 }
 * Devuelve { columns, rows, rowCount, truncated, ms, readOnly, message? }
 */
async function runQuery(conn, sql, opts = {}) {
  const write = !!opts.write;
  const limit = Math.max(1, Math.min(Number(opts.limit) || 1000, 100000));
  const timeoutMs = opts.timeoutMs || 60000;
  const engine = conn.engine;
  if (!ENGINES[engine]) throw new Error(`Motor no soportado: ${engine}`);
  if (conn.enabled === false) throw new Error(`La conexión "${conn.name || conn.id}" está desactivada. Actívala en FRAP → panel "Bases de datos".`);
  if (write && !conn.uiWrite) throw new Error('Esta conexión no permite escritura (tiene "Solo lectura" activado)');
  const stmt = write ? assertSafeWrite(sql, engine) : assertReadOnly(sql, engine);
  if (!stmt) throw new Error('Consulta vacía');
  const started = Date.now();
  let res;

  if (engine === 'mysql') {
    // la contraseña va en un archivo de opciones temporal (0600), nunca en argv
    const cnf = path.join(os.tmpdir(), `frap-my-${process.pid}-${crypto.randomBytes(6).toString('hex')}.cnf`);
    const q = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    fs.writeFileSync(cnf, `[client]\npassword=${q(conn.password)}\n`, { mode: 0o600 });
    const body = write
      ? stmt
      : [
        // Tiempo límite en el servidor, compatible con MySQL y MariaDB en UNA sentencia:
        //   MySQL ve   SET SESSION MAX_EXECUTION_TIME=…, @frap=1   (ignora /*M! */)
        //   MariaDB ve SET SESSION max_statement_time=…, @frap=1   (ignora /*!50708 */: es de MySQL 5.7+)
        // @frap evita que quede una sentencia vacía. Requiere `--comments` para que /*M! llegue al servidor.
        `SET /*!50708 SESSION MAX_EXECUTION_TIME=${timeoutMs}, */ /*M!100108 SESSION max_statement_time=${Math.max(1, Math.round(timeoutMs / 1000))}, */ @frap = 1;`,
        'SET SESSION TRANSACTION READ ONLY;',
        'START TRANSACTION READ ONLY;',
        `${stmt}\n;`,
        'ROLLBACK;',
      ].join('\n');
    const args = [`--defaults-extra-file=${cnf}`, '--comments', '--xml', '--default-character-set=utf8mb4', '--connect-timeout=10',
      '-h', conn.host || 'localhost', '-P', String(conn.port || 3306), '-u', conn.user || ''];
    // "localhost" en mysql = socket Unix; cualquier otro host va por TCP
    if (conn.host && conn.host !== 'localhost') args.splice(1, 0, '--protocol=TCP');
    if (conn.database) args.push('-D', conn.database);
    try {
      res = await runClient('mysql', args, { input: body, timeoutMs });
    } finally {
      fs.rmSync(cnf, { force: true });
    }
    const parsed = parseMysqlXml(res.out) || { columns: [], rows: [] };
    res = { ...parsed, truncatedBytes: res.truncatedBytes };
  } else if (engine === 'postgres') {
    const pgopts = [`-c statement_timeout=${timeoutMs}`];
    if (!write) pgopts.push('-c default_transaction_read_only=on');
    const args = ['-X', '-q', '--csv', '-v', 'ON_ERROR_STOP=1', '-P', `null=${NULL_MARK}`,
      '-h', conn.host || '127.0.0.1', '-p', String(conn.port || 5432), '-U', conn.user || '', '-d', conn.database || 'postgres',
      '-f', '-'];
    const r = await runClient('psql', args, {
      input: stmt.endsWith(';') ? stmt : `${stmt};`,
      timeoutMs,
      env: { PGPASSWORD: conn.password || '', PGOPTIONS: pgopts.join(' '), PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'frap' },
    });
    res = { ...fromCsv(r.out), truncatedBytes: r.truncatedBytes };
  } else {
    if (!conn.database) throw new Error('Falta la ruta del archivo SQLite');
    if (!write && !fs.existsSync(conn.database)) throw new Error(`No existe el archivo: ${conn.database}`);
    const args = ['-safe', '-bail', '-csv', '-header', '-nullvalue', NULL_MARK];
    if (!write) args.unshift('-readonly');
    args.push(conn.database);
    const r = await runClient('sqlite3', args, { input: stmt.endsWith(';') ? stmt : `${stmt};`, timeoutMs });
    if (/^Parse error|^Error:|^Runtime error/m.test(r.err)) throw new Error(r.err.trim());
    res = { ...fromCsv(r.out), truncatedBytes: r.truncatedBytes };
  }

  const total = res.rows.length;
  const rows = res.rows.slice(0, limit);
  return {
    columns: res.columns,
    rows,
    rowCount: rows.length,
    truncated: total > limit || !!res.truncatedBytes,
    ms: Date.now() - started,
    readOnly: !write,
    message: !res.columns.length ? (write ? 'Sentencia ejecutada' : 'Sin filas') : undefined,
  };
}

/** Consultas de introspección (siempre solo lectura). */
function tablesSql(engine) {
  if (engine === 'mysql') return "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name";
  if (engine === 'postgres') return "SELECT CASE WHEN table_schema = 'public' THEN table_name ELSE table_schema || '.' || table_name END AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema <> 'public', 1";
  return "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name";
}
function describeSql(engine, table) {
  const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
  if (engine === 'mysql') {
    return `SELECT column_name AS columna, column_type AS tipo, is_nullable AS nulo, column_key AS clave, column_default AS por_defecto FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ${lit(table)} ORDER BY ordinal_position`;
  }
  if (engine === 'postgres') {
    const [schema, name] = table.includes('.') ? table.split('.', 2) : ['public', table];
    return `SELECT column_name AS columna, data_type AS tipo, is_nullable AS nulo, column_default AS por_defecto FROM information_schema.columns WHERE table_schema = ${lit(schema)} AND table_name = ${lit(name)} ORDER BY ordinal_position`;
  }
  return `SELECT name AS columna, type AS tipo, CASE WHEN "notnull" THEN 'NO' ELSE 'YES' END AS nulo, pk AS clave, dflt_value AS por_defecto FROM pragma_table_info(${lit(table)})`;
}

module.exports = {
  ENGINES, NULL_MARK,
  loadConnections, saveConnections, slugify, publicConn, parseEnvValue, quoteEnvValue, isOff,
  splitSql, assertReadOnly, assertSafeWrite, parseCsv, parseMysqlXml, connectionHint,
  runQuery, tablesSql, describeSql,
};
