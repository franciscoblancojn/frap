'use strict';
// Tests de integración del bridge: levanta un bridge real en un puerto aleatorio,
// con FRAP_HOME/FRAP_FS_ROOT aislados en un directorio temporal.
//   node --test tests/

const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ws = require('../bridge/ws');
const issuesMod = require('../bridge/issues');

const TOKEN = 'test-token-123';
let bridge;
let port;
let root;
let client;

const FAKE_SSH = `#!/bin/sh
for last; do :; done
# sftp: conecta con el sftp-server local (si lo hay) y deja constancia de argumentos y contraseña
if [ "$last" = sftp ] && [ -n "$FRAP_TEST_SFTP_SERVER" ]; then
  echo "$*" > "$FRAP_TEST_SFTP_LOG"
  [ -n "$SSH_ASKPASS" ] && "$SSH_ASKPASS" "password:" >> "$FRAP_TEST_SFTP_LOG"
  exec "$FRAP_TEST_SFTP_SERVER"
fi
echo "ARGS:$*"
if [ -n "$SSH_ASKPASS" ]; then
  echo "PASS:$("$SSH_ASKPASS" "lector@host's password: ")"
  "$SSH_ASKPASS" "Are you sure you want to continue connecting (yes/no)?" >/dev/null; echo "HOSTKEY:$?"
fi
for last; do :; done
case "$last" in *FRAP_OK*) echo FRAP_OK; echo "Linux falso 6.0";; esac
exit 0
`;

/** sftp-server real del sistema (los tests de sftp.* se saltan si no hay). */
const SFTP_SERVER = (() => {
  const c = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/libexec/sftp-server', '/usr/lib/ssh/sftp-server'];
  try {
    for (const d of fs.readdirSync('/snap')) {
      if (!/^core\d*$/.test(d)) continue;
      for (const v of fs.readdirSync(path.join('/snap', d))) c.push(path.join('/snap', d, v, 'usr/lib/openssh/sftp-server'));
    }
  } catch (_) { /* sin snap */ }
  return c.find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return !require('child_process').spawnSync(f, ['-h']).error; } catch (_) { return false; } }) || null;
})();
const HAS_SFTP = !require('child_process').spawnSync('sftp', ['-h']).error;

