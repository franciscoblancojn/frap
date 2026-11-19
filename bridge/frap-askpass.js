#!/usr/bin/env node
'use strict';
// SSH_ASKPASS de FRAP: ssh lo llama con el texto de la pregunta como argumento y lee la
// respuesta de stdout. Solo responde preguntas de contraseña / passphrase; cualquier otra
// (p. ej. confirmar una llave de servidor) se rechaza con código 1.
//
// La contraseña sale de FRAP_SSH_PASS (prueba de un formulario sin guardar) o del .env
// FRAP_SSH_ENV buscando el id FRAP_SSH_ID.

const prompt = process.argv[2] || '';
if (!/password|passphrase|contraseña/i.test(prompt)) process.exit(1);

let pass = process.env.FRAP_SSH_PASS;
if (pass == null) {
  const { loadHosts } = require('./ssh');
  const h = loadHosts(process.env.FRAP_SSH_ENV || '').find((x) => x.id === process.env.FRAP_SSH_ID);
  if (!h || !h.password) process.exit(1);
  pass = h.password;
}
process.stdout.write(`${pass}\n`);
