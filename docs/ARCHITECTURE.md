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

## Música

- **Archivos:** se guardan como Blob en IndexedDB (`frap-music/files`) y se reproducen con un `<audio>` global. Funcionan sin bridge y sobreviven a recargas. En `state.music.tracks` solo va la metadata.
- **YouTube:** rechaza embeds desde `file://` (error 153, sin Referer). Por eso el bridge sirve `GET /yt-player`, un relé en `http://127.0.0.1:<puerto>` que carga la IFrame API de YouTube. La UI lo incrusta y le habla por `postMessage` (`{frap:'yt', cmd:'load'|'play'|'pause'|'seek'|'volume'}`), y recibe de vuelta `ready`, `state`, `time` y `error`. La UI valida `event.source` y `event.origin`, y el relé solo acepta mensajes de su ventana padre. El relé no usa token, y el WebSocket rechaza su Origin http, así que no da acceso al bridge.
- El reproductor (dock) vive fuera de `#rbody`, así que re-renderizar el panel no corta la música. Fuera de la pestaña Música el video se minimiza, pero sigue sonando.

## Bases de datos

- `bridge/db.js` es el núcleo compartido. Lee y escribe `FRAP_HOME/databases.env` (claves `FRAP_DB_<ID>_{NAME,ENGINE,HOST,PORT,USER,PASSWORD,DATABASE,UI_WRITE}`, archivo 0600), clasifica el SQL y ejecuta con los clientes del sistema. No hay drivers npm.
  - **MySQL:** `mysql --xml`, para distinguir NULL de `'NULL'`. La contraseña va en un `--defaults-extra-file` temporal 0600, nunca en argv.
  - **PostgreSQL:** `psql --csv` con un marcador de NULL. La contraseña va en `PGPASSWORD`.
  - **SQLite:** `sqlite3 -csv -safe`.
- La UI nunca recibe contraseñas: `db.list` y `db.save` devuelven `publicConn`.
- `bridge/frap-db.js` es el CLI de los agentes. Llama a `runQuery` sin `write`, así que siempre es solo lectura, sin ningún flag que lo cambie.
- Lo que hace la pestaña DB de la UI: lee en modo solo lectura por defecto. Escribe solo si la conexión tiene `UI_WRITE=1`, el usuario marca "escritura" y confirma.

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
| `db.list` | — | `{envFile, cli, clients, skills, conns}`; las conexiones van **sin contraseña** (`hasPassword`) |
| `db.save` | `{conn}` | crea, o edita si viene `id`; `password: null` conserva la guardada |
| `db.delete` | `{id}` | `true` |
| `db.test` | `{id}` o `{conn}` | `{ms, version}`; permite probar antes de guardar |
| `db.query` | `{id, sql, write?, limit?}` | `{columns, rows, rowCount, truncated, ms, readOnly}`; `write` solo si la conexión tiene `uiWrite` |
| `db.tables` | `{id}` | `[{name, view}]` |
| `music.ytInfo` | `{id}` | `{title, author}` vía oEmbed público de YouTube |
| `db.installSkill` | `{tools}` | escribe `~/.claude/skills/frap-db/SKILL.md` y `~/.codex/skills/frap-db/SKILL.md` |

## Dónde se busca la configuración (`config.scan`)

| | Usuario | Proyecto (cada carpeta) |
|---|---|---|
| Agentes | `~/.claude/agents/*.md`, `~/.config/opencode/agent(s)/*.md` | `.claude/agents/`, `.opencode/agent(s)/` |
| Skills | `~/.claude/skills/**/SKILL.md`, `~/.codex/skills/**` | `.claude/skills/**`, `.agents/skills/**` |
| Comandos | `~/.claude/commands/**/*.md`, `~/.codex/prompts/*.md`, `~/.config/opencode/command(s)/` | `.claude/commands/**`, `.opencode/command(s)/` |
| Hooks | `~/.claude/settings{,.local}.json` | `.claude/settings{,.local}.json` |
| Memoria | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md` | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` |
