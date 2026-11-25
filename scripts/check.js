#!/usr/bin/env node
'use strict';
// Chequeos estáticos sin dependencias: sintaxis JS/Python y reglas del proyecto
// (src/ debe funcionar abriendo index.html como file://).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failed = 0;
const fail = (msg) => { failed++; console.error(`✗ ${msg}`); };
const ok = (msg) => console.log(`✓ ${msg}`);

// 1. Sintaxis JS
for (const f of ['src/index.js', 'bridge/frap-bridge.js', 'bridge/ws.js', 'bridge/db.js', 'bridge/frap-db.js', 'bridge/ssh.js', 'bridge/frap-ssh.js', 'bridge/frap-askpass.js', 'bridge/wordpress.js', 'bridge/frap-wp.js', 'bridge/aveonline.js', 'bridge/frap-ave.js', 'bridge/api.js', 'bridge/frap-api.js', 'bridge/team.js', 'bridge/frap-team.js', 'scripts/check.js', 'tests/bridge.test.js', 'tests/db.test.js', 'tests/ssh.test.js']) {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); ok(`sintaxis ${f}`); } catch (e) { fail(`sintaxis ${f}\n${e.stderr}`); }
}

// 2. Sintaxis Python
try {
  execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', path.join(ROOT, 'bridge/frap_pty.py')], { stdio: 'pipe' });
  ok('sintaxis bridge/frap_pty.py');
} catch (e) { fail(`sintaxis bridge/frap_pty.py\n${e.stderr}`); }

// 3. Reglas de src/
const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');

if (/type=["']module["']/.test(html)) fail('index.html no puede usar <script type="module"> (falla en file://)');
else ok('sin módulos ES en index.html');

const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map((m) => m[1]);
const remote = refs.filter((r) => /^(https?:)?\/\//.test(r));
if (remote.length) fail(`recursos remotos en index.html (deben estar en src/vendor): ${remote.join(', ')}`);
else ok('todos los recursos son locales');
for (const r of refs) {
  if (!fs.existsSync(path.join(ROOT, 'src', r))) fail(`index.html referencia ${r}, que no existe`);
}

if (/\bimport\s*\(|^\s*import\s.+from\s/m.test(js) || /^\s*export\s/m.test(js)) fail('src/index.js no puede usar import/export');
else ok('src/index.js es script clásico');

if (/\.innerHTML\s*=/.test(js)) fail('src/index.js usa innerHTML (usa h()/textContent para evitar XSS con contenido de archivos)');
else ok('sin innerHTML');

if (/\bfetch\s*\(\s*['"`]https?:/.test(js)) fail('src/index.js hace fetch a red externa');

if (failed) { console.error(`\n${failed} chequeo(s) fallaron`); process.exit(1); }
console.log('\nchequeos estáticos OK');
