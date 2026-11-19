# FRAP — instrucciones para agentes

FRAP es una alternativa ligera a Warp que corre en el navegador: 3 paneles (proyectos · terminal · procesos/config/prompts) para trabajar con `claude`, `codex` y `opencode` sobre una o varias carpetas.

## Reglas duras (no romper)

1. **`src/index.html` debe funcionar abriéndolo como `file://`.** Nada de build, bundlers, servidores web ni CDNs.
   - Solo scripts clásicos: nada de `<script type="module">`, `import` ni `export` (Chrome bloquea módulos en `file://`).
   - Las librerías y recursos de terceros van en `src/vendor/`: xterm.js 5.5.0, addon-fit 0.10.0 y `icons/` (logos de claude, codex y opencode, con su origen en `icons/README.md`).
2. **Cero dependencias npm** en runtime y en tests. El bridge usa solo la librería estándar de Node 18+ y Python 3.
3. **Nunca `innerHTML`** en `src/index.js`: se muestra contenido de archivos del usuario. Usa `h()` (crea nodos con `textContent`).
4. **Seguridad del bridge**: escucha solo en `127.0.0.1`, exige token y rechaza Origins `http(s)` (salvo los de `FRAP_ALLOW_ORIGINS`). `fs.*` queda limitado a `FRAP_FS_ROOT` (por defecto `$HOME`) y `proc.kill` solo a descendientes de sesiones FRAP. No relajes esto.
5. **Git**: `git.run` solo ejecuta el binario `git` con la lista blanca `GIT_ALLOWED`. No agregues subcomandos ni opciones que ejecuten código (`config`, `-c`, `--upload-pack`, `--exec`) sin un test que lo cubra.
6. **Bases de datos**:
   - Las contraseñas solo viven en `FRAP_HOME/databases.env` (0600): nunca en el estado de la UI, en localStorage ni en las respuestas del bridge (usa `publicConn`).
   - `frap-db.js` (agentes) es siempre solo lectura, sin flags para escribir.
   - No debilites `assertReadOnly` ni las capas del motor: cualquier cambio necesita un test en `tests/db.test.js`.
7. La UI está en español.

## Estructura

```
src/index.html   layout de 3 paneles + modal
src/index.css    tema oscuro (variables CSS en :root)
src/index.js     toda la UI (IIFE): Bridge RPC, terminales xterm, paneles, modales, atajos
src/vendor/      xterm.js + addon-fit + icons/ (no editar)
src/favicon.svg  favicon de FRAP
bridge/frap-bridge.js  servidor WS: sesiones PTY, fs, ps, escaneo de config, estado
bridge/ws.js           WebSocket RFC 6455 mínimo (servidor + cliente para tests)
bridge/frap_pty.py     sesión PTY persistente (Python stdlib, desligada del bridge, socket Unix). NO renombrar a pty.py: tapa el módulo stdlib
bridge/db.js           conexiones de BD (.env), clasificador de solo lectura, ejecución vía mysql/psql/sqlite3
bridge/frap-db.js      CLI de SOLO LECTURA para agentes (lo usa la skill frap-db)
tests/bridge.test.js   tests de integración del bridge (node:test)
tests/db.test.js       clasificador, parsers, .env, motores y CLI
scripts/check.js       chequeos estáticos + reglas de arriba
docs/                  arquitectura, protocolo y roadmap
```

## Comandos

- `npm run check`: chequeos estáticos y tests. **Córrelo antes de dar algo por terminado.**
- `npm test`: solo los tests del bridge.
- `npm start`: lanza el bridge y abre la UI (`npm run bridge` la lanza sin abrir).

## Cómo trabajar

- Si la UI empieza a usar una operación nueva del bridge, agrégala a `REQUIRED_OPS` en `index.js`: así un bridge viejo en ejecución muestra el aviso de reiniciar.
- Una operación nueva del bridge se agrega en `ops` de `frap-bridge.js`, se documenta en `docs/ARCHITECTURE.md` (tabla del protocolo) y se cubre con un test en `tests/bridge.test.js`.
- Los tests aíslan `HOME`, `FRAP_HOME` y `FRAP_FS_ROOT` en un tmpdir. Nunca dependas del `~/.claude` real.
- Las sesiones **sobreviven al bridge**: un test que crea terminales debe cerrarlas con `session.kill`, porque matar el bridge no basta y quedarían procesos vivos.
- Los tests de SQLite corren siempre. Los de MySQL y PostgreSQL solo si defines `FRAP_TEST_MYSQL` / `FRAP_TEST_PG` con el JSON de la conexión (ver la cabecera de `tests/db.test.js`).
- El estado de la UI vive en `state` (index.js). Se persiste en localStorage y en `~/.config/frap/state.json` vía `state.set`, y gana el `savedAt` más reciente. Las terminales **no** se persisten en el estado: se derivan de `sessions.list` del bridge (`meta.projectId`).
- Para cambios visuales, verifica en un navegador real: abre `src/index.html` con el bridge corriendo y revisa la consola.
- Actualiza `docs/ROADMAP.md` cuando completes o agregues ítems.
