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
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  port = await new Promise((resolve, reject) => {
    bridge.on('message', (m) => m.ready && resolve(m.port));
    bridge.on('exit', (c) => reject(new Error(`bridge salió con ${c}`)));
  });
  client = rpcClient(await ws.connect(port, `/?token=${TOKEN}`, { Origin: 'null' }));
});

test.after(() => {
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
  assert.equal(info.version, '1.0.0');
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
