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

// ------------------------------------------------------------------ SFTP (gestor de archivos)
const sftp = require('../bridge/sftp');

/** sftp-server real del sistema (para probar el protocolo sin servidor ssh). */
function findSftpServer() {
  const fixed = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/libexec/sftp-server', '/usr/lib/ssh/sftp-server'];
  const snap = [];
  try {
    for (const c of fs.readdirSync('/snap')) {
      if (!/^core\d*$/.test(c)) continue;
      for (const v of fs.readdirSync(path.join('/snap', c))) snap.push(path.join('/snap', c, v, 'usr/lib/openssh/sftp-server'));
    }
  } catch (_) { /* sin snap */ }
  for (const f of [...fixed, ...snap]) {
    try { fs.accessSync(f, fs.constants.X_OK); if (spawnSync(f, ['-h']).error) continue; return f; } catch (_) { /* sigue */ }
  }
  return null;
}
const SFTP_SERVER = findSftpServer();
const hasSftp = !spawnSync('sftp', ['-h']).error;

test('sftpArgs: BatchMode=no antes de -b con contraseña, puerto -P y destino tras --', () => {
  const a = sftp.sftpArgs({ ...base, port: '2222', key: '/k', password: 'x' }, { sshBin: '/usr/bin/ssh' });
  assert.deepEqual(a.slice(0, 2), ['-S', '/usr/bin/ssh']);
  assert.deepEqual(a.slice(-4), ['-b', '-', '--', 'deploy@10.0.0.5']);
  assert.ok(a.indexOf('BatchMode=no') < a.indexOf('-b'), 'si va después, sftp fuerza BatchMode=yes y askpass no se usa');
  assert.deepEqual(a.slice(a.indexOf('-P'), a.indexOf('-P') + 2), ['-P', '2222']);
  assert.ok(a.includes('IdentitiesOnly=yes'));
  assert.equal(sftp.sftpArgs(base).includes('BatchMode=no'), false); // sin contraseña: llave/agente, sin preguntas
  for (const bad of [{ host: '-oProxyCommand=x' }, { user: '-l' }, { port: '22 -o' }, { key: '-oX' }]) {
    assert.throws(() => sftp.sftpArgs({ ...base, ...bad }), /inválid/, JSON.stringify(bad));
  }
});

test('sftp: escape de rutas, rutas remotas absolutas y parseo de ls -la', () => {
  assert.equal(sftp.quote('/a b/c*"d\'\\e[1]?#'), '/a\\ b/c\\*\\"d\\\'\\\\e\\[1\\]\\?\\#');
  for (const bad of ['', 'a\nrm -rf /', 'x\r', 'x\0']) assert.throws(() => sftp.quote(bad), /inválida/);
  assert.equal(sftp.remotePath('/var/www/../log/./x/'), '/var/log/x');
  assert.equal(sftp.remotePath('/..'), '/');
  for (const bad of ['relativa', '-R', '~/x', '', '/a\nput /etc/passwd /x']) assert.throws(() => sftp.remotePath(bad), /inválida/);
  const out = [
    'sftp> ls -la',
    'drwxr-xr-x    3 www  www      4096 Nov 20 14:57 .',
    'drwxr-xr-x    9 root root     4096 Jan  2  2023 ..',
    '-rw-r--r--    1 www  www   1048576 Nov 20 14:57 a b*.txt',
    'lrwxrwxrwx    1 www  www        11 Nov 20 14:57 actual',
    'drwxr-x---    2 www  www      4096 Mar  5  2024 logs',
  ].join('\n');
  assert.deepEqual(sftp.parseLs(out).map((e) => [e.name, e.dir, e.link, e.size, e.mtime]), [
    ['logs', true, false, 4096, 'Mar 5 2024'],
    ['a b*.txt', false, false, 1048576, 'Nov 20 14:57'],
    ['actual', false, true, 11, 'Nov 20 14:57'],
  ]);
  assert.match(sftp.sftpError('Warning: Permanently added x\nremote open("/x"): No such file or directory\nConnection closed\n', 1), /No such file/);
});

test('sftp real (sftp-server local): listar, subir, descargar, renombrar y borrar con nombres raros', { skip: !SFTP_SERVER || !hasSftp }, async () => {
  const dir = path.join(root, 'sftp');
  const bin = path.join(dir, 'bin');
  const rem = path.join(dir, 'remoto');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(rem);
  // ssh falso: ignora el destino y conecta sftp con el sftp-server local
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nexec ${SFTP_SERVER}\n`, { mode: 0o755 });
  const c = { ...base, id: 'local' };
  const run = (lines) => sftp.runSftp(c, lines, { sshBin: path.join(bin, 'ssh'), timeoutMs: 15000 });
  const q = sftp.quote;
  const raro = 'a*b x\'"q\\z#[1]?';
  const local = path.join(dir, `local ${raro}`);
  fs.writeFileSync(local, 'contenido');
  fs.writeFileSync(path.join(rem, 'axb'), 'no tocar'); // el comodín de "a*b" no debe alcanzarlo

  let r = await run([`mkdir ${q(`${rem}/${raro}`)}`, `put ${q(local)} ${q(`${rem}/${raro}/f ${raro}`)}`, `cd ${q(`${rem}/${raro}`)}`, 'pwd', 'ls -la']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Remote working directory: ${rem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/a\\*b`));
  assert.deepEqual(sftp.parseLs(r.stdout).map((e) => [e.name, e.size]), [[`f ${raro}`, 9]]);

  r = await run([`rename ${q(`${rem}/${raro}/f ${raro}`)} ${q(`${rem}/${raro}/g`)}`, `get -R ${q(`${rem}/${raro}`)} ${q(path.join(dir, 'bajada'))}`]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'bajada', 'g'), 'utf8'), 'contenido');

  r = await run([`rm ${q(`${rem}/a*b`)}`]); // no existe un archivo llamado literalmente "a*b": falla y axb sigue
  assert.notEqual(r.code, 0);
  assert.equal(fs.readFileSync(path.join(rem, 'axb'), 'utf8'), 'no tocar');
  r = await run([`rm ${q(`${rem}/${raro}/g`)}`, `rmdir ${q(`${rem}/${raro}`)}`]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(rem), ['axb']);
});