function rpcClient(conn) {
  let seq = 0;
  const pending = new Map();
  const events = [];
  const waiters = [];
  conn.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.re != null) {
      const p = pending.get(msg.re);
      pending.delete(msg.re);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
    } else {
      events.push(msg);
      for (const w of [...waiters]) if (w.test(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  return {
    call(op, args) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        conn.send(JSON.stringify({ id, op, args }));
      });
    },
    send(op, args) { conn.send(JSON.stringify({ op, args })); },
    /** Espera un evento que cumpla `test` (incluye los ya recibidos). */
    waitFor(test, ms = 5000) {
      const hit = events.find(test);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { test, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timeout esperando evento')), ms);
      });
    },
    /** Espera hasta que la salida acumulada de `sid` cumpla `re`. */
    async waitOutput(sid, re, ms = 5000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const out = events.filter((e) => e.ev === 'out' && e.sid === sid).map((e) => e.d).join('');
        if (re.test(out)) return out;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw new Error(`timeout esperando ${re}`);
    },
    events,
  };
}

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'frap-test-'));
  // ssh falso: muestra los argumentos y lo que responde SSH_ASKPASS (no se usa ningún servidor real)
  const fakeBin = path.join(root, 'fakebin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'ssh'), FAKE_SSH, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'cloudflared'), '#!/bin/sh\necho "INF Requesting new quick Tunnel on trycloudflare.com..." >&2\necho "INF |  https://falso-tunel-123.trycloudflare.com  |" >&2\necho "args: $*" >&2\nexec sleep 60\n', { mode: 0o755 });
  bridge = fork(path.join(__dirname, '..', 'bridge', 'frap-bridge.js'), [], {
    env: {
      ...process.env,
      FRAP_PORT: '0', FRAP_TOKEN: TOKEN, HOME: root, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', FRAP_HOME: path.join(root, 'cfg'),
      FRAP_TEST_SFTP_SERVER: SFTP_SERVER || '', FRAP_TEST_SFTP_LOG: path.join(root, 'sftp.log'),
      FRAP_FS_ROOT: root, FRAP_LOCAL: path.join(root, 'local'), FRAP_QUIET: '1', SHELL: '/bin/sh', PATH: `${path.join(root, 'fakebin')}${path.delimiter}${process.env.PATH}`,
      GIT_AUTHOR_NAME: 'FRAP Test', GIT_AUTHOR_EMAIL: 'test@frap.local', GIT_COMMITTER_NAME: 'FRAP Test', GIT_COMMITTER_EMAIL: 'test@frap.local',
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  port = await new Promise((resolve, reject) => {
    bridge.on('message', (m) => m.ready && resolve(m.port));
    bridge.on('exit', (c) => reject(new Error(`bridge salió con ${c}`)));
  });
  client = rpcClient(await ws.connect(port, `/?token=${TOKEN}`, { Origin: 'null' }));
});

test.after(async () => {
  // las sesiones sobreviven al bridge: se cierran explícitamente
  try {
    for (const s of await client.call('sessions.list')) if (s.alive) await client.call('session.kill', { sid: s.sid });
    await new Promise((r) => setTimeout(r, 300));
  } catch (_) { /* nada */ }
  if (bridge) bridge.kill('SIGTERM');
  fs.rmSync(root, { recursive: true, force: true });
});

test('rechaza token inválido', async () => {
  await assert.rejects(ws.connect(port, '/?token=malo', { Origin: 'null' }), { status: 401 });
});

test('rechaza origins web', async () => {
  await assert.rejects(ws.connect(port, `/?token=${TOKEN}`, { Origin: 'https://evil.example' }), { status: 403 });
});

test('hello', async () => {
  const info = await client.call('hello');
  assert.equal(info.version, '1.3.0');
  for (const op of ['db.list', 'db.save', 'db.toggle', 'db.check', 'ssh.list', 'ssh.connect', 'session.seen', 'export.creds', 'import.creds', 'git.run', 'music.ytInfo']) assert.ok(info.ops.includes(op), op);
  assert.equal(info.fsRoot, root);
});

test('operación desconocida devuelve error', async () => {
  await assert.rejects(client.call('nope'), /desconocida/);
});

test('sesión: comando, salida y exit', async () => {
  const s = await client.call('session.create', { cwd: root, cmd: ['sh', '-c', 'echo hola-frap'], meta: { kind: 'shell' } });
  await client.waitOutput(s.sid, /hola-frap/);
  const ex = await client.waitFor((e) => e.ev === 'exit' && e.sid === s.sid);
  assert.equal(ex.code, 0);
});

test('sesión interactiva: input, resize y attach', async () => {
  const s = await client.call('session.create', { cwd: root, cols: 80, rows: 24, meta: { title: 't' } });
  client.send('session.input', { sid: s.sid, data: 'echo $((40+2))\r' });
  await client.waitOutput(s.sid, /\b42\b/);

  client.send('session.resize', { sid: s.sid, cols: 120, rows: 40 });
  await new Promise((r) => setTimeout(r, 100));
  client.send('session.input', { sid: s.sid, data: 'stty size\r' });
  await client.waitOutput(s.sid, /40 120/);

  const att = await client.call('session.attach', { sid: s.sid });
  assert.match(att.buffer, /42/);
  assert.equal(att.meta.title, 't');

  const ps = await client.call('ps');
  assert.ok(Array.isArray(ps[s.sid]) && ps[s.sid].length >= 1, 'ps debe listar la shell');

  const list = await client.call('sessions.list');
  assert.ok(list.some((x) => x.sid === s.sid));

  await client.call('session.kill', { sid: s.sid });
  await client.waitFor((e) => e.ev === 'exit' && e.sid === s.sid);
});

test('init escribe el comando inicial en la shell', async () => {
  const s = await client.call('session.create', { cwd: root, init: 'echo init-$((1+1))' });
  await client.waitOutput(s.sid, /init-2/);
  await client.call('session.kill', { sid: s.sid });
});

test('open.folder: carpeta con xdg-open; archivo seleccionado por D-Bus o, si falla, su carpeta', async () => {
  const fake = path.join(root, 'fakebin');
  const log = path.join(root, 'open.log');
  const logger = `#!/bin/sh\necho "$(basename "$0") $*" >> "${log}"\n`;
  fs.writeFileSync(path.join(fake, 'xdg-open'), logger, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, 'gdbus'), logger, { mode: 0o755 });
  const dir = path.join(root, 'explorar', "it's mío");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a b.txt'), 'x');
  const waitLog = async (re) => { for (let i = 0; i < 50; i++) { const t = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''; if (re.test(t)) return t; await new Promise((r) => setTimeout(r, 40)); } throw new Error(`sin ${re}`); };
  assert.deepEqual(await client.call('open.folder', { path: dir }), { opened: dir, how: 'xdg-open' });
  await waitLog(new RegExp(`xdg-open ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const r = await client.call('open.folder', { path: path.join(dir, 'a b.txt') });
  assert.equal(r.how, 'select');
  const t = await waitLog(/gdbus call/);
  assert.match(t, /org\.freedesktop\.FileManager1\.ShowItems \['file:\/\/[^ ]*it%27s%20m%C3%ADo\/a%20b\.txt'\]/);
  // sin gestor de archivos por D-Bus: abre la carpeta del archivo
  fs.writeFileSync(path.join(fake, 'gdbus'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.deepEqual(await client.call('open.folder', { path: path.join(dir, 'a b.txt') }), { opened: dir, how: 'xdg-open' });
  await assert.rejects(client.call('open.folder', { path: '/etc' }), /fuera/);
  await assert.rejects(client.call('open.folder', { path: path.join(dir, 'no-existe') }), /No existe/);
  fs.rmSync(path.join(fake, 'gdbus'));
  fs.rmSync(path.join(fake, 'xdg-open'));
});

test('fs: escribir/leer dentro de la raíz, rechazar fuera', async () => {
  const f = path.join(root, 'proj', 'nota.md');
  await client.call('fs.write', { path: f, content: 'hola' });
  assert.equal((await client.call('fs.read', { path: f })).content, 'hola');
  const bin = path.join(root, 'proj', 'bin.dat');
  fs.writeFileSync(bin, Buffer.from([0, 255, 137, 80, 78, 71]));
  const b64 = await client.call('fs.read', { path: bin, encoding: 'base64' });
  assert.equal(b64.encoding, 'base64');
  assert.deepEqual([...Buffer.from(b64.content, 'base64')], [0, 255, 137, 80, 78, 71]);
  await assert.rejects(client.call('fs.read', { path: '/etc/hostname', encoding: 'base64' }), /fuera/);
  assert.equal(await client.call('fs.exists', { path: f }), true);
  const ls = await client.call('fs.list', { path: root });
  assert.ok(ls.entries.some((e) => e.name === 'proj' && e.dir));
  await assert.rejects(client.call('fs.read', { path: '/etc/passwd' }), /fuera/);
  await assert.rejects(client.call('fs.write', { path: path.join(root, '..', 'x') }), /fuera/);
});

test('editor (fs.stat/mkdir/rename/trash, code.files, code.search): con y sin git, dentro de la raíz', async () => {
  const { execFileSync } = require('child_process');
  const plain = path.join(root, 'code-plain');
  fs.mkdirSync(path.join(plain, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(plain, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(plain, 'src', 'app.js'), 'const a = 1;\nfunction Buscame() {}\n');
  fs.writeFileSync(path.join(plain, 'src', 'lib', 'util.js'), 'export const buscame = 2;\n');
  fs.writeFileSync(path.join(plain, 'node_modules', 'x', 'i.js'), 'buscame');
  fs.writeFileSync(path.join(plain, 'img.bin'), Buffer.from([0, 1, 2, 98, 117, 115, 99, 97, 109, 101]));

  // sin git: recorre carpetas, salta node_modules
  const fl = await client.call('code.files', { root: plain });
  assert.equal(fl.git, false);
  assert.deepEqual(fl.files.sort(), ['img.bin', 'src/app.js', 'src/lib/util.js']);
  const s1 = await client.call('code.search', { root: plain, query: 'buscame' });
  assert.deepEqual(s1.results.map((r) => `${r.file}:${r.line}:${r.col}`).sort(), ['src/app.js:2:10', 'src/lib/util.js:1:14']);
  const s2 = await client.call('code.search', { root: plain, query: 'Buscame', caseSensitive: true });
  assert.deepEqual(s2.results.map((r) => r.file), ['src/app.js']);
  const s3 = await client.call('code.search', { root: plain, query: 'busc[a]me\\b', regex: true });
  assert.equal(s3.results.length, 2);
  await assert.rejects(client.call('code.search', { root: plain, query: '(', regex: true }), /regular/);
  await assert.rejects(client.call('code.search', { root: plain, query: '' }), /inválida/);
  await assert.rejects(client.call('code.files', { root: '/etc' }), /fuera/);

  // con git: respeta .gitignore e incluye archivos sin seguimiento
  const repo = path.join(root, 'code-repo');
  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'uno\nOpción con: dos puntos\n');
  fs.writeFileSync(path.join(repo, 'dist', 'b.txt'), 'Opción');
  execFileSync('git', ['-C', repo, 'add', '.gitignore']);
  const fg = await client.call('code.files', { root: repo });
  assert.equal(fg.git, true);
  assert.deepEqual(fg.files.sort(), ['.gitignore', 'a.txt']);
  const sg = await client.call('code.search', { root: repo, query: 'opción con:' });
  assert.deepEqual(sg.results, [{ file: 'a.txt', line: 2, col: 1, text: 'Opción con: dos puntos' }]);
  // una búsqueda que empieza con "-" no se toma como opción de git
  assert.deepEqual((await client.call('code.search', { root: repo, query: '--version' })).results, []);

  // stat / mkdir / rename / trash
  const st = await client.call('fs.stat', { paths: [path.join(plain, 'src', 'app.js'), path.join(plain, 'no')] });
  assert.equal(st[0].exists, true);
  assert.ok(st[0].mtime > 0);
  assert.equal(st[1].exists, false);
  await assert.rejects(client.call('fs.stat', { paths: ['/etc/passwd'] }), /fuera/);
  await client.call('fs.mkdir', { path: path.join(plain, 'nueva', 'sub') });
  assert.ok(fs.statSync(path.join(plain, 'nueva', 'sub')).isDirectory());
  await assert.rejects(client.call('fs.mkdir', { path: path.join(plain, 'nueva') }), /Ya existe/);
  await client.call('fs.rename', { from: path.join(plain, 'src', 'app.js'), to: path.join(plain, 'src', 'main.js') });
  assert.ok(fs.existsSync(path.join(plain, 'src', 'main.js')));
  await assert.rejects(client.call('fs.rename', { from: path.join(plain, 'src', 'main.js'), to: path.join(plain, 'src', 'lib', 'util.js') }), /Ya existe/);
  await assert.rejects(client.call('fs.rename', { from: path.join(plain, 'src', 'main.js'), to: '/tmp/fuera.js' }), /fuera/);
  const tr = await client.call('fs.trash', { path: path.join(plain, 'src', 'main.js') });
  assert.equal(fs.existsSync(path.join(plain, 'src', 'main.js')), false);
  assert.equal(tr.trashed, path.join(root, '.local', 'share', 'Trash', 'files', 'main.js'));
  assert.equal(fs.readFileSync(tr.trashed, 'utf8'), 'const a = 1;\nfunction Buscame() {}\n');
  assert.match(fs.readFileSync(path.join(root, '.local', 'share', 'Trash', 'info', 'main.js.trashinfo'), 'utf8'), /^\[Trash Info\]\nPath=.*code-plain\/src\/main\.js\nDeletionDate=\d{4}-/);
  fs.writeFileSync(path.join(plain, 'main.js'), 'otro');
  assert.equal((await client.call('fs.trash', { path: path.join(plain, 'main.js') })).trashed, path.join(root, '.local', 'share', 'Trash', 'files', 'main.js.2'));
  await assert.rejects(client.call('fs.trash', { path: root }), /raíz/);
});

test('config.scan encuentra agentes, comandos, skills, hooks y memoria del proyecto', async () => {
  const p = path.join(root, 'proj');
  fs.mkdirSync(path.join(p, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(p, '.claude', 'commands', 'git'), { recursive: true });
  fs.mkdirSync(path.join(p, '.claude', 'skills', 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude', 'agents', 'rev.md'), '---\nname: reviewer\ndescription: Revisa código\n---\nx');
  fs.writeFileSync(path.join(p, '.claude', 'commands', 'git', 'pr.md'), 'abre un PR');
  fs.writeFileSync(path.join(p, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\n');
  fs.writeFileSync(path.join(p, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier -w' }] }] },
  }));
  fs.writeFileSync(path.join(p, 'CLAUDE.md'), '# reglas');

  const cfg = await client.call('config.scan', { folders: [p] });
  const agent = cfg.agents.find((a) => a.name === 'reviewer');
  assert.ok(agent);
  assert.equal(agent.description, 'Revisa código');
  assert.equal(agent.scope, 'project');
  assert.ok(cfg.commands.some((c) => c.name === 'git:pr'));
  assert.ok(cfg.skills.some((s) => s.name === 'deploy'));
  assert.deepEqual(
    cfg.hooks.map(({ event, matcher, command }) => ({ event, matcher, command })),
    [{ event: 'PostToolUse', matcher: 'Edit', command: 'prettier -w' }]
  );
  assert.ok(cfg.memory.some((m) => m.name === 'CLAUDE.md' && m.exists && m.scope === 'project'));
});

test('state.get / state.set', async () => {
  assert.equal(await client.call('state.get'), null);
  await client.call('state.set', { state: { v: 1, projects: [{ id: 'a' }] } });
  assert.deepEqual(await client.call('state.get'), { v: 1, projects: [{ id: 'a' }] });
});

test('ws: frames grandes (>64KB) se transmiten completos', async () => {
  const big = 'x'.repeat(200_000);
  const f = path.join(root, 'big.txt');
  await client.call('fs.write', { path: f, content: big });
  assert.equal((await client.call('fs.read', { path: f })).content.length, big.length);
});

test('skills anidadas (~/.claude/skills/synced/<id>/<skill>/SKILL.md)', async () => {
  const d = path.join(root, '.claude', 'skills', 'synced', 'abc', 'pdf');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), '---\nname: pdf\ndescription: PDFs\n---\n');
  const cfg = await client.call('config.scan', { folders: [] });
  assert.ok(cfg.skills.some((s) => s.name === 'pdf' && s.scope === 'user'));
});

test('las terminales no heredan marcadores de sesión de Claude Code', async () => {
  const s = await client.call('session.create', { cwd: root, cmd: ['sh', '-c', 'echo "cc=[${CLAUDECODE}${CLAUDE_CODE_CHILD_SESSION}] path=[${PATH:+ok}]"'] });
  const out = await client.waitOutput(s.sid, /path=\[ok\]/);
  assert.match(out, /cc=\[\]/);
});

test('acciones: Ctrl+C por el PTY detiene el comando en primer plano (bash -ic)', async () => {
  const s = await client.call('session.create', {
    cwd: root, cmd: ['bash', '-ic', 'echo listo-ok; sleep 30'], meta: { kind: 'action', actionId: 'a1', title: 'VPN' },
  });
  await client.waitOutput(s.sid, /listo-ok/);
  client.send('session.input', { sid: s.sid, data: '\x03' });
  const ex = await client.waitFor((e) => e.ev === 'exit' && e.sid === s.sid, 4000);
  assert.notEqual(ex.code, null);
  const info = (await client.call('sessions.list')).find((x) => x.sid === s.sid);
  assert.equal(info.meta.actionId, 'a1');
});

test('db.*: guardar (sin exponer contraseña), probar, consultar, tablas, skill y borrar', async () => {
  const file = path.join(root, 'proj', 'app.sqlite');
  require('child_process').execFileSync('sqlite3', [file, 'CREATE TABLE t (x INT); INSERT INTO t VALUES (7);']);

  const saved = await client.call('db.save', { conn: { name: 'App Local', engine: 'sqlite', database: file } });
  assert.equal(saved.id, 'app_local');
  assert.equal(saved.password, undefined);
  const list = await client.call('db.list');
  assert.equal(list.conns.length, 1);
  assert.equal(fs.statSync(list.envFile).mode & 0o777, 0o600);

  // editar sin enviar contraseña la conserva (sqlite no guarda contraseña: se prueba con mysql)
  const my = await client.call('db.save', { conn: { name: 'Remota', engine: 'mysql', host: 'db.ejemplo', user: 'lector', password: 'p4ss-secreta' } });
  await client.call('db.save', { conn: { id: my.id, name: 'Remota 2', engine: 'mysql', host: 'db.ejemplo', user: 'lector', password: null } });
  assert.match(fs.readFileSync(list.envFile, 'utf8'), /FRAP_DB_REMOTA_PASSWORD="p4ss-secreta"/);
  assert.equal(JSON.stringify(await client.call('db.list')).includes('p4ss-secreta'), false);
  await client.call('db.delete', { id: my.id });

  assert.ok((await client.call('db.test', { id: 'app_local' })).version);
  const r = await client.call('db.query', { id: 'app_local', sql: 'SELECT x FROM t' });
  assert.deepEqual(r.rows, [['7']]);
  await assert.rejects(client.call('db.query', { id: 'app_local', sql: 'DELETE FROM t' }), /Solo lectura/);
  await assert.rejects(client.call('db.query', { id: 'app_local', sql: 'DELETE FROM t', write: true }), /no permite escritura/);
  assert.deepEqual(await client.call('db.tables', { id: 'app_local' }), [{ name: 't', view: false }]);

  // interruptores: por defecto activa y con uso por IA; desactivada no consulta (pero sí se puede probar)
  assert.equal(saved.enabled, true);
  assert.equal(saved.ai, true);
  const off = await client.call('db.toggle', { id: 'app_local', enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.ai, true);
  assert.match(fs.readFileSync(list.envFile, 'utf8'), /FRAP_DB_APP_LOCAL_ENABLED=0/);
  await assert.rejects(client.call('db.query', { id: 'app_local', sql: 'SELECT x FROM t' }), /desactivada/);
  await assert.rejects(client.call('db.tables', { id: 'app_local' }), /desactivada/);
  assert.ok((await client.call('db.test', { id: 'app_local' })).version);
  const noAi = await client.call('db.toggle', { id: 'app_local', enabled: true, ai: false });
  assert.deepEqual([noAi.enabled, noAi.ai], [true, false]);
  // editar sin mandar los interruptores los conserva
  await client.call('db.save', { conn: { id: 'app_local', name: 'App Local', engine: 'sqlite', database: file } });
  assert.equal((await client.call('db.list')).conns[0].ai, false);
  await client.call('db.toggle', { id: 'app_local', ai: true });
  await assert.rejects(client.call('db.toggle', { id: 'nope', ai: true }), /no encontrada/);

  // "Solo lectura": activado por defecto; desactivado permite INSERT/UPDATE/CREATE/ALTER pero nunca eliminaciones
  assert.equal(saved.uiWrite, false);
  assert.deepEqual(await client.call('db.check', { id: 'app_local', sql: 'SELECT x FROM t' }), { write: false });
  await assert.rejects(client.call('db.check', { id: 'app_local', sql: 'UPDATE t SET x = 8' }), /Solo lectura/);
  const rw = await client.call('db.toggle', { id: 'app_local', uiWrite: true });
  assert.equal(rw.uiWrite, true);
  assert.match(fs.readFileSync(list.envFile, 'utf8'), /FRAP_DB_APP_LOCAL_UI_WRITE=1/);
  assert.deepEqual(await client.call('db.check', { id: 'app_local', sql: 'UPDATE t SET x = 8' }), { write: true });
  await assert.rejects(client.call('db.check', { id: 'app_local', sql: 'DELETE FROM t' }), /DELETE/);
  await client.call('db.query', { id: 'app_local', sql: 'UPDATE t SET x = 8; ALTER TABLE t ADD COLUMN y TEXT; CREATE TABLE u (z INT); INSERT INTO u VALUES (1)', write: true });
  assert.deepEqual((await client.call('db.query', { id: 'app_local', sql: 'SELECT x, (SELECT count(*) FROM u) FROM t' })).rows, [['8', '1']]);
  for (const sql of ['DELETE FROM t', 'DROP TABLE u', 'ALTER TABLE t DROP COLUMN y']) {
    await assert.rejects(client.call('db.query', { id: 'app_local', sql, write: true }), /DELETE|DROP|no está permitido/, sql);
  }
  assert.equal((await client.call('db.query', { id: 'app_local', sql: 'SELECT count(*) FROM t' })).rows[0][0], '1');
  // editar sin mandar uiWrite lo conserva
  await client.call('db.save', { conn: { id: 'app_local', name: 'App Local', engine: 'sqlite', database: file } });
  assert.equal((await client.call('db.list')).conns[0].uiWrite, true);
  await client.call('db.toggle', { id: 'app_local', uiWrite: false });
  await assert.rejects(client.call('db.query', { id: 'app_local', sql: 'UPDATE t SET x = 9', write: true }), /no permite escritura/);

  // sqlite fuera de FRAP_FS_ROOT se rechaza
  await assert.rejects(client.call('db.save', { conn: { name: 'x', engine: 'sqlite', database: '/etc/x.db' } }), /fuera/);

  const skills = await client.call('db.installSkill', { tools: ['claude'] });
  assert.equal(skills.length, 1);
  assert.match(fs.readFileSync(skills[0], 'utf8'), /frap-db\.js/);
  assert.equal((await client.call('db.list')).skills.claude, true);

  await client.call('db.delete', { id: 'app_local' });
  assert.equal((await client.call('db.list')).conns.length, 0);
});

test('música: /yt-player sirve el relé de YouTube y music.ytInfo valida el ID', async () => {
  const body = await new Promise((resolve, reject) => {
    require('http').get(`http://127.0.0.1:${port}/yt-player`, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], d }));
    }).on('error', reject);
  });
  assert.equal(body.status, 200);
  assert.match(body.type, /text\/html/);
  assert.match(body.d, /youtube\.com\/iframe_api/);
  assert.match(body.d, /e\.source !== parent/, 'el relé solo debe aceptar mensajes de la ventana padre');
  await assert.rejects(client.call('music.ytInfo', { id: 'no-valido!' }), /inválido/);
  // el Origin http del relé no puede abrir el WebSocket del bridge
  await assert.rejects(ws.connect(port, `/?token=${TOKEN}`, { Origin: `http://127.0.0.1:${port}` }), { status: 403 });
});

