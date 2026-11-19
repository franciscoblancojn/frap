'use strict';
// Tests de bridge/db.js y del CLI frap-db.
//   - SQLite: siempre (requiere el binario sqlite3).
//   - MySQL / PostgreSQL: solo si se definen FRAP_TEST_MYSQL / FRAP_TEST_PG con JSON de conexión,
//     p. ej. FRAP_TEST_PG='{"host":"127.0.0.1","port":5432,"user":"u","password":"p","database":"d"}'
//     La BD debe tener la tabla `clientes` (ver seedSql abajo).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const db = require('../bridge/db');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frap-db-test-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const hasSqlite = spawnSync('sqlite3', ['-version']).status === 0;
const sqliteFile = path.join(root, 'tienda.sqlite');
if (hasSqlite) {
  execFileSync('sqlite3', [sqliteFile,
    "CREATE TABLE clientes (id INTEGER PRIMARY KEY, nombre TEXT, nota TEXT, saldo REAL);" +
    "INSERT INTO clientes VALUES (1,'Ana Peña','línea1'||char(10)||'línea2',10.5),(2,'Bob'||char(9)||'Tab',NULL,0),(3,'NULL','a, \"b\"',NULL);"]);
}

// ------------------------------------------------------------------ clasificador
test('assertReadOnly acepta lecturas', () => {
  const ok = [
    ['mysql', 'SELECT * FROM t'],
    ['mysql', '  -- comentario\nselect 1;'],
    ['mysql', 'SHOW TABLES'],
    ['mysql', 'DESCRIBE t'],
    ['mysql', "SELECT REPLACE(nombre, 'a', 'b') FROM t"],
    ['mysql', "SELECT 'DELETE FROM x; DROP TABLE y' AS texto"],
    ['postgres', 'WITH x AS (SELECT 1) SELECT * FROM x'],
    ['postgres', 'EXPLAIN SELECT 1'],
    ['postgres', 'SELECT $$ ; DROP TABLE t $$'],
    ['postgres', '(SELECT 1) UNION (SELECT 2)'],
    ['sqlite', 'PRAGMA table_info(t)'],
    ['sqlite', 'SELECT * FROM pragma_table_info(\'t\')'],
  ];
  for (const [e, q] of ok) assert.doesNotThrow(() => db.assertReadOnly(q, e), `${e}: ${q}`);
  assert.equal(db.assertReadOnly('SELECT 1; -- fin', 'mysql'), 'SELECT 1');
  // los comentarios ejecutables /*! */ se eliminan del texto que se ejecuta: no sirven para colar SQL
  const smuggled = db.assertReadOnly('SELECT 1 /*!50000 , (SELECT 1) ; DROP TABLE t */', 'mysql');
  assert.doesNotMatch(smuggled, /DROP|50000/);
});

