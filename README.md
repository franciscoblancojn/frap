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
- **Derecho**:
  - **Procesos:** árbol de procesos de cada terminal (CPU, memoria, tiempo), con los agentes resaltados. Se pueden terminar.
  - **Prompts:** prompts estándar que se ejecutan en la terminal activa con un clic. Admiten `{{project}}`, `{{folder}}` y `{{folders}}`, y se pueden importar y exportar en JSON.
  - **Agentes / Skills / Comandos:** de `~/.claude`, `~/.codex`, `~/.config/opencode` y de las carpetas del proyecto. Se pueden editar y crear desde plantillas.
  - **Hooks:** hooks de Claude Code (`settings.json` / `settings.local.json`). Se pueden listar, agregar, eliminar o editar en el JSON.
  - **Memoria:** `CLAUDE.md`, `AGENTS.md` y `settings.json`. Se editan o se crean si faltan.

## Atajos

| Atajo | Acción |
|---|---|
| `Alt+1…9` | ir a la pestaña N |
| `Alt+Shift+T` / `C` / `X` / `O` | nueva shell / claude / codex / opencode |
| `Alt+Shift+W` | cerrar pestaña |
| `Alt+Shift+B` / `P` | ocultar panel izquierdo / derecho |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | copiar / pegar |
| `Ctrl+S` (editor) | guardar |

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
