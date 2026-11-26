'use strict';
// Integración Aveonline: tiendas con los envíos de Aveonline y su "Revisión por token". Dos tipos:
//  - WordPress (WooCommerce + plugin Aveonline → Revisión por token): rutas aveonline/v1/review/{info,log,orders,order/<id>}.
//  - Shopify (app Aveonline Connect → Revisión por token): <app>/api/revision/{log,pedido}?shop=<tienda>.myshopify.com.
// Es de solo lectura: log, pedidos y tramas de cotización y guía. El token es uno por tienda, de corta vida
// (10 min por defecto, máx. 24 h). Los tokens solo viven en FRAP_HOME/aveonline.env (0600): nunca en la UI ni en la
// salida del CLI. Reutiliza el almacén y el cliente HTTP de la integración WordPress. Solo librería estándar de Node.

const path = require('path');
const wp = require('./wordpress');

const NAMESPACE = 'aveonline/v1';
const HEADER = 'X-Avshme-Token';
const CLI = path.join(__dirname, 'frap-ave.js');
const NOT_API = 'La respuesta no es de la revisión por token de Aveonline: ¿la URL es la de la tienda y el plugin Aveonline (4.11.4 o más nuevo) está activo?';
const NOT_SHOPIFY = 'La respuesta no es de la revisión por token de la app Aveonline Connect: ¿la URL de la app es correcta?';

// En Shopify la URL es la de la app (por defecto la de producción) y la tienda va aparte (xxx.myshopify.com).
const TYPES = ['wordpress', 'shopify'];
const SHOPIFY_APP_URL = 'https://connect-crm-s.aveonline.co';
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const store = wp.envStore('FRAP_AVE_', [
  '# FRAP — integración Aveonline (revisión por token: plugin de WordPress o app de Shopify, en cada tienda).',
  '# Se gestiona desde FRAP (panel izquierdo → Integraciones → Aveonline); se puede editar a mano.',
  '# TYPE=shopify: URL es la de la app Aveonline Connect, SHOP el dominio xxx.myshopify.com y DOMAIN el propio de la tienda.',
  '# Los agentes (claude, codex, opencode) usan las que tienen ENABLED=1 y AI=1 (solo lectura) a través de:',
  `#   node ${CLI} <id> info`,
], [{ key: 'TYPE', prop: 'type', def: 'wordpress' }, { key: 'SHOP', prop: 'shop' }, { key: 'DOMAIN', prop: 'domain' }]);

/** Dominio de una tienda Shopify: «mitienda», «mitienda.myshopify.com», su URL, la del admin o un ?shop= → mitienda.myshopify.com */
function normalizeShop(raw) {
  let t = String(raw || '').trim().toLowerCase();
  if (!t) throw new Error('Falta la tienda de Shopify (mitienda.myshopify.com)');
  const q = t.match(/[?&]shop=([a-z0-9.-]+)/);
  if (q) t = q[1];
  const adm = t.match(/admin\.shopify\.com\/store\/([a-z0-9-]+)/);
  if (adm) t = adm[1];
  t = t.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  if (!t.includes('.')) t = `${t}.myshopify.com`;
  if (!SHOP_RE.test(t)) throw new Error(`Tienda de Shopify inválida: ${raw} (se espera mitienda.myshopify.com)`);
  return t;
}

/**
 * Tienda de Shopify a partir de lo que escriba el usuario: si ya es xxx.myshopify.com (o la URL del admin) se usa tal
 * cual; si es el dominio propio de la tienda (p. ej. https://mitienda.com) se pregunta a Shopify por su
 * /meta.json público (`myshopify_domain`). → {shop, domain} (domain = el dominio propio, o '')
 */
