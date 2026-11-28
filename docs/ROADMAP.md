# Roadmap

## v1: base ✅

- [x] `src/index.html` + `index.css` + `index.js`, que funcionan con `file://`, sin build y con xterm.js en `src/vendor`
- [x] Bridge local sin dependencias (WebSocket propio, PTY vía Python), con token y bloqueo de Origins web
- [x] Panel izquierdo: proyectos con varias carpetas, terminales por proyecto, crear, renombrar y eliminar
- [x] Panel central: pestañas y lanzadores shell/claude/codex/opencode (`--add-dir` para las carpetas extra)
- [x] Terminales persistentes: sobreviven a recargar la página y se re-adjuntan con su scrollback
- [x] Shell y SSH: botones arriba a la derecha para limpiar (también vacía el historial guardado: no vuelve al recargar ni al reiniciar el bridge) y copiar todo el contenido de la terminal
- [x] Ícono por sesión (al renombrarla con doble clic): se ve después del punto de estado en el panel izquierdo y en la pestaña, encabeza los mensajes copiados, y se conserva al reabrir y en el export
- [x] Mensajes copiados listos para WhatsApp: título «📌 *nombre de la sesión*» en negrita y el Markdown convertido al formato de WhatsApp
- [x] El botón del mensaje dice para quién es («Copiar mensaje para Andrés»), sacado del propio mensaje (cómo lo presenta la IA o el nombre del archivo), nunca de la persona asignada a la sesión
- [x] Al copiar un mensaje, va primero el nombre de la sesión (el del panel izquierdo) y un salto de línea
- [x] Varios mensajes en una respuesta: un botón por mensaje con «persona · tema» (como los presenta la IA o según el nombre del archivo), cada uno se copia y marca por separado
- [x] Mensajes y PR detectados se muestran encima de «Hablar», solo para la sesión de IA activa; copiar pasa a naranja «✓ Mensaje copiado» (se puede volver a copiar) y un mensaje nuevo vuelve a verde
- [x] Terminales: los enlaces de pull/merge request dan un botón «🔀 Generar PR · rama → base» o «↗ Abrir PR #N» (GitHub, GitLab, Bitbucket) que abre el enlace en otra pestaña
- [x] Terminales de IA: si la respuesta trae la ruta de un mensaje listo (mensajes/…md), aparece «📋 Copiar último mensaje»; la skill frap-equipo guarda así los mensajes
- [x] Pendientes: al marcar uno como hecho, su sesión de IA (si sigue abierta) recibe un aviso con lo que quedó desbloqueado
- [x] Módulo «Mensajes» (pestaña del panel derecho): mensajes para personas y de PR (review, aprobado, cambios, comentario, merge) que la IA guarda con `frap-msg` (skill `frap-mensajes`), vinculados a su sesión; filtros por persona, sesión, tipo, sección y enviados; editar, copiar (WhatsApp) y marcar enviado. Reemplaza el «Copiar mensaje» encima de «Hablar»
- [x] Notas: cada sección guardada por la IA lleva el ícono y el nombre de su sesión (`frap-team sesion`); la skill frap-notes se actualiza sola al arrancar el bridge
- [x] 📱 Módulo «Remoto»: FRAP desde el celular con un QR (Wi-Fi local o túnel), clave nueva en cada encendido, apagado sin uso (5 min por defecto), conectados (sacar/bloquear) y bloqueados; página móvil con sesiones, chat de la IA (permisos, segundo plano, mensajes guardados) y Mensajes
- [x] 📖 En la vista de lectura: barra con el estado de claude y los procesos en segundo plano (⏳/✓, resumen y «Ver salida»)
- [x] 📖 En la vista de lectura: «escribiendo…» mientras claude trabaja y los menús de claude (permisos, preguntas) como tarjeta con un botón por opción
- [x] 📖 Vista de lectura de las sesiones de claude (botón en la franja de arriba): mensajes en cajas con markdown, procesos plegados con solo su título (clic: comando y resultado), en vivo, y un campo para escribirle; ⌨ vuelve a la terminal
- [x] Importar el JSON no duplica terminales: las que ya están abiertas (misma conversación de claude, o mismo tipo, carpeta y nombre) salen «ya abierta» y sin marcar, y una conversación de IA ya abierta nunca se reabre
- [x] Pendientes: filtro por sesión (selector con el ícono de la sesión y su persona, incluidas las cerradas y «Sin sesión»); cada pendiente muestra el ícono y la persona de su sesión
- [x] Pestañas del panel derecho con ícono; doble clic para editar ícono, título y descripción (se ve al pasar el ratón); arrastrar para ordenarlas. Se guarda en `state.rtabs` y viaja en el export .json («Pestañas del panel derecho»)
- [x] Módulo «Pendientes» (pestaña del panel derecho): tareas locales con prioridad, estado, ícono, descripción y dependencias, en orden (lo que espera va después de aquello de lo que depende), vinculadas a su sesión de IA con «→» para volver a ella (o reabrirla con su conversación); la IA los guarda con la skill `frap-pendientes` (📌 en la terminal de IA)
- [x] Módulo «Equipo»: personas (nombre, ícono, rol, descripción) y cada sesión de IA asignada a una (chip arriba a la derecha de la terminal, menú por rol, modal del equipo); la IA lo lee con la skill `frap-equipo` (`frap-team quien` encuentra su sesión por el árbol de procesos) y escribe para esa persona respetando su descripción
- [x] Equipo en el export .json (personas con rol, ícono, color y descripción) y la persona asignada a cada terminal: al importar vuelve el equipo y las terminales se reabren asignadas
- [x] Vista «API» (como Postman): peticiones HTTP guardadas en local/api con carpetas, variables por carpeta y globales ({{var}}), cuerpo JSON/texto/formularios, última respuesta guardada, árbol con clic derecho, Ctrl+Enter; CLI `frap-api` y skill `frap-api` para que la IA guarde sus peticiones en la carpeta de la issue o del proyecto; viaja en el zip de local/
- [x] Git: las URL de la pestaña Salida son enlaces (p. ej. el pull/new/rama que da git push); en Ramas, la principal del remoto va primero con su color y la actual segunda
- [x] Git: clic derecho en las ramas (locales y remotas): cambiar, abrir en línea, crear pull/merge request (GitHub, GitLab, Bitbucket), fusionar en la actual, comparar (commits de cada lado y diff --stat), crear rama desde aquí, renombrar, publicar (push -u), copiar nombre, eliminar (-d / -D) y eliminar del remoto
- [x] Git: botón «↗ Repo» que abre el remoto (origin, o el primero) en el navegador; convierte URLs ssh (git@host:u/r.git) a https y nunca abre un token embebido
- [x] Git: clic derecho en los archivos con cambios: ver diff, abrir en el editor de código, explorador o editor externo, copiar ruta, enviar a la IA, agregar/quitar/descartar, historial del archivo (git log --follow) y git blame
- [x] Git: el selector incluye los repos de subcarpetas (la carpeta del proyecto puede no tener git) y 🔍 vuelve a buscarlos; botón «🚀 Versión X.Y.Z» si el repo tiene `npm run push-v` (o `deploy` con bump-version): modal patch/minor/major con la versión siguiente y aviso de cambios sin commit; se ejecuta en el bridge y su salida aparece en vivo en la pestaña «Salida» de Git
- [x] «Retomar conversación…» (↺ o clic derecho en el proyecto): lista las conversaciones de claude de sus carpetas con tema, último mensaje, respuesta de la IA e issues, con buscador; las reabre con claude --resume o lleva a la terminal donde ya están abiertas
- [x] Reabrir terminales tras reiniciar: cada terminal de claude retoma SU conversación (`claude --resume <id>`, leído de `~/.claude/sessions/<pid>.json`), no la última de la carpeta
- [x] Cerrar una terminal (✕) la cierra de verdad aunque el programa capture SIGHUP (claude): escalada a SIGTERM/SIGKILL de toda su sesión; ya no reaparece al recargar
- [x] Terminales: se repintan al volver a mostrarse, tras re-adjuntar (recargar la página o el bridge), al cargar la fuente y al volver a la pestaña; al re-adjuntar se manda un SIGWINCH (tamaño de ida y vuelta) para que claude/codex se redibujen enteras
- [x] Terminales: el nombre que pone el usuario (doble clic) ya no lo pisa el título que cambian claude/codex; ese título queda en el tooltip. Nombre vacío = vuelve al título automático
- [x] Cada sección del panel izquierdo recuerda su proyecto y ventana abierta (y cada proyecto su última ventana): al cambiar de sección vuelve a ellas
- [x] Barra de secciones en una sola fila con scroll (rueda del ratón) y un ＋ fijo a la derecha con menú: abrir carpeta (nuevo proyecto) o crear sección. Sin el ＋ de la cabecera
- [x] Carpetas fuera de la carpeta personal (p. ej. /var/www): el selector ofrece permitirlas y muestra accesos a cada una; `FRAP_FS_EXTRA` o `FRAP_HOME/fs-roots`; nunca carpetas del sistema
- [x] Editor: arrastrar archivos lo abre: desde el gestor de archivos (con su ruta file:// si el navegador la da; si no, se busca en el proyecto por nombre y tamaño, y si no está se abre como nuevo sin guardar en la carpeta del proyecto) o desde el árbol a un panel concreto. Soltar un archivo fuera ya no saca de FRAP
- [x] Editor: Ctrl+clic (Cmd en Mac) en una URL la abre en una pestaña del navegador; con Ctrl pulsado se subraya. Fuera de una URL, Ctrl+clic sigue agregando cursores
- [x] Editor: una ruta de carpeta (clic en la terminal, o «Ver sus archivos» en el árbol) se abre como pestaña 📁 con su contenido (miniaturas de imágenes, ↑, terminal, explorador); si está fuera del proyecto, aparece como raíz aparte en el árbol
- [x] Panel derecho:
  - [x] Procesos: árbol por terminal con CPU, memoria y tiempo, agentes resaltados, matar proceso
  - [x] Prompts estándar: clic para ejecutar en la terminal activa, insertar sin Enter, variables, importar y exportar
  - [x] Prompts con ícono, persona del equipo y categorías (con ícono): en el panel derecho salen agrupados en bloques plegables, con «Sin categoría» al final; 🗂 para administrar las categorías
  - [x] Agentes, skills y comandos (claude/codex/opencode, usuario y proyecto): listar, editar y crear desde plantilla
  - [x] Hooks de Claude Code: listar, agregar, eliminar y editar el JSON
  - [x] Memoria: CLAUDE.md, AGENTS.md y settings.json (crear si faltan)
- [x] Estado en localStorage + `~/.config/frap/state.json`
- [x] Harness: `npm run check` (chequeos estáticos + tests de integración), CLAUDE.md y docs

## v1.1: pulido

- [x] Acciones: comandos con nombre e interruptor encender/apagar (VPN…), patrón de "lista", log e indicador en la barra de estado
- [x] Páginas: accesos nombre + URL, abrir en pestaña del navegador (por defecto) o pestaña interna (iframe), modo por página y global
- [x] Bases de datos: conexiones en `.env` (0600), pestaña DB (tablas, editor, resultados, historial, CSV), CLI `frap-db` de solo lectura para agentes y skill para claude/codex
- [x] Exportar / importar configurable: proyectos y terminales, configuración, BD y SSH (contraseñas cifradas), reabrir terminales retomando la conversación
- [x] Avisos de agentes: hooks → `$FRAP_NOTIFY` → marca ✓ terminó / ● espera en el panel izquierdo y contador en el título
- [x] SSH: servidores en `ssh.env` (0600), terminal conectada con askpass, prueba con pistas, interruptores activo / uso por IA, CLI `frap-ssh` y skill para agentes
- [x] Archivos por SFTP (tipo FileZilla) sobre los servidores SSH: dos paneles local/servidor, subir/descargar archivos y carpetas (botones, doble clic o arrastrar), cola con cancelar, crear carpeta, renombrar y eliminar (carpetas solo vacías). Pestaña "Archivos" (Alt+Shift+F)
- [x] SSH: ruta inicial opcional por servidor (la terminal hace `cd` ahí y el gestor SFTP abre ahí; botón ⌂ para volver)
- [x] SFTP: clic derecho en ambos paneles. Local: editar en el editor de código, abrir carpeta, subir al servidor, nuevo archivo/carpeta, renombrar (F2), papelera (Supr), copiar ruta, enviar a la IA, terminal aquí, túnel, explorador y editor externo. Servidor: descargar, nueva carpeta, renombrar, eliminar, copiar ruta
- [x] Proyectos con descripción y URL: ojo 👁 con tooltip (nombre + descripción, se puede ocultar) y botón 🌐 que abre la URL en otra pestaña
- [x] Git, DB y Archivos (SFTP) por proyecto, como las terminales: cada carpeta del panel izquierdo tiene los suyos (repo, conexión y servidor propios) y se administran al cambiar de carpeta
- [x] Tras apagar o reiniciar el equipo, ofrecer reabrir las terminales que estaban abiertas (foto en el estado), retomando la conversación de cada IA
- [x] Notas por carpeta (`NOTES.md`): vista con editor y autoguardado, switch de git-ignore (activado por defecto), skill `frap-notes` y prompts "Guardar en notas" / "Leer notas" para que la IA guarde y lea contexto
- [x] Pantalla dividida ajustable: divisores arrastrables entre paneles (alto de las filas y ancho de las columnas de cada fila), con ícono de 2 flechas al pasar el mouse; doble clic vuelve a 50/50; las proporciones se recuerdan
- [x] Reordenar arrastrando (asa ⠿) en el panel izquierdo: proyectos, y terminales y vistas dentro de su proyecto. El orden lo siguen las pestañas, Alt+1…9, la pantalla dividida (toma las primeras 4) y la reapertura tras apagar
- [x] Carpetas colapsables (▾/▸ junto a editar): colapsada muestra cuántos elementos tiene y, si una terminal avisa (claude terminó / espera respuesta), la carpeta muestra el aviso y cambia de color; clic en el aviso abre esa terminal
- [x] Módulo interno "Scripts": scripts en `local/scripts/<carpeta>/` con interruptores Usuario / IA (como las BD), ejecutar en una terminal de FRAP, crear con cabecera, skill `frap-scripts` (la IA crea los scripts ahí y solo los ejecuta con `frap-scripts run`) y viaja en el zip de local/
- [x] Túneles (panel derecho): compartir por URL pública un puerto, una IP de la red o un archivo/carpeta, con contraseña opcional, reescritura de Host/URLs, WebSocket (HMR), servidores detectados y proveedores cloudflared / localhost.run (ssh) / ngrok
- [x] Módulo interno "Gestión de issues": issues en `local/issues/<ID>/` (fuera de git) como el harness `_linear`, skill `frap-issues` para claude/codex (se instala/quita con el módulo), pestaña Issues y zip de la carpeta local en exportar/importar
- [x] Prioridad de issues con la escala y el formato de Linear (también para issues locales sin tracker, `LOCAL-N`): secciones plegables por prioridad, cambio desde la tarjeta, `frap-issues priority` y criterios en la skill
- [x] Módulo Integraciones (panel izquierdo) con WordPress: plugin `frap-wordpress` (tokens de 24 h por defecto con permisos por recurso, solo lectura por defecto, API `frap/v1`, publicación en repo propio con git subtree), conexiones con interruptores Activa/IA, CLI `frap-wp` y skill `frap-wordpress`
- [x] Issues: «In Review» (o «En revisión») en el estado general cuenta como cerrada en local, con la marca 👀 In Review; `frap-issues list` la muestra como «en revisión» y la skill indica cómo escribir ese estado
- [x] Integraciones · Aveonline: tiendas con la revisión por token del plugin de envíos (solo lectura), «Pegar token» con el texto tal como se comparte, vencimiento en vivo, últimos pedidos, CLI `frap-ave` (info, pedidos, pedido con tramas, log) y skill `frap-aveonline`, export/import con token cifrado. En el plugin: rutas `/review/info` y `/review/orders`
  - [x] Tipo de tienda (WordPress o Shopify): las de Shopify usan la revisión por token de la app Aveonline Connect (log y pedido con tramas de cotización y CRM)
- [x] Módulos (Ajustes → Módulos): activar o desactivar cada lanzador, pestaña del panel derecho, la voz, la pantalla dividida y las secciones, agrupados por panel; todo activado por defecto y se exporta/importa
- [x] Vista previa de archivos en el editor y en Notas: botón para Markdown, CSV, SVG y HTML (sandbox con recursos incrustados); imágenes, video, audio y PDF se abren directo en su visor
- [x] Secciones en el panel izquierdo (como WhatsApp): "Todas" fija y secciones propias con ícono, título, descripción y vista (solo ícono, solo título o ambos); una carpeta puede estar en varias, se asignan arrastrando o con casillas, y cada chip muestra los avisos de sus carpetas
- [x] Editor de código por carpeta (vista "Código", Alt+Shift+E, CodeMirror 5 local): árbol de archivos, varias pestañas, hasta 4 paneles, Ctrl+P, buscar en archivos, guardar con aviso si una IA cambió el archivo (y recarga sola si no hay cambios locales), copiar `ruta:línea(s)` y enviarla a la IA; las rutas clicadas en la terminal se abren aquí en vez de VS Code
- [x] Módulo de voz (panel derecho, sobre el reproductor): dictar a claude / codex / opencode con whisper.cpp local (`scripts/install-whisper.sh`); el texto se pega sin Enter en la terminal de IA activa; en otras ventanas avisa que no es compatible
- [x] Interruptores por conexión de BD: activa / uso por IA (`db.toggle`; `frap-db` solo ve las habilitadas)
- [x] Interruptor "Solo lectura" por conexión (activado por defecto). Desactivado, la pestaña DB puede ejecutar INSERT, UPDATE, CREATE y ALTER con confirmación (`db.check` + `assertSafeWrite`), pero nunca DELETE, DROP ni TRUNCATE. Los agentes siguen siempre en solo lectura
- [x] Música: archivos (IndexedDB) y YouTube (relé `/yt-player`), bucle (lista/canción), aleatorio sin repetir, arrastrar para reordenar, dock persistente y teclas multimedia
- [x] Logos de claude, codex, opencode y DB en lanzadores, pestañas y panel izquierdo; favicon propio
- [x] «Temporizador» pasa a «Alertas»: además de cada X / dentro de X, a una fecha y hora y todos los días (o ciertos días) a una hora; la IA puede mostrar o programar alertas con `frap-alert` (skill `frap-alertas`) si se enciende el interruptor «🤖 IA»
- [x] Temporizador: recordatorios recurrentes o de una vez, aviso simple o bloqueante (posponer), ícono/título/descripción, plantillas, sonido y notificación del sistema
- [x] Git guiado: status, add/restore, commit (y push), ramas (checkout, checkout -b, track remoto, borrar), fetch/pull/push, stash, diff, historial, comandos libres con salida visible
- [x] Terminales persistentes de verdad: sobreviven a reiniciar o perder el bridge (procesos desligados + socket Unix + historial propio); la UI se reconecta sola
- [x] Rutas de archivos clicables en la terminal → abrir en VS Code (línea y columna), con rutas partidas y caracteres anchos
- [x] Aviso de bridge desactualizado (el bridge anuncia sus operaciones)
- [ ] Paneles redimensionables arrastrando el borde
- [ ] Buscar en la terminal (xterm addon-search vendorizado)
- [ ] Notificación del navegador cuando un agente termina o pide atención (pasa de activo a inactivo)
- [x] Pantalla dividida: botón con contador (1 → 2 → 3 → 4 → 1) que muestra a la vez las primeras 4 terminales del proyecto (shell, agentes, ssh; no git ni DB), con borde en la activa y marcas de grupo en el panel izquierdo y pestañas
- [ ] Paleta de comandos (Ctrl+K): proyectos, prompts, lanzadores
- [ ] Prompts por proyecto, además de los globales
- [ ] Tema claro

## v2: integración profunda con agentes

- [ ] Leer las sesiones de Claude (`~/.claude/projects/*.jsonl`) para mostrar el historial y reanudar (`claude --resume`)
- [ ] Mostrar los subagentes y tareas en curso de una sesión de Claude (no solo procesos del SO)
- [ ] Skills, agentes y comandos de plugins (`~/.claude/plugins`)
- [ ] DB: autocompletado de tablas y columnas en el editor, varias pestañas DB, SQL Server y MongoDB
- [ ] Música: importar playlists de YouTube, varias listas, ecualizador
- [ ] Alertas: horario activo (p. ej. solo de 9 a 18 h), estadísticas de cumplimiento
- [ ] MCP servers: listar y editar (`.mcp.json`, `~/.claude.json`, `~/.codex/config.toml`)
- [ ] Git: stage por líneas (hunks), resolver conflictos, generar el mensaje de commit con claude
- [ ] Lanzar con worktrees: un agente por rama en paralelo

## Ideas

- Grabación y reproducción de sesiones (asciicast)
- Bridge remoto vía túnel SSH (`ssh -L 7681:127.0.0.1:7681`)
- Sincronizar los prompts estándar con un repo
