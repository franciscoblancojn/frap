#!/usr/bin/env node
'use strict';
// CLI para agentes (skill frap-aveonline): tiendas Aveonline (WordPress con el plugin o Shopify con la app Aveonline
// Connect) conectadas en FRAP por la «Revisión por token». Solo lectura. Solo ve las tiendas con ENABLED=1 y AI=1. Nunca imprime el token.
// Uso:
//   node frap-ave.js list
//   node frap-ave.js <id> info
//   node frap-ave.js <id> pedidos [per_page=20] [page=1] [status=processing] [aveonline=0] [--json]
//   node frap-ave.js <id> pedido <número>
//   node frap-ave.js <id> log [TIPO]

const os = require('os');
const path = require('path');
const ave = require('./aveonline');

const FRAP_HOME = process.env.FRAP_HOME || path.join(os.homedir(), '.config', 'frap');
const ENV_FILE = path.join(FRAP_HOME, 'aveonline.env');
const USAGE = `Uso:
  frap-ave list
  frap-ave <id> info                      versión del plugin y vencimiento del token
  frap-ave <id> pedidos [clave=valor …]   (solo WordPress) per_page=20 page=2 status=processing aveonline=0 (todos) --json
  frap-ave <id> pedido <número>           tramas del pedido (WordPress: cotización y guía; Shopify: cotización y CRM)
  frap-ave <id> log [TIPO]                log del plugin (p. ej. MULTIAGENTE_RESOLVE)`;

const usable = () => ave.loadSites(ENV_FILE).filter((s) => s.enabled && s.ai && s.token);

function site(id) {
  const s = ave.loadSites(ENV_FILE).find((x) => x.id === id);
  if (!s) throw new Error(`No existe la tienda "${id}". Disponibles: ${usable().map((x) => x.id).join(', ') || '(ninguna)'}`);
  if (!s.enabled) throw new Error(`La tienda "${id}" está apagada en FRAP: pídele al usuario que la active.`);
  if (!s.ai) throw new Error(`La tienda "${id}" no tiene "Uso por IA" en FRAP: pídele al usuario que lo active.`);
  if (!s.token) throw new Error(`La tienda "${id}" no tiene token: pídele al usuario que lo pegue en FRAP (Integraciones → Aveonline).`);
  return s;
}

const left = (d) => {
  const secs = Math.max(0, (d.expires || 0) - (d.now || 0));
  return secs ? `vence en ${Math.floor(secs / 60)} min ${secs % 60} s` : 'vencido';
};

async function get(s, p, query) {
  const r = await ave.request(s, p, { query });
  if (r.status === 404 && r.data && r.data.code === 'rest_no_route') {
    throw new Error(`La tienda tiene un plugin Aveonline anterior a 4.11.4 (sin /review/${p.split('/')[0]}): \`log\` sí funciona.`);
  }
  if (r.status !== 200) throw ave.apiError(r);
  return r.data;
}

async function main(argv) {
  const [first, cmd, ...rest] = argv;
  if (!first || first === 'help' || first === '--help') { console.log(USAGE); return; }
  if (first === 'list') {
    const list = usable();
    if (!list.length) { console.log(`Sin tiendas disponibles (activas, con "IA" y con token) en ${ENV_FILE}`); return; }
    for (const s of list) console.log(`${s.id}\t${s.type}\t${s.name}\t${s.type === 'shopify' ? s.shop : s.url}`);
    return;
  }
  const s = site(first);
  if (!cmd || cmd === 'info') {
    const i = await ave.info(s);
    const types = Object.entries(i.types || {}).map(([k, n]) => `${k} (${n})`).join(', ');
    if (s.type === 'shopify') {
      console.log(`${s.name} — ${i.shop} (Shopify)
App Aveonline Connect ${i.version} · ${s.url}
Token: ${left(i)}
Log: ${types || '(vacío)'}`);
      return;
    }
    console.log(`${i.name || s.name} — ${i.site}
Plugin Aveonline ${i.version}${i.wordpress ? ` · WordPress ${i.wordpress}` : ''}${i.woocommerce ? ` · WooCommerce ${i.woocommerce}` : ''}${i.legacy ? '  (plugin anterior a 4.11.4: solo `log`)' : ''}
Token: ${left(i)}
Log: ${types || '(vacío)'}`);
    return;
  }
  if (cmd === 'pedidos' || cmd === 'orders') {
    const json = rest.includes('--json');
    const query = {};
    for (const a of rest.filter((x) => x !== '--json')) {
      const m = a.match(/^(per_page|page|status|aveonline)=([\w-]+)$/);
      if (!m) throw new Error(`Parámetro inválido: ${a} (per_page, page, status, aveonline)`);
      query[m[1]] = m[2];
    }
    const d = await get(s, 'orders', query);
    if (json) { console.log(JSON.stringify(d.orders, null, 2)); return; }
    console.error(`# ${d.orders.length} pedido(s) · página ${d.page} · token ${left(d)}`);
    for (const o of d.orders) {
      const tr = [o.tramas.cotizacion ? 'cotización' : '', o.tramas.guia ? 'guía' : ''].filter(Boolean).join('+') || 'sin tramas';
      console.log(`${o.number}\t${o.created}\t${o.status}\t${o.shipping ? o.shipping.name : '(sin envío)'}\t${o.guia && o.guia.numguia ? `guía ${o.guia.numguia}` : 'sin guía'}\t${tr}\t${o.city || ''}`);
    }
    return;
  }
  if (cmd === 'pedido' || cmd === 'order') {
    const n = String(rest[0] || '').replace(/^#/, '');
    if (!/^\d{1,12}$/.test(n)) throw new Error('pedido necesita el número: frap-ave <id> pedido 16322');
    console.log(JSON.stringify(await get(s, `order/${n}`), null, 2));
    return;
  }
  if (cmd === 'log') {
    const type = rest[0];
    if (type && !/^[A-Za-z0-9_ ]{1,80}$/.test(type)) throw new Error('Tipo de log inválido');
    const d = await get(s, 'log', type ? { type } : {});
    console.error(`# ${Object.entries(d.types || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || 'sin eventos'} · token ${left(d)}`);
    console.log(JSON.stringify(d.log, null, 2));
    return;
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((e) => { console.error(e.status ? `Error ${e.status}: ${e.message}` : e.message); process.exitCode = 1; });
