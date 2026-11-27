# Arquitectura

```
navegador (file://src/index.html)                     máquina local
┌──────────────────────────────┐   ws://127.0.0.1:7681  ┌─────────────────────────┐
│ index.js                     │  ?token=…  Origin:null │ frap-bridge.js (Node)   │
│  Bridge (RPC JSON)  ─────────┼────────────────────────┼─▶ ops{} ─ fs / ps / scan │
│  xterm.js por sesión ◀───────┼── ev:out / ev:exit ────┼── sesiones PTY          │
│  state → localStorage        │                        │   └ python3 frap_pty.py │
└──────────────────────────────┘                        │       └ $SHELL ─ claude │
                                                        └─────────────────────────┘
```

- **Por qué un bridge:** una página no puede lanzar procesos. El bridge es el mínimo posible: un solo archivo Node, sin dependencias. El WebSocket está implementado a mano en `ws.js` y el PTY usa el módulo `pty` de Python, para no compilar `node-pty`.
- **Sesiones persistentes:** cada terminal es un proceso `frap_pty.py` **desligado del bridge** (`detached`, en su propia sesión, ignora SIGHUP). Guarda los últimos 512 KB de salida y escucha en un socket Unix privado: `$XDG_RUNTIME_DIR/frap-<uid>-<hash de FRAP_HOME>/<sid>.sock` (carpeta 0700, socket 0600). Junto al socket, `<sid>.json` guarda la meta (proyecto, título, tipo, cwd).
  - El bridge es solo un cliente. Al arrancar, `rediscoverSessions()` se reconecta a los sockets vivos **antes** de aceptar a la UI. Al cerrarlo (Ctrl+C) las terminales siguen vivas, salvo con `--kill-sessions`.
  - Protocolo del socket: tramas `tipo(1) + largo(4, BE) + datos`. Del helper al bridge van `B` (historial al conectar), `O` (salida) y `X` (código de salida); del bridge al helper, `I` (entrada), `R` (filas columnas) y `K` (terminar). Hay un solo cliente a la vez.
  - Si el comando termina antes de que el bridge se conecte, el helper espera hasta 10 s para entregarle la salida y el código.
  - La UI, al reconectar (`syncSessions(true)`), vuelve a llamar a `session.attach` en cada terminal para traer lo que se imprimió mientras estaba desconectada. Las terminales se agrupan por `meta.projectId`.
- **Lanzar agentes:** toda terminal es una shell interactiva. `claude`, `codex` y `opencode` se lanzan escribiendo el comando (`init`) en la shell, así que al salir del agente vuelves a la shell.
- **Acciones:** son sesiones con `meta.kind = 'action'` y `meta.actionId`, lanzadas con `cmd: [$SHELL, '-ic', comando]`, así que la sesión termina cuando termina el comando. Su estado se deriva de la sesión viva y del patrón "lista" buscado en la salida. Para apagar se escribe `\x03` en el PTY: el kernel manda SIGINT al grupo en primer plano, también a procesos root bajo `sudo`. Si no responde en unos 10 s, se mata la sesión.
- **Entorno de las terminales:** se limpian las variables que marcan una sesión padre de Claude Code o Codex (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, …), por si el bridge se lanzó desde una.

## Música

- **Archivos:** se guardan como Blob en IndexedDB (`frap-music/files`) y se reproducen con un `<audio>` global. Funcionan sin bridge y sobreviven a recargas. En `state.music.tracks` solo va la metadata.
- **YouTube:** rechaza embeds desde `file://` (error 153, sin Referer). Por eso el bridge sirve `GET /yt-player`, un relé en `http://127.0.0.1:<puerto>` que carga la IFrame API de YouTube. La UI lo incrusta y le habla por `postMessage` (`{frap:'yt', cmd:'load'|'play'|'pause'|'seek'|'volume'}`), y recibe de vuelta `ready`, `state`, `time` y `error`. La UI valida `event.source` y `event.origin`, y el relé solo acepta mensajes de su ventana padre. El relé no usa token, y el WebSocket rechaza su Origin http, así que no da acceso al bridge.
- El reproductor (dock) vive fuera de `#rbody`, así que re-renderizar el panel no corta la música. Fuera de la pestaña Música el video se minimiza, pero sigue sonando.

## Terminales tras apagar el equipo

- Las sesiones sobreviven al bridge, pero no a un apagado: son procesos `frap_pty.py` con su socket en `$XDG_RUNTIME_DIR` (tmpfs), y ambos desaparecen al apagar.
- La UI guarda una foto de las terminales vivas en `state.lastTerms` (`[{sid, projectId, kind, title, cwd, sshId?}]`), que persiste en localStorage y state.json. Se actualiza en cada `renderAll`, solo si cambió.
- En cada conexión al bridge, `checkRestore()` busca los sids de la foto que ya no están en `sessions.list`. Si falta alguno, ofrece reabrirlos con `reopenTerminals` (lo mismo que el import), retomando la última conversación de cada IA (`claude --continue`, `codex resume --last`, `opencode --continue`).
- Hasta que el usuario decide, la foto no se pisa, porque si no, el arranque vacío la borraría. "Ahora no" las sigue ofreciendo; "Descartar" las olvida.

## Módulos (Ajustes → Módulos)

- Modal con cuatro columnas (panel izquierdo, central, derecho y **módulos internos**, como la gestión de issues) y un switch por módulo: secciones de carpetas; lanzadores (shell, claude, codex, opencode, git, ssh, sftp, db, notas, código) y pantalla dividida; pestañas del panel derecho y el dock de voz. Lista en `MODULES` (index.js).
- `state.modules.off` guarda solo lo apagado, así lo nuevo sale activado. `applyModules()` oculta botones, pestañas y barras (al arrancar, al cambiar algo y al llegar un estado remoto). Se exporta e importa como parte de la configuración ("Módulos").
- Apagar un módulo oculta su botón o pestaña y su atajo; lo ya abierto sigue hasta cerrarlo. Además:
  - Secciones apagadas: se ve "Todas".
  - Pantalla dividida apagada: `splitN()` es 1.
  - Editor apagado: las rutas clicadas van al editor externo.
  - Música apagada: se oculta su barra.
  - Alertas apagadas: no avisan (y la IA no puede pedirlas).
  - Si se apaga la pestaña derecha activa, pasa a la primera visible. Sin ninguna, el panel muestra un aviso.

## Túneles (pestaña del panel derecho)

- Comparten por una URL pública algo que corre en local, como el port forwarding de VS Code: un puerto (npm, bun, pnpm, `php -S`, WordPress…), una URL o IP de la red, o un archivo o carpeta. Están en `bridge/tunnels.js`, solo con la librería estándar.
- **Puerta local:** cada túnel abre un servidor http en `127.0.0.1:<puerto al azar>` del bridge, y el proveedor publica esa puerta, no el servidor directamente. La puerta:
  - **Contraseña** opcional: Basic, con cualquier usuario. También acepta un enlace `?frap_key=<clave>`, que deja una cookie y redirige sin la clave. La contraseña no llega al servidor.
  - **Host:** lo reescribe a `localhost:<puerto>`, porque Vite, Next y similares rechazan hosts desconocidos. Los `Location` que apuntan a localhost pasan a la URL pública.
  - **URLs del contenido** (opcional, pensado para WordPress): reemplaza las URLs localhost en HTML, CSS, JS y JSON, incluido el JSON escapado.
  - **WebSocket:** los pasa, así funciona el HMR.
  - **Errores:** responde 502 legible si el servidor no contesta.
  - **Visitas:** cuenta peticiones y visitantes.
  - **Archivos estáticos:** el tipo `path` se sirve desde la misma puerta. Un archivo suelto abre ese archivo y sirve su carpeta; una carpeta muestra su `index.html` o un listado. Nunca sale de la raíz y no sirve dotfiles (`.env`, `.git`). Soporta `Range` para video.
- **Proveedores:**
  - `cloudflared` (quick tunnel `*.trycloudflare.com`), recomendado. Se instala con `scripts/install-cloudflared.sh` en `FRAP_HOME/bin`.
  - **localhost.run** por `ssh`, sin instalar nada. La URL sale de su salida JSON. Usa su propio `known_hosts` en `FRAP_HOME`.
  - `ngrok`, si está instalado.
  - "Automático" elige en ese orden.
- **TLS:** solo se omite la verificación para destinos locales o de red privada, que suelen tener certificado propio. Los destinos remotos se verifican.
- **Vida útil:** los túneles no sobreviven al bridge. `shutdown` y `exit` los detienen, y las URLs gratuitas cambian en cada arranque. La configuración vive en `state.tunnels` y se exporta como parte de la configuración, con sus contraseñas. El bridge avisa cada cambio con el evento `tunnel`.
- **UI:** muestra las tarjetas de túneles (estado, URL, copiar con o sin clave, visitantes, registro del proveedor) y los "Servidores detectados", asociados al proyecto por la carpeta del proceso. El árbol del editor tiene "Compartir por túnel…" para HTML, medios y carpetas, y la barra de estado muestra 🚇 N.

## Scripts (módulo interno)

- Los scripts viven en `local/scripts/<carpeta>/<script>`: la carpeta es el ID de la issue o un tema. Las utilidades compartidas (`conexion.ts`, `select.ts`, `package.json`) van en la raíz, y lo generado en `<carpeta>/salida/`. Todo está en `bridge/scripts.js`; `bridge/frap-scripts.js` es el CLI para agentes.
- **Interruptores**, como en las bases de datos: cada script tiene «Usuario» (se puede ejecutar desde FRAP) e «IA» (la IA lo puede ejecutar con `frap-scripts run`). Los dos vienen encendidos por defecto.
  - Se guardan en `local/scripts/.frap-scripts.json`, junto con `enabled`, que indica si el módulo está activo, así que viajan en el zip de `local/`.
  - Al listar se limpian los interruptores de scripts que ya no existen.
