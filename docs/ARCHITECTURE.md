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
- **Sesiones persistentes:** las PTY viven en el bridge, no en la página. Cada sesión guarda unos 400 KB de scrollback. Al recargar, la UI llama a `sessions.list` y a `session.attach` para recuperar el historial. Las terminales se agrupan por `meta.projectId`.
- **Lanzar agentes:** toda terminal es una shell interactiva. `claude`, `codex` y `opencode` se lanzan escribiendo el comando (`init`) en la shell, así que al salir del agente vuelves a la shell.
- **Acciones:** son sesiones con `meta.kind = 'action'` y `meta.actionId`, lanzadas con `cmd: [$SHELL, '-ic', comando]`, así que la sesión termina cuando termina el comando. Su estado se deriva de la sesión viva y del patrón "lista" buscado en la salida. Para apagar se escribe `\x03` en el PTY: el kernel manda SIGINT al grupo en primer plano, también a procesos root bajo `sudo`. Si no responde en unos 10 s, se mata la sesión.
- **Entorno de las terminales:** se limpian las variables que marcan una sesión padre de Claude Code o Codex (`CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, …), por si el bridge se lanzó desde una.

## Protocolo

Cliente → bridge: `{ id?, op, args }`. Con `id` se responde `{ re: id, ok, data | error }`; sin `id` no se responde (se usa para input y resize).
Eventos bridge → cliente: `{ ev: 'out', sid, d }`, `{ ev: 'exit', sid, code }`, `{ ev: 'sessions' }` (la lista cambió).

| op | args | devuelve |
|---|---|---|
| `hello` | — | `{version, home, fsRoot, shell, platform, hostname, tools:{claude,codex,opencode}}` |
| `sessions.list` | — | `[{sid, pid, meta, created, lastOutput, alive, exitCode}]` |
| `session.create` | `{cwd, cols, rows, meta, init?, cmd?}` | info de la sesión |
| `session.attach` | `{sid}` | info + `buffer` (scrollback) |
| `session.input` | `{sid, data}` | — |
| `session.resize` | `{sid, cols, rows}` | — |
| `session.meta` | `{sid, meta}` | info (mezcla la meta) |
| `session.kill` | `{sid}` | `true` |
| `ps` | — | `{sid: [{pid, ppid, etime, cpu, rss, args, depth}]}` |
| `proc.kill` | `{pid, signal?}` | solo descendientes de sesiones FRAP |
| `fs.list` | `{path, dirsOnly?, hidden?}` | `{path, parent, entries:[{name, dir}]}` |
| `fs.read` | `{path}` | `{path, content, mtime}` (≤ 2 MB) |
| `fs.write` | `{path, content}` | escritura atómica, crea los directorios |
| `fs.exists` | `{path}` | `bool` |
| `config.scan` | `{folders}` | `{agents, skills, commands, hooks, memory}` |
| `state.get` / `state.set` | `{state}` | estado de la UI en `FRAP_HOME/state.json` |

## Dónde se busca la configuración (`config.scan`)

| | Usuario | Proyecto (cada carpeta) |
|---|---|---|
| Agentes | `~/.claude/agents/*.md`, `~/.config/opencode/agent(s)/*.md` | `.claude/agents/`, `.opencode/agent(s)/` |
| Skills | `~/.claude/skills/**/SKILL.md`, `~/.codex/skills/**` | `.claude/skills/**`, `.agents/skills/**` |
| Comandos | `~/.claude/commands/**/*.md`, `~/.codex/prompts/*.md`, `~/.config/opencode/command(s)/` | `.claude/commands/**`, `.opencode/command(s)/` |
| Hooks | `~/.claude/settings{,.local}.json` | `.claude/settings{,.local}.json` |
| Memoria | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md` | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` |
