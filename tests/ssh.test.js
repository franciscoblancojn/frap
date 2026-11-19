'use strict';
// Tests de bridge/ssh.js, del askpass y del CLI frap-ssh (con un ssh falso: no hay servidor real).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ssh = require('../bridge/ssh');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frap-ssh-test-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const base = { host: '10.0.0.5', port: '', user: 'deploy', password: '', key: '', enabled: true, ai: true };

test('.env: guardar y leer conserva caracteres especiales; ENABLED/AI faltantes valen 1', () => {
  const env = path.join(root, 'cfg', 'ssh.env');
  const hosts = [
    { ...base, id: 'web', name: 'Web "prod"', port: '2222', password: 'p@ss "x" \\ $HOME #no', ai: false },
    { ...base, id: 'bd', name: 'BD', key: '/home/u/.ssh/id_ed25519', enabled: false },
  ];
  ssh.saveHosts(env, hosts, '/x/frap-ssh.js');
  assert.deepEqual(ssh.loadHosts(env), hosts);
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
  assert.equal(ssh.publicHost(hosts[0]).password, undefined);
  assert.equal(ssh.publicHost(hosts[0]).hasPassword, true);
  const old = path.join(root, 'old.env');
  fs.writeFileSync(old, 'FRAP_SSH_A_HOST=h\nFRAP_SSH_A_USER=u\n');
  const [a] = ssh.loadHosts(old);
  assert.deepEqual([a.enabled, a.ai], [true, true]);
});

test('sshArgs: opciones seguras y sin inyección', () => {
  const a = ssh.sshArgs({ ...base, port: '2222', key: '/k', password: 'x' }, { command: 'uptime' });
  assert.deepEqual(a.slice(-3), ['--', 'deploy@10.0.0.5', 'uptime']);
  assert.ok(a.includes('StrictHostKeyChecking=accept-new'));
  assert.ok(a.includes('NumberOfPasswordPrompts=1'));
  assert.ok(a.includes('-T'));
  assert.deepEqual(a.slice(a.indexOf('-i'), a.indexOf('-i') + 2), ['-i', '/k']);
  // sin contraseña en modo batch: nunca pregunta
  assert.ok(ssh.sshArgs(base, { command: 'x', batch: true }).includes('BatchMode=yes'));
  // interactivo: sin -T ni comando
  const i = ssh.sshArgs(base);
  assert.equal(i.includes('-T'), false);
  assert.equal(i[i.length - 1], 'deploy@10.0.0.5');
  for (const bad of [{ host: '-oProxyCommand=x' }, { host: 'a b' }, { user: '-l' }, { user: '' }, { port: '22; rm' }, { key: '-oX' }]) {
    assert.throws(() => ssh.sshArgs({ ...base, ...bad }), /inválid/, JSON.stringify(bad));
  }
});

test('sshHint reconoce errores comunes', () => {
  assert.match(ssh.sshHint('deploy@h: Permission denied (publickey,password).'), /contraseña/);
  assert.match(ssh.sshHint('ssh: connect to host h port 22: Connection timed out'), /VPN/);
  assert.match(ssh.sshHint('ssh: connect to host h port 22: Connection refused'), /puerto/);
  assert.equal(ssh.sshHint('otra cosa'), '');
});

test('askpass: responde solo a contraseñas, por id o por FRAP_SSH_PASS', () => {
  const home = path.join(root, 'ap');
  const env = path.join(home, 'ssh.env');
  ssh.saveHosts(env, [{ ...base, id: 'web', name: 'Web', password: 'secreta' }]);
  const ap = ssh.askpassPath(home);
  assert.equal(fs.statSync(ap).mode & 0o777, 0o700);
  const run = (prompt, extra) => spawnSync(ap, [prompt], { encoding: 'utf8', env: { ...process.env, FRAP_SSH_ENV: env, ...extra } });
  assert.equal(run("deploy@h's password: ", { FRAP_SSH_ID: 'web' }).stdout, 'secreta\n');
  assert.equal(run('Enter passphrase for key', { FRAP_SSH_ID: 'web' }).stdout, 'secreta\n');
  assert.equal(run('Password:', { FRAP_SSH_PASS: 'del-formulario' }).stdout, 'del-formulario\n');
  const hk = run('Are you sure you want to continue connecting (yes/no/[fingerprint])?', { FRAP_SSH_ID: 'web' });
  assert.equal(hk.status, 1);
  assert.equal(hk.stdout, '');
  assert.equal(run('password:', { FRAP_SSH_ID: 'nope' }).status, 1);
});

test('CLI frap-ssh: solo servidores activos con uso por IA, ejecuta y propaga el código', () => {
  const home = path.join(root, 'cli');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
for last; do :; done
echo "ARGS:$*"
[ -n "$SSH_ASKPASS" ] && echo "PASS:$("$SSH_ASKPASS" "password:")"
case "$last" in *falla*) echo "boom" >&2; exit 3;; esac
exit 0
`, { mode: 0o755 });
  ssh.saveHosts(path.join(home, 'ssh.env'), [
    { ...base, id: 'web', name: 'Web', password: 'no-mostrar' },
    { ...base, id: 'privado', name: 'Privado', ai: false },
    { ...base, id: 'apagado', name: 'Apagado', enabled: false },
  ]);
  const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'bridge', 'frap-ssh.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, FRAP_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  const l = cli('list');
  assert.equal(l.status, 0);
  assert.match(l.stdout, /web/);
  assert.doesNotMatch(l.stdout, /privado|apagado|no-mostrar/);

  const r = cli('web', 'uptime');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /-T -- deploy@10\.0\.0\.5 uptime/);
  assert.match(r.stdout, /PASS:no-mostrar/); // solo dentro de ssh, vía askpass
  const f = cli('web', 'algo que falla');
  assert.equal(f.status, 3);
  assert.match(f.stderr, /boom/);

  assert.match(cli('privado', 'id').stderr, /no está habilitado para agentes/);
  assert.match(cli('apagado', 'id').stderr, /desactivado/);
  assert.match(cli('nope', 'id').stderr, /no existe/);
  assert.notEqual(cli('web').status, 0);
});
