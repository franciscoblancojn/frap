'use strict';
// Integración WordPress: conexiones a sitios con el plugin frap-wordpress (integrations/wordpress/frap-wordpress).
// Cada conexión es URL + token (temporal, con permisos por recurso que se configuran en el sitio).
// Los tokens solo viven en FRAP_HOME/wordpress.env (0600), igual que las contraseñas de BD: nunca en la UI.
// Solo librería estándar de Node.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const db = require('./db');
const { isPrivateHost } = require('./tunnels');

const FIELDS = ['NAME', 'URL', 'TOKEN', 'ENABLED', 'AI'];
const MAX_BYTES = 20 * 1024 * 1024;
const NAMESPACE = 'frap/v1';
const CLI = path.join(__dirname, 'frap-wp.js');

/**
 * Conexiones "URL + token + interruptores" en un .env (0600) con el prefijo dado (FRAP_WP_, FRAP_AVE_…).
 * La comparten la integración WordPress y la de Aveonline.
 */
function envStore(prefix, header) {
  const keyRe = new RegExp(`^${prefix}([A-Z0-9_]+?)_(${FIELDS.join('|')})$`);
  function load(envFile) {
    let text = '';
    try { text = fs.readFileSync(envFile, 'utf8'); } catch (_) { return []; }
    const byId = new Map();
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (!m) continue;
      const k = m[1].match(keyRe);
      if (!k) continue;
      const id = k[1].toLowerCase();
      if (!byId.has(id)) byId.set(id, { id });
      byId.get(id)[k[2]] = db.parseEnvValue(m[2]);
    }
    return [...byId.values()].map((c) => ({
      id: c.id,
      name: c.NAME || c.id,
      url: c.URL || '',
      token: c.TOKEN || '',
      enabled: !db.isOff(c.ENABLED),
      ai: !db.isOff(c.AI),
    }));
  }
  function save(envFile, sites) {
    const lines = [...header, '# Contiene tokens: no lo subas a git ni lo compartas.', ''];
    for (const c of sites) {
      const p = `${prefix}${c.id.toUpperCase()}_`;
      lines.push(`# --- ${c.name} — id: ${c.id}`);
      lines.push(`${p}NAME=${db.quoteEnvValue(c.name)}`);
      lines.push(`${p}URL=${db.quoteEnvValue(c.url)}`);
      lines.push(`${p}TOKEN=${db.quoteEnvValue(c.token)}`);
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
  return { load, save };
}

const wpStore = envStore('FRAP_WP_', [
  '# FRAP — integración WordPress (plugin frap-wordpress en cada sitio).',
  '# Se gestiona desde FRAP (panel izquierdo → Integraciones → WordPress); se puede editar a mano.',
  '# Los agentes (claude, codex, opencode) usan las que tienen ENABLED=1 y AI=1, con los permisos del token, a través de:',
  `#   node ${CLI} <id> info`,
]);
const loadSites = wpStore.load;
const saveSites = wpStore.save;

/** Sin token: lo que puede ver la UI. */
function publicSite(c) {
  const { token, ...rest } = c;
  return { ...rest, hasToken: !!token, tokenHint: token ? token.slice(-4) : '' };
}

/** URL base del sitio: http(s), sin barra final ni /wp-json, /wp-admin o /wp-login.php. */
function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) throw new Error('La URL del sitio es obligatoria');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) && !/^https?:\/\//i.test(u)) throw new Error('La URL debe ser http o https');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  let parsed;
  try { parsed = new URL(u); } catch (_) { throw new Error(`URL inválida: ${raw}`); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('La URL debe ser http o https');
  if (parsed.username || parsed.password) throw new Error('La URL no puede llevar usuario ni contraseña');
  let p = parsed.pathname.replace(/\/+(wp-json|wp-admin|wp-login\.php)(\/.*)?$/i, '').replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${p}`;
}

/** Ruta de la API: info, posts, posts/12, products/3/variations… (solo letras, _, / y números). */
function checkPath(p) {
  const s = String(p || '').replace(/^\/+|\/+$/g, '');
  if (!/^[a-z_]+(\/\d+(\/[a-z_]+(\/\d+)?)?)?$/.test(s)) throw new Error(`Ruta inválida: ${p} (ej.: info, posts, posts/12, products/3/variations)`);
  return s;
}

/**
 * Petición a la API del plugin. Usa ?rest_route= para funcionar también sin enlaces permanentes.
 * Devuelve {status, data, total, totalPages, ms}. En sitios locales o de red privada acepta certificados propios.
 */
function request(site, method, apiPath, { query = {}, body, timeoutMs = 30000 } = {}) {
  return restRequest(site.url, `/${NAMESPACE}/${checkPath(apiPath)}`, {
    method, query, body, timeoutMs,
    headers: { 'X-Frap-Token': site.token },
    notApi: 'La respuesta no es de la API de FRAP: ¿la URL es la del sitio y el plugin frap-wordpress está activo?',
  });
}

/**
 * Petición JSON a la API REST de un WordPress por ?rest_route= (funciona sin enlaces permanentes).
 * `notApi`: el mensaje si responde HTML (URL equivocada o plugin inactivo). La usan WordPress y Aveonline.
 */
function restRequest(siteUrl, route, { method = 'GET', query = {}, body, timeoutMs = 30000, headers: extra = {}, notApi } = {}) {
  const base = new URL(`${normalizeUrl(siteUrl)}/`);
  base.searchParams.set('rest_route', route);
  for (const [k, v] of Object.entries(query || {})) {
    if (v == null || k === 'rest_route') continue;
    base.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const m = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) throw new Error(`Método no soportado: ${method}`);
  const payload = body === undefined || m === 'GET' ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const lib = base.protocol === 'https:' ? https : http;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = lib.request(base, {
      method: m,
      headers: {
        ...extra,
        Accept: 'application/json',
        'User-Agent': 'FRAP',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
      rejectUnauthorized: !isPrivateHost(base.hostname),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(new Error('Respuesta demasiado grande (más de 20 MB)')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = text ? JSON.parse(text) : null; } catch (_) {
          // HTML u otra cosa: casi siempre el plugin no está instalado o la URL no es la del sitio
          const hint = res.statusCode === 404 || /<html/i.test(text)
            ? notApi || 'La respuesta no es de la API REST de WordPress: ¿la URL es la del sitio?'
            : `Respuesta inválida (${res.statusCode})`;
          reject(Object.assign(new Error(hint), { status: res.statusCode }));
          return;
        }
        resolve({
          status: res.statusCode,
          data,
          total: res.headers['x-wp-total'] != null ? Number(res.headers['x-wp-total']) : undefined,
          totalPages: res.headers['x-wp-totalpages'] != null ? Number(res.headers['x-wp-totalpages']) : undefined,
          ms: Date.now() - t0,
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Sin respuesta en ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', (e) => reject(new Error(e.code === 'ENOTFOUND' ? `No se encuentra el sitio (${base.hostname})` : e.code === 'ECONNREFUSED' ? `Conexión rechazada (${base.host})` : e.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Error legible de una respuesta de la API ({code, message}) o del estado HTTP. */
function apiError(r) {
  const msg = r.data && typeof r.data === 'object' && r.data.message ? r.data.message : `HTTP ${r.status}`;
  return Object.assign(new Error(msg), { status: r.status, code: r.data && r.data.code });
}

/** GET /info: comprueba la conexión. {site, name, plugin, wordpress, woocommerce, now, token, resources, ms} */
async function info(site) {
  if (!site.token) throw new Error('La conexión no tiene token');
  const r = await request(site, 'GET', 'info', { timeoutMs: 15000 });
  if (r.status !== 200) throw apiError(r);
  return { ...r.data, ms: r.ms };
}

// ---------- skill frap-wordpress ----------
const SKILL_MARK = 'frap-wordpress (FRAP)';
function skillText() {
  const cli = `node ${CLI}`;
  return `---
name: frap-wordpress
description: Trabajar con sitios WordPress conectados a FRAP (plugin frap-wordpress): ver, crear o editar páginas, entradas, productos de WooCommerce, medios, categorías y más, con los permisos del token de cada sitio. Úsala cuando el usuario pida algo sobre el contenido de un sitio WordPress.
---

<!-- ${SKILL_MARK}: la instala y la quita FRAP con el módulo Integraciones -->

# Sitios WordPress de FRAP

Los sitios los conecta el usuario en FRAP (Integraciones → WordPress). Cada sitio tiene un token temporal
(24 h por defecto) con permisos por recurso que se configuran en el propio WordPress (FRAP → Tokens): por defecto
solo lectura. Accede **solo** con este CLI, que nunca muestra el token:

\`\`\`bash
${cli} list                                       # sitios disponibles (activos y con "IA")
${cli} <id> info                                  # sitio, versiones, vencimiento y qué permite el token
${cli} <id> get <recurso>[/<id>] [clave=valor …]   # ver o listar (parámetros de la API de WordPress)
${cli} <id> create <recurso> '<json>'              # crear      (o el JSON por stdin con "-")
${cli} <id> update <recurso>/<id> '<json>'         # editar
${cli} <id> delete <recurso>/<id> [force=true]     # a la papelera (force=true borra del todo)
\`\`\`

Recursos: posts, pages, media, categories, tags, comments, users, plugins y, con WooCommerce, products
(y products/<id>/variations), product_categories, coupons, orders, customers. \`info\` dice cuáles existen y qué
acciones permite el token en cada uno.

Parámetros útiles al listar: \`search=…\`, \`per_page=20\`, \`page=2\`, \`status=draft\`, \`_fields=id,title,link\`
(pide solo los campos que necesites: las respuestas de WordPress son grandes). Los campos para crear o editar son
los de la API REST de WordPress (\`/wp/v2\`) o WooCommerce (\`/wc/v3\`): p. ej. una entrada \`{"title": "…", "content": "…", "status": "draft"}\`,
un producto \`{"regular_price": "19900"}\`.

## Reglas
- Empieza con \`info\` para saber qué permite el token. Si una acción da 403, el token no tiene ese permiso:
  díselo al usuario (se cambia en WordPress → FRAP → Tokens). Si da 401 "vencido", pídele que lo renueve allá.
- **Antes de crear, editar o eliminar**, muestra al usuario qué vas a cambiar (recurso, id y campos) y espera su visto bueno,
  salvo que él mismo haya pedido ese cambio concreto. Lo nuevo, mejor como borrador (\`"status": "draft"\`) salvo que pida publicarlo.
- Eliminar va a la papelera; \`force=true\` solo si el usuario lo pide explícitamente.
- No copies datos personales (clientes, pedidos, usuarios) a archivos ni a otras herramientas sin que el usuario lo pida.
- Si trabajas una issue (skill frap-issues), anota en su changelog qué cambiaste en qué sitio (recurso, id y qué).
- Si la conexión que necesitas está apagada o sin "IA", pídele al usuario que la active en FRAP: no edites \`wordpress.env\`.
`;
}
/** Skill de una integración en claude y codex: {status, set}. Solo quita la que lleva la marca de FRAP. */
function skillManager(name, mark, text) {
  const dirs = {
    claude: () => path.join(os.homedir(), '.claude', 'skills', name),
    codex: () => path.join(os.homedir(), '.codex', 'skills', name),
  };
  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } };
  return {
    status() {
      const out = {};
      for (const [k, dir] of Object.entries(dirs)) {
        const file = path.join(dir(), 'SKILL.md');
        const txt = read(file);
        out[k] = { installed: txt != null, current: txt === text(), file };
      }
      return out;
    },
    /** Instala/actualiza (on) o quita (off, solo si es la de FRAP). */
    set(on) {
      const changed = [];
      for (const dir of Object.values(dirs)) {
        const file = path.join(dir(), 'SKILL.md');
        const txt = read(file);
        if (on) {
          if (txt !== text()) { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(file, text()); changed.push(file); }
        } else if (txt != null && txt.includes(mark)) {
          fs.rmSync(dir(), { recursive: true, force: true });
          changed.push(file);
        }
      }
      return { on: !!on, changed };
    },
  };
}
const wpSkill = skillManager('frap-wordpress', SKILL_MARK, skillText);
const skillStatus = () => wpSkill.status();
const setSkill = (on) => wpSkill.set(on);

module.exports = {
  NAMESPACE, CLI,
  FIELDS, envStore, restRequest, skillManager,
  loadSites, saveSites, publicSite, normalizeUrl, checkPath, request, apiError, info,
  skillText, skillStatus, setSkill,
};