test('git.run: flujo status → add → commit → checkout -b, errores y lista blanca', async () => {
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => client.call('git.run', { cwd: repo, args });
  assert.equal((await git('init', '-b', 'main')).code, 0);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hola\n');
  assert.match((await git('status', '--porcelain=v1', '-b')).stdout, /\?\? a\.txt/);
  assert.equal((await git('add', '--', 'a.txt')).code, 0);
  assert.match((await git('status', '--porcelain=v1')).stdout, /^A {2}a\.txt/m);
  const c = await git('commit', '-m', 'primero');
  assert.equal(c.code, 0, c.stderr);
  assert.equal((await git('checkout', '-b', 'feature/x')).code, 0);
  assert.equal((await git('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'feature/x');
  assert.match((await git('log', '-n', '1', '--pretty=format:%s')).stdout, /primero/);
  // errores de git vuelven como code != 0 con stderr, no como excepción
  const bad = await git('checkout', 'no-existe');
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /no-existe/);
  // lista blanca y opciones peligrosas
  await assert.rejects(git('config', 'user.name', 'x'), /no permitido/);
  await assert.rejects(git('-c', 'core.sshCommand=touch /tmp/pwn', 'fetch'), /no permitida/);
  await assert.rejects(git('push', '--receive-pack=touch /tmp/pwn'), /no permitida/);
  await assert.rejects(client.call('git.run', { cwd: '/etc', args: ['status'] }), /fuera/);
});

test('persistencia: las terminales sobreviven a reiniciar el bridge (historial, entrada y meta)', async () => {
  const home = path.join(root, 'persist-cfg');
  const start = () => new Promise((resolve, reject) => {
    const b = fork(path.join(__dirname, '..', 'bridge', 'frap-bridge.js'), [], {
      env: { ...process.env, FRAP_PORT: '0', FRAP_TOKEN: TOKEN, FRAP_HOME: home, FRAP_FS_ROOT: root, FRAP_LOCAL: path.join(root, 'local'), FRAP_QUIET: '1', SHELL: '/bin/sh', HOME: root },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    b.on('message', async (m) => {
      if (!m.ready) return;
      try { resolve({ b, c: rpcClient(await ws.connect(m.port, `/?token=${TOKEN}`, { Origin: 'null' })) }); } catch (e) { reject(e); }
    });
    b.on('error', reject);
  });
  const stop = (b) => new Promise((r) => { b.once('exit', r); b.kill('SIGTERM'); });

  let { b, c } = await start();
  const s = await c.call('session.create', { cwd: root, meta: { projectId: 'p1', title: 'larga', kind: 'claude' } });
  c.send('session.input', { sid: s.sid, data: 'echo antes-$((20+1))\r' });
  await c.waitOutput(s.sid, /antes-21/);
  await c.call('session.meta', { sid: s.sid, meta: { title: 'renombrada' } });
  await stop(b); // reiniciar el bridge

  ({ b, c } = await start());
  try {
    const list = await c.call('sessions.list');
    const again = list.find((x) => x.sid === s.sid);
    assert.ok(again, 'la sesión debe seguir viva tras reiniciar el bridge');
    assert.equal(again.alive, true);
    assert.equal(again.meta.title, 'renombrada');
    assert.equal(again.meta.projectId, 'p1');
    const att = await c.call('session.attach', { sid: s.sid });
    assert.match(att.buffer, /antes-21/, 'el historial se conserva');
    c.send('session.input', { sid: s.sid, data: 'echo despues-$((40+2))\r' });
    await c.waitOutput(s.sid, /despues-42/);
    await c.call('session.kill', { sid: s.sid });
    const ex = await c.waitFor((e) => e.ev === 'exit' && e.sid === s.sid);
    assert.equal(typeof ex.code, 'number');
  } finally {
    await stop(b);
  }
  // con la sesión terminada, un bridge nuevo ya no la ve
  ({ b, c } = await start());
  try {
    assert.equal((await c.call('sessions.list')).some((x) => x.sid === s.sid), false);
  } finally { await stop(b); }
});

test('paths.check y open.editor: rutas detectadas en la terminal', async () => {
  const dir = path.join(root, 'proj', 'salida');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'backfill.sql');
  fs.writeFileSync(file, 'select 1;\n');
  const found = await client.call('paths.check', {
    cwd: path.join(root, 'proj'),
    paths: [file, 'salida/backfill.sql', '~/proj/salida', 'no/existe.txt', '/etc/passwd'],
  });
  assert.deepEqual(found.map((f) => [f.input, f.path, f.dir]), [
    [file, file, false],
    ['salida/backfill.sql', file, false],
    ['~/proj/salida', dir, true],
  ]);
  // "editor" de prueba: un comando que existe y termina enseguida
  const r = await client.call('open.editor', { path: file, line: 12, col: 3, editor: 'true' });
  assert.equal(r.opened, file);
  await assert.rejects(client.call('open.editor', { path: file, editor: 'no-existe-este-editor' }), /No se encontró/);
  await assert.rejects(client.call('open.editor', { path: file, editor: 'code; rm -rf ~' }), /inválido/);
  await assert.rejects(client.call('open.editor', { path: '/etc/passwd' }), /fuera/);
  await assert.rejects(client.call('open.editor', { path: path.join(root, 'nada.txt'), editor: 'true' }), /No existe/);
});

test('ssh.*: guardar sin exponer contraseña, validar, probar, conectar con askpass, interruptores y skill', async () => {
  const saved = await client.call('ssh.save', { host: { name: 'Servidor App', host: '10.0.0.9', port: '2222', user: 'lector', password: 'cl4ve "ssh"' } });
  assert.equal(saved.id, 'servidor_app');
  assert.equal(saved.password, undefined);
  assert.equal(saved.hasPassword, true);
  assert.deepEqual([saved.enabled, saved.ai], [true, false]); // uso por IA apagado por defecto
  const list = await client.call('ssh.list');
  assert.equal(fs.statSync(list.envFile).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(list).includes('cl4ve'), false);
  assert.ok(list.client.endsWith(path.join('fakebin', 'ssh')));

  // inyección de opciones en host/usuario
  await assert.rejects(client.call('ssh.save', { host: { name: 'x', host: '-oProxyCommand=touch /tmp/pwn', user: 'a' } }), /Host inválido/);
  await assert.rejects(client.call('ssh.save', { host: { name: 'x', host: 'h', user: '-oX' } }), /Usuario inválido/);
  await assert.rejects(client.call('ssh.save', { host: { name: 'x', host: 'h', user: 'a b' } }), /Usuario inválido/);
  await assert.rejects(client.call('ssh.save', { host: { name: 'x', host: 'h', user: 'a', dir: 'relativa' } }), /Ruta inicial inválida/);

  // editar sin contraseña la conserva
  await client.call('ssh.save', { host: { id: 'servidor_app', name: 'Servidor App', host: '10.0.0.9', port: '2222', user: 'lector', password: null } });
  assert.match(fs.readFileSync(list.envFile, 'utf8'), /FRAP_SSH_SERVIDOR_APP_PASSWORD="cl4ve \\"ssh\\""/);

  const t = await client.call('ssh.test', { id: 'servidor_app' });
  assert.equal(t.system, 'Linux falso 6.0');
  // formulario sin guardar con contraseña escrita
  assert.ok((await client.call('ssh.test', { host: { name: 'Nuevo', host: 'otro', user: 'u', password: 'x' } })).ms >= 0);

  const s = await client.call('ssh.connect', { id: 'servidor_app', cols: 80, rows: 24 });
  assert.equal(s.meta.kind, 'ssh');
  assert.equal(s.meta.sshId, 'servidor_app');
  const out = await client.waitOutput(s.sid, /HOSTKEY:\d/);
  assert.match(out, /-p 2222/);
  assert.match(out, /-- lector@10\.0\.0\.9/);
  assert.match(out, /PASS:cl4ve "ssh"/); // askpass la lee del .env por id
  assert.match(out, /HOSTKEY:1/); // otras preguntas no se responden
  await client.call('session.kill', { sid: s.sid }).catch(() => {});

  // ruta inicial: se guarda, se conserva al editar sin enviarla y ssh entra con cd antes de la shell
  const withDir = await client.call('ssh.save', { host: { id: 'servidor_app', name: 'Servidor App', host: '10.0.0.9', port: '2222', user: 'lector', password: null, dir: '/var/www/mi app/' } });
  assert.equal(withDir.dir, '/var/www/mi app');
  assert.equal((await client.call('ssh.save', { host: { id: 'servidor_app', name: 'Servidor App', host: '10.0.0.9', port: '2222', user: 'lector', password: null } })).dir, '/var/www/mi app');
  assert.match(fs.readFileSync(list.envFile, 'utf8'), /FRAP_SSH_SERVIDOR_APP_DIR="\/var\/www\/mi app"/);
  const sd = await client.call('ssh.connect', { id: 'servidor_app', cols: 80, rows: 24 });
  const outd = await client.waitOutput(sd.sid, /HOSTKEY:\d/);
  assert.match(outd, /-t -- lector@10\.0\.0\.9 cd '\/var\/www\/mi app' \|\|/);
  await client.call('session.kill', { sid: sd.sid }).catch(() => {});

  const off = await client.call('ssh.toggle', { id: 'servidor_app', enabled: false });
  assert.equal(off.enabled, false);
  await assert.rejects(client.call('ssh.connect', { id: 'servidor_app' }), /desactivado/);
  const ai = await client.call('ssh.toggle', { id: 'servidor_app', enabled: true, ai: true });
  assert.deepEqual([ai.enabled, ai.ai], [true, true]);

  const skills = await client.call('ssh.installSkill', { tools: ['claude'] });
  assert.match(fs.readFileSync(skills[0], 'utf8'), /frap-ssh\.js/);
  assert.equal((await client.call('ssh.list')).skills.claude, true);
  await client.call('ssh.delete', { id: 'servidor_app' });
  assert.equal((await client.call('ssh.list')).hosts.length, 0);
});

test('sftp.*: listar, subir, descargar, carpetas, renombrar, borrar y límites locales', { skip: !SFTP_SERVER || !HAS_SFTP }, async () => {
  await client.call('ssh.save', { host: { name: 'Archivos', host: '10.0.0.7', port: '2200', user: 'ops', password: 'pw "sftp"' } });
  const rem = path.join(root, 'remoto');
  const loc = path.join(root, 'proj', 'sftp-local');
  fs.mkdirSync(path.join(rem, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(loc, 'carpeta'), { recursive: true });
  fs.writeFileSync(path.join(rem, 'hola mundo.txt'), 'hola');
  fs.writeFileSync(path.join(loc, 'subir *.txt'), 'arriba');
  fs.writeFileSync(path.join(loc, 'carpeta', 'x.txt'), 'x');

  const l = await client.call('sftp.list', { id: 'archivos', path: rem });
  assert.equal(l.path, rem);
  assert.equal(l.parent, path.dirname(rem));
  assert.deepEqual(l.entries.map((e) => [e.name, e.dir]), [['sub', true], ['hola mundo.txt', false]]);
  const log = fs.readFileSync(path.join(root, 'sftp.log'), 'utf8');
  assert.match(log, /-oPort 2200/);
  assert.match(log, /-l ops/);
  assert.match(log, /pw "sftp"/); // la contraseña llega por askpass, no por argv
  assert.equal((await client.call('sftp.list', { id: 'archivos' })).path.length > 0, true); // sin ruta: carpeta de inicio
  // ruta inicial: sin path, abre ahí; si no existe, vuelve al home con startError
  await client.call('ssh.save', { host: { id: 'archivos', name: 'Archivos', host: '10.0.0.7', port: '2200', user: 'ops', password: null, dir: `${rem}/sub` } });
  const sl = await client.call('sftp.list', { id: 'archivos' });
  assert.equal(sl.path, path.join(rem, 'sub'));
  assert.equal(sl.startError, '');
  assert.equal((await client.call('sftp.list', { id: 'archivos', path: rem })).path, rem); // con path explícito manda el path
  await client.call('ssh.save', { host: { id: 'archivos', name: 'Archivos', host: '10.0.0.7', port: '2200', user: 'ops', password: null, dir: `${rem}/no existe` } });
  const nf = await client.call('sftp.list', { id: 'archivos' });
  assert.match(nf.startError, /no existe/);
  assert.notEqual(nf.path, `${rem}/no existe`);
  await client.call('ssh.save', { host: { id: 'archivos', name: 'Archivos', host: '10.0.0.7', port: '2200', user: 'ops', password: null, dir: '' } });

  await client.call('sftp.get', { id: 'archivos', remote: `${rem}/hola mundo.txt`, local: path.join(loc, 'bajado.txt') });
  assert.equal(fs.readFileSync(path.join(loc, 'bajado.txt'), 'utf8'), 'hola');
  await client.call('sftp.put', { id: 'archivos', local: path.join(loc, 'subir *.txt'), remote: `${rem}/sub/subir *.txt` });
  assert.equal(fs.readFileSync(path.join(rem, 'sub', 'subir *.txt'), 'utf8'), 'arriba');
  await client.call('sftp.put', { id: 'archivos', local: path.join(loc, 'carpeta'), remote: `${rem}/carpeta` });
  assert.equal(fs.readFileSync(path.join(rem, 'carpeta', 'x.txt'), 'utf8'), 'x');
  await client.call('sftp.get', { id: 'archivos', remote: `${rem}/sub`, local: path.join(loc, 'sub-bajada'), dir: true });
  assert.equal(fs.readFileSync(path.join(loc, 'sub-bajada', 'subir *.txt'), 'utf8'), 'arriba');

  await client.call('sftp.mkdir', { id: 'archivos', path: `${rem}/nueva` });
  await client.call('sftp.rename', { id: 'archivos', from: `${rem}/nueva`, to: `${rem}/renombrada` });
  assert.ok(fs.statSync(path.join(rem, 'renombrada')).isDirectory());
  await client.call('sftp.remove', { id: 'archivos', path: `${rem}/renombrada`, dir: true });
  await client.call('sftp.remove', { id: 'archivos', path: `${rem}/hola mundo.txt` });
  assert.deepEqual(fs.readdirSync(rem).sort(), ['carpeta', 'sub']);
  // nunca borra carpetas con contenido
  await assert.rejects(client.call('sftp.remove', { id: 'archivos', path: `${rem}/carpeta`, dir: true }), /./);
  assert.ok(fs.existsSync(path.join(rem, 'carpeta', 'x.txt')));

  // límites: local fuera de FRAP_FS_ROOT (también vía enlace simbólico), rutas remotas relativas o con saltos de línea
  await assert.rejects(client.call('sftp.get', { id: 'archivos', remote: `${rem}/sub/subir *.txt`, local: '/etc/frap-x' }), /fuera/);
  await assert.rejects(client.call('sftp.put', { id: 'archivos', local: '/etc/hostname', remote: `${rem}/h` }), /fuera/);
  fs.symlinkSync('/etc', path.join(loc, 'enlace'));
  await assert.rejects(client.call('sftp.put', { id: 'archivos', local: path.join(loc, 'enlace', 'hostname'), remote: `${rem}/h` }), /fuera/);
  await assert.rejects(client.call('sftp.get', { id: 'archivos', remote: `${rem}/sub/subir *.txt`, local: path.join(loc, 'enlace', 'x') }), /fuera/);
  await assert.rejects(client.call('sftp.list', { id: 'archivos', path: 'relativa' }), /inválida/);
  await assert.rejects(client.call('sftp.mkdir', { id: 'archivos', path: `${rem}/a\nput /etc/passwd /tmp/x` }), /inválida/);
  await assert.rejects(client.call('sftp.remove', { id: 'archivos', path: '/' }), /raíz/);
  assert.equal(await client.call('sftp.cancel', { tid: 'no-existe' }), false);

  await client.call('ssh.toggle', { id: 'archivos', enabled: false });
  await assert.rejects(client.call('sftp.list', { id: 'archivos', path: rem }), /desactivado/);
  await client.call('ssh.delete', { id: 'archivos' });
});

test('notes.*: skill frap-notes (estado e instalación) y NOTES.md con fs.write/fs.read', async () => {
  assert.deepEqual(await client.call('notes.skill'), { claude: false, codex: false });
  const files = await client.call('notes.installSkill', {});
  assert.deepEqual(files, [path.join(root, '.claude', 'skills', 'frap-notes', 'SKILL.md'), path.join(root, '.codex', 'skills', 'frap-notes', 'SKILL.md')]);
  const text = fs.readFileSync(files[0], 'utf8');
  assert.match(text, /^---\nname: frap-notes\ndescription: .*guarda esto en notas.*lee las notas/m);
  assert.match(text, /NOTES\.md/);
  assert.match(text, /\/NOTES\.md/); // indica el .gitignore
  assert.deepEqual(await client.call('notes.skill'), { claude: true, codex: true });
  assert.deepEqual(await client.call('notes.installSkill', { tools: ['nada'] }), []);
  // la vista edita NOTES.md con fs.*: dentro de FRAP_FS_ROOT sí, fuera no
  const notes = path.join(root, 'proj', 'NOTES.md');
  await client.call('fs.write', { path: notes, content: '# Notas\n' });
  assert.equal((await client.call('fs.read', { path: notes })).content, '# Notas\n');
  await assert.rejects(client.call('fs.write', { path: '/etc/NOTES.md', content: 'x' }), /fuera/);
});

test('voice.*: estado, transcripción con whisper.cpp (falso), limpieza del audio y validaciones', async () => {
  // sin binario ni modelo: no está listo y explica cómo instalarlo
  const st0 = await client.call('voice.status');
  assert.equal(st0.ready, false);
  assert.match(st0.install, /install-whisper\.sh/);
  assert.equal(st0.dir, path.join(root, 'cfg', 'whisper'));
  // WAV mínimo: cabecera de 44 bytes + 0,1 s de silencio a 16 kHz mono 16 bits
  const wav = Buffer.alloc(44 + 3200);
  wav.write('RIFF', 0, 'latin1'); wav.writeUInt32LE(36 + 3200, 4); wav.write('WAVE', 8, 'latin1');
  wav.write('fmt ', 12, 'latin1'); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'latin1'); wav.writeUInt32LE(3200, 40);
  const audio = wav.toString('base64');
  await assert.rejects(client.call('voice.transcribe', { audio }), /Falta whisper/);

  // whisper-cli falso: deja sus argumentos y si el archivo era un WAV, y responde como whisper.cpp con -nt
  const log = path.join(root, 'whisper.log');
  fs.writeFileSync(path.join(root, 'fakebin', 'whisper-cli'), `#!/bin/sh
echo "$*" > "${log}"
while [ $# -gt 0 ]; do [ "$1" = -f ] && head -c 4 "$2" >> "${log}"; shift; done
printf ' Hola mundo.\\n [BLANK_AUDIO]\\n Segunda línea.\\n'
`, { mode: 0o755 });
  fs.mkdirSync(path.join(root, 'cfg', 'whisper'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cfg', 'whisper', 'ggml-tiny.bin'), 'x');
  fs.writeFileSync(path.join(root, 'cfg', 'whisper', 'ggml-base.bin'), 'x');
  const st = await client.call('voice.status');
  assert.equal(st.ready, true);
  assert.equal(st.model, path.join(root, 'cfg', 'whisper', 'ggml-base.bin')); // base antes que tiny

  const r = await client.call('voice.transcribe', { audio, lang: 'es' });
  assert.equal(r.text, 'Hola mundo. Segunda línea.');
  const args = fs.readFileSync(log, 'utf8');
  assert.match(args, /-m \S+ggml-base\.bin -f (\S+voz\.wav) -l es -nt -np -t \d/);
  assert.match(args, /RIFF/); // recibió el WAV
  const tmpWav = args.match(/-f (\S+voz\.wav)/)[1];
  assert.equal(fs.existsSync(path.dirname(tmpWav)), false); // el audio se borra al terminar
  assert.equal((await client.call('voice.transcribe', { audio, lang: 'auto' })).text, 'Hola mundo. Segunda línea.');

  await assert.rejects(client.call('voice.transcribe', { audio, lang: 'es; rm -rf /' }), /Idioma inválido/);
  await assert.rejects(client.call('voice.transcribe', { audio: Buffer.from('no es audio').toString('base64') }), /WAV/);
  await assert.rejects(client.call('voice.transcribe', {}), /Sin audio/);
});

test('avisos de agentes: $FRAP_NOTIFY → evento notice, sessions.list lo incluye y session.seen lo borra', async () => {
  const s = await client.call('session.create', {
    cwd: root, cmd: ['/bin/sh', '-c', 'echo "waiting Claude espera tu respuesta" >> "$FRAP_NOTIFY"; sleep 0.3; echo done >> "$FRAP_NOTIFY"; sleep 5'],
  });
  const w = await client.waitFor((e) => e.ev === 'notice' && e.sid === s.sid && e.notice && e.notice.kind === 'waiting');
  assert.equal(w.notice.msg, 'Claude espera tu respuesta');
  await client.waitFor((e) => e.ev === 'notice' && e.sid === s.sid && e.notice && e.notice.kind === 'done');
  assert.equal((await client.call('sessions.list')).find((x) => x.sid === s.sid).notice.kind, 'done');
  await client.call('session.seen', { sid: s.sid });
  assert.equal((await client.call('sessions.list')).find((x) => x.sid === s.sid).notice, null);
  await client.call('session.kill', { sid: s.sid });
});

test('export.creds / import.creds: sin clave no salen contraseñas; con clave van cifradas y se restauran', async () => {
  await client.call('db.save', { conn: { name: 'Exp BD', engine: 'mysql', host: 'db.local', user: 'lector', password: 'pw-bd-1', ai: false } });
  await client.call('ssh.save', { host: { name: 'Exp SSH', host: '10.1.1.1', user: 'ops', password: 'pw-ssh-2', ai: true } });

  const plain = await client.call('export.creds', { db: ['exp_bd'], ssh: ['exp_ssh'] });
  assert.equal(plain.secrets, undefined);
  assert.equal(JSON.stringify(plain).includes('pw-'), false);
  assert.equal(plain.db[0].ai, false);

  await assert.rejects(client.call('export.creds', { db: ['exp_bd'], passphrase: '123' }), /al menos 6/);
  const sealed = await client.call('export.creds', { db: ['exp_bd'], ssh: ['exp_ssh'], passphrase: 'clave-larga' });
  assert.equal(JSON.stringify(sealed).includes('pw-'), false);
  assert.equal(sealed.secrets.alg, 'aes-256-gcm');

  // se borran y se importan de nuevo
  await client.call('db.delete', { id: 'exp_bd' });
  await client.call('ssh.delete', { id: 'exp_ssh' });
  await assert.rejects(client.call('import.creds', { ...sealed, passphrase: 'otra-clave' }), /Clave incorrecta/);
  const r = await client.call('import.creds', { ...sealed, passphrase: 'clave-larga' });
  assert.deepEqual([r.db, r.ssh, r.errors], [1, 1, []]);
  const cfg = path.join(root, 'cfg');
  assert.match(fs.readFileSync(path.join(cfg, 'databases.env'), 'utf8'), /FRAP_DB_EXP_BD_PASSWORD="pw-bd-1"/);
  assert.match(fs.readFileSync(path.join(cfg, 'ssh.env'), 'utf8'), /FRAP_SSH_EXP_SSH_PASSWORD="pw-ssh-2"/);
  assert.equal((await client.call('db.list')).conns.find((c) => c.id === 'exp_bd').ai, false);

  // sin clave: se importa y conserva la contraseña que ya había
  const again = await client.call('import.creds', { db: [{ ...sealed.db[0], host: 'db2.local' }], secrets: sealed.secrets });
  assert.equal(again.db, 1);
  const env = fs.readFileSync(path.join(cfg, 'databases.env'), 'utf8');
  assert.match(env, /FRAP_DB_EXP_BD_HOST="db2.local"/);
  assert.match(env, /FRAP_DB_EXP_BD_PASSWORD="pw-bd-1"/);
  // inválidos se reportan sin romper el resto
  const bad = await client.call('import.creds', { ssh: [{ id: 'malo', name: 'Malo', host: '-oProxyCommand=x', user: 'u' }] });
  assert.equal(bad.ssh, 0);
  assert.match(bad.errors[0], /Host inválido/);
  await client.call('db.delete', { id: 'exp_bd' });
  await client.call('ssh.delete', { id: 'exp_ssh' });
});

test('issues.* y local.*: carpeta local/issues, skill frap-issues, importar carpeta y zip de local/', async () => {
  const local = path.join(root, 'local');
  // crear: plantillas, id en mayúsculas, idempotente, id inválido
  const c = await client.call('issues.create', { id: 'ave-303', title: 'Visor | seguro\nde logs' });
  assert.equal(c.id, 'AVE-303');
  assert.equal(c.created, true);
  assert.equal(c.dir, path.join(local, 'issues', 'AVE-303'));
  assert.match(fs.readFileSync(path.join(c.dir, 'issue.md'), 'utf8'), /^# AVE-303 — Visor \| seguro de logs$/m);
  assert.ok(fs.existsSync(path.join(c.dir, 'changelog.md')) && fs.existsSync(path.join(c.dir, 'status.md')) && !fs.existsSync(path.join(c.dir, 'final.md')));
  assert.equal((await client.call('issues.create', { id: 'AVE-303' })).created, false);
  await assert.rejects(client.call('issues.create', { id: '../x-1' }), /inválido/);
  await assert.rejects(client.call('issues.create', { id: 'AVE-1/../../x' }), /inválido/);
  assert.match(fs.readFileSync(path.join(local, '.gitignore'), 'utf8'), /^\*$/m);
  // listar: estado, pendientes por enviar y cerrada
  fs.appendFileSync(path.join(c.dir, 'status.md'), '- Comentario de avance\n- [x] ya enviado\n- Pasar a In Review\n');
  await client.call('issues.create', { id: 'AVE-1', title: 'Otra' });
  fs.writeFileSync(path.join(local, 'issues', 'AVE-1', 'final.md'), '# Cierre');
  const l = await client.call('issues.list');
  const a = l.issues.find((i) => i.id === 'AVE-303');
  assert.equal(a.title, 'Visor | seguro de logs');
  assert.equal(a.estado, 'En curso');
  assert.equal(a.pending, 2);
  assert.equal(a.closed, false);
  assert.equal(l.issues.find((i) => i.id === 'AVE-1').closed, true);
  // CLI para agentes
  const { execFileSync } = require('child_process');
  const cli = (...args) => execFileSync(process.execPath, [path.join(__dirname, '..', 'bridge', 'frap-issues.js'), ...args], { env: { ...process.env, FRAP_LOCAL: local }, encoding: 'utf8' });
  assert.match(cli('new', 'ENG-7', 'Desde', 'la', 'CLI'), /Creada/);
  assert.match(cli('new', 'ENG-7'), /ya existe/);
  const lst = cli('list');
  assert.match(lst, /AVE-303\tactiva\tEn curso\t📤 2 por enviar\tVisor/);
  assert.doesNotMatch(lst, /AVE-1\t/);
  assert.match(cli('list', '--all'), /AVE-1\tcerrada/);
  // importar carpeta (acepta la que contiene "issues"), sin pisar existentes
  const old = path.join(root, 'harness');
  fs.mkdirSync(path.join(old, 'issues', 'AVE-9'), { recursive: true });
  fs.writeFileSync(path.join(old, 'issues', 'AVE-9', 'status.md'), '- **Estado general:** ✅ Terminada\n');
  fs.mkdirSync(path.join(old, 'issues', 'AVE-303'), { recursive: true });
  fs.mkdirSync(path.join(old, 'issues', '_plantillas'), { recursive: true });
  const imp = await client.call('issues.importDir', { path: old });
  assert.deepEqual(imp.copied, ['AVE-9']);
  assert.deepEqual(imp.skipped, ['AVE-303']);
  assert.match(fs.readFileSync(path.join(c.dir, 'issue.md'), 'utf8'), /Visor/); // no se pisó
  await assert.rejects(client.call('issues.importDir', { path: '/etc' }), /fuera/);
  // skill: se instala en claude y codex, se actualiza solo si cambió y se quita
  const on = await client.call('issues.setSkill', { on: true });
  assert.equal(on.changed.length, 2);
  const sk = await client.call('issues.skill');
  assert.ok(sk.claude.installed && sk.claude.current && sk.codex.current);
  const txt = fs.readFileSync(sk.claude.file, 'utf8');
  assert.match(txt, /^name: frap-issues$/m);
  assert.ok(txt.includes(path.join(local, 'issues')));
  assert.equal((await client.call('issues.setSkill', { on: true })).changed.length, 0);
  assert.equal((await client.call('issues.setSkill', { on: false })).changed.length, 2);
  assert.ok(!fs.existsSync(sk.claude.file) && !fs.existsSync(path.dirname(sk.claude.file)));
  // zip: exportar, restaurar sin pisar / pisando, rechazar rutas que salen de local/
  fs.writeFileSync(path.join(local, 'otra.txt'), Buffer.from([0, 1, 2, 255]));
  const ex = await client.call('local.export');
  assert.ok(ex.files >= 7 && ex.bytes > 0);
  const zbuf = Buffer.from(ex.data, 'base64');
  assert.equal(zbuf.readUInt32LE(0), 0x04034b50);
  const ents = issuesMod.unzip(zbuf);
  assert.ok(ents.some((e) => e.name === 'local/issues/AVE-303/issue.md'));
  assert.deepEqual([...ents.find((e) => e.name === 'local/otra.txt').data], [0, 1, 2, 255]);
  if (process.platform !== 'win32') {
    try { assert.match(require('child_process').execFileSync('unzip', ['-l', '-'], { input: zbuf }).toString(), /AVE-303/); } catch (e) { if (e.code !== 'ENOENT' && !/unzip/.test(String(e.message))) throw e; }
  }
  fs.writeFileSync(path.join(c.dir, 'status.md'), 'cambiado');
  fs.rmSync(path.join(local, 'issues', 'ENG-7'), { recursive: true });
  const r1 = await client.call('local.import', { data: ex.data });
  assert.ok(r1.written >= 3 && r1.skipped >= 3);
  assert.equal(fs.readFileSync(path.join(c.dir, 'status.md'), 'utf8'), 'cambiado');
  assert.ok(fs.existsSync(path.join(local, 'issues', 'ENG-7', 'issue.md')));
  await client.call('local.import', { data: ex.data, overwrite: true });
  assert.match(fs.readFileSync(path.join(c.dir, 'status.md'), 'utf8'), /Por enviar a Linear/);
  const evil = issuesMod.zip([{ name: '../escape.txt', data: Buffer.from('x') }, { name: '/abs.txt', data: Buffer.from('x') }, { name: 'local/ok.txt', data: Buffer.from('ok') }]);
  const r2 = await client.call('local.import', { data: evil.toString('base64') });
  assert.equal(r2.written, 2); // /abs.txt queda como local/abs.txt (sin "/" inicial)
  assert.deepEqual(r2.rejected, ['../escape.txt']);
  assert.ok(!fs.existsSync(path.join(root, 'escape.txt')));
  assert.equal(fs.readFileSync(path.join(local, 'ok.txt'), 'utf8'), 'ok');
  await assert.rejects(client.call('local.import', { data: Buffer.from('no es zip').toString('base64') }), /zip/);
});

test('tunnel.*: proveedor, puerta local (contraseña, Host, redirecciones, URLs, estáticos, WebSocket) y parar', async (t) => {
  const http = require('http');
  const net = require('net');
  // servidor "local" a compartir
  let port;
  const srv = http.createServer((req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: `http://localhost:${port}/destino` }); res.end(); return; }
    if (req.url === '/wp') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<a href="http://localhost:${port}/a">a</a> {"u":"http:\\/\\/localhost:${port}\\/b"}`); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ host: req.headers.host, url: req.url, auth: req.headers.authorization || null, xfh: req.headers['x-forwarded-host'] }));
  });
  srv.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`eco:${d}`));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  port = srv.address().port;
  t.after(async () => { // aunque falle: nada de servidores ni túneles colgados
    srv.close();
    if (srv.closeAllConnections) srv.closeAllConnections();
    for (const id of ['t1', 't2', 't3']) await client.call('tunnel.stop', { id }).catch(() => {});
  });
  const get = (url, headers = {}) => new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject);
  });

  const st = await client.call('tunnel.status');
  assert.ok(st.providers.cloudflared.path.endsWith('cloudflared'));
  assert.match(st.install, /install-cloudflared\.sh/);
  await assert.rejects(client.call('tunnel.start', { target: { type: 'url', url: String(port) }, provider: 'nada' }), /desconocido/);
  await assert.rejects(client.call('tunnel.start', { target: { type: 'path', path: '/etc' } }), /fuera/);

  // puerto local con contraseña y reescritura de URLs
  const t1 = await client.call('tunnel.start', { id: 't1', name: 'Mi app', target: { type: 'url', url: String(port) }, provider: 'cloudflared', password: 'clave', rewriteUrls: true });
  assert.equal(t1.status, 'starting');
  assert.equal(t1.target, `http://localhost:${port}`);
  const on = await client.waitFor((e) => e.ev === 'tunnel' && e.tunnel.id === 't1' && e.tunnel.status === 'online');
  assert.equal(on.tunnel.url, 'https://falso-tunel-123.trycloudflare.com');
  assert.ok(on.tunnel.log.some((l) => l.includes(`--url ${on.tunnel.localUrl}`)));
  const gw = on.tunnel.localUrl;
  const pub = { host: 'falso-tunel-123.trycloudflare.com' };
  assert.equal((await get(`${gw}/x`, pub)).status, 401);
  const basic = { ...pub, authorization: `Basic ${Buffer.from('cualquiera:clave').toString('base64')}` };
  const ok = JSON.parse((await get(`${gw}/x?y=1`, basic)).body);
  assert.equal(ok.host, `localhost:${port}`); // Host reescrito (Vite y similares)
  assert.equal(ok.url, '/x?y=1');
  assert.equal(ok.auth, null); // la contraseña del túnel no llega al servidor
  assert.equal(ok.xfh, 'falso-tunel-123.trycloudflare.com');
  assert.equal((await get(`${gw}/x`, { ...pub, authorization: `Basic ${Buffer.from('u:mala').toString('base64')}` })).status, 401);
  // enlace con clave: cookie y redirección sin la clave
  const k = await get(`${gw}/panel?frap_key=clave&a=1`, pub);
  assert.equal(k.status, 302);
  assert.equal(k.headers.location, '/panel?a=1');
  const cookie = k.headers['set-cookie'][0].split(';')[0];
  assert.equal((await get(`${gw}/x`, { ...pub, cookie })).status, 200);
  // redirecciones y contenido con localhost → URL pública
  assert.equal((await get(`${gw}/redir`, basic)).headers.location, 'https://falso-tunel-123.trycloudflare.com/destino');
  const wp = (await get(`${gw}/wp`, basic)).body;
  assert.ok(wp.includes('href="https://falso-tunel-123.trycloudflare.com/a"') && wp.includes('https:\\/\\/falso-tunel-123.trycloudflare.com\\/b'), wp);
  // WebSocket (HMR) pasa por la puerta
  const echo = await new Promise((resolve, reject) => {
    const u = new URL(gw);
    const so = net.connect(Number(u.port), '127.0.0.1', () => so.write(`GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nAuthorization: ${basic.authorization}\r\n\r\n`));
    let b = '';
    so.on('data', (d) => { b += d; if (b.includes('101') && !b.includes('eco:')) so.write('hola'); if (b.includes('eco:hola')) { so.destroy(); resolve(b); } });
    so.on('error', reject);
    setTimeout(() => reject(new Error('sin eco ws')), 3000);
  });
  assert.match(echo, /101 Switching/);
  const list = (await client.call('tunnel.status')).tunnels;
  assert.ok(list.find((x) => x.id === 't1').hits === 4);
  // servidor caído: 502 legible
  srv.close();
  const down = await get(`${gw}/x`, basic);
  assert.equal(down.status, 502);
  assert.match(down.body, /no contesta/);
  // parar: la puerta se cierra
  const stopped = await client.call('tunnel.stop', { id: 't1' });
  assert.equal(stopped.status, 'stopped');
  await assert.rejects(get(`${gw}/x`, basic));
  assert.ok(!(await client.call('tunnel.status')).tunnels.some((x) => x.id === 't1'));

  // archivo suelto: redirige a él, sirve su carpeta, nada de dotfiles ni salir de la raíz
  const site = path.join(root, 'sitio');
  fs.mkdirSync(path.join(site, 'img'), { recursive: true });
  fs.writeFileSync(path.join(site, 'demo.html'), '<h1>demo</h1>');
  fs.writeFileSync(path.join(site, 'img', 'a.svg'), '<svg/>');
  fs.writeFileSync(path.join(site, '.env'), 'SECRETO=1');
  await client.call('tunnel.start', { id: 't2', target: { type: 'path', path: path.join(site, 'demo.html') }, provider: 'cloudflared' });
  const on2 = await client.waitFor((e) => e.ev === 'tunnel' && e.tunnel.id === 't2' && e.tunnel.status === 'online');
  const g2 = on2.tunnel.localUrl;
  assert.equal((await get(`${g2}/`)).headers.location, '/demo.html');
  const page = await get(`${g2}/demo.html`);
  assert.equal(page.body, '<h1>demo</h1>');
  assert.match(page.headers['content-type'], /text\/html/);
  assert.equal((await get(`${g2}/img/a.svg`)).headers['content-type'], 'image/svg+xml');
  assert.equal((await get(`${g2}/.env`)).status, 404);
  assert.notEqual((await get(`${g2}/../../etc/passwd`)).body.includes('root:'), true);
  for (const evil of ['/%2e%2e/%2e%2e/etc/passwd', '/img/..%2f..%2f..%2fetc%2fpasswd', '/..%5c..%5cetc/passwd']) {
    const r = await get(`${g2}${evil}`);
    assert.ok([403, 404].includes(r.status) && !r.body.includes('root:'), `${evil} → ${r.status}`);
  }
  const listing = await get(`${g2}/img/`);
  assert.match(listing.body, /a\.svg/);
  await client.call('tunnel.stop', { id: 't2' });

  // localhost.run: la URL sale del JSON, no del banner (que menciona admin.localhost.run)
  const tun = require('../bridge/tunnels');
  assert.equal(tun.findUrl('localhostrun', 'To set up go to https://admin.localhost.run/\n'), null);
  assert.equal(tun.findUrl('localhostrun', 'banner https://admin.localhost.run/\n{"type":"run.localhost.tunnel.registered","data":{"address":"abc123.app.lhr.life"}}\n'), 'https://abc123.app.lhr.life');
  const thr = tun.providerEvent('{"type":"run.localhost.tunnel.throttled","data":{"message":"\\u001b[1mthrottled\\u001b[0m: bandwidth limit\\r\\nmore"}}');
  assert.equal(thr.text, '[throttled] throttled: bandwidth limit');
  assert.match(thr.warning, /limitando/);
  assert.equal(tun.providerEvent('{"type":"run.localhost.tunnel.notice","data":{"message":"hola"}}').warning, undefined);
  assert.equal(tun.providerEvent('texto normal'), null);
  assert.equal(tun.findUrl('cloudflared', 'INF |  https://a-b-c.trycloudflare.com  |'), 'https://a-b-c.trycloudflare.com');
  assert.equal(tun.findUrl('ngrok', '{"msg":"started tunnel","url":"https://x.ngrok-free.app"}'), 'https://x.ngrok-free.app');
  // el proveedor muere: estado error con su salida
  fs.writeFileSync(path.join(root, 'fakebin', 'ngrok'), '#!/bin/sh\necho "ERR_NGROK_4018 authentication failed" >&2\nexit 1\n', { mode: 0o755 });
  await client.call('tunnel.start', { id: 't3', target: { type: 'url', url: 'http://192.168.1.50:8080' }, provider: 'ngrok' });
  const err = await client.waitFor((e) => e.ev === 'tunnel' && e.tunnel.id === 't3' && e.tunnel.status === 'error');
  assert.match(err.tunnel.error, /ERR_NGROK_4018/);
  assert.equal(err.tunnel.target, 'http://192.168.1.50:8080');
  await client.call('tunnel.stop', { id: 't3' });
});

test('scripts.*: crear, listar, interruptores Usuario/IA, comando, CLI frap-scripts (run respeta IA y módulo) y skill', async () => {
  const { execFileSync, spawnSync } = require('child_process');
  const sdir = path.join(root, 'local', 'scripts');
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bridge', 'frap-scripts.js'), ...args], { env: { ...process.env, FRAP_LOCAL: path.join(root, 'local') }, encoding: 'utf8' });
  // crear con cabecera; nombre y ruta validados
  const c = await client.call('scripts.create', { path: 'AVE-7/1-contar.sh', desc: 'Cuenta los argumentos' });
  assert.equal(c.path, 'AVE-7/1-contar.sh');
  assert.ok(c.user && c.ai);
  assert.match(fs.readFileSync(c.abs, 'utf8'), /^#!\/usr\/bin\/env bash\n# Cuenta los argumentos\n/);
  fs.appendFileSync(c.abs, 'echo "args=$# cwd=$(pwd) primero=$1"\n');
  await assert.rejects(client.call('scripts.create', { path: 'AVE-7/1-contar.sh' }), /Ya existe/);
  await assert.rejects(client.call('scripts.create', { path: '../fuera.sh' }), /inválida/);
  await assert.rejects(client.call('scripts.create', { path: 'node_modules/x.js' }), /inválida/);
  await assert.rejects(client.call('scripts.create', { path: 'AVE-7/sin-extension' }), /Nombre inválido/);
  // listar: descripción, carpetas, salida/ y node_modules fuera, .sql no ejecutable
  fs.mkdirSync(path.join(sdir, 'AVE-7', 'salida'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'AVE-7', 'salida', 'r.csv'), 'a');
  fs.writeFileSync(path.join(sdir, 'AVE-7', 'salida', 'gen.ts'), '// generado');
  fs.mkdirSync(path.join(sdir, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(sdir, 'node_modules', 'pkg', 'index.js'), '//');
  fs.writeFileSync(path.join(sdir, 'AVE-7', '2-fix.sql'), '-- Corrige algo\nUPDATE x SET y=1;');
  fs.writeFileSync(path.join(sdir, 'comun.ts'), '/**\n * Utilidades compartidas\n */\nexport {}');
  const l = await client.call('scripts.list');
  assert.deepEqual(l.scripts.map((x) => x.path), ['comun.ts', 'AVE-7/1-contar.sh', 'AVE-7/2-fix.sql']);
  assert.equal(l.scripts[0].desc, 'Utilidades compartidas');
  assert.equal(l.scripts[1].desc, 'Cuenta los argumentos');
  assert.equal(l.scripts[2].runnable, false);
  assert.deepEqual(l.folders.find((f) => f.name === 'AVE-7'), { name: 'AVE-7', salida: 2, mtime: l.folders.find((f) => f.name === 'AVE-7').mtime });
  assert.ok(!l.folders.some((f) => f.name === 'node_modules'));
  // comando para la terminal de FRAP (con comillas si hace falta)
  const cmd = await client.call('scripts.command', { path: 'AVE-7/1-contar.sh' });
  assert.equal(cmd.cwd, sdir);
  assert.equal(cmd.line, 'bash AVE-7/1-contar.sh');
  await assert.rejects(client.call('scripts.command', { path: 'AVE-7/2-fix.sql' }), /no se ejecuta/);
  // CLI: run con argumentos desde local/scripts
  const r1 = cli('run', 'AVE-7/1-contar.sh', 'hola mundo', 'b');
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, new RegExp(`args=2 cwd=${sdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} primero=hola mundo`));
  assert.match(cli('list').stdout, /AVE-7\/1-contar\.sh\tusuario:sí\tIA:sí\tCuenta/);
  // interruptor IA apagado: la CLI se niega; Usuario apagado: FRAP no lo ejecuta
  assert.deepEqual(await client.call('scripts.set', { path: 'AVE-7/1-contar.sh', ai: false }), { path: 'AVE-7/1-contar.sh', user: true, ai: false });
  const r2 = cli('run', 'AVE-7/1-contar.sh');
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /no está habilitado para la IA/);
  assert.equal(r2.stdout, '');
  await client.call('scripts.set', { path: 'AVE-7/1-contar.sh', user: false, ai: true });
  await assert.rejects(client.call('scripts.command', { path: 'AVE-7/1-contar.sh' }), /Usuario/);
  assert.equal(cli('run', 'AVE-7/1-contar.sh', 'x').status, 0);
  // CLI new: registra el script
  const n = cli('new', 'tema-x/1-algo.py', 'Hace', 'algo');
  assert.equal(n.status, 0, n.stderr);
  assert.match(fs.readFileSync(path.join(sdir, 'tema-x', '1-algo.py'), 'utf8'), /^# Hace algo\n/);
  assert.equal(cli('run', '../../etc/passwd').status, 1);
  // módulo: skill y bloqueo de run
  const on = await client.call('scripts.setModule', { on: true });
  assert.equal(on.changed.length, 2);
  const sk = await client.call('scripts.skill');
  assert.ok(sk.claude.current && sk.codex.current);
  assert.ok(fs.readFileSync(sk.claude.file, 'utf8').includes(sdir));
  await client.call('scripts.setModule', { on: false });
  assert.ok(!fs.existsSync(sk.claude.file));
  const r3 = cli('run', 'AVE-7/1-contar.sh');
  assert.equal(r3.status, 1);
  assert.match(r3.stderr, /módulo Scripts está apagado/);
  assert.equal((await client.call('scripts.list')).enabled, false);
  await client.call('scripts.setModule', { on: true });
  assert.equal(cli('run', 'AVE-7/1-contar.sh', 'x').status, 0);
  // los interruptores viajan en el zip de local/ (y node_modules no)
  const ents = issuesMod.unzip(Buffer.from((await client.call('local.export')).data, 'base64')).map((e) => e.name);
  assert.ok(ents.includes('local/scripts/.frap-scripts.json'));
  assert.ok(ents.includes('local/scripts/AVE-7/1-contar.sh'));
  assert.ok(!ents.some((e) => e.includes('node_modules')));
  // borrar un script limpia su interruptor al listar
  fs.rmSync(path.join(sdir, 'tema-x', '1-algo.py'));
  await client.call('scripts.list');
  assert.ok(!('tema-x/1-algo.py' in JSON.parse(fs.readFileSync(path.join(sdir, '.frap-scripts.json'), 'utf8')).scripts));
  void execFileSync;
});