async function resolveShop(raw) {
  try { return { shop: normalizeShop(raw), domain: '' }; } catch (_) { /* no es .myshopify.com: puede ser el dominio propio */ }
  const t = String(raw || '').trim();
  let base;
  try { base = wp.normalizeUrl(t.replace(/[?#].*$/, '')); } catch (_) { throw new Error(`Tienda de Shopify inválida: ${raw} (mitienda.myshopify.com o el dominio de la tienda)`); }
  const origin = new URL(base).origin;
  let r;
  try { r = await wp.httpJson(new URL(`${origin}/meta.json`), { timeoutMs: 15000, notApi: 'no es Shopify' }); } catch (e) { r = null; }
  const shop = r && r.status === 200 && r.data && typeof r.data.myshopify_domain === 'string' ? r.data.myshopify_domain.toLowerCase() : '';
  if (!SHOP_RE.test(shop)) throw new Error(`No pude averiguar el dominio .myshopify.com de ${new URL(origin).host}: ¿es una tienda Shopify? Escríbelo tú (Shopify → Configuración → Dominios).`);
  return { shop, domain: new URL(origin).host };
}

/** Tipo, URL y tienda de una conexión que viene de la UI o de un import. → {type, url, shop} */
function normalizeKind(input, existing) {
  const type = String(input.type || (existing && existing.type) || 'wordpress').toLowerCase();
  if (!TYPES.includes(type)) throw new Error(`Tipo inválido: ${input.type} (wordpress o shopify)`);
  if (type === 'wordpress') return { type, url: wp.normalizeUrl(input.url), shop: '' };
  // si pegan el endpoint de la app (…/api/revision/log?shop=…) salen de ahí la URL y la tienda
  const rawUrl = String(input.url || '').trim();
  const urlIsShop = /myshopify\.com|admin\.shopify\.com/i.test(rawUrl.replace(/[?#].*$/, ''));
  const shop = normalizeShop(input.shop || (urlIsShop || /[?&]shop=/.test(rawUrl) ? rawUrl : ''));
  const app = rawUrl && !urlIsShop ? rawUrl.replace(/[?#].*$/, '').replace(/\/api\/revision.*$/i, '') : SHOPIFY_APP_URL;
  return { type, url: wp.normalizeUrl(app), shop };
}

/** Ruta de la revisión: info, log, orders, order/<id>. */
function checkPath(p) {
  const s = String(p || '').replace(/^\/+|\/+$/g, '');
  if (!/^(info|log|orders|order\/\d+)$/.test(s)) throw new Error(`Ruta inválida: ${p} (info, log, orders u order/<id>)`);
  return s;
}

/** GET a la revisión por token. {status, data, ms} */
function request(site, apiPath, { query = {}, timeoutMs = 30000 } = {}) {
  if (!site.token) throw new Error('La tienda no tiene token');
  const p = checkPath(apiPath);
  if (site.type === 'shopify') return shopifyRequest(site, p, { query, timeoutMs });
  return wp.restRequest(site.url, `/${NAMESPACE}/review/${p}`, {
    query, timeoutMs, headers: { [HEADER]: site.token }, notApi: NOT_API,
  });
}

/**
 * App de Shopify: /api/revision/log?shop=&type= y /api/revision/pedido?shop=&pedido=. Se traduce desde las rutas de
 * WordPress: info = log sin el detalle, order/<n> = pedido. No tiene lista de pedidos.
 * Sus `now`/`expires` vienen en milisegundos: se pasan a segundos, como los del plugin.
 */
async function shopifyRequest(site, p, { query = {}, timeoutMs }) {
  if (p === 'orders') throw new Error('La app de Shopify no tiene lista de pedidos en la revisión por token: pide uno por su número (pedido <n>).');
  const order = p.match(/^order\/(\d+)$/);
  const u = new URL(`${wp.normalizeUrl(site.url)}/api/revision/${order ? 'pedido' : 'log'}`);
  u.searchParams.set('shop', normalizeShop(site.shop));
  if (order) u.searchParams.set('pedido', order[1]);
  if (p === 'log' && query.type) u.searchParams.set('type', String(query.type));
  u.searchParams.set('_', Date.now().toString(36)); // que ninguna caché intermedia lo sirva
  const r = await wp.httpJson(u, { timeoutMs, headers: { [HEADER]: site.token, 'Cache-Control': 'no-cache' }, notApi: NOT_SHOPIFY });
  const d = r.data;
  if (d && typeof d === 'object') {
    for (const k of ['now', 'expires']) if (Number(d[k]) > 1e11) d[k] = Math.floor(Number(d[k]) / 1000);
    if (r.status === 404 && d.code === 'pedido_no_encontrado') d.message = `No existe el pedido ${order ? order[1] : ''} en la tienda`;
    if (r.status === 400 && d.code === 'pedido_invalido') d.message = 'Número de pedido inválido';
  }
  if (r.status === 200 && p === 'info') {
    const { log, ...rest } = d;
    r.data = { ...rest, site: d.shop, name: d.shop, platform: 'shopify' };
  }
  return r;
}

/** Error legible; 401 = token inválido o vencido (se renueva en la tienda). */
function apiError(r) {
  const e = wp.apiError(r);
  if (r.status === 401) e.message = 'Token inválido o vencido: actívalo de nuevo en la tienda (WordPress: Aveonline → Revisión por token; Shopify: app Aveonline Connect → Revisión por token) y pégalo en FRAP.';
  return e;
}

/**
 * Comprueba la conexión: GET /review/info. Con un plugin anterior a esa ruta (rest_no_route) cae a /review/log
 * con un tipo que no existe (respuesta mínima). En Shopify, el log (tipos y cuántos eventos).
 * {site, name, version, wordpress, woocommerce, now, expires, types, legacy, platform?, ms}
 */
async function info(site) {
  let r = await request(site, 'info', { timeoutMs: 15000 });
  let legacy = false;
  if (site.type !== 'shopify' && r.status === 404 && r.data && r.data.code === 'rest_no_route') {
    legacy = true;
    r = await request(site, 'log', { query: { type: '__FRAP_CHECK__' }, timeoutMs: 15000 });
  }
  if (r.status !== 200) throw apiError(r);
  return { ...r.data, legacy, ms: r.ms };
}

/**
 * Extrae tienda, token y pedido de un texto pegado como el que se comparte hoy:
 * "pedido 16322 token 6dbc… tienda http://www.chp.com.co/". Cualquier campo puede faltar.
 * Si menciona una tienda xxx.myshopify.com (o el endpoint de la app) es de Shopify. → {type, url, shop, token, order}
 */
function parsePaste(text) {
  const t = String(text || '');
  const token = ((t.match(/\btoken\s*[:=]?\s*([A-Za-z0-9]{32,200})\b/i) || [])[1]) || ((t.match(/\b([a-f0-9]{40,200})\b/i) || [])[1]) || '';
  const order = ((t.match(/\b(?:pedido|orden|order)\s*(?:#|n[º°o.]*)?\s*[:=]?\s*#?(\d{1,12})\b/i) || [])[1]) || '';
  const shopM = t.match(/\b([a-z0-9][a-z0-9-]*\.myshopify\.com)\b/i) || t.match(/admin\.shopify\.com\/store\/([a-z0-9-]+)/i);
  if (shopM) {
    let shop = '';
    try { shop = normalizeShop(shopM[1]); } catch (_) { /* inválida: se sigue como WordPress */ }
    if (shop) {
      let app = SHOPIFY_APP_URL;
      const appM = t.match(/\bhttps?:\/\/[^\s"'<>?]+?\/api\/revision/i);
      if (appM) { try { app = wp.normalizeUrl(appM[0].replace(/\/api\/revision$/i, '')); } catch (_) { /* la de producción */ } }
      return { type: 'shopify', url: app, shop, token, order };
    }
  }
  const url = (t.match(/\bhttps?:\/\/[^\s"'<>]+/i) || [])[0] || ((t.match(/\b(?:tienda|sitio|url)\s*[:=]?\s*([a-z0-9.-]+\.[a-z]{2,}[^\s"'<>]*)/i) || [])[1]) || '';
  let site = '';
  if (url) { try { site = wp.normalizeUrl(url); } catch (_) { /* URL inválida: se deja vacía */ } }
  return { type: 'wordpress', url: site, shop: '', token, order };
}

/** La misma tienda: en Shopify por su dominio, en WordPress por la URL. */
function sameStore(a, b) {
  if ((a.type || 'wordpress') !== (b.type || 'wordpress')) return false;
  if (a.type === 'shopify') return (!!a.shop && a.shop === b.shop) || (!!a.domain && a.domain === b.domain);
  try { return wp.normalizeUrl(a.url) === wp.normalizeUrl(b.url); } catch (_) { return false; }
}

// ---------- skill frap-aveonline ----------
const SKILL_MARK = 'frap-aveonline (FRAP)';
function skillText() {
  const cli = `node ${CLI}`;
  return `---
name: frap-aveonline
description: Revisar tiendas con los envíos de Aveonline conectadas a FRAP (revisión por token, solo lectura): WooCommerce con el plugin Aveonline o Shopify con la app Aveonline Connect. Pedidos, tramas de cotización, de guía o del CRM (envío y respuesta) y el log. Úsala cuando el usuario pida revisar un pedido, una cotización, una guía o el log de una tienda Aveonline.
---

<!-- ${SKILL_MARK}: la instala y la quita FRAP con el módulo Integraciones -->

# Tiendas Aveonline de FRAP

Las tiendas las conecta el usuario en FRAP (Integraciones → Aveonline) con el token de la «Revisión por token».
Hay dos tipos (\`list\` lo dice): **wordpress** (plugin Aveonline en WooCommerce) y **shopify** (app Aveonline Connect).
Es **solo lectura** y el token dura poco (10 min por defecto). Accede **solo** con este CLI, que nunca muestra el token:

\`\`\`bash
${cli} list                                   # tiendas disponibles (activas y con "IA"), con su tipo
${cli} <id> info                              # versión del plugin o de la app, cuánto le queda al token y tipos de log
${cli} <id> pedidos [per_page=20] [page=2] [status=processing] [aveonline=0]   # (solo WordPress) últimos pedidos: guía y si tienen tramas
${cli} <id> pedido <número>                   # tramas exactas del pedido (envío y respuesta) y metadatos de envío
${cli} <id> log [TIPO]                        # log (p. ej. MULTIAGENTE_RESOLVE, GENERARGUIA2); sin tipo, todo
\`\`\`

- **WordPress**: \`pedido\` devuelve \`tramas.cotizacion\` y \`tramas.guia\` (cada una con \`send\` y \`response\`), la línea de
  envío y \`AVSHME_generate_guia_request\` / \`AVSHME_generate_guia\` / \`guias_rotulos\`.
- **Shopify**: \`pedido\` va por el número del pedido (el de #1021) y devuelve \`pedido\` (total, envío, atributos
  \`aveonline_*\`, borrador), \`estado\` (estado en Aveonline) y \`tramas.cotizacion\` (la cotización elegida en el
  formulario) y \`tramas.crm\` (la creación en el CRM). No hay \`pedidos\`: pide el número al usuario.

Tokens y claves salen como \`***\` y los PDF en base64 se omiten. \`info\` dice qué tipos de log hay y cuántos eventos tiene cada uno.

## Reglas
- Si da 401, el token venció o lo cambiaron: pídele al usuario que lo active de nuevo en la tienda y lo pegue en FRAP
  (Integraciones → Aveonline → «Pegar token»). **No le pidas que te pegue el token en el chat.**
- Si \`pedidos\` o \`info\` dan "ruta no encontrada" en WordPress, la tienda tiene un plugin anterior a 4.11.4: \`log\` funciona igual.
- Las tramas tienen datos personales (nombres, teléfonos, direcciones): muéstralos solo si hacen falta para lo que pide
  el usuario y no los copies a archivos ni a otras herramientas sin que lo pida.
- Si trabajas una issue (skill frap-issues), anota en su changelog qué revisaste (tienda, pedido y hallazgo).
- Si la tienda que necesitas está apagada o sin "IA", pídele al usuario que la active en FRAP: no edites \`aveonline.env\`.
`;
}
const skill = wp.skillManager('frap-aveonline', SKILL_MARK, skillText);

module.exports = {
  NAMESPACE, HEADER, CLI, TYPES, SHOPIFY_APP_URL,
  loadSites: store.load, saveSites: store.save, publicSite: wp.publicSite, normalizeUrl: wp.normalizeUrl,
  normalizeShop, resolveShop, normalizeKind, sameStore,
  checkPath, request, apiError, info, parsePaste,
  skillText, skillStatus: () => skill.status(), setSkill: (on) => skill.set(on),
};
