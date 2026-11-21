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

## Vistas por proyecto (git, DB, Archivos, Notas)

- Como las terminales, cada proyecto tiene sus propias pestañas de Git, DB, Archivos (SFTP) y Notas, listadas en el panel izquierdo junto a sus terminales. Sid: `git:<projectId>`, `db:<projectId>`, `sftp:<projectId>`, `notes:<projectId>`. Una por tipo y proyecto: los launchers y Alt+Shift+G/D/F/N abren o enfocan la del proyecto activo. Requieren un proyecto.
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

- `bridge/db.js` es el núcleo compartido. Lee y escribe `FRAP_HOME/databases.env` (claves `FRAP_DB_<ID>_{NAME,ENGINE,HOST,PORT,USER,PASSWORD,DATABASE,UI_WRITE,ENABLED,AI}`, archivo 0600), clasifica el SQL y ejecuta con los clientes del sistema. No hay drivers npm.
  - **MySQL / MariaDB:** `mysql --xml --comments`. `--xml` distingue NULL de `'NULL'`. La contraseña va en un `--defaults-extra-file` temporal 0600, nunca en argv. El tiempo límite se fija con una sola sentencia compatible con los dos motores: `SET /*!50708 SESSION MAX_EXECUTION_TIME=… */ /*M!100108 SESSION max_statement_time=… */ @frap=1`. MySQL ignora `/*M!`, MariaDB ignora los `/*!5xxxx` de MySQL 5.7+, y `@frap` evita una sentencia vacía. Verificado con MySQL 8.0 y MariaDB 10.11.
  - **PostgreSQL:** `psql --csv` con un marcador de NULL. La contraseña va en `PGPASSWORD`.
  - **SQLite:** `sqlite3 -csv -safe`.
- La UI nunca recibe contraseñas: `db.list` y `db.save` devuelven `publicConn`.
- `bridge/frap-db.js` es el CLI de los agentes. Llama a `runQuery` sin `write`, así que siempre es solo lectura, sin ningún flag que lo cambie.
- Interruptores por conexión: `ENABLED=0` la desactiva (la UI y `frap-db` la rechazan; `db.test` sí funciona). `AI=0` la oculta a los agentes: `frap-db list` no la muestra y las consultas a ese id fallan. Si faltan, valen 1.
- Lo que hace la pestaña DB de la UI: cada consulta se intenta primero en solo lectura. Si la conexión tiene "Solo lectura" desactivado (`UI_WRITE=1`; por defecto está activado) y la consulta no es una lectura, la UI la valida con `db.check`, pide confirmación y la ejecuta con `write`. En ese modo `assertSafeWrite` solo deja pasar INSERT, UPDATE, CREATE y ALTER (además de lecturas). Nunca deja pasar eliminaciones (DELETE, DROP, incluido `ALTER … DROP`, TRUNCATE, DISCARD, REPLACE), rutinas o triggers (podrían esconder un DELETE), metacomandos (`\!`, `.shell`) ni `INTO OUTFILE`.

## Exportar / importar

Todo se arma en la UI (`openExport` / `openImport`) y se descarga como `frap-export-AAAA-MM-DD.json` (`format: "frap-export", version: 1`): `projects` (con `terminals: [{kind, title, cwd, sshId?}]`), `config` (prompts, actions, pages, timers, music —solo YouTube—, settings) y, vía bridge, `db`, `ssh` y `secrets`. Las contraseñas nunca pasan por la UI en claro: `export.creds` las cifra e `import.creds` las descifra dentro del bridge.

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
| `sessions.list` | — | `[{sid, pid, meta, created, lastOutput, alive, exitCode}]` |
| `session.create` | `{cwd, cols, rows, meta, init?, cmd?}` | info de la sesión |
| `session.attach` | `{sid}` | info + `buffer` (scrollback) |
| `session.input` | `{sid, data}` | — |
| `session.resize` | `{sid, cols, rows}` | — |
| `session.meta` | `{sid, meta}` | info (mezcla la meta) |
| `session.seen` | `{sid}` | `true`; borra el aviso (`notice`) de la sesión |
| `session.kill` | `{sid}` | `true` |
| `ps` | — | `{sid: [{pid, ppid, etime, cpu, rss, args, depth}]}` |
| `proc.kill` | `{pid, signal?}` | solo descendientes de sesiones FRAP |
| `fs.list` | `{path, dirsOnly?, hidden?, details?}` | `{path, parent, entries:[{name, dir}]}`; con `details` cada entrada trae además `link, size, mtime` |
| `fs.read` | `{path}` | `{path, content, mtime}` (≤ 2 MB) |
| `fs.write` | `{path, content}` | escritura atómica, crea los directorios |
| `fs.exists` | `{path}` | `bool` |
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
| `export.creds` | `{db: ids, ssh: ids, passphrase?}` | `{db, ssh, secrets?}` sin contraseñas; con `passphrase` (≥6) van en `secrets` cifradas (scrypt + AES-256-GCM) |
| `import.creds` | `{db, ssh, secrets?, passphrase?}` | `{db, ssh, errors}`; mismo id se reemplaza; clave incorrecta → error; sin clave conserva la contraseña existente |
| `db.installSkill` | `{tools}` | escribe `~/.claude/skills/frap-db/SKILL.md` y `~/.codex/skills/frap-db/SKILL.md` |

## Dónde se busca la configuración (`config.scan`)

| | Usuario | Proyecto (cada carpeta) |
|---|---|---|
| Agentes | `~/.claude/agents/*.md`, `~/.config/opencode/agent(s)/*.md` | `.claude/agents/`, `.opencode/agent(s)/` |
| Skills | `~/.claude/skills/**/SKILL.md`, `~/.codex/skills/**` | `.claude/skills/**`, `.agents/skills/**` |
| Comandos | `~/.claude/commands/**/*.md`, `~/.codex/prompts/*.md`, `~/.config/opencode/command(s)/` | `.claude/commands/**`, `.opencode/command(s)/` |
| Hooks | `~/.claude/settings{,.local}.json` | `.claude/settings{,.local}.json` |
| Memoria | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md` | `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` |
