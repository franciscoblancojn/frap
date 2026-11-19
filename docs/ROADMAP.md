# Roadmap

## v1: base ✅

- [x] `src/index.html` + `index.css` + `index.js`, que funcionan con `file://`, sin build y con xterm.js en `src/vendor`
- [x] Bridge local sin dependencias (WebSocket propio, PTY vía Python), con token y bloqueo de Origins web
- [x] Panel izquierdo: proyectos con varias carpetas, terminales por proyecto, crear, renombrar y eliminar
- [x] Panel central: pestañas y lanzadores shell/claude/codex/opencode (`--add-dir` para las carpetas extra)
- [x] Terminales persistentes: sobreviven a recargar la página y se re-adjuntan con su scrollback
- [x] Panel derecho:
  - [x] Procesos: árbol por terminal con CPU, memoria y tiempo, agentes resaltados, matar proceso
  - [x] Prompts estándar: clic para ejecutar en la terminal activa, insertar sin Enter, variables, importar y exportar
  - [x] Agentes, skills y comandos (claude/codex/opencode, usuario y proyecto): listar, editar y crear desde plantilla
  - [x] Hooks de Claude Code: listar, agregar, eliminar y editar el JSON
  - [x] Memoria: CLAUDE.md, AGENTS.md y settings.json (crear si faltan)
- [x] Estado en localStorage + `~/.config/frap/state.json`
- [x] Harness: `npm run check` (chequeos estáticos + tests de integración), CLAUDE.md y docs

## v1.1: pulido

- [x] Acciones: comandos con nombre e interruptor encender/apagar (VPN…), patrón de "lista", log e indicador en la barra de estado
- [x] Páginas: accesos nombre + URL, abrir en pestaña del navegador (por defecto) o pestaña interna (iframe), modo por página y global
- [x] Bases de datos: conexiones en `.env` (0600), pestaña DB (tablas, editor, resultados, historial, CSV), CLI `frap-db` de solo lectura para agentes y skill para claude/codex
- [x] Interruptores por conexión de BD: activa / uso por IA (`db.toggle`; `frap-db` solo ve las habilitadas)
- [x] Música: archivos (IndexedDB) y YouTube (relé `/yt-player`), bucle (lista/canción), aleatorio sin repetir, arrastrar para reordenar, dock persistente y teclas multimedia
- [x] Logos de claude, codex, opencode y DB en lanzadores, pestañas y panel izquierdo; favicon propio
- [x] Temporizador: recordatorios recurrentes o de una vez, aviso simple o bloqueante (posponer), ícono/título/descripción, plantillas, sonido y notificación del sistema
- [x] Git guiado: status, add/restore, commit (y push), ramas (checkout, checkout -b, track remoto, borrar), fetch/pull/push, stash, diff, historial, comandos libres con salida visible
- [x] Terminales persistentes de verdad: sobreviven a reiniciar o perder el bridge (procesos desligados + socket Unix + historial propio); la UI se reconecta sola
- [x] Rutas de archivos clicables en la terminal → abrir en VS Code (línea y columna), con rutas partidas y caracteres anchos
- [x] Aviso de bridge desactualizado (el bridge anuncia sus operaciones)
- [ ] Paneles redimensionables arrastrando el borde
- [ ] Buscar en la terminal (xterm addon-search vendorizado)
- [ ] Notificación del navegador cuando un agente termina o pide atención (pasa de activo a inactivo)
- [ ] Split de terminales (2 en paralelo en el panel central)
- [ ] Paleta de comandos (Ctrl+K): proyectos, prompts, lanzadores
- [ ] Prompts por proyecto, además de los globales
- [ ] Tema claro

## v2: integración profunda con agentes

- [ ] Leer las sesiones de Claude (`~/.claude/projects/*.jsonl`) para mostrar el historial y reanudar (`claude --resume`)
- [ ] Mostrar los subagentes y tareas en curso de una sesión de Claude (no solo procesos del SO)
- [ ] Skills, agentes y comandos de plugins (`~/.claude/plugins`)
- [ ] DB: autocompletado de tablas y columnas en el editor, varias pestañas DB, SQL Server y MongoDB
- [ ] Música: importar playlists de YouTube, varias listas, ecualizador
- [ ] Temporizador: horario activo (p. ej. solo de 9 a 18 h), días de la semana, estadísticas de cumplimiento
- [ ] MCP servers: listar y editar (`.mcp.json`, `~/.claude.json`, `~/.codex/config.toml`)
- [ ] Git: stage por líneas (hunks), resolver conflictos, generar el mensaje de commit con claude
- [ ] Lanzar con worktrees: un agente por rama en paralelo

## Ideas

- Grabación y reproducción de sesiones (asciicast)
- Bridge remoto vía túnel SSH (`ssh -L 7681:127.0.0.1:7681`)
- Sincronizar los prompts estándar con un repo
