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

const TOKEN = 'test-token-123';
let bridge;
let port;
let root;
let client;

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
  bridge = fork(path.join(__dirname, '..', 'bridge', 'frap-bridge.js'), [], {
    env: {
      ...process.env,
      FRAP_PORT: '0', FRAP_TOKEN: TOKEN, HOME: root, CLAUDECODE: '1', CLAUDE_CODE_CHILD_SESSION: '1', FRAP_HOME: path.join(root, 'cfg'),
      FRAP_FS_ROOT: root, FRAP_QUIET: '1', SHELL: '/bin/sh',
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
  assert.equal(info.version, '1.1.0');
  for (const op of ['db.list', 'db.save', 'git.run', 'music.ytInfo']) assert.ok(info.ops.includes(op), op);
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

test('fs: escribir/leer dentro de la raíz, rechazar fuera', async () => {
  const f = path.join(root, 'proj', 'nota.md');
  await client.call('fs.write', { path: f, content: 'hola' });
  assert.equal((await client.call('fs.read', { path: f })).content, 'hola');
  assert.equal(await client.call('fs.exists', { path: f }), true);
  const ls = await client.call('fs.list', { path: root });
  assert.ok(ls.entries.some((e) => e.name === 'proj' && e.dir));
  await assert.rejects(client.call('fs.read', { path: '/etc/passwd' }), /fuera/);
  await assert.rejects(client.call('fs.write', { path: path.join(root, '..', 'x') }), /fuera/);
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
      env: { ...process.env, FRAP_PORT: '0', FRAP_TOKEN: TOKEN, FRAP_HOME: home, FRAP_FS_ROOT: root, FRAP_QUIET: '1', SHELL: '/bin/sh', HOME: root },
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
