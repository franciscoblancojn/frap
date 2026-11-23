'use strict';
// Integración Aveonline: tiendas WooCommerce con el plugin de envíos Aveonline y su "Revisión por token"
// (WordPress → Aveonline → Revisión por token). Es de solo lectura: log del plugin, pedidos y tramas de
// cotización y guía. El token es uno por tienda, de corta vida (10 min por defecto, máx. 24 h).
// Los tokens solo viven en FRAP_HOME/aveonline.env (0600): nunca en la UI ni en la salida del CLI.
// Reutiliza el almacén y el cliente HTTP de la integración WordPress. Solo librería estándar de Node.

const path = require('path');
const wp = require('./wordpress');

const NAMESPACE = 'aveonline/v1';
const HEADER = 'X-Avshme-Token';
const CLI = path.join(__dirname, 'frap-ave.js');
const NOT_API = 'La respuesta no es de la revisión por token de Aveonline: ¿la URL es la de la tienda y el plugin Aveonline (4.11.4 o más nuevo) está activo?';

const store = wp.envStore('FRAP_AVE_', [
  '# FRAP — integración Aveonline (plugin de envíos Aveonline → Revisión por token, en cada tienda).',
  '# Se gestiona desde FRAP (panel izquierdo → Integraciones → Aveonline); se puede editar a mano.',
  '# Los agentes (claude, codex, opencode) usan las que tienen ENABLED=1 y AI=1 (solo lectura) a través de:',
  `#   node ${CLI} <id> info`,
]);

/** Ruta de la revisión: info, log, orders, order/<id>. */
function checkPath(p) {
  const s = String(p || '').replace(/^\/+|\/+$/g, '');
  if (!/^(info|log|orders|order\/\d+)$/.test(s)) throw new Error(`Ruta inválida: ${p} (info, log, orders u order/<id>)`);
  return s;
}

/** GET a la revisión por token. {status, data, ms} */
function request(site, apiPath, { query = {}, timeoutMs = 30000 } = {}) {
  if (!site.token) throw new Error('La tienda no tiene token');
  return wp.restRequest(site.url, `/${NAMESPACE}/review/${checkPath(apiPath)}`, {
    query, timeoutMs, headers: { [HEADER]: site.token }, notApi: NOT_API,
  });
}

/** Error legible; 401 = token inválido o vencido (se renueva en la tienda). */
function apiError(r) {
  const e = wp.apiError(r);
  if (r.status === 401) e.message = 'Token inválido o vencido: actívalo de nuevo en la tienda (Aveonline → Revisión por token) y pégalo en FRAP.';
  return e;
}

/**
 * Comprueba la conexión: GET /review/info. Con un plugin anterior a esa ruta (rest_no_route) cae a /review/log
 * con un tipo que no existe (respuesta mínima). {site, name, version, wordpress, woocommerce, now, expires, types, legacy, ms}
 */
async function info(site) {
  let r = await request(site, 'info', { timeoutMs: 15000 });
  let legacy = false;
  if (r.status === 404 && r.data && r.data.code === 'rest_no_route') {
    legacy = true;
    r = await request(site, 'log', { query: { type: '__FRAP_CHECK__' }, timeoutMs: 15000 });
  }
  if (r.status !== 200) throw apiError(r);
  return { ...r.data, legacy, ms: r.ms };
}

/**
 * Extrae tienda, token y pedido de un texto pegado como el que se comparte hoy:
 * "pedido 16322 token 6dbc… tienda http://www.chp.com.co/". Cualquier campo puede faltar.
 */
