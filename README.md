# FRAP

Terminal ligera en el navegador para trabajar con **claude**, **codex** y **opencode** sobre tus proyectos. Una versión de Warp mucho más liviana: un HTML, un CSS y un JS, sin build.

```
┌────────────────┬──────────────────────────────────┬──────────────────┐
│ Proyectos      │ [shell] [claude] [codex]   ＞_ … │ Procesos·Prompts │
│ ▸ frap         │                                  │ Agentes·Skills   │
│   ● claude     │        terminal (xterm.js)       │ Comandos·Hooks   │
│   ● shell      │                                  │ Memoria          │
│ ▸ api          │                                  │                  │
└────────────────┴──────────────────────────────────┴──────────────────┘
```

## Uso

Un navegador no puede ejecutar procesos por sí solo, así que FRAP usa un **bridge local mínimo** (Node + Python, sin `npm install`):

```bash
node bridge/frap-bridge.js          # o: npm start (lo abre en el navegador)
```

Imprime una URL `file:///…/src/index.html#port=7681&token=…`. Ábrela una vez: el token se guarda y desde entonces basta con abrir `src/index.html` (doble clic) mientras el bridge esté corriendo. Las terminales viven en el bridge, así que si recargas o cierras la pestaña siguen corriendo y se re-adjuntan con su historial.

Requisitos: Node ≥ 18, Python 3, Linux (macOS debería funcionar; no está probado).

## Paneles

- **Izquierdo, proyectos.** Cada proyecto tiene una o más carpetas y sus terminales. ＋ crea un proyecto desde una carpeta y ⊕ le agrega otra. La primera carpeta es el `cwd`; las demás se pasan con `--add-dir` a claude y codex.
- **Central, terminal.** Pestañas por proyecto. Los botones lanzan `shell`, `claude`, `codex` u `opencode` en una terminal nueva. El punto verde indica actividad.
  - **db** abre la pestaña de consultas SQL. Tiene selector de conexión, lista de tablas (clic = `SELECT * … LIMIT 100`), editor (Ctrl+Enter ejecuta, o ejecuta solo la selección), resultados en tabla (clic en una celda la copia), historial y exportación a CSV. Es **solo lectura** salvo que la conexión permita escritura en la UI, y entonces cada ejecución pide confirmación.
- **Derecho**:
  - **Procesos:** árbol de procesos de cada terminal (CPU, memoria, tiempo), con los agentes resaltados. Se pueden terminar.
  - **Prompts:** prompts estándar que se ejecutan en la terminal activa con un clic. Admiten `{{project}}`, `{{folder}}` y `{{folders}}`, y se pueden importar y exportar en JSON.
  - **Acciones:** comandos con nombre que se encienden y apagan con un interruptor (VPN, servidores, túneles). Corren con tu shell interactiva (`bash -ic`), así que funcionan los alias. Para apagarlas se envía Ctrl+C, que llega aunque el proceso corra con `sudo`. Un patrón opcional ("lista cuando la salida contenga…") distingue *iniciando* de *activa*. ☰ abre el log, donde se puede escribir si pide contraseña. Las activas se muestran en la barra de estado.
  - **Páginas:** accesos con nombre y URL (`localhost:3000` se completa como `http://…`). Se abren en una pestaña del navegador, que es lo predeterminado, o como pestaña interna con iframe junto a las terminales. El modo por defecto se cambia en Ajustes o con el botón del panel, y cada página puede tener el suyo. Muchos sitios públicos bloquean los iframes; los servidores locales suelen funcionar.
  - **Bases de datos:** conexiones MySQL/MariaDB, PostgreSQL o SQLite (nombre, host, puerto, usuario, contraseña, base). Se guardan en `~/.config/frap/databases.env` con permisos 0600, nunca en el navegador. ⚡ prueba la conexión. **Instalar skill** enseña a claude y codex a consultarlas en solo lectura con `frap-db`.
  - **Música:** lista de reproducción con archivos de tu equipo (📁 o arrastrándolos a la lista) y links de YouTube (`youtube.com/watch`, `youtu.be`, `shorts`…). Clic en una pista la reproduce, y arrastrando ⋮⋮ cambias el orden. Tiene aleatorio (⇄, recorre toda la lista antes de repetir) y repetición (🔁 lista, 🔂 canción, o apagada). El reproductor queda fijo al pie del panel derecho y sigue sonando en cualquier pestaña. Las teclas multimedia y `Alt+Shift+M` hacen ⏯. Los archivos se guardan en el navegador (IndexedDB), y YouTube necesita el bridge.
  - **Temporizador:** recordatorios con ícono, título y descripción, que se repiten cada X tiempo (*💧 Toma agua cada 1 h*) o suenan una sola vez (*🍅 Pomodoro 25 min*). Tienen dos modos: 🔔 **aviso simple**, que aparece en la esquina sin interrumpir, y 🛑 **bloquear la pantalla**, un aviso a pantalla completa que no deja usar FRAP hasta pulsar *Listo* o *Posponer 5/15 min*. Hay plantillas, un interruptor de encendido/apagado, ↺ para reiniciar la cuenta y ▶ para probar el aviso. El próximo aviso se ve en la barra de estado. Con FRAP en segundo plano el título de la pestaña parpadea, y si el navegador lo permite llega una notificación del sistema.
  - **Agentes / Skills / Comandos:** de `~/.claude`, `~/.codex`, `~/.config/opencode` y de las carpetas del proyecto. Se pueden editar y crear desde plantillas.
  - **Hooks:** hooks de Claude Code (`settings.json` / `settings.local.json`). Se pueden listar, agregar, eliminar o editar en el JSON.
  - **Memoria:** `CLAUDE.md`, `AGENTS.md` y `settings.json`. Se editan o se crean si faltan.

