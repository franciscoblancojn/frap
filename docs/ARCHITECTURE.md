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

## Rutas clicables

- Cada xterm registra un *link provider* (`pathLinkProvider`). Por cada fila, `logicalLine()` une las filas partidas (`isWrapped`) y arma un mapa índice → celda que respeta los caracteres anchos (emoji, CJK). `pathCandidates()` busca rutas con un `:línea:col` opcional, y `paths.check` filtra las que existen, con una caché de 15 s.
- El clic llama a `open.editor`. Funciona aunque la app tenga el modo ratón activo, como Claude Code (`?1000h`…).

## Git

- La vista es solo UI sobre `git.run`. El bridge ejecuta el binario `git` con `GIT_TERMINAL_PROMPT=0` (si faltan credenciales falla en lugar de colgarse), `GIT_EDITOR=true` (sin editor en merges) y `color.ui=false`.
- `GIT_ALLOWED` limita los subcomandos a los de uso diario. `config`, `submodule`, hooks, etc. se rechazan, igual que las opciones que permiten ejecutar comandos arbitrarios (`-c core.sshCommand=…`, `--upload-pack`, `--exec`, `-C`, `--git-dir`).
- El status se lee con `git status --porcelain=v1 -b -z` (independiente del idioma). La vista se refresca cada 5 s mientras está visible y al volver el foco a la ventana.

## Temporizador

- Vive solo en la UI, en `state.timers`. Cada temporizador guarda `nextAt` (marca de tiempo absoluta), así que sobrevive a recargas. Si al volver a abrir FRAP alguno ya venció, avisa una vez marcado como "atrasado" y se reprograma desde ese momento, sin acumular avisos.
- `tickTimers()` corre cada segundo. Dispara los vencidos y actualiza los contadores en el sitio, sin re-renderizar. Con la pestaña en segundo plano Chrome puede espaciar los timers, y el aviso puede llegar hasta ~1 min tarde.
- El aviso bloqueante es `#alarm`, por encima de modales y toasts. Quita el foco de xterm, atrapa el teclado (Tab cicla entre sus botones) y desactiva los atajos. Varios avisos simultáneos se ponen en cola.
- El sonido se genera con WebAudio, sin archivos.

## Bases de datos

- `bridge/db.js` es el núcleo compartido. Lee y escribe `FRAP_HOME/databases.env` (claves `FRAP_DB_<ID>_{NAME,ENGINE,HOST,PORT,USER,PASSWORD,DATABASE,UI_WRITE}`, archivo 0600), clasifica el SQL y ejecuta con los clientes del sistema. No hay drivers npm.
  - **MySQL / MariaDB:** `mysql --xml --comments`. `--xml` distingue NULL de `'NULL'`. La contraseña va en un `--defaults-extra-file` temporal 0600, nunca en argv. El tiempo límite se fija con una sola sentencia compatible con los dos motores: `SET /*!50708 SESSION MAX_EXECUTION_TIME=… */ /*M!100108 SESSION max_statement_time=… */ @frap=1`. MySQL ignora `/*M!`, MariaDB ignora los `/*!5xxxx` de MySQL 5.7+, y `@frap` evita una sentencia vacía. Verificado con MySQL 8.0 y MariaDB 10.11.
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
| `paths.check` | `{cwd, paths}` | `[{input, path, dir}]` de las rutas que existen (las relativas se resuelven contra `cwd`; solo dentro de `FRAP_FS_ROOT`) |
| `open.editor` | `{path, line?, col?, editor?}` | abre en el editor sin shell; la familia VS Code recibe `--goto ruta:línea:col` |
| `git.run` | `{cwd, args}` | `{code, stdout, stderr}`; ejecuta `git` sin shell, solo subcomandos de `GIT_ALLOWED`, sin `-c`/`--upload-pack`/`--exec`…; un código distinto de 0 no lanza error |
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