function parsePaste(text) {
  const t = String(text || '');
  const url = (t.match(/\bhttps?:\/\/[^\s"'<>]+/i) || [])[0] || ((t.match(/\b(?:tienda|sitio|url)\s*[:=]?\s*([a-z0-9.-]+\.[a-z]{2,}[^\s"'<>]*)/i) || [])[1]) || '';
  const token = ((t.match(/\btoken\s*[:=]?\s*([A-Za-z0-9]{32,200})\b/i) || [])[1]) || ((t.match(/\b([a-f0-9]{40,200})\b/i) || [])[1]) || '';
  const order = ((t.match(/\b(?:pedido|orden|order)\s*(?:#|n[º°o.]*)?\s*[:=]?\s*(\d{1,12})\b/i) || [])[1]) || '';
  let site = '';
  if (url) { try { site = wp.normalizeUrl(url); } catch (_) { /* URL inválida: se deja vacía */ } }
  return { url: site, token, order };
}

// ---------- skill frap-aveonline ----------
const SKILL_MARK = 'frap-aveonline (FRAP)';
function skillText() {
  const cli = `node ${CLI}`;
  return `---
name: frap-aveonline
description: Revisar tiendas WooCommerce con el plugin de envíos Aveonline conectadas a FRAP (revisión por token, solo lectura): pedidos, tramas de cotización y de generación de guía (envío y respuesta), y el log del plugin. Úsala cuando el usuario pida revisar un pedido, una cotización, una guía o el log de una tienda Aveonline.
---

<!-- ${SKILL_MARK}: la instala y la quita FRAP con el módulo Integraciones -->

# Tiendas Aveonline de FRAP

Las tiendas las conecta el usuario en FRAP (Integraciones → Aveonline) con el token de la «Revisión por token»
del plugin (WordPress → Aveonline → Revisión por token). Es **solo lectura** y el token dura poco (10 min por defecto).
Accede **solo** con este CLI, que nunca muestra el token:

\`\`\`bash
${cli} list                                   # tiendas disponibles (activas y con "IA")
${cli} <id> info                              # versión del plugin y cuánto le queda al token
${cli} <id> pedidos [per_page=20] [page=2] [status=processing] [aveonline=0]   # últimos pedidos con Aveonline: guía y si tienen tramas
${cli} <id> pedido <número>                   # tramas exactas de cotización y de guía (envío y respuesta) y metadatos de envío
${cli} <id> log [TIPO]                        # log del plugin (p. ej. MULTIAGENTE_RESOLVE, GENERARGUIA2); sin tipo, todo
\`\`\`

\`pedido\` devuelve \`tramas.cotizacion\` y \`tramas.guia\` (cada una con \`send\` y \`response\`), la línea de envío y
\`AVSHME_generate_guia_request\` / \`AVSHME_generate_guia\` / \`guias_rotulos\`. Tokens y claves salen como \`***\` y los
PDF en base64 se omiten. \`info\` dice qué tipos de log hay y cuántos eventos tiene cada uno.

## Reglas
- Si da 401, el token venció o lo cambiaron: pídele al usuario que lo active de nuevo en la tienda y lo pegue en FRAP
  (Integraciones → Aveonline → «Pegar token»). **No le pidas que te pegue el token en el chat.**
- Si \`pedidos\` o \`info\` dan "ruta no encontrada", la tienda tiene un plugin anterior a 4.11.4: \`log\` funciona igual.
- Las tramas tienen datos personales (nombres, teléfonos, direcciones): muéstralos solo si hacen falta para lo que pide
  el usuario y no los copies a archivos ni a otras herramientas sin que lo pida.
- Si trabajas una issue (skill frap-issues), anota en su changelog qué revisaste (tienda, pedido y hallazgo).
- Si la tienda que necesitas está apagada o sin "IA", pídele al usuario que la active en FRAP: no edites \`aveonline.env\`.
`;
}
const skill = wp.skillManager('frap-aveonline', SKILL_MARK, skillText);

module.exports = {
  NAMESPACE, HEADER, CLI,
  loadSites: store.load, saveSites: store.save, publicSite: wp.publicSite, normalizeUrl: wp.normalizeUrl,
  checkPath, request, apiError, info, parsePaste,
  skillText, skillStatus: () => skill.status(), setSkill: (on) => skill.set(on),
};
