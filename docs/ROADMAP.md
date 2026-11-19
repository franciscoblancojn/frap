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
- [x] Harness: `npm run check` (chequeos estáticos + 13 tests de integración), CLAUDE.md y docs

## v1.1: pulido

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
- [ ] MCP servers: listar y editar (`.mcp.json`, `~/.claude.json`, `~/.codex/config.toml`)
- [ ] Git por proyecto: rama, cambios y diff en el panel derecho
- [ ] Lanzar con worktrees: un agente por rama en paralelo

## Ideas

- Grabación y reproducción de sesiones (asciicast)
- Bridge remoto vía túnel SSH (`ssh -L 7681:127.0.0.1:7681`)
- Sincronizar los prompts estándar con un repo