test('assertReadOnly rechaza escrituras y trucos', () => {
  const bad = [
    ['mysql', 'UPDATE t SET a = 1', /UPDATE/],
    ['mysql', 'select 1; drop table t', /una sola sentencia/],
    ['mysql', 'SELECT * INTO OUTFILE "/tmp/x" FROM t', /OUTFILE/],
    ['mysql', 'SELECT * FROM t FOR UPDATE', /UPDATE|bloqueos/],
    ['postgres', 'SELECT * FROM t FOR SHARE', /bloqueos/],
    ['mysql', 'SELECT 1 \\! touch /tmp/pwn', /metacomandos/],
    ['mysql', 'SELECT LOAD_FILE("/etc/passwd")', /LOAD_FILE/],
    ['mysql', 'REPLACE INTO t VALUES (1)', /REPLACE/],
    ['postgres', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', /DELETE/],
    ['postgres', "SELECT set_config('default_transaction_read_only', 'off', false)", /SET_CONFIG/],
    ['postgres', 'SET default_transaction_read_only = off', /SET/],
    ['postgres', 'SELECT 1 \\! id', /metacomandos/],
    ['postgres', 'COPY t TO \'/tmp/x\'', /COPY/],
    ['sqlite', '.shell ls', /comandos "\."/],
    ['sqlite', 'ATTACH DATABASE \'/tmp/x.db\' AS x', /ATTACH/],
    ['sqlite', 'PRAGMA journal_mode = WAL', /PRAGMA/],
    ['sqlite', '', /vacía/],
  ];
  for (const [e, q, re] of bad) assert.throws(() => db.assertReadOnly(q, e), re, `${e}: ${q}`);
});

test('connectionHint: pistas para errores de conexión frecuentes', () => {
  assert.match(db.connectionHint("ERROR 2003 (HY000): Can't connect to MySQL server on '131.0.136.187:3306' (110)"), /timeout.*IP interna y enciende la VPN/);
  assert.match(db.connectionHint("ERROR 2003 (HY000): Can't connect to MySQL server on '192.168.0.187:3306' (110)"), /VPN esté encendida/);
  assert.match(db.connectionHint("ERROR 2003 (HY000): Can't connect to MySQL server on '127.0.0.1:1' (111)"), /puerto/);
  assert.match(db.connectionHint("ERROR 1045 (28000): Access denied for user 'x'@'y' (using password: YES)"), /contraseña/);
  const h1045 = db.connectionHint("ERROR 1045 (28000): Access denied for user 'apiappave-only-read'@'192.168.0.4' (using password: YES)");
  assert.match(h1045, /desde 192\.168\.0\.4/);
  assert.match(h1045, /'apiappave-only-read'@'192\.168\.0\.4'/);
  const pub = db.connectionHint("ERROR 1045 (28000): Access denied for user 'c1logisd-only-read'@'191.95.130.19' (using password: YES)");
  assert.match(pub, /IP pública 191\.95\.130\.19/);
  assert.match(pub, /VPN/);
  assert.doesNotMatch(pub, /191\.95\.130\.%/, 'nunca sugerir abrir un rango público');
  assert.match(h1045, /túnel SSH/);
  assert.match(db.connectionHint('psql: error: could not translate host name "nope" to address'), /resolver/);
  assert.equal(db.connectionHint('ERROR 1146: Table x doesn\'t exist'), '');
});

test('conexión real rechazada devuelve el error con pista', { skip: spawnSync('mysql', ['--version']).status !== 0 }, async () => {
  await assert.rejects(
    db.runQuery({ engine: 'mysql', host: '127.0.0.1', port: '1', user: 'x', password: 'y' }, 'SELECT 1', { timeoutMs: 15000 }),
    /\(111\)[\s\S]*→ El host responde pero no hay nada escuchando/
  );
});

// ------------------------------------------------------------------ parsers y .env
test('parseCsv: comillas, comas y saltos de línea', () => {
  assert.deepEqual(db.parseCsv('a,b\n"x, y","l1\nl2"\n"",z\n'), [['a', 'b'], ['x, y', 'l1\nl2'], ['', 'z']]);
});

test('parseMysqlXml distingue NULL de "NULL" y decodifica entidades', () => {
  const xml = `<?xml version="1.0"?>
<resultset statement="x" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
\t<field name="a">NULL</field>
\t<field name="b" xsi:nil="true" />
\t<field name="c">&lt;b&gt; &amp; &quot;q&quot;</field>
  </row>
</resultset>`;
  assert.deepEqual(db.parseMysqlXml(xml), { columns: ['a', 'b', 'c'], rows: [['NULL', null, '<b> & "q"']] });
});

test('.env: guardar y leer conserva caracteres especiales y permisos 0600', () => {
  const env = path.join(root, 'cfg', 'databases.env');
  const conns = [
    { id: 'prod', name: 'Producción "A"', engine: 'mysql', host: '10.0.0.1', port: '3306', user: 'lector', password: 'p@ss "x" \\ $HOME #no', database: 'app', uiWrite: false },
    { id: 'local_db', name: 'Local', engine: 'sqlite', host: '', port: '', user: '', password: '', database: '/tmp/a b.db', uiWrite: true },
  ];
  db.saveConnections(env, conns, '/x/frap-db.js');
  assert.deepEqual(db.loadConnections(env), conns);
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
  assert.equal(db.slugify('Producción AVE', new Set(['produccion_ave'])), 'produccion_ave_2');
  assert.equal(db.publicConn(conns[0]).password, undefined);
  assert.equal(db.publicConn(conns[0]).hasPassword, true);
});

// ------------------------------------------------------------------ motores
const engines = [];
if (hasSqlite) engines.push(['sqlite', { engine: 'sqlite', database: sqliteFile }]);
if (process.env.FRAP_TEST_MYSQL) engines.push(['mysql', { engine: 'mysql', ...JSON.parse(process.env.FRAP_TEST_MYSQL) }]);
if (process.env.FRAP_TEST_PG) engines.push(['postgres', { engine: 'postgres', ...JSON.parse(process.env.FRAP_TEST_PG) }]);

for (const [name, conn] of engines) {
  test(`${name}: consulta, NULL, límite, esquema y errores`, async () => {
    const r = await db.runQuery(conn, 'SELECT id, nombre, nota FROM clientes ORDER BY id');
    assert.deepEqual(r.columns, ['id', 'nombre', 'nota']);
    assert.equal(r.rows[0][1], 'Ana Peña');
    assert.equal(r.rows[0][2], 'línea1\nlínea2');
    assert.equal(r.rows[1][1], 'Bob\tTab');
    assert.equal(r.rows[1][2], null);
    assert.equal(r.rows[2][1], 'NULL');
    assert.equal(r.readOnly, true);

    const l = await db.runQuery(conn, 'SELECT id FROM clientes', { limit: 2 });
    assert.equal(l.rowCount, 2);
    assert.equal(l.truncated, true);

    const t = await db.runQuery(conn, db.tablesSql(name));
    assert.ok(t.rows.some((row) => row[0] === 'clientes'));
    const d = await db.runQuery(conn, db.describeSql(name, 'clientes'));
    assert.deepEqual(d.rows.map((row) => row[0]), ['id', 'nombre', 'nota', 'saldo']);

    if (name === 'mysql') {
      // el tiempo límite del servidor se aplica (MySQL: max_execution_time; MariaDB: max_statement_time)
      const v = await db.runQuery(conn, 'SELECT VERSION() AS v, @@max_execution_time AS met', { timeoutMs: 45000 });
      if (!/mariadb/i.test(v.rows[0][0])) assert.equal(v.rows[0][1], '45000');
      const ro = await db.runQuery(conn, 'SELECT @@transaction_read_only AS ro');
      assert.equal(ro.rows[0][0], '1', 'la consulta corre en una transacción de solo lectura');
    }
    await assert.rejects(db.runQuery(conn, 'SELECT * FROM no_existe'), /no_existe/);
    await assert.rejects(db.runQuery(conn, 'DELETE FROM clientes'), /Solo lectura/);
    await assert.rejects(db.runQuery(conn, 'SELECT 1', { write: true }), /no permite escritura/);
  });
}

test('sqlite: el motor bloquea escrituras aunque el clasificador no las vea (-readonly)', { skip: !hasSqlite }, async () => {
  // escritura habilitada solo para la UI: funciona
  const w = { engine: 'sqlite', database: sqliteFile, uiWrite: true };
  await db.runQuery(w, 'CREATE TABLE tmp_w (x INT); INSERT INTO tmp_w VALUES (1)', { write: true });
  const r = await db.runQuery(w, 'SELECT count(*) FROM tmp_w');
  assert.equal(r.rows[0][0], '1');
  // y la capa del motor: sqlite3 -readonly rechaza el INSERT
  const out = spawnSync('sqlite3', ['-readonly', '-safe', sqliteFile, 'INSERT INTO tmp_w VALUES (2)'], { encoding: 'utf8' });
  assert.match(out.stderr, /readonly/);
});

// ------------------------------------------------------------------ CLI
test('CLI frap-db: list, --tables, --describe, consulta, --json y rechazo de escrituras', { skip: !hasSqlite }, () => {
  const home = path.join(root, 'cli');
  db.saveConnections(path.join(home, 'databases.env'), [
    { id: 'tienda', name: 'Tienda', engine: 'sqlite', host: '', port: '', user: '', password: 'secreto-no-mostrar', database: sqliteFile, uiWrite: true },
  ]);
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bridge', 'frap-db.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, FRAP_HOME: home },
  });
  const list = cli('list');
  assert.equal(list.status, 0);
  assert.match(list.stdout, /tienda/);
  assert.doesNotMatch(list.stdout, /secreto/);

  assert.match(cli('tienda', '--tables').stdout, /clientes/);
  assert.match(cli('tienda', '--describe', 'clientes').stdout, /nombre/);

  const q = cli('tienda', 'SELECT nombre, nota FROM clientes ORDER BY id');
  assert.equal(q.status, 0);
  assert.match(q.stdout, /Ana Peña/);
  assert.match(q.stdout, /línea1\\nlínea2/);
  assert.match(q.stdout, /NULL/);

  const j = JSON.parse(cli('tienda', 'SELECT id FROM clientes ORDER BY id', '--json', '--limit', '2').stdout);
  assert.deepEqual(j.rows, [['1'], ['2']]);
  assert.equal(j.truncated, true);

  // el CLI nunca escribe, aunque la conexión permita escritura en la UI
  const w = cli('tienda', 'DELETE FROM clientes');
  assert.notEqual(w.status, 0);
  assert.match(w.stderr, /Solo lectura/);
  assert.notEqual(cli('nope', 'SELECT 1').status, 0);
});