- **Ejecución:** se usa bun para `.ts` y `.js` (o node si no hay bun), python3, bash, php o ruby, siempre desde `local/scripts`. Los `.sql` no se ejecutan: se muestran para revisarlos.
  - Desde FRAP (▶), el script corre en una terminal nueva del proyecto ("▶ nombre"). Se le pueden pasar argumentos, que se recuerdan por script.
  - La IA solo lo ejecuta con `frap-scripts run`, que revisa el módulo y el interruptor «IA». La skill le prohíbe saltárselo. Esto no es un bloqueo duro, porque la IA tiene shell: es la misma confianza que con las instrucciones de cualquier skill.
- **Skill `frap-scripts`:** con el módulo activo se instala en `~/.claude/skills` y `~/.codex/skills`. Explica dónde crear los scripts (`frap-scripts new <carpeta>/<nombre.ext>`, con cabecera), cómo nombrarlos, que no escriban en bases de datos (generan un `.sql`) y que se anoten en el changelog de la issue. Al apagar el módulo se quita la skill y `run` queda bloqueado.
- **Pestaña Scripts:** grupos por carpeta ("Compartidos" primero; 🎫 si la carpeta es una issue), con su botón "📂 salida N". Cada script tiene descripción (el primer comentario del archivo), interruptores, ▶ y un menú con ejecutar con argumentos, abrir en el editor, copiar ruta o el comando para la IA, mostrar en el explorador y mandar a la papelera. "+ Nuevo" crea el script con cabecera y lo abre en el editor.

## Integraciones (panel izquierdo): WordPress y Aveonline

- Módulo `left.integrations`: un bloque plegable abajo del panel izquierdo («Integraciones») con un colapsable por integración: **WordPress** y **Aveonline**. Lo plegado se recuerda en `state.ui.integCollapsed`.
- **Plugin `frap-wordpress`** (`integrations/wordpress/frap-wordpress/`, PHP, misma estructura que los demás plugins del autor: `index.php` con constantes, `src/{data,services,api,page}` con su `_.php`, `libs/` con `wordpress_utils` y `FWUUpdate`, harness, `push-v` y workflow de release).
  - El administrador crea **tokens** en WordPress → FRAP → Tokens.
    - Cada token tiene nombre, duración (24 h por defecto, de 1 h a 30 días) y permisos por recurso × acción (ver, crear, editar, eliminar).
    - Por defecto todo es solo lectura, y lo que tiene datos personales (usuarios, pedidos, clientes) empieza apagado.
    - Del token solo se guarda el hash. Se puede renovar (mismo valor), revocar o eliminar.
  - **API** `frap/v1` con la cabecera `X-Frap-Token`:
    - `GET /info` devuelve el sitio, las versiones, el vencimiento y los permisos.
    - `/<recurso>[/<id>[/variations[/<id>]]]` se traduce con `rest_do_request` a `/wp/v2/…` o `/wc/v3/…`. Se ejecuta como el administrador que creó el token, después de comprobar el permiso: GET = ver, POST sin id = crear, POST/PUT/PATCH con id = editar, DELETE = eliminar.
    - Todo queda en «Actividad» (`FWUSystemLog`).
  - **Repo propio:** el código vive en FRAP y se publica con `git subtree split` (`scripts/publish.sh`, `npm run push-v`) en `franciscoblancojn/frap-wordpress` (`FRAPWP_REMOTE` lo cambia). Su workflow arma la release que lee `FWUUpdate`. El token de GitHub de `FWUUpdate` va en `index.php` (`token_array_split`, solo lectura a repos públicos), como en los demás plugins del autor.
- **En FRAP** (`bridge/wordpress.js`): conexiones `FRAP_WP_<ID>_{NAME,URL,TOKEN,ENABLED,AI}` en `FRAP_HOME/wordpress.env` (0600).
  - `publicSite` quita el token (la UI solo ve `hasToken` y los últimos 4 caracteres).
  - Las peticiones usan `?rest_route=`, así funcionan sin enlaces permanentes. En hosts locales o de red privada (`isPrivateHost`) aceptan certificados propios.
- **Interruptores** Activa / IA, como en las bases de datos. `bridge/frap-wp.js` (skill `frap-wordpress`) solo ve los sitios activos y con IA, y nunca imprime el token.
  - La skill se instala y se quita con el módulo.
  - Antes de crear, editar o eliminar, la IA muestra el cambio y espera el visto bueno.
- **Exportar / importar (.json):** grupo «Integraciones · WordPress» en la columna del panel izquierdo. Viajan URL e interruptores; el token, solo cifrado con la clave de la exportación (`secrets.wp`).
- **UI:** cada sitio muestra un punto de estado (probado al conectar), el host, el vencimiento del token, los interruptores y un menú: probar, editar o cambiar el token, abrir los tokens en WordPress, abrir el sitio, copiar el comando para la IA y eliminar.

### Aveonline (revisión por token del plugin de envíos)

- Tiendas WooCommerce con el **plugin de envíos Aveonline** (repo aparte: `aveonline`), que trae la «Revisión por token» (WordPress → Aveonline → Revisión por token): **un solo token por tienda**, de corta vida (10 min por defecto, máx. 24 h), siempre **solo lectura**. Cabecera `X-Avshme-Token`, rutas `aveonline/v1/review/…`:
  - `info` (versión, vencimiento, tipos de log), `orders` (últimos pedidos con Aveonline: guía y si tienen tramas; `per_page` ≤ 50, `page`, `status`, `aveonline=0`), `order/<id>` (tramas de cotización y guía con envío y respuesta, metadatos de envío) y `log` (`?type=`).
- **Tipo de tienda** (`TYPE`, por defecto `wordpress`): `shopify` = app **Aveonline Connect** (repo aparte: `aveonline-connect-shopify`). Ahí `URL` es la de la app (por defecto `https://connect-crm-s.aveonline.co`) y `SHOP` el dominio `xxx.myshopify.com`; rutas `<app>/api/revision/log?shop=&type=` y `<app>/api/revision/pedido?shop=&pedido=` con la misma cabecera. `bridge/aveonline.js` traduce: `info` = log sin el detalle (`platform: 'shopify'`), `order/<n>` = pedido, `orders` no existe; `now`/`expires` llegan en ms y se pasan a segundos. «Pegar token» reconoce Shopify si el texto trae `xxx.myshopify.com` (o el endpoint de la app) y busca la tienda por su dominio. Si en la tienda se escribe el dominio propio (`https://mitienda.com`), `ave.save`/`ave.check` averiguan el `xxx.myshopify.com` con el `/meta.json` público de Shopify (`myshopify_domain`) y guardan el propio en `DOMAIN`.
  - `info` y `orders` existen desde la versión siguiente a 4.11.4; con un plugin anterior, FRAP comprueba con `log?type=` de un tipo inexistente (`legacy: true`) y solo funciona `log` y `order/<id>` (4.11.4).