## Atajos

| Atajo | Acción |
|---|---|
| `Alt+1…9` | ir a la pestaña N |
| `Alt+Shift+T` / `C` / `X` / `O` | nueva shell / claude / codex / opencode |
| `Alt+Shift+D` | pestaña DB |
| `Alt+Shift+M` | música: reproducir / pausa |
| `Ctrl+Enter` (DB) | ejecutar consulta o selección |
| `Alt+Shift+W` | cerrar pestaña |
| `Alt+Shift+B` / `P` | ocultar panel izquierdo / derecho |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | copiar / pegar |
| `Ctrl+S` (editor) | guardar |

## Bases de datos y agentes

Los agentes acceden a las bases de datos **solo en lectura** con el CLI `frap-db`, que nunca muestra contraseñas:

```bash
node bridge/frap-db.js list                       # conexiones (id, motor, destino)
node bridge/frap-db.js <id> --tables              # tablas
node bridge/frap-db.js <id> --describe <tabla>    # columnas
node bridge/frap-db.js <id> "SELECT … LIMIT 50"   # consulta (--json, --limit N)
```

El modo solo lectura tiene varias capas:
1. **Clasificador:** una sola sentencia, que debe empezar por SELECT, WITH, SHOW, DESCRIBE o EXPLAIN. Rechaza INSERT, UPDATE, DELETE, DDL, `INTO OUTFILE`, `FOR UPDATE`, los metacomandos `\!` y `.shell`, y funciones peligrosas.
2. **Motor:** MySQL ejecuta dentro de `START TRANSACTION READ ONLY` y hace ROLLBACK. PostgreSQL corre con `default_transaction_read_only=on`. SQLite se abre con `-readonly -safe`.
3. **Recomendado:** un usuario de base de datos con permisos solo SELECT.

Requiere los clientes del sistema: `mysql`, `psql` o `sqlite3`.

## Configuración del bridge

| Variable | Por defecto | |
|---|---|---|
| `FRAP_PORT` / `--port` | `7681` | puerto WS |
| `FRAP_HOME` | `~/.config/frap` | token y estado |
| `FRAP_TOKEN` | (generado) | fuerza un token |
| `FRAP_FS_ROOT` | `$HOME` | raíz permitida para leer y escribir archivos |
| `FRAP_ALLOW_ORIGINS` | — | Origins http extra permitidos (coma) |
| `FRAP_PYTHON` | `python3` | intérprete para el PTY |

## Desarrollo

```bash
npm run check   # chequeos estáticos + tests (sin dependencias)
```

Ver [CLAUDE.md](CLAUDE.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) y [docs/ROADMAP.md](docs/ROADMAP.md).