- **En FRAP** (`bridge/aveonline.js`): reutiliza el almacén y el cliente HTTP de WordPress (`envStore`, `restRequest`, `skillManager` en `bridge/wordpress.js`). Tiendas `FRAP_AVE_<ID>_{NAME,URL,TOKEN,ENABLED,AI,TYPE,SHOP,DOMAIN}` (`envStore` acepta campos extra) en `FRAP_HOME/aveonline.env` (0600). El token nunca llega a la UI ni a la salida del CLI.
- **«Pegar token»** (`ave.paste`): acepta el texto tal como se comparte («pedido 16322 token … tienda http://…»); el bridge saca URL, token y pedido. Si la tienda existe (por URL, o la elegida) le cambia el token; si no, la crea con el dominio como nombre e id (`chp.com.co` → `chp`). Devuelve el pedido para copiar la petición a la IA.
- **CLI `bridge/frap-ave.js`** (skill `frap-aveonline`): `list`, `<id> info`, `<id> pedidos [per_page= page= status= aveonline=0] [--json]`, `<id> pedido <n>`, `<id> log [TIPO]`. Solo tiendas Activas, con IA y con token.
- **UI:** colapsable «Aveonline» con 📋 (pegar token) y ＋. Cada tienda muestra estado, host y «vence en N min» (se refresca cada 30 s), interruptores y menú: pegar token nuevo, probar, últimos pedidos (modal con «⧉ IA» que copia la petición), editar, abrir la revisión por token en la tienda, abrir la tienda, copiar el comando y eliminar.
- **Exportar / importar:** grupo «Integraciones · Aveonline»; token solo cifrado (`secrets.ave`). Como duran minutos, lo normal es pegar uno nuevo tras importar.

## Retomar conversación (menú del proyecto)

- Botón ↺ y clic derecho en el nombre del proyecto → «Retomar conversación…»: modal con las conversaciones de claude de todas sus carpetas (`claude.conversations`), con tema, tu último mensaje, lo último que respondió la IA, fecha, tamaño e issues, y buscador. «↺ Retomar» abre una terminal de claude en esa carpeta con `claude --resume <id>`, con nombre «ISSUE · tema»; las que ya están abiertas en una terminal ofrecen «→ Ir».

## Pendientes (pestaña del panel derecho)

- Módulo `right.todos` (pestaña «Pendientes» del panel derecho): tareas locales del usuario en `local/pendientes/pendientes.json` (fuera de git; viaja en el zip). Cada una: `{id, title, descripcion, icon, priority (las 5 de las issues), estado (pendiente / en curso / bloqueado / hecho), depends: [ids], session: {sid, projectId, cwd, title, kind, agent}, created, updated}`.
- **Orden** (`todos.list`, `bridge/todos.js`): topológico; entre los que ya no esperan a nadie, por prioridad y antigüedad. Lo que depende de un pendiente abierto va después de él (`blockedBy`); lo hecho al final. Las dependencias no pueden formar ciclos; borrar uno lo quita de las dependencias de los demás.
- **Desde una sesión de IA:** `bridge/frap-todo.js` (skill `frap-pendientes`) `add` detecta su sesión de FRAP como `frap-team quien` y la guarda en `session`. El botón 📌 (arriba a la derecha de las terminales de IA, junto al chip de Equipo) escribe en la terminal la petición de guardar la última lista como pendientes, sin Enter. El bridge revisa el archivo cada 2 s y emite `{ev: 'todos'}` si cambió (la IA lo escribe sin pasar por el bridge).
- **Aviso al marcar hecho:** si el usuario marca un pendiente como hecho desde FRAP y su sesión de IA sigue abierta, se le escribe y envía un aviso («✅ Aviso de FRAP: … #N … Ya se pueden empezar: …» con los pendientes de esa sesión que quedaron libres). Si la sesión está cerrada, solo se avisa en pantalla. Lo que marca la propia IA con `frap-todo` no genera aviso.
- **UI:** pestaña «Pendientes»: estado (clic: cambiarlo), prioridad (clic: cambiarla), ícono, nombre y «→». «→» activa la sesión si sigue abierta (con su proyecto); si no, la reabre en su carpeta con `claude --resume <conversación>` y el pendiente queda con la sesión nueva. Filtros: solo este proyecto y mostrar hechos. Clic: detalle; doble clic o «Editar»: modal (nombre, ícono, prioridad, estado, descripción, dependencias, vincular a la sesión activa o desvincular). Clic derecho: editar, ir a la sesión, estados, nuevo que dependa de este, borrar.

## Mensajes (pestaña del panel derecho)

- Módulo `right.msgs` (pestaña «Mensajes»): los mensajes que la IA redacta para otras personas y los de pull requests, en `local/mensajes/mensajes.json` (fuera de git; viaja en el zip). Cada uno: `{id, tipo: 'persona'|'pr', titulo, texto, para, person, pr: {url, accion, numero}|null, session: {sid, projectId, cwd, title, kind, agent, icon, person}|null, estado: 'pendiente'|'enviado', copiedAt, created, updated, sentAt}`. `copiedAt`: cuándo lo copió el usuario (el botón queda «✓ Copiado» y lo cuenta el ✓✓ «marcar copiados como enviados»); se guarda, así sobrevive a recargas y reinicios. `para` es el nombre; `person`, su id en el Equipo si está. Acciones de PR: review, aprobado, cambios, comentario, merge, nuevo. El tema, si falta, es la primera línea del texto.
- **La IA** los guarda con `bridge/frap-msg.js` (skill `frap-mensajes`): `add --para … --texto …|-`, `pr --url … --accion …`, `list [--todos]`, `show`, `edit`, `enviado`/`pendiente`. Quedan vinculados a su sesión (como `frap-todo`). La skill `frap-equipo` le indica guardar ahí los mensajes. El bridge vigila el archivo (cada 2 s) y emite `{ev: 'msgs'}`. **Respaldo:** si una sesión de IA escribe en la terminal la ruta de un archivo dentro de `mensajes/` (como pedía antes `frap-equipo`), la UI lo importa con `msgs.importFile` vinculado a esa sesión; también `frap-msg import <archivo>`. Igual con los enlaces de PR que muestra (`msgs.importPr`; reemplaza al antiguo «🔀 Generar PR»): primero los archivos, luego los enlaces. No se importa lo que la IA **vuelve a imprimir**: el historial al adjuntar la terminal y lo que sale en el primer minuto y medio de una sesión (al retomarse con `claude --resume` tras reiniciar, la IA repite su conversación) quedan como «vistos»; y `msgs.importFile` solo importa archivos modificados en los últimos 30 min (`{skipped: 'viejo'}`).
- **UI:** pestaña «Mensajes» del panel derecho, con el número de pendientes y «＋ Nuevo». Filtros: persona, sesión (con su ícono y persona), solo personas o solo PR, «🗂 Sección» (solo las carpetas de la sección activa) y «✓ Enviados» (por defecto se ocultan). Cada mensaje: tipo/acción, tema, ícono de la sesión, destinatario, «↗ PR #n», «📋 Copiar» (formato de WhatsApp con el ícono y el nombre de la sesión arriba; se pone naranja) y ○/✓ enviado. Clic: el texto; doble clic: editar; clic derecho: copiar, copiar solo el texto, enviado/pendiente, editar, abrir PR, ir a la sesión (o reabrirla), borrar. Reemplaza el antiguo «📋 Copiar mensaje» y los botones de PR encima de «Hablar».

## Equipo: a quién está asignada cada sesión de IA

- Módulo `center.team`. Las personas (`{id, name, icon, role, descripcion}`) viven en `local/equipo/equipo.json` (fuera de git; viaja en el zip). Roles sugeridos: Jefe, Project manager, Desarrollador, QA, Diseño, Soporte, Cliente, Otro (se puede escribir uno propio).
- **Asignación:** en la meta de la sesión (`meta.person`, con `session.meta`), así sobrevive a recargas, al bridge y a reabrir terminales (va en `state.lastTerms`).
- **UI:** arriba a la derecha de cada terminal de IA (claude/codex/opencode, o una shell donde se detectó claude) un chip con la persona (ícono, nombre, rol) o «＋ Asignar sesión»; ambos abren el equipo por rol, con «Quitar asignación», «＋ Agregar persona…» (al crearla desde ahí queda asignada) y «👥 Ver equipo…» (modal: lista por rol, editar, quitar, formulario). El panel izquierdo muestra el ícono junto al nombre de la terminal.
- **Exportar / importar (.json):** grupo «Equipo» en la columna del panel izquierdo (`team: [{id, name, icon, role, descripcion, color}]`; al importar, `team.import` conserva el id y el mismo id se reemplaza) y cada terminal exportada lleva `person`, así se reabre asignada. El equipo se importa antes de reabrir las terminales.
- **IA:** `bridge/frap-team.js` (skill `frap-equipo`). `quien` sube por los procesos (`/proc/<pid>/stat`) hasta el pid de una sesión de FRAP (el helper `frap_pty.py`, cuya meta está en `<SOCK_DIR>/<sid>.json`; `sockDirFor` es común al bridge y al CLI) y muestra su persona. La skill pide consultarlo antes de redactar un mensaje para alguien y respetar su descripción (p. ej. no pedirle a quien no le gusta algo; eso se le dice al usuario).

## API: peticiones HTTP guardadas (vista del panel central)

- Como Postman, dentro de FRAP. Lanzador «API» (Alt+Shift+R, módulo `center.api`). Todo vive en `local/api/` (fuera de git; viaja en el zip de `local/`):
  - `<carpeta>/<nombre>.req.json`: la petición `{method, url, query: [{key, value, off?}], headers: […], body: {mode: none|json|text|urlencoded|form, text, form}, descripcion}`.
  - `<carpeta>/<nombre>.res.json`: la última respuesta (se guarda al enviar; cuerpo hasta 2 MB).
  - `<carpeta>/_carpeta.json`: `{variables, descripcion}` de la carpeta. `_globales.json` en la raíz: las globales.
- **Variables** `{{nombre}}` en URL, parámetros, cabeceras y cuerpo. Se buscan en la carpeta de la petición, luego en sus carpetas padre y por último en las globales (la más cercana gana). Dinámicas: `{{$timestamp}}`, `{{$isoDate}}`, `{{$uuid}}`, `{{$randomInt}}`. Las resuelve el bridge al enviar.
- **Envío** (`bridge/api.js`): http/https con la librería estándar, sigue hasta 5 redirecciones, descomprime gzip/deflate/br, 30 s de espera, lee hasta 10 MB; los binarios vuelven en base64. Acepta certificados propios en hosts locales o de red privada (como WordPress).
- **UI:** árbol de carpetas y peticiones (método en color, filtro, clic derecho: nueva petición o carpeta aquí, variables, duplicar, renombrar/mover, papelera, copiar el comando para la IA) y, a la derecha, pestañas con el editor (método, URL con la URL resuelta debajo y las variables sin definir, Parámetros, Cabeceras, Cuerpo, Descripción, Variables que ve la petición) y la respuesta (estado, tiempo, tamaño; Cuerpo formateado o sin formato, vista HTML sin scripts, imágenes; Cabeceras; lo Enviado). Ctrl+Enter envía (guarda antes), Ctrl+S guarda.
- **IA:** `bridge/frap-api.js` (skill `frap-api`): `list`, `new`, `run`, `show`, `vars`, `set-var`. La skill pide guardarlas en una carpeta con el ID de la issue o el nombre del proyecto, poner la URL base y los tokens en variables, y pedir visto bueno antes de peticiones que cambian datos. `vars` oculta las variables con nombre sensible (token, key, pass…).

## Gestión de issues (módulo interno)

- Replica dentro de FRAP el harness de tareas `_linear`. Cada issue vive en `local/issues/<ID>/` de la carpeta de FRAP, con `issue.md` (copia fiel del tracker), `changelog.md`, `status.md` y `final.md` al cerrar.
- `local/` está en el `.gitignore` de FRAP y además tiene su propio `.gitignore` con `*`. Ahí pueden ir más cosas locales en el futuro.
- Toda la lógica está en `bridge/issues.js`: plantillas, lista, importación, zip y skill, solo con la librería estándar. `bridge/frap-issues.js` es el CLI para agentes (`new`, `priority`, `list`, `path`, `dir`). `FRAP_LOCAL` cambia la carpeta (lo usan los tests).
- **Prioridad:** misma escala y formato que Linear, venga o no de Linear. Es la línea `- **Prioridad:** Urgent|High|Medium|Low|No priority` de `issue.md`.
  - `parsePriority` acepta inglés, español o el número de Linear (1–4, 0). Sin línea o con un valor que no se reconoce, la issue queda en "No priority".
  - `setPriority` reescribe esa línea, o la agrega bajo «Estado», siempre con la etiqueta en inglés.
  - Una issue local (sin tracker) se crea con un prefijo sin número (`new LOCAL "…"` → `LOCAL-1`, `LOCAL-2`…) o con `local: true`. Su `issue.md` dice que es local y empieza en Backlog con la prioridad elegida.
  - La skill explica cuándo usar cada prioridad. Las de Linear se copian tal cual; las locales se clasifican al crearlas y la IA dice cuál propone y por qué.
- **Skill `frap-issues`:** con el módulo activo, FRAP la instala o actualiza al conectar en `~/.claude/skills` y `~/.codex/skills`. Al apagar el módulo la quita, solo si es la suya.
  - La skill explica el flujo: tomar, trabajar, cerrar y fin de jornada.
  - Mientras se trabaja no se escribe en el tracker. Lo pendiente se anota en «📤 Por enviar a Linear» de `status.md` y se envía al cerrar o al final de la jornada, siempre mostrándolo antes al usuario.
- **Pestaña Issues (panel derecho):** lista Activas, Cerradas o Todas con buscador. Una issue cuenta como cerrada si tiene `final.md` o su «Estado general» dice terminada o cancelada. El badge 📤 muestra los pendientes por enviar.
  - Abre sus archivos en el editor de FRAP.
  - "Nueva" crea la carpeta y puede pedirle a la IA que la traiga.
  - Las issues se agrupan por prioridad en secciones plegables (Urgente, Alta, Media, Baja, Sin prioridad). Lo plegado se recuerda en `state.ui.issuesCollapsed`. El icono de cada tarjeta abre un menú para cambiar la prioridad.
  - "Nueva" permite elegir prioridad y marcar la issue como local (sin tracker).
  - "Retomar", "Cerrar" y "Fin de jornada" escriben el pedido en la terminal de IA del proyecto, sin Enter. Si no hay terminal de IA, lo copian al portapapeles.
  - ⇩ importa carpetas de un harness existente.
- **Zip:** en Exportar / importar, "Carpeta local (.zip)" descarga o restaura todo `local/` (issues, scripts con sus interruptores…, sin `node_modules`, que se reinstala con `bun install`) (`local.export` / `local.import`). El zip se escribe y se lee a mano (deflate de zlib y CRC32 propio). Al importar se descartan las rutas con `..`.

## Secciones del panel izquierdo

- Barra de chips arriba de las carpetas, como las listas de WhatsApp. `state.sections = [{id, icon, title, desc, display: 'both'|'icon'|'title', projects: [pid]}]` y `state.ui.section` guarda la elegida.
- La primera es siempre "Todas" (`id: 'all'`). Muestra todas las carpetas (y las terminales "Sin proyecto"), no guarda `projects` y no se puede eliminar, pero sí editar su ícono, título y cómo se ve.
- Una carpeta puede estar en varias secciones. Se asigna al editar la sección, al editar la carpeta (casillas "Secciones"), arrastrándola desde su asa ⠿ sobre el chip o creándola mientras la sección está elegida. El orden es el de `state.projects`.
- `ensureSections()` (en cada `renderProjects`) deja "Todas" primero y quita ids repetidos y carpetas que ya no existen. Al eliminar una carpeta también sale de las secciones.
- Cada chip muestra cuántas carpetas de la sección tienen avisos (amarillo: espera tu respuesta; verde: terminó). Se reordenan arrastrando el chip ("Todas" queda primera). Clic derecho: editar, mover y eliminar. Se exportan como parte de la configuración ("Secciones del panel izquierdo").

## Vistas por proyecto (git, DB, Archivos, Notas, Código)

- Como las terminales, cada proyecto tiene sus propias pestañas de Git, DB, Archivos (SFTP), Notas y Código, listadas en el panel izquierdo junto a sus terminales. Sid: `git:<projectId>`, `db:<projectId>`, `sftp:<projectId>`, `notes:<projectId>`, `code:<projectId>`. Una por tipo y proyecto: los launchers y Alt+Shift+G/D/F/N/E abren o enfocan la del proyecto activo. Requieren un proyecto.
- Persisten en `state.views = [{kind, projectId, open, data}]`. `data` es lo de cada vista (repo, conexión, SQL e historial, servidor y rutas). Cerrar la pestaña deja `open: false` y conserva `data`. Borrar el proyecto borra sus vistas.
- Hay un panel DOM por vista (`viewPanes`). `bindView(v)` hace que `state.git/db/sftp` apunten a `v.data` y `gitPane`/`dbPane`/`sftpPane`/`Git` a su panel y memoria, así el código de cada vista opera sobre "la enlazada". Lo asíncrono captura su panel (o `rt`) antes de esperar y no pinta si se cambió de vista. `gitAction` fija repo y memoria (`fn(g, pane)`), así una acción no salta de repo a mitad. La cola de transferencias SFTP es común a todas las vistas.
- Estados viejos (`git:main`, `state.git.open`…) se migran a la vista del proyecto activo (`migrateViews`).

## Notas (NOTES.md)

- La vista Notas edita `NOTES.md` de la primera carpeta del proyecto, solo con `fs.exists`, `fs.read` y `fs.write` (limitados a `FRAP_FS_ROOT`). Si el archivo no existe, muestra "Crear NOTES.md".
- Guarda solo 800 ms después de dejar de escribir, o con Ctrl+S. Antes de escribir compara el `mtime` del disco: si otro proceso (una IA) cambió el archivo, no lo pisa y muestra un aviso con "Usar la del disco" y "Guardar la mía".
- Mientras está visible lee el archivo cada 3 s y al volver el foco a la ventana. Si no hay cambios locales, trae lo que escribió la IA sin perder el cursor.
- git-ignore: solo aparece si la carpeta está en un repo (`git rev-parse`). Agrega o quita `/NOTES.md` del `.gitignore` de esa misma carpeta: los patrones son relativos a su `.gitignore`, así que funciona aunque la carpeta sea una subcarpeta del repo.
  - Activado por defecto (`views[].data.gitignore`). Se aplica al crear o guardar.
  - Si `NOTES.md` ya está versionado (`git ls-files --error-unmatch`), avisa que el `.gitignore` no lo saca del repo.
- IA: la skill `frap-notes` (`notes.installSkill`, en `~/.claude/skills` y `~/.codex/skills`) enseña a guardar ("guarda esto en notas": al final, en una sección con fecha, sin borrar lo que ya hay ni guardar secretos) y a leer ("lee las notas").
  - Se instala sola al crear el primer `NOTES.md`; el botón "🤖 IA" la reinstala.
  - Los prompts "Guardar en notas" y "Leer notas" se agregan una sola vez también a los estados existentes (`state.seeded`).

## Editor de código (vista "Código")

- Vista por proyecto (Alt+Shift+E o el lanzador `</>`): árbol de las carpetas del proyecto a la izquierda y hasta 4 paneles con pestañas (1, 2 o 3 columnas, o 2×2). Usa CodeMirror 5.65.18 empaquetado en `src/vendor/codemirror/` (script clásico, funciona en `file://`; lista de modos y addons en su README). Tema `cm-s-frap` en `index.css`.
- **Documentos:** un documento maestro por archivo (`CodeMirror.Doc`). Cada panel que lo muestra usa un `linkedDoc({sharedHist: true})`, así el mismo archivo en dos paneles comparte texto, historial y estado "sin guardar" (`isClean(gen)` sobre el maestro). Los archivos se leen y escriben con `fs.read` / `fs.write` (máx. 2 MB, dentro de `FRAP_FS_ROOT`). Binarios: solo aviso; imágenes, video, audio y PDF: visor automático con `file://` (ver "Vista previa de archivos").
- **Cambios en disco (IA):** mientras la vista está visible, cada 2,5 s y al volver el foco, `fs.stat` de los archivos abiertos. Si cambió el `mtime` y no hay cambios locales, recarga conservando cursor y scroll. Si hay cambios locales, aviso con "Usar la del disco" / "Guardar la mía" / "Decidir luego". Guardar también compara el `mtime` antes de escribir, para no pisar lo que escribió otro.
- **Persistencia:** `views[].data` = `{groups: [{tabs, active}], focus, expanded, side, hidden, wrap, cursors}`. Tras recargar vuelven las pestañas y la posición del cursor; el contenido se relee del disco. Cerrar la vista con cambios sin guardar pide confirmación y suelta su panel. Recargar la página con cambios sin guardar muestra el aviso del navegador.
- **Funciones:** Ctrl+S guardar (Ctrl+Alt+S todo), Ctrl+P abrir por nombre (difuso, admite `ruta:línea`; lista de `code.files`), Ctrl+Shift+F buscar en archivos (`code.search`), Ctrl+F / Ctrl+H buscar y reemplazar, Ctrl+G ir a línea, Ctrl+/ comentar, Ctrl+\\ dividir, Alt+Z ajuste de línea, Ctrl+Espacio autocompletar palabras, keymap de Sublime (Ctrl+D siguiente coincidencia, multicursor, mover/duplicar líneas), plegado, cierre de paréntesis y etiquetas. Arrastrar una pestaña a otro panel la mueve. Ctrl+W no se usa: el navegador cierra la pestaña sin dejar interceptarlo.
- **Árbol:** carga perezosa con `fs.list`; clic derecho: nuevo archivo/carpeta (`fs.write` / `fs.mkdir`), renombrar (`fs.rename`, las pestañas abiertas siguen al archivo), mover a la papelera (`fs.trash`: papelera de freedesktop, recuperable), copiar ruta, abrir terminal ahí, abrir en el editor externo.
- **Pasar contexto a la IA:** Ctrl+Alt+C copia `ruta:línea` o `ruta:inicio-fin` según la selección (Ctrl+Shift+Alt+C agrega el código en un bloque ```); Ctrl+Alt+I (o "Enviar a la IA") escribe `ruta:líneas ` sin Enter en la última terminal de claude/codex/opencode usada del proyecto, con la ruta relativa a su carpeta, y la enfoca.
- **Rutas clicadas en la terminal:** con `settings.editor = 'frap'` (por defecto) se abren en esta vista, en la línea y columna, en el proyecto de la terminal; una carpeta se revela en el árbol. Con otro valor (`code`, `cursor`…) van a `open.editor` como antes. `settings.extEditor` es el editor de "Abrir en…". Los estados existentes se migran una vez (`seeded: 'frap-editor'`).

## Vista previa de archivos (editor y Notas)

- **Con botón** "👁 Vista previa" (arriba a la derecha de cada panel del editor y en la barra de Notas; también Ctrl+Shift+V): `.md`, `.csv`/`.tsv`, `.svg` y `.html`. Alterna con el editor, se recuerda por archivo (`state.code.preview`, `state.notes.preview`) y se repinta al escribir o cuando una IA cambia el archivo.
- **Automática** (no se editan): imágenes, video, audio y PDF. Se cargan directo del disco como `file://` (el PDF con el visor de Chrome en un iframe).
- **Markdown:** renderizador propio (`mdBlocks` / `mdInline`, subconjunto de GFM) que arma nodos con `h()`, nunca HTML: el HTML crudo del .md se ve como texto. Las casillas `[ ]` se marcan en la vista previa del editor y de Notas: cada ítem recuerda su línea del archivo (también en listas anidadas y dentro de citas) y se cambia `[ ]` ⇄ `[x]` en esa línea. En Notas se autoguarda. Las imágenes relativas van como `file://`. Un enlace relativo se abre en el editor de FRAP (`#L12` = línea) y uno externo en otra pestaña. `javascript:` y similares no se enlazan.
- **CSV:** parser con comillas, detecta el separador (`,` `;` tab `|`) y muestra hasta 3000 filas.
  - En el editor las celdas son editables (`contenteditable`). Al confirmar (Enter, Tab o clic fuera) se vuelve a parsear el texto actual y se reemplaza **solo el campo crudo** de esa celda. Lleva comillas si lo necesita o si ya las tenía, y el resto del archivo queda igual byte a byte.
  - El número de fila da un menú para insertar o eliminar filas, y debajo de la tabla hay "+ fila".
  - Los cambios entran al documento como una edición normal: quedan sin guardar, se guardan con Ctrl+S desde la vista previa y se deshacen con Ctrl+Z.
  - No se repinta mientras hay una celda con el foco.
- **SVG:** `<img>` con un blob URL, donde el SVG no ejecuta scripts.
- **HTML:** iframe `srcdoc` con `sandbox="allow-scripts allow-forms allow-popups allow-modals"`, **sin `allow-same-origin`**. En Chrome todas las páginas `file://` comparten localStorage, donde está el token del bridge; con origen opaco la página no puede leerlo ni tocar a FRAP. Como ese origen tampoco puede cargar `file://`, `htmlInline` incrusta los recursos relativos: `<link stylesheet>` pasa a `<style>` (con sus `url()`), `<script src>` a inline, y las imágenes, íconos y posters a `data:`, leídos con `fs.read` (`encoding: 'base64'` para binarios).

## Voz (dictado a las IA)

- Es un módulo del panel derecho (`#voice-dock`), justo encima del reproductor; si el reproductor no está, queda abajo del todo. Solo funciona si la ventana activa es una terminal de claude, codex u opencode. Si no, avisa "Ventana no compatible con el sistema de voz" y no graba.
- **Grabación:** el navegador graba con `MediaRecorder`. Al detener (botón, o Alt+Shift+V; Esc descarta), decodifica el audio y lo remuestrea con `OfflineAudioContext` a un WAV PCM de 16 kHz mono, sin ffmpeg, y lo manda en base64 a `voice.transcribe`.
- **Transcripción:** el bridge escribe el WAV en un tmpdir propio (`mkdtemp`, archivo 0600), corre whisper.cpp (`-l <idioma> -nt -np -t <hilos>`) y borra el tmpdir. Limpia las marcas como `[BLANK_AUDIO]`. Todo es local: no usa red al transcribir.
- **Pegado:** el texto va a la terminal de IA activa al terminar, como `sendToTerminal(text, false)`, sin Enter, para revisarlo antes de enviarlo. Si al terminar ya no estás en una terminal de IA, el texto queda en el módulo para copiarlo o pegarlo después.
- **Motor:** `scripts/install-whisper.sh [tiny|base|small|medium]` compila whisper.cpp v1.7.2 con make/g++ (no necesita cmake) y baja el modelo. Todo queda en `FRAP_HOME/whisper` (`whisper-cli`, `ggml-*.bin`).
  - El binario se busca en `FRAP_WHISPER_BIN`, luego en `FRAP_HOME/whisper/whisper-cli` y luego `whisper-cli` en el PATH.
  - El modelo se busca en `FRAP_WHISPER_MODEL` y, si no, en esa carpeta, con preferencia small > base > medium > tiny.
- La Web Speech API no se usa: no existe en Brave ni en Chromium y manda el audio a Google.

## Rutas clicables

- Cada xterm registra un *link provider* (`pathLinkProvider`). Por cada fila, `logicalLine()` une las filas partidas (`isWrapped`) y arma un mapa índice → celda que respeta los caracteres anchos (emoji, CJK). `pathCandidates()` busca rutas con un `:línea:col` opcional, y `paths.check` filtra las que existen, con una caché de 15 s.
- El clic abre la ruta en el editor de FRAP (vista Código) o, si en Ajustes hay otro comando, llama a `open.editor`. Funciona aunque la app tenga el modo ratón activo, como Claude Code (`?1000h`…).

## Git

- La vista es solo UI sobre `git.run`. El bridge ejecuta el binario `git` con `GIT_TERMINAL_PROMPT=0` (si faltan credenciales falla en lugar de colgarse), `GIT_EDITOR=true` (sin editor en merges) y `color.ui=false`.
- `GIT_ALLOWED` limita los subcomandos a los de uso diario. `config`, `submodule`, hooks, etc. se rechazan, igual que las opciones que permiten ejecutar comandos arbitrarios (`-c core.sshCommand=…`, `--upload-pack`, `--exec`, `-C`, `--git-dir`).
- El status se lee con `git status --porcelain=v1 -b -z` (independiente del idioma). La vista se refresca cada 5 s mientras está visible y al volver el foco a la ventana.

## Alertas (antes «Temporizador»)

- Pestaña «Alertas» (`right.timers`; por compatibilidad, las claves siguen siendo `timers`). Cuatro tipos: **cada** cierto tiempo (`repeat`), **una vez dentro de** un rato (`once`), **una vez a una fecha y hora** (`at`: `date` + `time`) y **todos los días a una hora** (`daily`: `time` y `days` [0-6], vacío = todos). `timerNext` calcula el próximo disparo; las diarias se reprograman al siguiente día permitido. Una hora que ya pasó no se enciende.
- **IA:** interruptor «🤖 IA» en la cabecera. `alerts.set` guarda `{ai, module}` en `FRAP_HOME/alerts/ai.json` e instala la skill `frap-alertas` solo con ambos encendidos. La IA usa `bridge/frap-alert.js` (`ya`, `en 10m`, `a-las 15:30 [--fecha]`, `diaria 09:00 [--dias lun,…]`, `list`; `--bloquear`, `--icono`, `--desc`, `--sin-sonido`): deja la petición en `FRAP_HOME/alerts/inbox/` (si no está permitido, se niega). El bridge revisa la bandeja cada segundo y, si hay una UI conectada, la entrega como `{ev: 'alert', alert}` (si no, espera). La UI la muestra ya (`action: 'show'`) o la agrega a la lista (`create`, con la insignia 🤖 y la sesión que la pidió); el aviso trae «→ Ir a la sesión».
- Vive solo en la UI, en `state.timers`. Cada alerta guarda `nextAt` (marca de tiempo absoluta), así que sobrevive a recargas. Si al volver a abrir FRAP alguno ya venció, avisa una vez marcado como "atrasado" y se reprograma desde ese momento, sin acumular avisos.
- `tickTimers()` corre cada segundo. Dispara los vencidos y actualiza los contadores en el sitio, sin re-renderizar. Con la pestaña en segundo plano Chrome puede espaciar los timers, y el aviso puede llegar hasta ~1 min tarde.
- El aviso bloqueante es `#alarm`, por encima de modales y toasts. Quita el foco de xterm, atrapa el teclado (Tab cicla entre sus botones) y desactiva los atajos. Varios avisos simultáneos se ponen en cola.
- El sonido se genera con WebAudio, sin archivos.

## Bases de datos

- `bridge/db.js` es el núcleo compartido. Lee y escribe `FRAP_HOME/databases.env` (claves `FRAP_DB_<ID>_{NAME,ENGINE,HOST,PORT,USER,PASSWORD,DATABASE,UI_WRITE,ENABLED,AI}`, archivo 0600), clasifica el SQL y ejecuta con los clientes del sistema. No hay drivers npm.
  - **MySQL / MariaDB:** `mysql --xml --comments`. `--xml` distingue NULL de `'NULL'`. La contraseña va en un `--defaults-extra-file` temporal 0600, nunca en argv. El tiempo límite se fija con una sola sentencia compatible con los dos motores: `SET /*!50708 SESSION MAX_EXECUTION_TIME=… */ /*M!100108 SESSION max_statement_time=… */ @frap=1`. MySQL ignora `/*M!`, MariaDB ignora los `/*!5xxxx` de MySQL 5.7+, y `@frap` evita una sentencia vacía. Verificado con MySQL 8.0 y MariaDB 10.11.
  - **PostgreSQL:** `psql --csv` con un marcador de NULL. La contraseña va en `PGPASSWORD`.
  - **SQLite:** `sqlite3 -csv -safe`.
- La UI nunca recibe contraseñas: `db.list` y `db.save` devuelven `publicConn`.
- `bridge/frap-db.js` es el CLI de los agentes. Llama a `runQuery` sin `write`, así que siempre es solo lectura, sin ningún flag que lo cambie.
- Interruptores por conexión: `ENABLED=0` la desactiva (la UI y `frap-db` la rechazan; `db.test` sí funciona). `AI=0` la oculta a los agentes: `frap-db list` no la muestra y las consultas a ese id fallan. Si faltan, valen 1.
- Lo que hace la pestaña DB de la UI: cada consulta se intenta primero en solo lectura. Si la conexión tiene "Solo lectura" desactivado (`UI_WRITE=1`; por defecto está activado) y la consulta no es una lectura, la UI la valida con `db.check`, pide confirmación y la ejecuta con `write`. En ese modo `assertSafeWrite` solo deja pasar INSERT, UPDATE, CREATE y ALTER (además de lecturas). Nunca deja pasar eliminaciones (DELETE, DROP, incluido `ALTER … DROP`, TRUNCATE, DISCARD, REPLACE), rutinas o triggers (podrían esconder un DELETE), metacomandos (`\!`, `.shell`) ni `INTO OUTFILE`.

## Exportar / importar

Todo se arma en la UI (`openExport` / `openImport`) y se descarga como `frap-export-AAAA-MM-DD.json` (`format: "frap-export", version: 1`): `projects` (con `terminals: [{kind, title, cwd, sshId?}]`), `config` (prompts —con `icon`, `person` y `cat`—, promptCats, actions, pages, timers, music —solo YouTube—, settings) y, vía bridge, `db`, `ssh` y `secrets`. Las contraseñas nunca pasan por la UI en claro: `export.creds` las cifra e `import.creds` las descifra dentro del bridge.

## Avisos de agentes

Cada sesión recibe `FRAP_NOTIFY=<SOCK_DIR>/<sid>.notify`. Un hook del agente escribe ahí una línea `done` o `waiting <mensaje>`. El bridge vigila el directorio (`fs.watch`), consume el archivo, guarda `notice = {kind, msg, at}` en la sesión (va en `sessions.list`) y emite el evento `{ev: 'notice', sid, notice}`. La UI marca la terminal (✓ terminó / ● espera) y muestra el total en el título hasta que se abre; `session.seen` lo borra. Fuera de FRAP la variable no existe y el hook no hace nada.

Hooks de claude (`~/.claude/settings.json`):

```bash
# Stop
[ -n "$FRAP_NOTIFY" ] && echo done >> "$FRAP_NOTIFY"
# Notification (stdin trae {"message": …})
jq -r '.message' | { read -r m; [ -n "$FRAP_NOTIFY" ] && printf 'waiting %s\n' "$m" >> "$FRAP_NOTIFY"; }
```

## SSH

- `bridge/ssh.js` lee y escribe `FRAP_HOME/ssh.env` (claves `FRAP_SSH_<ID>_{NAME,HOST,PORT,USER,PASSWORD,KEY,DIR,ENABLED,AI}`, 0600) y arma los argumentos de `ssh`. Valida host y usuario (sin espacios ni `-` inicial) y pone `--` antes del destino para evitar inyección de opciones.
- `DIR` (ruta inicial, opcional): absoluta (`/var/www`) o del home (`~`, `~/app`), sin saltos de línea. En la terminal, `ssh -t … -- user@host "cd '<dir>' || echo …; exec \"${SHELL:-/bin/sh}\" -l"` (la ruta va entre comillas simples con `'\''`); si el cd falla, igual abre la shell. No se usa en `frap-ssh` (comandos de agentes) ni en `ssh.test`.
- Contraseña: `SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` apuntan a `FRAP_HOME/askpass.sh` (envoltorio que ejecuta `bridge/frap-askpass.js` con el mismo node). El askpass busca la contraseña por `FRAP_SSH_ID` en el `.env` y solo responde preguntas de contraseña o passphrase; cualquier otra (p. ej. confirmar una llave de servidor) la rechaza. `ssh.test` con un formulario sin guardar la pasa en `FRAP_SSH_PASS` a ese proceso corto.
- `ssh.connect` crea una sesión PTY normal (`meta.kind = 'ssh'`, `meta.sshId`) con `ssh` como comando, en el proyecto activo o en "Sin proyecto".
- **Archivos (SFTP)**: `bridge/sftp.js` ejecuta el binario `sftp` del sistema en modo batch (`-b -`, comandos por stdin) contra los mismos servidores. La UI muestra dos paneles tipo FileZilla, local y servidor, con una cola de transferencias que corren de a una. Detalles de seguridad:
  - `sftp -b` le agrega `BatchMode=yes` a ssh, y eso desactiva askpass. Como ssh se queda con el primer valor de cada opción, `-o BatchMode=no` va **antes** de `-b` cuando hay contraseña.
  - Se usa `-S <ssh del PATH>`: sftp llama a `/usr/bin/ssh` por ruta fija, y así respeta el mismo `ssh` que las terminales (y el falso de los tests).
  - Las rutas van escapadas con `\` y sin comillas (`sftp.quote`), así sftp no las parte en espacios ni expande comodines. Se rechazan saltos de línea, porque cada línea es un comando. Las rutas remotas siempre son absolutas (`remotePath`), así que nunca parecen opciones.
  - Las rutas locales quedan dentro de `FRAP_FS_ROOT` también después de resolver enlaces simbólicos (`sftpLocal`). Al descargar, el destino no puede ser un enlace.
  - `sftp.remove` borra archivos o carpetas **vacías** (`rmdir`), nunca de forma recursiva.
- `bridge/frap-ssh.js` (agentes): solo ve servidores con `ENABLED=1` y `AI=1`, ejecuta `ssh -T` sin terminal, con `BatchMode=yes` si no hay contraseña, y propaga el código de salida. `AI` vale 0 por defecto en servidores nuevos creados desde la UI.

## Protocolo

Cliente → bridge: `{ id?, op, args }`. Con `id` se responde `{ re: id, ok, data | error }`; sin `id` no se responde (se usa para input y resize).
Eventos bridge → cliente: `{ ev: 'out', sid, d }`, `{ ev: 'exit', sid, code }`, `{ ev: 'sessions' }` (la lista cambió).

| op | args | devuelve |
|---|---|---|
| `hello` | — | `{version, home, fsRoot, shell, platform, hostname, tools:{claude,codex,opencode}}` |
| `sessions.list` | — | `[{sid, pid, meta, created, lastOutput, alive, exitCode}]` (sin las que se están cerrando). `meta.agent = {tool: 'claude', session}`: la conversación de claude que corre en esa terminal, leída cada 15 s de `~/.claude/sessions/<pid>.json`; al reabrir terminales se retoma con `claude --resume <session>` |
| `session.create` | `{cwd, cols, rows, meta, init?, cmd?}` | info de la sesión |
| `session.attach` | `{sid}` | info + `buffer` (scrollback) |
| `session.input` | `{sid, data}` | — |
| `session.clear` | `{sid}` | `true` (vacía el historial del bridge y el de `frap_pty.py`: botón limpiar de shell/ssh) |
| `session.resize` | `{sid, cols, rows}` | — |
| `session.meta` | `{sid, meta}` | info (mezcla la meta) |
| `session.seen` | `{sid}` | `true`; borra el aviso (`notice`) de la sesión |
| `session.kill` | `{sid}` | `true`. Deja de listarla al instante (y lo guarda en su meta por si el bridge se reinicia); SIGHUP vía `frap_pty.py` y, si a los `FRAP_KILL_GRACE_MS` (4 s) sigue viva (claude captura SIGHUP y queda huérfano al morir la shell), SIGTERM y luego SIGKILL a su árbol y a toda su sesión de Unix |
| `ps` | — | `{sid: [{pid, ppid, etime, cpu, rss, args, depth}]}` |
| `proc.kill` | `{pid, signal?}` | solo descendientes de sesiones FRAP |
| `fs.list` | `{path, dirsOnly?, hidden?, details?}` | `{path, parent, entries:[{name, dir}]}`; con `details` cada entrada trae además `link, size, mtime` |
| `fs.read` | `{path, encoding?}` | `{path, content, mtime}` (≤ 2 MB). `encoding: 'base64'`: contenido binario en base64 (+ `encoding`) |
| `fs.write` | `{path, content}` | escritura atómica, crea los directorios |
| `fs.exists` | `{path}` | `bool` |
| `fs.roots` | — | `{main, extra: [{path, source: env\|file, exists}], file}`: carpetas que `fs.*` puede abrir |
| `fs.addRoot` | `{path}` | permite una carpeta extra (absoluta, existente, no del sistema: nunca `/`, `/etc`, `/usr`, `/var`…). Se guarda en `FRAP_HOME/fs-roots` (0600). `{path, already, roots}` |
| `fs.removeRoot` | `{path}` | deja de permitirla (solo las del archivo; las de `FRAP_FS_EXTRA` se quitan de la variable) |
| `fs.stat` | `{paths}` (máx. 500) | `[{path, exists, mtime?, size?, dir?}]` |
| `fs.mkdir` | `{path}` | `{path}`; falla si ya existe |
| `fs.rename` | `{from, to}` | `{path}`; no pisa un destino existente ni mueve la raíz |
| `fs.trash` | `{path}` | `{path, trashed}`: lo mueve a la papelera de freedesktop (`~/.local/share/Trash`, con `.trashinfo`); no borra |
| `code.files` | `{root}` | `{root, files: [relativas], truncated, git}`: en un repo, `git ls-files` (con no versionados, respeta `.gitignore`); si no, recorre carpetas saltando `node_modules`, `.git`… Máx. 20000 |
| `code.search` | `{root, query, regex?, caseSensitive?}` | `{root, results: [{file, line, col, text}], truncated}`: `git grep -F/-E … -e <query> --` en repos; si no, búsqueda en Node (sin binarios ni archivos > 1 MB). Máx. 500 |
| `config.scan` | `{folders}` | `{agents, skills, commands, hooks, memory}` |
| `state.get` / `state.set` | `{state}` | estado de la UI en `FRAP_HOME/state.json` |
| `db.list` | — | `{envFile, cli, clients, skills, conns}`; las conexiones van **sin contraseña** (`hasPassword`) |
| `db.save` | `{conn}` | crea, o edita si viene `id`; `password: null` conserva la guardada |
| `db.delete` | `{id}` | `true` |
| `db.test` | `{id}` o `{conn}` | `{ms, version}`; permite probar antes de guardar |
| `db.toggle` | `{id, enabled?, ai?, uiWrite?}` | conexión pública; cambia solo los interruptores (activa / uso por IA / `uiWrite=false` = "Solo lectura") |
| `db.check` | `{id, sql}` | `{write}` sin ejecutar: `false` si es lectura, `true` si es una escritura permitida (requiere `uiWrite`); error si no se permite (p. ej. DELETE/DROP) |
| `db.query` | `{id, sql, write?, limit?}` | `{columns, rows, rowCount, truncated, ms, readOnly}`; `write` solo si la conexión tiene `uiWrite` ("Solo lectura" desactivado) y pasa `assertSafeWrite` (sin eliminaciones) |
| `db.tables` | `{id}` | `[{name, view}]` |
| `paths.check` | `{cwd, paths}` | `[{input, path, dir}]` de las rutas que existen (las relativas se resuelven contra `cwd`; solo dentro de `FRAP_FS_ROOT`) |
| `open.editor` | `{path, line?, col?, editor?}` | abre en el editor sin shell; la familia VS Code recibe `--goto ruta:línea:col` |
| `open.folder` | `{path}` | abre en el explorador de archivos: una carpeta con `xdg-open`; un archivo, su carpeta con él seleccionado (`FileManager1.ShowItems` por D-Bus, si no `xdg-open` de la carpeta). macOS: `open` / `open -R`. `{opened, how}` |
| `git.release` | `{cwd, script: push-v\|deploy, kind: major\|minor\|patch, rid}` | `npm run <script> -- <kind>` en el repo, sin terminal (solo esos scripts, si existen en su package.json, y esos tres argumentos; sin stdin y `GIT_TERMINAL_PROMPT=0`). Emite la salida en vivo como `{ev: 'release', rid, d}`; resuelve `{code, ms}` |
| `git.findRepos` | `{paths, depth?}` | repos (carpetas con `.git`) dentro de las carpetas del proyecto, hasta 3 niveles (máx. 4), sin entrar en `node_modules`, `vendor`, `libs`… ni dentro de otro repo. La vista Git los ofrece en su selector |
| `git.run` | `{cwd, args}` | `{code, stdout, stderr}`; ejecuta `git` sin shell, solo subcomandos de `GIT_ALLOWED`, sin `-c`/`--upload-pack`/`--exec`…; un código distinto de 0 no lanza error |
| `music.ytInfo` | `{id}` | `{title, author}` vía oEmbed público de YouTube |
| `ssh.list` | — | `{envFile, cli, client, skills, hosts}` (sin contraseñas) |
| `ssh.save` | `{host}` | servidor público; `password: null` conserva la guardada |
| `ssh.delete` | `{id}` | `true` |
| `ssh.toggle` | `{id, enabled?, ai?}` | servidor público |
| `ssh.test` | `{id}` o `{host}` | `{ms, system}`; error con pista si falla |
| `ssh.connect` | `{id, cwd?, projectId?, cols, rows}` | info de la sesión nueva (rechaza si está desactivado) |
| `sftp.list` | `{id, path?}` | `{path, parent, entries:[{name, dir, link, size, mtime, perm, owner}]}`; sin `path` lista la ruta inicial (`DIR`) o, si no hay o no existe, la carpeta de inicio; en ese caso `startError` explica por qué |
| `sftp.get` | `{id, remote, local, dir?, tid?}` | `{local}`; descarga a la ruta local completa (dentro de `FRAP_FS_ROOT`); `dir` = `get -R` |
| `sftp.put` | `{id, local, remote, tid?}` | `{remote}`; sube un archivo o una carpeta (`put -R`) a la ruta remota completa |
| `sftp.cancel` | `{tid}` | `true` si había una transferencia con ese id en curso |
| `sftp.mkdir` | `{id, path}` | `true` |
| `sftp.rename` | `{id, from, to}` | `true` |
| `sftp.remove` | `{id, path, dir?}` | `true`; archivo (`rm`) o carpeta vacía (`rmdir`), nunca recursivo ni la raíz |
| `ssh.installSkill` | `{tools}` | escribe la skill `frap-ssh` en `~/.claude/skills` y `~/.codex/skills` |
| `voice.status` | — | `{ready, bin, model, dir, install}` (install = comando para instalar whisper.cpp) |
| `voice.transcribe` | `{audio, lang?}` | `{text, ms}`; `audio` = WAV en base64 (máx. ~10 min), `lang` = `es`, `en`… o `auto` |
| `notes.skill` | — | `{claude, codex}`: si la skill `frap-notes` está instalada |
| `notes.installSkill` | `{tools}` | escribe la skill `frap-notes` (guardar/leer `NOTES.md`) en `~/.claude/skills` y `~/.codex/skills` |
| `tunnel.status` | — | `{providers: {cloudflared, localhostrun, ngrok: {name, path}}, tunnels, binDir, install}` |
| `tunnel.ports` | — | servidores escuchando en el equipo (`ss -ltnp`), sin puertos no web, de las IA ni de FRAP: `[{port, host, pid, name, cmd, cwd}]` |
| `tunnel.start` | `{id, name, target: {type:'url', url\|port} \| {type:'path', path}, provider, password?, hostRewrite?, rewriteUrls?}` | arranca la puerta local y el proveedor; la URL pública llega en el evento `tunnel` |
| `tunnel.stop` | `{id}` | detiene el proveedor y cierra la puerta (también sus WebSocket) |
| `claude.conversations` | `{cwd, limit?}` | conversaciones de claude de esa carpeta (`~/.claude/projects/<carpeta con «-»>/<id>.jsonl`), las más recientes primero: `[{id, mtime, size, title (resumen o primer mensaje), first, last, lastAi, issues, skill, open: {sid, title} \| null}]`. Lee solo el principio (512 KB) y el final (256 KB) de cada archivo |
| `todos.list` | — | `{file, cli, skill, estados, todos: [… en orden, con n y blockedBy]}` |
| `todos.save` | `{todo: {id?, title, descripcion, icon, priority, estado, depends, session}}` | crea (sin id) o edita; valida prioridad, estado, dependencias y ciclos. Emite `{ev: 'todos'}` |
| `todos.delete` | `{id}` | lo borra y lo quita de las dependencias de los demás |
| `todos.skill` / `todos.setSkill` | — / `{on}` | estado / instala o quita la skill `frap-pendientes` |
| `alerts.status` | — | `{ai, module, allowed, cli, skill}` |
| `alerts.set` | `{ai?, module?}` | interruptor «IA» y pestaña encendida; instala o quita la skill `frap-alertas` (solo con ambos). Las peticiones de `frap-alert` llegan como `{ev: 'alert', alert: {id, action: 'show'\|'create', title, desc, icon, mode, sound, when?, session?}}` |
| `msgs.list` | — | `{file, cli, skill, acciones, mensajes: [… pendientes primero, más nuevos arriba]}` |
| `msgs.save` | `{msg: {id?, tipo, titulo, texto, para, person, pr: {url, accion}, session, estado}}` | crea (sin id) o edita; valida tipo, URL y acción del PR y estado (al pasar a enviado guarda `sentAt`). Emite `{ev: 'msgs'}` |
| `msgs.delete` | `{id}` | lo borra |
| `msgs.importPr` | `{url, session?, desc?}` | respaldo: la IA mostró un enlace de PR. Para crearlo (`compare/…`, `pull/new/…`, `-/merge_requests/new`, `pull-requests/new`) crea un mensaje «🆕 Crear PR» con la descripción `desc` (…/pr-*.md) como texto; para uno existente (`pull/N`…), uno de review. Una vez por URL (no duplica el importado de un archivo). `{msg, created}` |
| `msgs.importFile` | `{path, session?}` | respaldo: importa un mensaje que la IA dejó en un archivo `…/mensajes/*.md\|txt` (dentro de las raíces de `fs.*`): sin los comentarios HTML; con enlace de PR es tipo pr (acción por el nombre: approve, review, changes, comment, merge); persona por el nombre (`fecha-persona-tema`). Una vez por archivo (si cambió y sigue pendiente, actualiza el texto). `{msg, created}` |
| `msgs.skill` / `msgs.setSkill` | — / `{on}` | estado / instala o quita la skill `frap-mensajes` |
| `team.list` | — | `{file, cli, skill, roles, people: [{id, name, icon, role, descripcion}]}` |
| `team.save` | `{person: {id?, name, icon, role, descripcion}}` | crea (sin id; el id sale del nombre) o edita una persona |
| `team.delete` | `{id}` | la borra y la quita de las sesiones asignadas (`meta.person`) |
| `team.import` | `{people}` | importa personas de un export .json conservando su id (mismo id = se reemplaza). `{added, replaced}` |
| `team.skill` / `team.setSkill` | — / `{on}` | estado / instala o quita la skill `frap-equipo` |
| `api.tree` | — | `{dir, cli, skill, tree: [{name, path, type: folder\|request, method?, url?, hasRes?, vars?, children?}]}` |
| `api.read` | `{path}` | `{path, request, response}` (la última respuesta guardada o null) |
| `api.save` | `{path, request, create?}` | guarda (o crea) una petición normalizada |
| `api.mkdir` / `api.rename` / `api.delete` | `{path}` / `{from, to, type}` / `{path, type}` | carpetas y peticiones (con su respuesta); `delete` manda a la papelera |
| `api.vars` | `{folder?, path?}` | `{folder, variables, descripcion}` y, con `path`, `scope: {vars, from}` (lo que ve esa petición) |
| `api.setVars` | `{folder, variables, descripcion?}` | guarda las variables de una carpeta (`''` = globales); crea la carpeta si falta |
| `api.send` | `{path, request?, vars?, timeoutMs?}` | resuelve variables, envía y guarda la respuesta: `{path, request (enviada), response, missing}` |
| `api.skill` / `api.setSkill` | — / `{on}` | estado / instala o quita la skill `frap-api` |
| `scripts.list` | — | `{dir, enabled, bun, scripts: [{path, abs, folder, name, ext, runnable, runner, desc, size, mtime, user, ai}], folders: [{name, salida}]}` |
| `scripts.set` | `{path, user?, ai?}` | cambia los interruptores de un script (en `local/scripts/.frap-scripts.json`) |
| `scripts.create` | `{path, desc?}` | crea `local/scripts/<carpeta>/<nombre.ext>` con cabecera; interruptores encendidos |
| `scripts.command` | `{path}` | `{cwd, line, rel}` para ejecutarlo en una terminal de FRAP; falla si el módulo o «Usuario» están apagados |
| `scripts.skill` | — | `{claude, codex}`: `{installed, current, file}` de la skill `frap-scripts` |
| `scripts.setModule` | `{on}` | instala/quita la skill `frap-scripts` y habilita/bloquea `frap-scripts run` |
| `issues.list` | — | `{dir, local, issues: [{id, title, estado, priority, url, updated, closed, pending, files}]}` de `local/issues/` (`priority`: `urgent\|high\|medium\|low\|none`) |
| `issues.create` | `{id, title?, priority?, local?}` | crea `local/issues/<ID>/` desde las plantillas; si existe no toca nada. `id` sin número (`LOCAL`) numera solo y la marca local. `{id, dir, created, priority}` |
| `issues.setPriority` | `{id, priority}` | cambia la línea `**Prioridad:**` de `issue.md` (formato de Linear). `{id, priority, label}` |
| `wp.list` | — | `{envFile, cli, skill, sites: [{id, name, url, enabled, ai, hasToken, tokenHint}]}` (sin tokens) |
| `wp.save` | `{site: {id?, name, url, token?}}` | crea o edita una conexión WordPress; URL normalizada; token vacío al editar = conservar. Devuelve la conexión pública |
| `wp.toggle` | `{id, enabled?, ai?}` | interruptores Activa / IA |
| `wp.delete` | `{id}` | quita la conexión (el token sigue existiendo en el sitio hasta que venza o se revoque) |
| `wp.check` | `{id}` o `{site}` | `GET /info` del plugin: `{site, name, plugin, wordpress, woocommerce, now, token, resources, ms}` |
| `wp.skill` | — | `{claude, codex}`: `{installed, current, file}` de la skill `frap-wordpress` |
| `wp.setSkill` | `{on}` | instala/actualiza o quita (solo la de FRAP) la skill `frap-wordpress`. `{on, changed}` |
| `ave.list` | — | `{envFile, cli, skill, sites: [{id, name, url, enabled, ai, hasToken, tokenHint}]}` (sin tokens) |
| `ave.save` | `{site: {id?, name, type?, url, shop?, token?}}` | crea o edita una tienda Aveonline (`type`: `wordpress` o `shopify`; en Shopify `url` vacía = la app de producción); token vacío al editar = conservar |
| `ave.paste` | `{text, id?}` | «Pegar token»: saca URL, token y pedido del texto; actualiza la tienda (por URL o `id`) o la crea. `{site, created, order}` (sin token) |
| `ave.toggle` | `{id, enabled?, ai?}` | interruptores Activa / IA |
| `ave.delete` | `{id}` | quita la tienda de FRAP |
| `ave.check` | `{id}` o `{site}` | `GET /review/info` (o `log`, con plugin viejo): `{site, name, version, wordpress, woocommerce, now, expires, types, legacy, ms}` |
| `ave.orders` | `{id, query?}` | `GET /review/orders` (`per_page`, `page`, `status`, `aveonline`): `{page, per_page, orders: [...]}`. Solo WordPress |
| `ave.skill` / `ave.setSkill` | — / `{on}` | estado / instala o quita la skill `frap-aveonline` |
| `issues.importDir` | `{path}` | copia carpetas `<ID>/` de otra carpeta (o de su `issues/`) sin pisar las existentes. `{from, copied, skipped}` |
| `issues.skill` | — | `{claude, codex}`: `{installed, current, file}` de la skill `frap-issues` |
| `issues.setSkill` | `{on}` | instala/actualiza (`on`) o quita la skill `frap-issues` en `~/.claude/skills` y `~/.codex/skills`. `{on, changed}` |
| `local.export` | — | carpeta `local/` como .zip en base64 (entradas `local/…`, máx. 200 MB). `{data, files, bytes}` |
| `local.import` | `{data, overwrite?}` | restaura un .zip en `local/` (rutas saneadas; sin `overwrite` no pisa). `{written, skipped, rejected}` |
| `export.creds` | `{db: ids, ssh: ids, wp: ids, ave: ids, passphrase?}` | `{db, ssh, integrations: {wordpress, aveonline}, secrets?}` sin contraseñas ni tokens; con `passphrase` (≥6) van en `secrets` cifrados (scrypt + AES-256-GCM) |
| `import.creds` | `{db, ssh, wp, ave, secrets?, passphrase?}` | `{db, ssh, wp, ave, errors}`; mismo id se reemplaza; clave incorrecta → error; sin clave conserva la contraseña o el token existente (un sitio WordPress nuevo queda sin token) |
| `db.installSkill` | `{tools}` | escribe `~/.claude/skills/frap-db/SKILL.md` y `~/.codex/skills/frap-db/SKILL.md` |

## Dónde se busca la configuración (`config.scan`)

| | Usuario | Proyecto (cada carpeta) |
|---|---|---|
| Agentes | `~/.claude/agents/*.md`, `~/.config/opencode/agent(s)/*.md` | `.claude/agents/`, `.opencode/agent(s)/` |
| Skills | `~/.claude/skills/**/SKILL.md`, `~/.codex/skills/**` | `.claude/skills/**`, `.agents/skills/**` |
| Comandos | `~/.claude/commands/**/*.md`, `~/.codex/prompts/*.md`, `~/.config/opencode/command(s)/` | `.claude/commands/**`, `.opencode/command(s)/` |
| Hooks | `~/.claude/settings{,.local}.json` | `.claude/settings{,.local}.json` |
| Memoria | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md` | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` |

Al hacer clic en uno de estos archivos (`openEditor`), se abre en el **editor de código** si su módulo está activo. Si no, se abre en la modal de edición.
- Un archivo que aún no existe (skill nueva, memoria sin crear) se abre como pestaña sin guardar con su plantilla (`codeTemplates`) y se crea con Ctrl+S.
- Al guardar uno de estos archivos (`cfgFiles`) se valida el JSON y se refresca el panel.
