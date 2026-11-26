/* FRAP v1 — UI de terminal ligera para claude / codex / opencode.
 * Script clásico (sin módulos ES) para que funcione abriendo index.html como file://.
 * Toda ejecución real pasa por el bridge local (bridge/frap-bridge.js) vía WebSocket.
 */
(() => {
  'use strict';

  // ======================================================================
  // Utilidades DOM
  // ======================================================================
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  /** h('div.cls#id', {attrs/on*}, ...children) — siempre usa textContent, nunca innerHTML. */
  function h(spec, attrs, ...children) {
    const m = spec.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const el = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) {
      for (const part of m[2].match(/[.#][\w-]+/g)) {
        if (part[0] === '.') el.classList.add(part.slice(1));
        else el.id = part.slice(1);
      }
    }
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
      children.unshift(attrs);
      attrs = null;
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /** Logos de las herramientas (src/vendor/icons). */
  const ICONS = {
    claude: 'vendor/icons/claude.svg',
    codex: 'vendor/icons/codex.svg',
    opencode: 'vendor/icons/opencode.svg',
    db: 'vendor/icons/db.svg',
    git: 'vendor/icons/git.svg',
    ssh: 'vendor/icons/ssh.svg',
    notes: 'vendor/icons/notes.svg',
    code: 'vendor/icons/code.svg',
    api: 'vendor/icons/api.svg',
  };
  const kindIcon = (kind) => (ICONS[kind] ? h('img.ico', { src: ICONS[kind], alt: kind, title: kind }) : null);
  const uid = () => Math.random().toString(36).slice(2, 10);
  /** /home/u/x -> ~/x (solo para mostrar). */
  const tilde = (p) => {
    const home = Bridge.info && Bridge.info.home;
    return home && (p === home || String(p).startsWith(home + '/')) ? '~' + String(p).slice(home.length) : p;
  };
  const basename = (p) => String(p).replace(/\/+$/, '').split('/').pop() || p;
  const shQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
  const debounce = (fn, ms) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const fmtTime = (secs) => {
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m`;
    if (secs < 86400) return `${Math.floor(secs / 3600)}h${String(Math.floor((secs % 3600) / 60)).padStart(2, '0')}`;
    return `${Math.floor(secs / 86400)}d`;
  };
  const fmtMem = (kb) => (kb > 1024 * 1024 ? `${(kb / 1048576).toFixed(1)}G` : kb > 1024 ? `${Math.round(kb / 1024)}M` : `${kb}K`);

  function storeGet(key, def) {
    try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch (_) { return def; }
  }
  function storeSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* privado / bloqueado */ }
  }

  function toast(msg, kind = '') {
    const el = h(`div.toast${kind ? '.' + kind : ''}`, msg);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3000);
  }

  // ======================================================================
  // Estado
  // ======================================================================
  const AGENT_TOOLS = ['claude', 'codex', 'opencode'];
  // notas (vista "Notas" + skill frap-notes): también se agregan a los prompts de estados ya existentes
  const NOTES_PROMPTS = [
    { title: 'Guardar en notas', body: 'Guarda esto en notas: agrega al final de NOTES.md (en la raíz de esta carpeta; créalo si no existe) una sección con la fecha y un resumen útil para retomar después: contexto, decisiones y por qué, pendientes (- [ ]), comandos y rutas clave. No borres lo que ya hay y no incluyas secretos.' },
    { title: 'Leer notas', body: 'Lee las notas: abre NOTES.md de esta carpeta y úsalo como contexto para seguir trabajando. Resúmeme en pocas líneas lo más importante y los pendientes.' },
  ];
  const DEFAULT_PROMPTS = [
    { title: 'Explicar proyecto', body: 'Explícame la estructura de este proyecto, sus partes principales y cómo se ejecuta.' },
    { title: 'Revisar cambios', body: 'Revisa los cambios sin commitear (git diff) y señala bugs, riesgos y mejoras concretas.' },
    { title: 'Escribir tests', body: 'Escribe tests para el código modificado recientemente y ejecútalos.' },
    { title: 'Commit', body: 'Crea un commit con un mensaje claro que describa los cambios actuales.' },
    ...NOTES_PROMPTS,
  ];
  const DEFAULT_STATE = () => ({
    v: 1,
    savedAt: 0,
    projects: [],
    activeProject: null,
    activeSid: null,
    prompts: DEFAULT_PROMPTS.map((p) => ({ id: uid(), ...p })),
    promptCats: [], // categorías de prompts: [{id, name, icon}] (en el panel derecho, cada una en un bloque plegable)
    actions: [], // {id, name, cmd, cwd, ready} comandos con nombre que se encienden/apagan
    pages: [], // {id, name, url, mode: 'default'|'tab'|'iframe'} accesos a páginas web
    openPages: [], // ids de páginas abiertas como pestaña interna (iframe)
    // vistas del panel central por proyecto: [{kind: 'git'|'db'|'sftp', projectId, open, data}] (ver "vistas por proyecto")
    views: [],
    // foto de las terminales abiertas: [{sid, projectId, kind, title, cwd, sshId?}] (para reabrirlas tras apagar el equipo)
    lastTerms: [],
    seeded: ['notes-prompts', 'frap-editor'], // siembras ya aplicadas (ver migrateViews)
    db: { connId: null, sql: '', limit: 500, history: [] }, // datos de la vista DB enlazada (apunta a views[i].data)
    // música: tracks = [{id, type: 'file'|'youtube', title, videoId?, duration?}]; los archivos viven en IndexedDB
    music: { tracks: [], current: null, loop: 'all', shuffle: false, volume: 80 },
    git: { repo: null, tab: 'diff' }, // datos de la vista Git enlazada
    sftp: { hostId: null, local: null, remote: {}, hidden: false }, // datos de la vista Archivos (SFTP) enlazada; remote = última ruta por servidor
    notes: { gitignore: true }, // datos de la vista Notas enlazada: gitignore = agregar NOTES.md al .gitignore
    code: { groups: [{ tabs: [], active: null }], focus: 0, expanded: [], side: 'tree', hidden: false, wrap: false, cursors: {} }, // vista Código enlazada
    voice: { lang: 'es' }, // módulo de voz (panel derecho): idioma para whisper.cpp ("auto" = detectar)
    // temporizadores: [{id, icon, title, desc, kind: 'repeat'|'once', every (seg), mode: 'toast'|'modal', sound, enabled, nextAt, startedAt}]
    timers: [],
    // túneles: [{id, name, kind: 'port'|'url'|'path', port, url, path, provider, password, hostRewrite, rewriteUrls}]
    tunnels: [],
    // secciones del panel izquierdo: la primera es siempre "Todas" (ver ensureSections)
    sections: [{ id: 'all', icon: '🗂️', title: 'Todas', desc: 'Todas las carpetas', display: 'both' }],
    modules: { off: [] }, // módulos de la UI apagados (Ajustes → Módulos); vacío = todo activado
    rtabs: { order: [], custom: {} }, // pestañas del panel derecho: orden (arrastrando) e ícono/título/descripción propios
    settings: {
      fontSize: 13,
      editor: 'frap', // rutas clicadas en la terminal: 'frap' = editor de código de FRAP; si no, un comando (code, cursor…)
      extEditor: 'code', // "Abrir en editor externo" desde el editor de FRAP (VS Code)
      pageMode: 'tab', // cómo se abren las páginas por defecto: 'tab' (navegador) | 'iframe' (pestaña interna)
      launchers: {
        claude: { cmd: 'claude', addDir: '--add-dir' },
        codex: { cmd: 'codex', addDir: '--add-dir' },
        opencode: { cmd: 'opencode', addDir: '' },
      },
    },
    // split: 1-4 terminales a la vez; splitSizes (%): y = alto de la fila de arriba, xTop/xBot = ancho de la columna izquierda de cada fila
    ui: { section: 'all', rtab: 'procs', hideLeft: false, hideRight: false, procsAll: false, split: 1, splitSizes: { y: 50, xTop: 50, xBot: 50 } },
  });

  function mergeState(base, saved) {
    if (!saved || typeof saved !== 'object') return base;
    return migrateViews({
      ...base,
      ...saved,
      settings: {
        ...base.settings,
        ...(saved.settings || {}),
        launchers: { ...base.settings.launchers, ...((saved.settings || {}).launchers || {}) },
      },
      ui: { ...base.ui, ...(saved.ui || {}), splitSizes: { ...base.ui.splitSizes, ...((saved.ui || {}).splitSizes || {}) } },
      db: { ...base.db, ...(saved.db || {}) },
      music: { ...base.music, ...(saved.music || {}) },
      git: { ...base.git, ...(saved.git || {}) },
      voice: { ...base.voice, ...(saved.voice || {}) },
      modules: { off: Array.isArray((saved.modules || {}).off) ? saved.modules.off.filter((k) => typeof k === 'string') : [] },
      sftp: { ...base.sftp, ...(saved.sftp || {}), remote: { ...((saved.sftp || {}).remote || {}) } },
      seeded: Array.isArray(saved.seeded) ? saved.seeded : [], // no el del estado por defecto: si no, nunca se siembra
    });
  }
  /**
   * Estados viejos: git/DB/SFTP eran una sola pestaña global ("git:main", state.git.open…).
   * Si estaba abierta pasa a ser la vista del proyecto activo.
   */
  function migrateViews(st) {
    // siembras de una sola vez (lo nuevo por defecto que también deben ver los estados existentes)
    st.seeded = Array.isArray(st.seeded) ? st.seeded : [];
    if (!st.seeded.includes('notes-prompts')) {
      st.seeded.push('notes-prompts');
      for (const np of NOTES_PROMPTS) if (!(st.prompts || []).some((x) => x.title === np.title)) st.prompts = [...(st.prompts || []), { id: uid(), ...np }];
    }
    if (!st.seeded.includes('frap-editor')) {
      // con el editor de código integrado, las rutas clicadas se abren en FRAP (antes: VS Code por defecto)
      st.seeded.push('frap-editor');
      if (st.settings) {
        const old = st.settings.editor;
        if (old && old !== 'code' && old !== 'frap') st.settings.extEditor = old;
        st.settings.editor = 'frap';
      }
    }
    if (!Array.isArray(st.promptCats)) st.promptCats = [];
    if (!st.rtabs || typeof st.rtabs !== 'object') st.rtabs = { order: [], custom: {} };
    if (!Array.isArray(st.rtabs.order)) st.rtabs.order = [];
    if (!st.rtabs.custom || typeof st.rtabs.custom !== 'object') st.rtabs.custom = {};
    if (!Array.isArray(st.views)) st.views = [];
    st.views = st.views.filter((v) => v && ['git', 'db', 'sftp', 'notes', 'code', 'api'].includes(v.kind) && v.projectId && v.data);
    for (const kind of ['git', 'db', 'sftp']) {
      const old = st[kind] || {};
      if (old.open && st.activeProject && !st.views.some((v) => v.kind === kind && v.projectId === st.activeProject)) {
        const { open, ...data } = old;
        st.views.push({ kind, projectId: st.activeProject, open: true, data: JSON.parse(JSON.stringify(data)) });
      }
      delete old.open;
      if (st.activeSid === `${kind}:main`) st.activeSid = st.activeProject ? `${kind}:${st.activeProject}` : null;
    }
    return st;
  }

  let state = mergeState(DEFAULT_STATE(), storeGet('frap.state', null));

  // localStorage se escribe al instante (recargar justo después de un cambio no lo pierde);
  // la copia en el bridge (~/.config/frap/state.json) va con debounce.
  const persistRemote = debounce(() => {
    if (Bridge.ready) Bridge.call('state.set', { state }).catch(() => {});
  }, 300);
  function save() {
    rememberActive();
    state.savedAt = Date.now();
    storeSet('frap.state', state);
    persistRemote();
  }

  // Conexión: token/puerto llegan en el hash (#port=..&token=..) la primera vez.
  const conn = storeGet('frap.conn', { port: 7681, token: '' });
  (function readHash() {
    if (!location.hash) return;
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('token')) conn.token = p.get('token');
    if (p.get('port')) conn.port = Number(p.get('port')) || 7681;
    storeSet('frap.conn', conn);
    history.replaceState(null, '', location.pathname + location.search);
  })();

  const project = (id = state.activeProject) => state.projects.find((p) => p.id === id) || null;

  // ---------- vistas por proyecto: git, DB y SFTP ----------
  // Como las terminales, cada proyecto tiene sus propias pestañas de git, DB y Archivos (sid "git:<projectId>").
  // Cada vista tiene su panel DOM. Al activarla, state.git/db/sftp pasan a apuntar a sus datos (v.data) y
  // gitPane/dbPane/sftpPane/Git a su panel y memoria: el código de cada vista trabaja siempre sobre "la actual".
  // Lo asíncrono captura su panel antes de esperar y no pinta si mientras tanto se cambió de vista.
  const VIEW_DATA = {
    git: () => ({ repo: null, tab: 'diff' }),
    db: () => ({ connId: null, sql: '', limit: 500, history: [] }),
    sftp: () => ({ hostId: null, local: null, remote: {}, hidden: false }),
    notes: () => ({ gitignore: true }),
    code: () => ({ groups: [{ tabs: [], active: null }], focus: 0, expanded: [], side: 'tree', hidden: false, wrap: false, cursors: {} }),
    api: () => ({ tabs: [], active: null, expanded: [], reqTab: 'params', resTab: 'body' }),
  };
  const vSid = (v) => `${v.kind}:${v.projectId}`;
  const viewKind = (sid) => { const m = /^(git|db|sftp|notes|code|api):/.exec(sid || ''); return m ? m[1] : null; };
  const viewBySid = (sid) => (viewKind(sid) ? state.views.find((v) => v.open && vSid(v) === sid) || null : null);
  const activeView = () => viewBySid(state.activeSid);
  const openViewsOf = (pid) => {
    const rank = orderRank(pid);
    return state.views.filter((v) => v.open && v.projectId === pid).sort((a, b) => (rank(vSid(a)) - rank(vSid(b))) || 0);
  };
  const viewPanes = new Map(); // sid -> panel DOM de la vista
  const gitRts = new Map(); // sid -> memoria de git (status, salida, diff…)
  let bound = { git: null, db: null, sftp: null, notes: null, code: null, api: null }; // sid enlazado por tipo
  /** Datos de todas las vistas de un tipo (para mantenerlas al borrar conexiones o servidores). */
  const viewDatas = (kind) => [...new Set([state[kind], ...state.views.filter((v) => v.kind === kind).map((v) => v.data)])];
  function needProject() {
    if (project()) return true;
    toast('Primero crea o selecciona un proyecto', 'err');
    return false;
  }
  function viewFor(kind, pid = state.activeProject) {
    let v = state.views.find((x) => x.kind === kind && x.projectId === pid);
    if (!v) { v = { kind, projectId: pid, open: false, data: VIEW_DATA[kind]() }; state.views.push(v); }
    return v;
  }
  function bindView(v) {
    const sid = vSid(v);
    if (bound[v.kind] === sid && state[v.kind] === v.data) return;
    bound[v.kind] = sid;
    state[v.kind] = v.data;
    const pane = viewPanes.get(sid) || null;
    if (v.kind === 'git') {
      if (!gitRts.has(sid)) gitRts.set(sid, newGitRt());
      Git = gitRts.get(sid);
      gitPane = pane;
    } else if (v.kind === 'db') dbPane = pane;
    else if (v.kind === 'sftp') sftpPane = pane;
    else if (v.kind === 'notes') notesPane = pane;
    else if (v.kind === 'api') apiPane = pane;
    else codePane = pane;
  }
  /** Enlaza y activa la vista `kind` del proyecto activo. fresh = todavía no tenía panel. */
  function showView(kind) {
    const v = viewFor(kind);
    v.open = true;
    bindView(v);
    const fresh = !viewPanes.has(vSid(v));
    state.activeSid = vSid(v);
    save();
    renderAll();
    return { v, fresh };
  }
  function closeView(v, force) {
    if (v.kind === 'code' && !force) {
      if (codeViewDirty(v)) { confirmBox('Cerrar editor', 'Hay archivos con cambios sin guardar. ¿Cerrar el editor y descartarlos?').then((ok) => ok && closeView(v, true)); return; }
    }
    if (v.kind === 'code') {
      // al cerrarlo se suelta su panel (al reabrirlo vuelven las mismas pestañas, recargadas del disco)
      const sid = vSid(v);
      const pane = viewPanes.get(sid);
      if (pane) pane.root.remove();
      viewPanes.delete(sid);
      if (bound.code === sid) codePane = null;
    }
    v.open = false;
    if (state.activeSid === vSid(v)) {
      const list = sessionsOf(state.activeProject);
      const others = openViewsOf(state.activeProject);
      state.activeSid = list.length ? list[list.length - 1].sid : others.length ? vSid(others[0]) : null;
    }
    save();
    renderAll();
  }
  /** Clic en una vista (panel izquierdo o pestaña): activa su proyecto y la abre. */
  function openViewSid(sid) {
    const v = viewBySid(sid);
    if (!v) return;
    if (project(v.projectId)) state.activeProject = v.projectId;
    if (v.kind === 'git') openGitView();
    else if (v.kind === 'db') openDbView();
    else if (v.kind === 'sftp') openSftpView();
    else if (v.kind === 'notes') openNotesView();
    else if (v.kind === 'api') openApiView();
    else openCodeView();
  }
  /** Al borrar un proyecto: se van sus vistas y sus paneles. */
  function dropProjectViews(pid) {
    for (const v of state.views.filter((x) => x.projectId === pid)) {
      const sid = vSid(v);
      const pane = viewPanes.get(sid);
      if (pane) pane.root.remove();
      viewPanes.delete(sid);
      gitRts.delete(sid);
      if (bound[v.kind] === sid) {
        bound[v.kind] = null;
        state[v.kind] = VIEW_DATA[v.kind]();
        if (v.kind === 'git') { gitPane = null; Git = newGitRt(); } else if (v.kind === 'db') dbPane = null; else if (v.kind === 'sftp') sftpPane = null; else if (v.kind === 'notes') notesPane = null; else if (v.kind === 'api') apiPane = null; else codePane = null;
      }
    }
    state.views = state.views.filter((x) => x.projectId !== pid);
  }
  const VIEW_TITLE = { git: 'Git (Alt+Shift+G)', db: 'Consultas SQL (Alt+Shift+D)', sftp: 'Archivos por SFTP (Alt+Shift+F)', notes: 'Notas: NOTES.md de la carpeta (Alt+Shift+N)', code: 'Editor de código (Alt+Shift+E)', api: 'API: peticiones HTTP guardadas (Alt+Shift+R)' };
  function viewLabel(v) {
    if (v.kind === 'notes') return 'Notas';
    if (v.kind === 'api') return v.data.active ? `API · ${basename(v.data.active)}` : 'API';
    if (v.kind === 'code') { const g = (v.data.groups || [])[v.data.focus || 0]; return g && g.active ? `Código · ${basename(g.active)}` : 'Código'; }
    if (v.kind === 'git') return v.data.repo ? `Git · ${basename(v.data.repo)}` : 'Git';
    if (v.kind === 'db') { const c = dbConnById(v.data.connId); return c ? `DB · ${c.name}` : 'DB'; }
    const c = sshInfo && sshInfo.hosts.find((x) => x.id === v.data.hostId);
    return c ? `⇅ ${c.name}` : '⇅ Archivos';
  }

  // ======================================================================
  // Bridge (WebSocket RPC)
  // ======================================================================
  const Bridge = {
    ws: null,
    ready: false,
    info: null,
    seq: 0,
    pending: new Map(),
    listeners: {},
    retry: 0,
    timer: null,

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    emit(ev, data) { for (const fn of this.listeners[ev] || []) fn(data); },

    connect() {
      clearTimeout(this.timer);
      if (this.ws) { try { this.ws.onclose = null; this.ws.close(); } catch (_) { /* nada */ } }
      if (!conn.token) { setConn('off', 'Falta el token'); return; }
      setConn('wait', 'Conectando…');
      let ws;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${conn.port}/?token=${encodeURIComponent(conn.token)}`);
      } catch (e) { setConn('off', e.message); return; }
      this.ws = ws;
      ws.onopen = async () => {
        this.retry = 0;
        this.ready = true;
        try {
          this.info = await this.call('hello');
          setConn('on', `${this.info.hostname} · bridge v${this.info.version}`);
          checkBridgeVersion(this.info);
          this.emit('open', this.info);
        } catch (e) { setConn('off', e.message); }
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        if (msg.re != null) {
          const p = this.pending.get(msg.re);
          if (!p) return;
          this.pending.delete(msg.re);
          msg.ok ? p.resolve(msg.data) : p.reject(new Error(/^Operación desconocida/.test(msg.error || '') ? `${msg.error}. El bridge está desactualizado: reinícialo (Ctrl+C y node bridge/frap-bridge.js).` : msg.error));
        } else if (msg.ev) {
          this.emit(msg.ev, msg);
        }
      };
      ws.onclose = () => {
        const wasReady = this.ready;
        this.ready = false;
        for (const p of this.pending.values()) p.reject(new Error('Bridge desconectado'));
        this.pending.clear();
        if (wasReady) this.emit('close');
        setConn('off', wasReady ? 'Conexión perdida, reintentando…' : 'No se pudo conectar al bridge (¿está corriendo? ¿token correcto?)');
        this.retry = Math.min(this.retry + 1, 6);
        this.timer = setTimeout(() => this.connect(), 500 * this.retry);
      };
    },

    call(op, args) {
      if (!this.ready) return Promise.reject(new Error('Bridge desconectado'));
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.ws.send(JSON.stringify({ id, op, args }));
      });
    },

    /** Sin respuesta (input / resize). */
    send(op, args) {
      if (this.ready) this.ws.send(JSON.stringify({ op, args }));
    },
  };

  // Operaciones del bridge que usa esta versión de la UI. Si el bridge en ejecución no las
  // tiene, es un proceso viejo (Node carga el código al arrancar): hay que reiniciarlo.
  const REQUIRED_OPS = ['session.create', 'session.seen', 'session.clear', 'config.scan', 'db.list', 'db.save', 'db.toggle', 'db.check', 'db.query', 'ssh.list', 'ssh.save', 'ssh.toggle', 'ssh.connect', 'sftp.list', 'sftp.get', 'sftp.put', 'sftp.mkdir', 'sftp.rename', 'sftp.remove', 'sftp.cancel', 'notes.skill', 'notes.installSkill', 'tunnel.status', 'tunnel.ports', 'tunnel.start', 'tunnel.stop', 'scripts.list', 'scripts.set', 'scripts.create', 'scripts.command', 'scripts.skill', 'scripts.setModule', 'issues.list', 'issues.create', 'issues.setPriority', 'wp.list', 'wp.save', 'wp.toggle', 'wp.delete', 'wp.check', 'wp.setSkill', 'ave.list', 'ave.save', 'ave.paste', 'ave.toggle', 'ave.delete', 'ave.check', 'ave.orders', 'ave.setSkill', 'issues.importDir', 'issues.skill', 'issues.setSkill', 'local.export', 'local.import', 'fs.stat', 'fs.mkdir', 'fs.rename', 'fs.trash', 'fs.roots', 'fs.addRoot', 'fs.removeRoot', 'code.files', 'code.search', 'voice.status', 'voice.transcribe', 'export.creds', 'import.creds', 'git.run', 'git.findRepos', 'git.release', 'api.tree', 'api.read', 'api.save', 'api.mkdir', 'api.rename', 'api.delete', 'api.vars', 'api.setVars', 'api.send', 'api.setSkill', 'team.list', 'team.save', 'team.delete', 'team.import', 'team.setSkill', 'todos.list', 'todos.save', 'todos.delete', 'todos.setSkill', 'msgs.list', 'msgs.save', 'msgs.delete', 'msgs.importFile', 'msgs.importPr', 'msgs.setSkill', 'claude.conversations', 'music.ytInfo', 'paths.check', 'open.editor', 'open.folder'];
  function checkBridgeVersion(info) {
    // bridges anteriores a 1.1 no anuncian sus operaciones: se tratan como desactualizados
    const missing = info.ops ? REQUIRED_OPS.filter((op) => !info.ops.includes(op)) : null;
    const bar = $('#bridge-warn');
    if (missing && !missing.length) { bar.classList.add('hidden'); return; }
    const started = info.startedAt ? ` (en marcha desde las ${new Date(info.startedAt).toLocaleTimeString()})` : '';
    bar.replaceChildren(
      h('span', '⚠'),
      h('span.grow',
        h('b', 'El bridge en ejecución es una versión anterior'), started,
        missing ? `: no soporta ${missing.join(', ')}.` : ` (v${info.version || '?'}): le faltan funciones nuevas como bases de datos, git y YouTube.`,
        ' Reinícialo: en su terminal pulsa Ctrl+C y vuelve a ejecutar ',
        h('code', 'node bridge/frap-bridge.js'),
        '. Las terminales abiertas se cerrarán.'),
      h('button.icon', { title: 'Ocultar', onclick: () => bar.classList.add('hidden') }, '✕'));
    bar.classList.remove('hidden');
  }

  function setConn(kind, detail) {
    const el = $('#conn');
    el.className = `conn ${kind}`;
    el.title = detail || '';
    $('#offline').classList.toggle('hidden', kind === 'on');
    if (kind !== 'on') $('#bridge-warn').classList.add('hidden');
    $('#offline-detail').textContent = kind === 'on' ? '' : detail || '';
    $('#st-host').textContent = kind === 'on' ? detail : '';
  }

  // ======================================================================
  // Terminales
  // ======================================================================
  /** sid -> { sid, info, term, fit, pane, attaching, lastOut, liveTitle } */
  const terms = new Map();

  const XTERM_THEME = {
    background: '#0e1014', foreground: '#d7dae0', cursor: '#7aa2f7', cursorAccent: '#0e1014',
    selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7',
    magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68',
    brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  };

  function ensureTerm(info) {
    let t = terms.get(info.sid);
    if (t) { t.info = info; return t; }
    const pane = h('div.term-pane', { dataset: { sid: info.sid } });
    pane.style.visibility = 'hidden';
    $('#term-host').append(pane);
    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
      fontSize: state.settings.fontSize,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: XTERM_THEME,
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(pane);
    term.registerLinkProvider(pathLinkProvider(() => t));
    t = { sid: info.sid, info, term, fit, pane, attaching: true, lastOut: info.lastOutput || 0, liveTitle: '' };
    terms.set(info.sid, t);
    if (['shell', 'ssh'].includes(termKind(t))) {
      // arriba a la derecha: limpiar y copiar todo (solo shell y ssh; en las IA la pantalla la maneja la propia app)
      pane.append(h('div.term-tools',
        h('button.icon.term-tool', { title: 'Limpiar la terminal (borra también el historial guardado)', onmousedown: (e) => e.preventDefault(), onclick: () => termClear(t) }, termToolIcon('clear')),
        h('button.icon.term-tool', { title: 'Copiar todo el contenido de la terminal', onmousedown: (e) => e.preventDefault(), onclick: () => termCopyAll(t) }, termToolIcon('copy'))));
    }

    const focusSplit = () => { if (t.sid !== state.activeSid && pane.classList.contains('split')) activate(t.sid); };
    pane.addEventListener('mousedown', focusSplit);
    pane.addEventListener('focusin', focusSplit);
    term.onData((data) => Bridge.send('session.input', { sid: t.sid, data }));
    term.onTitleChange((title) => { t.liveTitle = title; renderTabs(); renderProjects(); });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        const sel = term.getSelection();
        if (sel) copyText(sel);
        e.preventDefault();
        return false;
      }
      if (isAppShortcut(e)) return false; // lo maneja el listener global
      return true;
    });
    fitTerm(t);
    attach(t);
    renderTeamChip(t);
    return t;
  }

  /** Íconos SVG de los botones de la terminal (sin innerHTML: nodos creados uno a uno). */
  function termToolIcon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
    const shapes = name === 'copy'
      ? [['rect', { x: '9', y: '9', width: '12', height: '12', rx: '2' }], ['path', { d: 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1' }]]
      : [['path', { d: 'M3 6h18' }], ['path', { d: 'M8 6V4h8v2' }], ['path', { d: 'M19 6l-1 14H6L5 6' }], ['path', { d: 'M10 11v6M14 11v6' }]];
    for (const [tag, attrs] of shapes) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); svg.append(el); }
    return svg;
  }
  /** Limpia la pantalla y el historial (también el del bridge y la sesión: no vuelve al recargar). */
  function termClear(t) {
    t.term.clear();
    Bridge.call('session.clear', { sid: t.sid }).catch((e) => toast(e.message, 'err'));
    t.term.focus();
  }
  /** Copia todo lo que hay en la terminal (historial + pantalla), sin las líneas vacías del final. */
  function termCopyAll(t) {
    const b = t.term.buffer.active;
    const lines = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text; else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const text = lines.join('\n');
    if (!text) { toast('La terminal está vacía'); return; }
    copyText(text);
    toast(`Copiadas ${lines.length} línea${lines.length === 1 ? '' : 's'} de la terminal`, 'ok');
    t.term.focus();
  }

  /** Repinta todas las filas de una terminal (xterm a veces no dibuja lo que llegó mientras estaba oculta o al
   * re-adjuntar: el texto estaba, pero solo aparecía al seleccionarlo). */
  function termRepaint(t) {
    if (!t || !t.term || !t.pane.offsetWidth) return;
    try { t.term.refresh(0, t.term.rows - 1); } catch (_) { /* aún sin renderer */ }
  }
  /** Las apps de pantalla completa (claude, codex…) solo se redibujan con SIGWINCH: un cambio de tamaño de ida y vuelta. */
  function termNudge(t) {
    if (!t || t.info.alive === false || !t.term.rows || t.term.rows < 3) return;
    const { cols, rows } = t.term;
    Bridge.send('session.resize', { sid: t.sid, cols, rows: rows - 1 });
    setTimeout(() => { Bridge.send('session.resize', { sid: t.sid, cols, rows }); t.lastSize = `${cols}x${rows}`; }, 120);
  }

  async function attach(t) {
    t.attaching = true;
    try {
      const res = await Bridge.call('session.attach', { sid: t.sid });
      t.term.reset();
      if (res.buffer) t.term.write(res.buffer, () => requestAnimationFrame(() => termRepaint(t)));
      t.info = { ...t.info, ...res };
      if (res.buffer) actionScan(t, res.buffer, true);
      if (!res.alive) t.term.write('\r\n\x1b[2m[proceso terminado]\x1b[0m\r\n');
    } catch (e) {
      t.term.write(`\r\n\x1b[31m[frap] ${e.message}\x1b[0m\r\n`);
    }
    t.attaching = false;
    sendResize(t);
    // tras re-adjuntar (recargar la página o el bridge): que las apps de pantalla completa se redibujen enteras
    if (t.info.alive !== false) setTimeout(() => { termNudge(t); setTimeout(() => termRepaint(t), 400); }, 300);
  }

  function fitTerm(t) {
    if (!t || !t.pane.offsetWidth) return;
    try { t.fit.fit(); } catch (_) { /* sin tamaño */ }
    sendResize(t);
  }
  function sendResize(t) {
    const { cols, rows } = t.term;
    if (t.lastSize === `${cols}x${rows}`) return;
    t.lastSize = `${cols}x${rows}`;
    Bridge.send('session.resize', { sid: t.sid, cols, rows });
  }
  const fitAll = debounce(() => terms.forEach(fitTerm), 60);
  // la fuente monoespaciada carga tarde y la pestaña del navegador puede volver de segundo plano: repintar
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => terms.forEach((t) => { fitTerm(t); termRepaint(t); }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestAnimationFrame(() => terms.forEach(termRepaint)); });
  new ResizeObserver(() => { fitAll(); codeRefreshSoon(); }).observe($('#term-host'));
  const codeRefreshSoon = debounce(() => codeRefreshEditors(), 80);

  function disposeTerm(sid) {
    const t = terms.get(sid);
    if (!t) return;
    t.term.dispose();
    t.pane.remove();
    terms.delete(sid);
  }

  Bridge.on('out', ({ sid, d }) => {
    const t = terms.get(sid);
    if (!t) return;
    t.lastOut = Date.now();
    if (!t.attaching) {
      t.term.write(d, () => msgFileScanSoon(t));
      actionScan(t, d, false);
    }
  });

  /**
   * Markdown → formato de WhatsApp (los mensajes se copian para pegarlos ahí): **negrita** → *negrita*,
   * *cursiva* → _cursiva_, ~~tachado~~ → ~tachado~, títulos "## x" → *x*, [texto](url) → texto (url).
   * Los bloques de código (```) se dejan tal cual (WhatsApp también los usa).
   */
  function toWhatsApp(md) {
    return String(md).split(/(```[\s\S]*?```)/).map((part, i) => {
      if (i % 2) return part; // bloque de código
      return part
        .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_, t) => `\u0001${t.replace(/\*+/g, '')}\u0001`)
        .replace(/\*\*(.+?)\*\*/g, '\u0001$1\u0001')
        .replace(/__(.+?)__/g, '\u0001$1\u0001')
        .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, '$1_$2_')
        .replace(/\u0001/g, '*')
        .replace(/~~(.+?)~~/g, '~$1~')
        .replace(/!?\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t, u) => (t === u ? u : `${t} (${u})`));
    }).join('');
  }
  Bridge.on('exit', ({ sid, code }) => {
    const t = terms.get(sid);
    if (!t) return;
    t.info.alive = false;
    t.info.exitCode = code;
    if (termKind(t) === 'action') { onActionExit(t, code); return; }
    // si la terminal aún está cargando su historial (proceso que murió al instante), el aviso va después
    const note = () => {
      if (t.attaching) { setTimeout(note, 50); return; }
      t.term.write(`\r\n\x1b[2m[proceso terminado · código ${code}] — cierra la pestaña o pulsa Enter para reiniciar\x1b[0m\r\n`);
    };
    note();
    t.exitHandler = t.term.onData((d) => {
      if (d === '\r') restartTerm(sid);
    });
    renderAll();
  });
  Bridge.on('sessions', () => syncSessions());
  Bridge.on('notice', ({ sid, notice }) => {
    const t = terms.get(sid);
    if (!t) return;
    t.info.notice = notice;
    // si el usuario ya la está mirando, no hace falta marcarla
    if (notice && sid === state.activeSid && !document.hidden && document.hasFocus()) markSeen(t);
    renderProjects();
    renderTabs();
    updateTitle();
  });
  window.addEventListener('focus', () => { const t = activeTerm(); if (t && t.info.notice) { markSeen(t); renderAll(); } });

  /** reattach=true al (re)conectar: las terminales ya abiertas recargan su historial, porque
   *  mientras el bridge estuvo caído (o se reinició) siguieron produciendo salida. */
  async function syncSessions(reattach = false) {
    if (!Bridge.ready) return;
    let list;
    try { list = await Bridge.call('sessions.list'); } catch (_) { return; }
    const seen = new Set();
    for (const info of list) {
      seen.add(info.sid);
      const existed = terms.has(info.sid);
      const t = ensureTerm(info);
      if (reattach && existed) attach(t);
    }
    for (const sid of [...terms.keys()]) if (!seen.has(sid) && terms.get(sid).info.alive !== false) disposeTerm(sid);
    renderTeamChips(); // la persona asignada o el tipo de agente pudieron cambiar
    if (state.activeSid && !isViewSid(state.activeSid) && !terms.has(state.activeSid)) state.activeSid = null;
    if (!state.activeSid) {
      const first = sessionsOf(state.activeProject)[0];
      if (first) state.activeSid = first.sid;
    }
    renderAll();
  }

  /** Posición en el orden manual del proyecto (p.order, arrastrando en el panel izquierdo); lo nuevo va al final. */
  function orderRank(projectId) {
    const p = state.projects.find((x) => x.id === projectId);
    const o = (p && p.order) || [];
    return (key) => { const i = o.indexOf(key); return i < 0 ? Infinity : i; };
  }
  function sessionsOf(projectId) {
    const rank = orderRank(projectId);
    return [...terms.values()]
      .filter((t) => (t.info.meta || {}).projectId === projectId)
      .sort((a, b) => (rank(a.sid) - rank(b.sid)) || (a.info.created - b.info.created));
  }
  function orphanSessions() {
    const ids = new Set(state.projects.map((p) => p.id));
    return [...terms.values()].filter((t) => termKind(t) !== 'action' && !ids.has((t.info.meta || {}).projectId));
  }
  /** Terminales con pestaña: las del proyecto activo, o las "Sin proyecto" (p. ej. ssh) si una de ellas está activa. */
  function tabSessions() {
    const at = activeTerm();
    const orphanActive = at && termKind(at) !== 'action' && !project((at.info.meta || {}).projectId);
    return orphanActive || !project() ? orphanSessions() : sessionsOf(state.activeProject);
  }
  // Nombre de la terminal. Si el usuario la renombró (meta.named), manda su nombre: claude/codex cambian el título
  // de la terminal (tema de la conversación, ✳ mientras trabaja) y antes lo pisaban. Sin nombre propio, el título vivo.
  const termTitle = (t) => { const m = t.info.meta || {}; return (m.named && m.title) || t.liveTitle || m.title || t.sid; };
  /** Tooltip con el título que pone el programa (claude…) cuando no es el que se muestra. */
  const termLiveHint = (t) => (t.liveTitle && t.liveTitle !== termTitle(t) ? `Título de la terminal: ${t.liveTitle}\n` : '');
  const termKind = (t) => (t.info.meta || {}).kind || 'shell';

  function activeTerm() { return terms.get(state.activeSid) || null; }

  let lastAiSid = null; // última terminal de IA activada (destino de "Enviar a la IA" del editor)
  function activate(sid) {
    const t = terms.get(sid);
    if (!t) return;
    if (['claude', 'codex', 'opencode'].includes(termKind(t))) lastAiSid = sid;
    const pid = (t.info.meta || {}).projectId;
    if (pid && project(pid)) state.activeProject = pid;
    state.activeSid = sid;
    markSeen(t);
    save();
    renderAll();
    requestAnimationFrame(() => { fitTerm(t); t.term.focus(); });
  }

  function buildLaunch(kind, p) {
    if (kind === 'shell') return '';
    const l = state.settings.launchers[kind] || { cmd: kind, addDir: '' };
    let cmd = l.cmd;
    if (l.addDir) for (const f of p.folders.slice(1)) cmd += ` ${l.addDir} ${shQuote(f)}`;
    return cmd;
  }

  async function launch(kind, opts = {}) {
    const p = project();
    if (!p) { toast('Primero crea o selecciona un proyecto', 'err'); return; }
    if (!p.folders.length) { toast('El proyecto no tiene carpetas', 'err'); return; }
    if (!Bridge.ready) { toast('Bridge desconectado', 'err'); return; }
    const n = sessionsOf(p.id).filter((t) => termKind(t) === kind).length + 1;
    const tool = Bridge.info && Bridge.info.tools ? Bridge.info.tools[kind] : true;
    if (kind !== 'shell' && tool === null) toast(`No encuentro "${kind}" en el PATH del bridge; se intentará igual`, 'err');
    try {
      const info = await Bridge.call('session.create', {
        cwd: opts.cwd || p.folders[0],
        cols: 120, rows: 32,
        init: opts.init != null ? opts.init : buildLaunch(kind, p),
        meta: { projectId: p.id, kind, title: opts.title || (n > 1 ? `${kind} ${n}` : kind), ...(opts.named && opts.title ? { named: true } : {}), ...(opts.person ? { person: opts.person } : {}), ...(opts.icon ? { icon: String(opts.icon).slice(0, 8) } : {}) },
      });
      ensureTerm(info);
      activate(info.sid);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function restartTerm(sid) {
    const t = terms.get(sid);
    if (!t) return;
    const meta = t.info.meta || {};
    const p = project(meta.projectId);
    disposeTerm(sid);
    if (meta.sshId) { if (p) state.activeProject = p.id; await connectSsh(meta.sshId); return; }
    if (!p) { renderAll(); return; }
    state.activeProject = p.id;
    await launch(meta.kind || 'shell', { title: meta.title, cwd: meta.cwd, named: meta.named });
  }

  async function closeTerm(sid) {
    const t = terms.get(sid);
    if (!t) return;
    if (t.info.alive !== false) {
      try { await Bridge.call('session.kill', { sid }); } catch (_) { /* ya muerta */ }
    }
    const list = tabSessions();
    const idx = list.findIndex((x) => x.sid === sid);
    disposeTerm(sid);
    if (state.activeSid === sid) {
      const rest = list.filter((x) => x.sid !== sid);
      state.activeSid = rest.length ? rest[Math.min(idx, rest.length - 1)].sid : null;
    }
    save();
    renderAll();
  }

  // logos de plataformas: no hay emoji, se guardan como código corto (≤ 8) y se dibujan con su SVG
  const LOGO_ICONS = { '@shopify': { file: 'shopify', name: 'Shopify', emoji: '🛍️' }, '@wp': { file: 'wordpress', name: 'WordPress', emoji: '🌐' } };
  /** Nodo de un ícono de sesión: el logo (img) o el emoji tal cual. */
  const iconNode = (ic, cls = 'span.ticon') => (LOGO_ICONS[ic] ? h(`img.${cls.split('.').slice(1).join('.')}.ticon-logo`, { src: `vendor/icons/${LOGO_ICONS[ic].file}.svg`, alt: LOGO_ICONS[ic].name, title: LOGO_ICONS[ic].name }) : h(cls, ic));
  /** Para texto (WhatsApp): el logo se cambia por un emoji. */
  const iconText = (ic) => (LOGO_ICONS[ic] ? LOGO_ICONS[ic].emoji : ic);
  const SESSION_ICONS = ['', '@shopify', '@wp', '📌', '🚀', '🐞', '🔥', '⭐', '💼', '🛒', '🚚', '📦', '💰', '📊', '🧪', '🛠️', '🔒', '🌐', '📱', '🗄️', '📝', '💬', '📣', '🤝', '⏰', '🎯', '🧭', '🧩', '🎨', '✅', '⚠️', '❗', '🔔', '💡', '🟢', '🟡', '🔴', '🟣', '🔵'];
  /** Ícono propio de una sesión (se ve antes de su nombre y encabeza los mensajes que se copian). */
  const termIcon = (t) => String(((t && t.info.meta) || {}).icon || '');
  /** Renombrar una sesión: nombre (vacío = título automático) e ícono. */
  function renameTerm(sid) {
    const t = terms.get(sid);
    if (!t) return;
    const m = t.info.meta || {};
    const name = h('input', { value: m.named ? m.title : termTitle(t), placeholder: 'Vacío: el título automático de la terminal' });
    const icon = h('input.team-icon-in', { value: m.icon || '', maxlength: '8', placeholder: '·' });
    const picks = h('div.icon-grid', SESSION_ICONS.map((ic) => h('button.icon-pick', { type: 'button', title: ic ? (LOGO_ICONS[ic] ? LOGO_ICONS[ic].name : '') : 'Sin ícono', onclick: () => { icon.value = ic; } }, ic ? (LOGO_ICONS[ic] ? iconNode(ic, 'span.pick-logo') : ic) : '∅')));
    const doSave = async () => {
      const n = name.value.trim();
      const ic = icon.value.trim();
      try {
        // con nombre: queda fijo aunque claude/codex cambien el título. Vacío: vuelve al título automático
        const info = await Bridge.call('session.meta', { sid, meta: { ...(n ? { title: n, named: true } : { named: false }), icon: ic || null } });
        t.info.meta = info.meta;
        modalClose(true);
      } catch (e) { toast(e.message, 'err'); }
      renderAll();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    openModal({
      title: 'Renombrar terminal',
      body: [
        h('div.field-row', h('div.field', { style: 'width:80px' }, h('label', 'Ícono'), icon), h('div.field.grow', h('label', 'Nombre'), name)),
        picks,
        h('p.muted', { style: 'font-size:11px;margin:6px 0 0' }, 'El ícono se ve antes del nombre (en el panel izquierdo y en la pestaña) y encabeza los mensajes que copias de esta sesión (WhatsApp).'),
      ],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
    requestAnimationFrame(() => name.select());
  }

  /** Envía texto a la terminal activa. Multilínea va como bracketed paste. */
  function sendToTerminal(text, enter = true) {
    const t = activeTerm();
    if (!t || t.info.alive === false) { toast('No hay terminal activa', 'err'); return false; }
    let data = text;
    if (text.includes('\n')) data = `\x1b[200~${text}\x1b[201~`;
    Bridge.send('session.input', { sid: t.sid, data });
    if (enter) setTimeout(() => Bridge.send('session.input', { sid: t.sid, data: '\r' }), 60);
    t.term.focus();
    return true;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
    document.body.append(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) { /* nada */ }
    ta.remove();
  }

  // ======================================================================
  // Rutas clicables en la terminal: clic = abrir en el editor de FRAP (o el comando de Ajustes)
  // ======================================================================
  // Candidatas: /abs/ruta, ~/ruta, ./ruta, ../ruta, dir/archivo y archivo.ext, con :línea:col opcional.
  // Solo se subrayan las que el bridge confirma que existen.
  const PATH_RE = /(?:(?:~|\.{1,2})?\/|[\w@+-][\w@.+-]*\/)[^\s'"`<>()[\]{}|,;:*?]*|[\w@+-][\w@.+-]*\.[A-Za-z][\w]{0,7}/g;
  const pathCache = new Map(); // `${cwd}\0${ruta}` -> { hit: {path, dir} | null, at }
  const PATH_TTL = 15000;

  /** Texto de la línea lógica (une filas partidas) con un mapa índice -> celda {x, y} (1-based). */
  function logicalLine(buffer, row) {
    let start = row;
    while (start > 0 && buffer.getLine(start) && buffer.getLine(start).isWrapped) start--;
    let end = row;
    while (buffer.getLine(end + 1) && buffer.getLine(end + 1).isWrapped) end++;
    let text = '';
    const map = [];
    for (let y = start; y <= end; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue; // segunda mitad de un carácter ancho
        const ch = cell.getChars() || ' ';
        for (let k = 0; k < ch.length; k++) map.push({ x: x + 1, y: y + 1, w: cell.getWidth() });
        text += ch;
      }
    }
    return { text, map };
  }

  function pathCandidates(text) {
    const out = [];
    PATH_RE.lastIndex = 0;
    let m;
    while ((m = PATH_RE.exec(text))) {
      let raw = m[0];
      const startIdx = m.index;
      // puntuación final que no es parte de la ruta ("…/archivo.sql." al final de una frase)
      raw = raw.replace(/[.,;:!?'"]+$/, '');
      if (raw.length < 3 || /^\.+\/?$/.test(raw) || /^\/+$/.test(raw)) continue;
      if (/^[a-z][\w+.-]*:\/\//i.test(text.slice(Math.max(0, startIdx - 10), startIdx + 3))) continue; // parte de una URL
      // :línea[:columna] o (línea,col) justo después
      const rest = text.slice(startIdx + raw.length);
      const lc = rest.match(/^:(\d+)(?::(\d+))?/) || rest.match(/^\((\d+),\s*(\d+)\)/);
      const len = raw.length + (lc ? lc[0].length : 0);
      out.push({ raw, start: startIdx, end: startIdx + len - 1, line: lc ? +lc[1] : 0, col: lc && lc[2] ? +lc[2] : 0 });
    }
    return out;
  }

  async function resolvePaths(cwd, raws) {
    const now = Date.now();
    const need = [...new Set(raws)].filter((r) => {
      const c = pathCache.get(`${cwd}\0${r}`);
      return !c || now - c.at > PATH_TTL;
    });
    if (need.length && Bridge.ready) {
      try {
        const found = await Bridge.call('paths.check', { cwd, paths: need });
        const hit = new Map(found.map((f) => [f.input, f]));
        for (const r of need) pathCache.set(`${cwd}\0${r}`, { hit: hit.get(r) || null, at: now });
      } catch (_) { /* bridge viejo o caído: sin enlaces */ }
      if (pathCache.size > 3000) pathCache.clear();
    }
    const res = new Map();
    for (const r of raws) { const c = pathCache.get(`${cwd}\0${r}`); if (c && c.hit) res.set(r, c.hit); }
    return res;
  }

  function pathLinkProvider(getTerm) {
    return {
      provideLinks(y, callback) {
        const t = getTerm();
        if (!t || !Bridge.ready) { callback(undefined); return; }
        const buffer = t.term.buffer.active;
        const { text, map } = logicalLine(buffer, y - 1);
        const cands = pathCandidates(text);
        if (!cands.length) { callback(undefined); return; }
        const cwd = (t.info.meta || {}).cwd || '';
        resolvePaths(cwd, cands.map((c) => c.raw)).then((found) => {
          const links = [];
          for (const c of cands) {
            const f = found.get(c.raw);
            if (!f) continue;
            const a = map[c.start];
            const b = map[c.end];
            if (!a || !b || a.y > y || b.y < y) continue; // solo los que tocan esta fila
            const label = f.dir ? 'carpeta' : c.line ? `línea ${c.line}` : 'archivo';
            links.push({
              range: { start: { x: a.x, y: a.y }, end: { x: b.x + (b.w > 1 ? b.w - 1 : 0), y: b.y } },
              text: c.raw,
              decorations: { underline: true, pointerCursor: true },
              activate: (ev) => {
                if (ev && ev.button !== 0) return;
                openInEditor(f.path, c.line, c.col, f.dir, (t.info.meta || {}).projectId);
              },
              hover: () => { t.pane.title = `Clic: abrir ${label} en ${editorName()} — ${f.path}${c.line ? ':' + c.line : ''}`; },
              leave: () => { t.pane.title = ''; },
            });
          }
          callback(links.length ? links : undefined);
        });
      },
    };
  }

  // gancho de depuración (solo con localStorage frap.debug = true)
  if (storeGet('frap.debug', false)) window.__frap = { terms, logicalLine, pathCandidates, resolvePaths, openInEditor, openImport: (d, n) => openImport(d, n), get state() { return state; } };

  const cmdName = (cmd) => {
    const e = basename((cmd || 'code').split(/\s+/)[0]);
    return { code: 'VS Code', 'code-insiders': 'VS Code Insiders', codium: 'VSCodium', cursor: 'Cursor', windsurf: 'Windsurf', frap: 'el editor de FRAP' }[e] || e;
  };
  const editorName = () => cmdName(state.settings.editor || 'frap');
  const extEditorCmd = () => state.settings.extEditor || (state.settings.editor !== 'frap' && state.settings.editor) || 'code';
  const extEditorName = () => cmdName(extEditorCmd());
  /** Ruta clicada en la terminal: al editor de FRAP (por defecto) o al comando configurado en Ajustes. */
  async function openInEditor(p, line, col, isDir, pid) {
    if ((state.settings.editor || 'frap') === 'frap' && launchOn('code')) { await openInFrap(p, line, col, isDir, pid); return; }
    if ((state.settings.editor || 'frap') === 'frap') { await openExternal(p, line, col); return; } // editor de FRAP apagado (Módulos)
    await openExternal(p, line, col, state.settings.editor);
  }
  async function openExternal(p, line, col, cmd = extEditorCmd()) {
    try {
      await Bridge.call('open.editor', { path: p, line, col, editor: cmd });
      toast(`Abriendo ${basename(p)}${line ? ':' + line : ''} en ${cmdName(cmd)}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  // ======================================================================
  // Proyectos
  // ======================================================================
  async function newProject() {
    const folder = await pickFolder();
    if (!folder) return;
    const p = { id: uid(), name: basename(folder), folders: [folder] };
    state.projects.push(p);
    const sec = (state.sections || []).find((s) => s.id === state.ui.section);
    if (sec && sec.id !== 'all' && modOn('left.sections')) addToSection(sec, p.id); // creada estando en una sección: queda en ella
    state.activeProject = p.id;
    state.activeSid = null;
    save();
    renderAll();
    loadConfig(true);
  }
  async function addFolder(p) {
    const folder = await pickFolder(p.folders[0]);
    if (!folder || p.folders.includes(folder)) return;
    p.folders.push(folder);
    save();
    renderAll();
    loadConfig(true);
  }
  function removeFolder(p, folder) {
    if (p.folders.length === 1) { toast('Un proyecto necesita al menos una carpeta', 'err'); return; }
    p.folders = p.folders.filter((f) => f !== folder);
    save();
    renderAll();
    loadConfig(true);
  }
  /** Editar proyecto: nombre, descripción, URL y si se muestra el ojo con la info. */
  function renameProject(p) {
    const name = h('input', { value: p.name, placeholder: 'Mi proyecto' });
    const desc = h('textarea', { rows: 4, placeholder: 'Para qué es, notas, enlaces… (opcional)' });
    desc.value = p.desc || '';
    desc.style.cssText = 'width:100%;resize:vertical';
    const url = h('input.mono', { value: p.url || '', placeholder: 'https://mi-sitio.com o localhost:3000 (opcional)' });
    const info = h('input', { type: 'checkbox' });
    info.checked = p.showInfo !== false;
    const secChecks = state.sections.filter((s) => s.id !== 'all').map((s) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = s.projects.includes(p.id);
      return { s, cb, el: h('label.sec-proj', cb, h('span', `${s.icon ? s.icon + ' ' : ''}${s.title}`)) };
    });
    const doSave = () => {
      const n = name.value.trim();
      const u = normalizeUrl(url.value);
      if (!n) { toast('El nombre es obligatorio', 'err'); return; }
      if (u && !validUrl(u)) { toast('URL inválida (usa http, https o file)', 'err'); return; }
      p.name = n;
      p.desc = desc.value.trim();
      p.url = u;
      p.showInfo = info.checked;
      for (const { s, cb } of secChecks) s.projects = cb.checked ? [...new Set([...s.projects, p.id])] : s.projects.filter((id) => id !== p.id);
      save();
      modalClose(true);
      renderAll();
    };
    [name, url].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); }));
    openModal({
      title: `Editar proyecto · ${p.name}`,
      body: [
        h('div.field', h('label', 'Nombre'), name),
        h('div.field', h('label', 'Descripción'), desc),
        h('div.field', h('label', 'URL (botón 🌐: la abre en otra pestaña)'), url),
        h('label.muted', info, ' Mostrar el ojo 👁 con el nombre y la descripción al pasar el mouse'),
        secChecks.length ? h('div.field', h('label', 'Secciones'), h('div.sec-projs', secChecks.map((x) => x.el))) : null,
      ],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
    requestAnimationFrame(() => name.focus());
  }
  function openProjectUrl(p) {
    if (!p.url || !validUrl(p.url)) { toast('URL inválida', 'err'); return; }
    openPageTab({ url: p.url });
  }

  // Tooltip del ojo: flotante en <body> (el panel izquierdo recorta lo que sobresale).
  let projTip = null;
  function showProjectTip(p, anchor) {
    hideProjectTip();
    projTip = h('div.proj-tip',
      h('div.proj-tip-title', p.name),
      p.desc ? h('div.proj-tip-desc', p.desc) : h('div.proj-tip-desc.muted', 'Sin descripción. Agrégala con ✎.'),
      p.url ? h('div.proj-tip-url', `🌐 ${p.url}`) : null);
    document.body.append(projTip);
    const r = anchor.getBoundingClientRect();
    const tr = projTip.getBoundingClientRect();
    projTip.style.left = `${Math.min(r.right + 8, window.innerWidth - tr.width - 8)}px`;
    projTip.style.top = `${Math.max(8, Math.min(r.top - 6, window.innerHeight - tr.height - 8))}px`;
  }
  function hideProjectTip() { if (projTip) { projTip.remove(); projTip = null; } }
  /** «Retomar conversación…»: las conversaciones de claude de las carpetas del proyecto, para reabrir la que elijas. */
  async function resumeConversationModal(p) {
    if (!Bridge.ready) { toast('Bridge desconectado', 'err'); return; }
    let convs = [];
    try {
      for (const f of p.folders) for (const c of await Bridge.call('claude.conversations', { cwd: f, limit: 60 })) convs.push({ ...c, folder: f });
    } catch (e) { toast(e.message, 'err'); return; }
    convs.sort((a, b) => b.mtime - a.mtime);
    const q = h('input', { placeholder: 'Buscar por tema, issue o mensaje…', spellcheck: 'false' });
    const list = h('div.conv-list');
    const when = (ms) => { const d = new Date(ms); const today = new Date(); const y = new Date(Date.now() - 86400000); const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); return d.toDateString() === today.toDateString() ? `hoy ${hm}` : d.toDateString() === y.toDateString() ? `ayer ${hm}` : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); };
    const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
    const paint = () => {
      const t = q.value.trim().toLowerCase();
      const shown = convs.filter((c) => !t || `${c.title} ${c.first} ${c.last} ${c.lastAi} ${c.issues.join(' ')} ${c.skill}`.toLowerCase().includes(t));
      list.replaceChildren(...(shown.length ? shown.map((c) => h(`div.conv${c.open ? '.is-open' : ''}`,
        h('div.conv-main',
          h('div.conv-title', c.title || '(sin tema)'),
          c.last && c.last !== c.first && c.last !== c.title ? h('div.conv-last.muted', `Tú: ${c.last}`) : null,
          c.lastAi ? h('div.conv-last.muted', `IA: ${c.lastAi}`) : null,
          h('div.conv-meta.muted',
            h('span', when(c.mtime)), h('span', kb(c.size)),
            p.folders.length > 1 ? h('span', tilde(c.folder)) : null,
            ...c.issues.map((i) => h('span.conv-issue', i)),
            c.skill ? h('span', `skill ${c.skill}`) : null,
            h('span.mono', c.id.slice(0, 8)))),
        c.open
          ? h('button.mini', { title: `Ya está abierta en «${c.open.title}»`, onclick: () => { modalClose(true); activate(c.open.sid); } }, '→ Ir')
          : h('button.mini.primary', {
            title: `claude --resume ${c.id}`,
            onclick: async () => {
              modalClose(true);
              state.activeProject = p.id;
              const topic = (c.title || 'claude').replace(/\b[A-Z]{2,6}-\d{1,6}\b/g, '').replace(/\s+/g, ' ').trim();
              const title = c.issues[0] ? `${c.issues[0]} · ${topic}` : topic;
              await launch('claude', { cwd: c.folder, title: title.slice(0, 50), named: true, init: `${buildLaunch('claude', p)} --resume ${c.id}` });
              toast('Conversación retomada (renómbrala con doble clic si quieres)', 'ok');
            },
          }, '↺ Retomar'))) : [h('p.muted', convs.length ? 'Nada coincide.' : 'No hay conversaciones de claude en las carpetas de este proyecto.')]));
    };
    q.addEventListener('input', paint);
    paint();
    openModal({
      title: `Retomar conversación · ${p.name}`,
      wide: true,
      body: [h('p.muted', { style: 'margin:0 0 8px' }, 'Conversaciones de claude en las carpetas del proyecto, las más recientes primero. «Retomar» abre una terminal con claude --resume; las que ya están abiertas llevan a su terminal.'), q, list],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cerrar')],
    });
    requestAnimationFrame(() => q.focus());
  }
  async function deleteProject(p) {
    const live = sessionsOf(p.id);
    const ok = await confirmBox(
      `¿Eliminar el proyecto "${p.name}"?`,
      live.length ? `Se cerrarán ${live.length} terminal(es). Las carpetas no se tocan.` : 'Las carpetas no se tocan.'
    );
    if (!ok) return;
    for (const t of live) await closeTerm(t.sid);
    dropProjectViews(p.id);
    state.projects = state.projects.filter((x) => x.id !== p.id);
    for (const s of state.sections || []) if (Array.isArray(s.projects)) s.projects = s.projects.filter((id) => id !== p.id);
    if (state.activeProject === p.id) {
      state.activeProject = state.projects[0] ? state.projects[0].id : null;
      state.activeSid = null;
    }
    save();
    renderAll();
    loadConfig(true);
  }
  /** ¿La pestaña `sid` (terminal, vista o página) sigue abierta y es del proyecto `pid`? */
  function sidOfProject(sid, pid) {
    if (!sid) return false;
    const t = terms.get(sid);
    if (t) return (t.info.meta || {}).projectId === pid;
    const v = viewBySid(sid);
    if (v) return v.projectId === pid;
    return isPageView(sid) && (state.openPages || []).includes(sid.slice(PAGE_PREFIX.length));
  }
  /** Ventana por defecto de un proyecto: la última que tenía abierta; si no, la pantalla dividida, su última terminal o su primera vista. */
  function defaultSidFor(pid) {
    const last = (state.ui.lastByProject || {})[pid];
    if (sidOfProject(last, pid)) return last;
    const prev = state.activeProject;
    state.activeProject = pid; // splitGroup mira el proyecto activo
    const group = splitGroup();
    state.activeProject = prev;
    const list = sessionsOf(pid);
    const views = openViewsOf(pid);
    return group.length ? group[0].sid : list.length ? list[list.length - 1].sid : views.length ? vSid(views[0]) : null;
  }
  /** Recuerda la ventana activa de cada proyecto y el proyecto y ventana de cada sección del panel izquierdo. */
  function rememberActive() {
    const pid = state.activeProject;
    if (!pid || !state.ui || !Array.isArray(state.sections) || !state.sections.length) return;
    if (state.activeSid && sidOfProject(state.activeSid, pid)) {
      state.ui.lastByProject = { ...(state.ui.lastByProject || {}), [pid]: state.activeSid };
    }
    const sec = activeSection();
    if (sec && sectionProjects(sec).some((p) => p.id === pid)) {
      state.ui.lastBySection = { ...(state.ui.lastBySection || {}), [sec.id]: { project: pid, sid: state.activeSid || null } };
    }
    // limpia proyectos y secciones que ya no existen
    for (const k of Object.keys(state.ui.lastByProject || {})) if (!project(k)) delete state.ui.lastByProject[k];
    for (const k of Object.keys(state.ui.lastBySection || {})) if (!state.sections.some((x) => x.id === k)) delete state.ui.lastBySection[k];
  }
  function selectProject(id) {
    if (state.activeProject === id) return;
    state.activeProject = id;
    state.activeSid = defaultSidFor(id);
    save();
    renderAll();
    loadConfig();
    const t = activeTerm();
    if (t) requestAnimationFrame(() => { fitTerm(t); t.term.focus(); });
  }

  // ======================================================================
  // Render: panel izquierdo, pestañas, terminal visible
  // ======================================================================
  function isBusy(t) { return t.info.alive !== false && Date.now() - t.lastOut < 1500; }
  function dotClass(t) { return t.info.alive === false ? 'dot dead' : isBusy(t) ? 'dot busy' : 'dot'; }

  /** slot = posición (0-3) en la pantalla dividida, o undefined si no está agrupada. pid: se puede reordenar dentro de ese proyecto. */
  function termItem(t, slot, pid) {
    const grouped = slot != null;
    return h('div.term-item', {
      class: `term-item${t.sid === state.activeSid ? ' active' : ''}${grouped ? ' grouped' : ''}`,
      dataset: pid ? { sid: t.sid, drag: 'item', key: t.sid, pid } : { sid: t.sid },
      ...(pid ? dragEvents() : {}),
      title: `${termLiveHint(t)}${(t.info.meta || {}).cwd || ''}\nDoble clic: renombrar`,
      onclick: () => activate(t.sid),
      ondblclick: () => renameTerm(t.sid),
    },
    pid ? dragHandle() : null,
    h('span', { class: dotClass(t) }),
    grouped ? h('span.slot', { title: `Pantalla dividida: panel ${slot + 1}` }, String(slot + 1)) : null,
    termIcon(t) ? iconNode(termIcon(t)) : null,
    h('span.tname', termTitle(t)),
    teamOn() && teamPerson((t.info.meta || {}).person) ? h('span.tperson', { title: `Asignada a ${teamPerson(t.info.meta.person).name} (${teamPerson(t.info.meta.person).role})` }, teamAvatar(teamPerson(t.info.meta.person), '.sm'), h('span.tperson-name', { style: `color:${teamColor(teamPerson(t.info.meta.person))}` }, teamPerson(t.info.meta.person).name.split(' ')[0])) : null,
    noticeBadge(t),
    kindIcon(termKind(t)) || h(`span.kind.${termKind(t)}`, termKind(t)));
  }

  /** Vista de git, DB o Archivos del proyecto, listada junto a sus terminales. */
  function viewItem(v) {
    const sid = vSid(v);
    return h('div.term-item.view-item', {
      class: `term-item view-item${sid === state.activeSid ? ' active' : ''}`,
      dataset: { sid, drag: 'item', key: sid, pid: v.projectId },
      title: VIEW_TITLE[v.kind],
      onclick: () => openViewSid(sid),
      ...dragEvents(),
    },
    dragHandle(),
    h('span.dot.view'),
    h('span.tname', viewLabel(v)),
    kindIcon(v.kind) || h(`span.kind.${v.kind}`, v.kind),
    h('span.x', { title: 'Cerrar', onclick: (e) => { e.stopPropagation(); closeView(v); } }, '✕'));
  }

  /** Aviso de un agente (hook Stop/Notification → $FRAP_NOTIFY): visible hasta abrir la terminal. */
  function noticeBadge(t) {
    const n = t.info.notice;
    if (!n) return null;
    return n.kind === 'done'
      ? h('span.notice.done', { title: `Terminó ${fmtAgo(n.at)}` }, '✓ terminó')
      : h('span.notice.waiting', { title: n.msg || 'Espera tu respuesta' }, '● espera');
  }
  function fmtAgo(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.round(s / 60)} min` : `hace ${Math.round(s / 3600)} h`;
  }
  const APP_TITLE = document.title;
  function updateTitle() {
    const n = [...terms.values()].filter((t) => t.info.notice).length;
    document.title = n ? `(${n}) ${APP_TITLE}` : APP_TITLE;
  }
  /** Borra el aviso de la terminal que el usuario está mirando. */
  function markSeen(t) {
    if (!t || !t.info.notice) return;
    t.info.notice = null;
    if (Bridge.ready) Bridge.call('session.seen', { sid: t.sid }).catch(() => {});
  }

  /** Terminales y vistas del proyecto en el orden del panel izquierdo (p.order; sin orden: terminales y luego vistas). */
  function projectItems(pid) {
    const rank = orderRank(pid);
    return [...sessionsOf(pid).map((t) => ({ key: t.sid, t })), ...openViewsOf(pid).map((v) => ({ key: vSid(v), v }))]
      .map((it, i) => ({ ...it, i }))
      .sort((a, b) => (rank(a.key) - rank(b.key)) || (a.i - b.i));
  }

  // ---------- secciones del panel izquierdo (como las listas de WhatsApp) ----------
  // state.sections = [{id, icon, title, desc, display: 'both'|'icon'|'title', projects: [pid]}]; la primera es
  // siempre "Todas" (id 'all', no se borra ni guarda proyectos). state.ui.section = id de la sección elegida.
  const SECTION_ICONS = ['🗂️', '💼', '🏠', '⭐', '🔥', '🧪', '🚀', '📦', '🛠️', '🎨', '📚', '🌐', '🤖', '💡', '🐞', '🔒', '💰', '🎮', '📱', '☁️'];
  const ALL_SECTION = () => ({ id: 'all', icon: '🗂️', title: 'Todas', desc: 'Todas las carpetas', display: 'both' });
  /** Deja state.sections consistente: "Todas" primero, sin ids repetidos ni proyectos que ya no existen. */
  function ensureSections() {
    const pids = new Set(state.projects.map((p) => p.id));
    const list = Array.isArray(state.sections) ? state.sections.filter((s) => s && s.id) : [];
    const all = list.find((s) => s.id === 'all') || ALL_SECTION();
    delete all.projects;
    const seen = new Set(['all']);
    const rest = list.filter((s) => s.id !== 'all' && !seen.has(s.id) && seen.add(s.id));
    for (const s of rest) s.projects = [...new Set((Array.isArray(s.projects) ? s.projects : []).filter((id) => pids.has(id)))];
    for (const s of [all, ...rest]) if (!['both', 'icon', 'title'].includes(s.display)) s.display = 'both';
    state.sections = [all, ...rest];
    if (!state.sections.some((s) => s.id === state.ui.section)) state.ui.section = 'all';
  }
  const activeSection = () => state.sections.find((s) => s.id === state.ui.section) || state.sections[0];
  /** Proyectos visibles en una sección (en el orden de state.projects). */
  const sectionProjects = (s) => (s.id === 'all' ? state.projects : state.projects.filter((p) => s.projects.includes(p.id)));
  function selectSection(id) {
    if (state.ui.section === id) return;
    state.ui.section = id;
    // vuelve al proyecto y la ventana que tenía abiertos esta sección (si no, el primer proyecto de la sección)
    const sec = activeSection();
    const inSec = sectionProjects(sec);
    const rec = (state.ui.lastBySection || {})[sec.id];
    const pid = rec && inSec.some((p) => p.id === rec.project) ? rec.project
      : inSec.some((p) => p.id === state.activeProject) ? state.activeProject : inSec[0] ? inSec[0].id : null;
    if (pid) {
      state.activeProject = pid;
      state.activeSid = rec && rec.project === pid && sidOfProject(rec.sid, pid) ? rec.sid : defaultSidFor(pid);
    }
    save();
    renderAll();
    loadConfig();
    const t = activeTerm();
    if (t) requestAnimationFrame(() => { fitTerm(t); t.term.focus(); });
  }
  function addToSection(s, pid) {
    if (s.id === 'all' || s.projects.includes(pid)) return false;
    s.projects.push(pid);
    return true;
  }
  function moveSection(s, dir) {
    const i = state.sections.indexOf(s);
    const j = i + dir;
    if (i < 1 || j < 1 || j >= state.sections.length) return; // "Todas" no se mueve
    state.sections.splice(i, 1);
    state.sections.splice(j, 0, s);
    save();
    renderProjects();
  }
  async function deleteSection(s) {
    if (s.id === 'all') return;
    if (!(await confirmBox(`¿Eliminar la sección "${s.title}"?`, 'Las carpetas no se borran: siguen en "Todas" y en sus otras secciones.'))) return;
    state.sections = state.sections.filter((x) => x !== s);
    if (state.ui.section === s.id) state.ui.section = 'all';
    save();
    renderProjects();
  }
  function sectionMenu(ev, s) {
    const i = state.sections.indexOf(s);
    popMenu(ev, [
      { label: 'Editar sección…', action: () => editSection(s) },
      { label: '◂ Mover a la izquierda', disabled: i <= 1, action: () => moveSection(s, -1) },
      { label: 'Mover a la derecha ▸', disabled: i < 1 || i >= state.sections.length - 1, action: () => moveSection(s, 1) },
      s.id !== 'all' && '-',
      s.id !== 'all' && { label: 'Eliminar sección', danger: true, action: () => deleteSection(s) },
    ]);
  }
  /** Crear (s = null) o editar una sección: ícono, título, descripción, cómo se ve y qué carpetas tiene. */
  function editSection(s) {
    const isNew = !s;
    const isAll = !!s && s.id === 'all';
    const src = s || { icon: '⭐', title: '', desc: '', display: 'both', projects: [] };
    let icon = src.icon || '';
    const iconBtns = h('div.icon-grid', SECTION_ICONS.map((ic) => h('button.icon-pick', {
      class: `icon-pick${ic === icon ? ' sel' : ''}`,
      title: ic,
      onclick: (e) => {
        icon = ic;
        customIcon.value = '';
        $$('.icon-pick', iconBtns).forEach((b) => b.classList.toggle('sel', b === e.currentTarget));
      },
    }, ic)));
    const customIcon = h('input', { placeholder: 'u otro emoji', maxlength: '4', style: 'width:110px', value: SECTION_ICONS.includes(icon) ? '' : icon });
    customIcon.addEventListener('input', () => {
      if (customIcon.value.trim()) { icon = customIcon.value.trim(); $$('.icon-pick', iconBtns).forEach((b) => b.classList.remove('sel')); }
    });
    const title = h('input', { value: src.title || '', placeholder: 'Trabajo', maxlength: '40' });
    const desc = h('textarea', { rows: 2, placeholder: 'Para qué es esta sección (se ve al pasar el mouse)', style: 'width:100%;resize:vertical' });
    desc.value = src.desc || '';
    const display = h('select',
      h('option', { value: 'both' }, 'Ícono y título'),
      h('option', { value: 'icon' }, 'Solo ícono'),
      h('option', { value: 'title' }, 'Solo título'));
    display.value = src.display || 'both';
    const checks = isAll ? [] : state.projects.map((p) => {
      const cb = h('input', { type: 'checkbox', value: p.id });
      cb.checked = (src.projects || []).includes(p.id);
      return h('label.sec-proj', cb, h('span', p.name), h('span.muted', tilde(p.folders[0] || '')));
    });
    const doSave = () => {
      const t = title.value.trim();
      if (!t) { toast('El título es obligatorio', 'err'); return; }
      if (display.value !== 'title' && !icon) { toast('Elige un ícono o usa "Solo título"', 'err'); return; }
      const data = { icon, title: t, desc: desc.value.trim(), display: display.value };
      if (!isAll) data.projects = checks.map((l) => l.querySelector('input')).filter((cb) => cb.checked).map((cb) => cb.value);
      if (isNew) { s = { id: uid(), ...data }; state.sections.push(s); state.ui.section = s.id; } else Object.assign(s, data);
      save();
      modalClose(true);
      renderProjects();
    };
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    openModal({
      title: isNew ? 'Nueva sección' : `Editar sección · ${s.title}`,
      body: [
        h('div.field', h('label', 'Ícono'), iconBtns, customIcon),
        h('div.field', h('label', 'Título'), title),
        h('div.field', h('label', 'Descripción'), desc),
        h('div.field', h('label', 'Cómo se ve en la barra'), display),
        isAll ? h('p.muted', { style: 'margin:0' }, '"Todas" muestra siempre todas las carpetas y no se puede eliminar.')
          : h('div.field', h('label', 'Carpetas de esta sección (también puedes arrastrar una carpeta sobre la sección)'),
            checks.length ? h('div.sec-projs', checks) : h('span.muted', 'Aún no hay carpetas.')),
      ],
      foot: [
        !isNew && !isAll ? h('button.danger', { onclick: () => { modalClose(true); deleteSection(s); } }, 'Eliminar') : null,
        h('span.grow'),
        h('button', { onclick: () => modalClose(true) }, 'Cancelar'),
        h('button.primary', { onclick: doSave }, isNew ? 'Crear' : 'Guardar'),
      ],
    });
    requestAnimationFrame(() => title.focus());
  }
  // reordenar secciones arrastrando el chip ("Todas" queda siempre primera)
  let secDrag = null; // id de la sección que se arrastra
  function clearSecMarks() { for (const el of $$('#sections .drop-before, #sections .drop-after')) el.classList.remove('drop-before', 'drop-after'); }
  /** Dónde caería la sección arrastrada sobre este chip: {after} o null si no se puede. */
  function secDropPos(e, s) {
    if (!secDrag || s.id === secDrag) return null;
    if (s.id === 'all') return { after: true }; // soltar sobre "Todas" = ponerla justo después
    const r = e.currentTarget.getBoundingClientRect();
    return { after: e.clientX > r.left + r.width / 2 };
  }
  function reorderSection(id, targetId, after) {
    const moved = state.sections.find((x) => x.id === id);
    const list = state.sections.filter((x) => x.id !== id);
    const i = list.findIndex((x) => x.id === targetId);
    if (!moved || i < 0) return;
    list.splice(after ? i + 1 : i, 0, moved);
    state.sections = list;
    ensureSections();
    save();
  }
  function renderSections() {
    const bar = $('#sections');
    const cur = activeSection();
    const chips = state.sections.map((s) => {
      // avisos (claude terminó / espera tu respuesta) de las carpetas de la sección, como los "no leídos"
      const notices = sectionProjects(s).map((p) => projectNotice(p.id)).filter(Boolean);
      const waiting = notices.some((n) => n.kind === 'waiting');
      const showIcon = s.display !== 'title' && s.icon;
      const showTitle = s.display !== 'icon' || !s.icon;
      const n = s.id === 'all' ? state.projects.length : s.projects.length;
      return h('button.sec-chip', {
        class: `sec-chip${s === cur ? ' active' : ''}`,
        title: `${s.title}${s.desc ? `\n${s.desc}` : ''}\n${n} carpeta${n === 1 ? '' : 's'} · clic derecho o doble clic: editar${s.id === 'all' ? '' : ' · arrastra para ordenar'}`,
        draggable: s.id === 'all' ? null : 'true',
        dataset: { sec: s.id },
        onclick: () => selectSection(s.id),
        ondragstart: (e) => {
          if (s.id === 'all') { e.preventDefault(); return; }
          secDrag = s.id;
          e.currentTarget.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', s.title);
        },
        ondragend: (e) => {
          e.currentTarget.classList.toggle('dragging', false);
          secDrag = null;
          clearSecMarks();
        },
        ondblclick: () => editSection(s),
        oncontextmenu: (e) => sectionMenu(e, s),
        // soltar una carpeta (arrastrada desde su asa ⠿) sobre la sección la agrega
        ondragover: (e) => {
          const pos = secDropPos(e, s);
          if (pos) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            clearSecMarks();
            e.currentTarget.classList.add(pos.after ? 'drop-after' : 'drop-before');
            return;
          }
          if (!dragging || dragging.type !== 'project' || s.id === 'all') return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          e.currentTarget.classList.add('drop');
        },
        ondragleave: (e) => e.currentTarget.classList.remove('drop', 'drop-before', 'drop-after'),
        ondrop: (e) => {
          e.currentTarget.classList.remove('drop');
          const pos = secDropPos(e, s);
          if (pos) {
            e.preventDefault();
            const id = secDrag;
            secDrag = null;
            clearSecMarks();
            reorderSection(id, s.id, pos.after);
            renderProjects();
            return;
          }
          if (!dragging || dragging.type !== 'project' || s.id === 'all') return;
          e.preventDefault();
          const p = project(dragging.key);
          const added = p && addToSection(s, p.id);
          endDrag();
          if (added) { save(); toast(`"${p.name}" agregada a ${s.title}`, 'ok'); }
          renderProjects();
        },
      },
      showIcon ? h('span.sec-icon', s.icon) : null,
      showTitle ? h('span.sec-title', s.title) : null,
      notices.length ? h(`span.sec-badge.${waiting ? 'waiting' : 'done'}`, String(notices.length)) : null);
    });
    const old = bar.querySelector('.sec-scroll');
    const keepLeft = old ? old.scrollLeft : 0;
    const prevActive = bar.dataset.active || '';
    const scroller = h('div.sec-scroll', ...chips);
    bar.replaceChildren(scroller, sectionAddBtn(true));
    scroller.scrollLeft = keepLeft;
    // si cambió la sección activa, que quede a la vista
    bar.dataset.active = cur.id;
    const act = scroller.querySelector('.sec-chip.active');
    if (act && prevActive !== cur.id) requestAnimationFrame(() => act.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }
  // rueda del ratón sobre las secciones: scroll horizontal
  $('#sections').addEventListener('wheel', (e) => {
    const sc = e.currentTarget.querySelector('.sec-scroll');
    if (!sc || sc.scrollWidth <= sc.clientWidth) return;
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (!d) return;
    e.preventDefault();
    sc.scrollLeft += e.deltaMode === 1 ? d * 30 : d;
  }, { passive: false });
  /** ＋ fijo a la derecha de la barra de secciones: abrir carpeta (nuevo proyecto) o crear sección. */
  function sectionAddBtn(withSections) {
    return h('button.sec-chip.sec-add', {
      title: withSections ? 'Abrir carpeta o crear sección' : 'Abrir carpeta (nuevo proyecto)',
      onclick: (e) => {
        if (!withSections) { newProject(); return; }
        const r = e.currentTarget.getBoundingClientRect();
        popMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, [
          { label: '📂 Abrir carpeta', hint: 'nuevo proyecto', action: newProject },
          { label: '🗂️ Crear sección de carpetas', action: () => editSection(null) },
        ]);
      },
    }, '＋');
  }

  // ---------- reordenar arrastrando (asa ⠿) ----------
  // Proyectos entre sí, y terminales/vistas dentro de su proyecto. Solo se arrastra desde el asa:
  // el mousedown en ella vuelve "draggable" su fila; al soltar se reescribe el orden (state.projects o p.order).
  let dragging = null; // { type: 'project'|'item', key, pid, el, pendingRender }
  function dragHandle() {
    return h('span.drag-handle', {
      title: 'Arrastra para cambiar el orden',
      onmousedown: (e) => { const row = e.currentTarget.closest('[data-drag]'); if (row) row.draggable = true; },
      onmouseup: (e) => { const row = e.currentTarget.closest('[data-drag]'); if (row && !dragging) row.draggable = false; },
      onclick: (e) => e.stopPropagation(),
      ondblclick: (e) => e.stopPropagation(),
    }, '⠿');
  }
  function clearDropMarks() {
    for (const el of $$('#projects .drop-before, #projects .drop-after')) {
      el.classList.toggle('drop-before', false);
      el.classList.toggle('drop-after', false);
    }
  }
  /** ¿Se puede soltar sobre esta fila? Proyecto sobre proyecto; terminal/vista sobre otra del mismo proyecto. */
  function dropTarget(e) {
    if (!dragging) return null;
    const el = e.target.closest(dragging.type === 'project' ? '[data-drag="project"]' : '[data-drag="item"]');
    if (!el || el === dragging.el || (dragging.type === 'item' && el.dataset.pid !== dragging.pid)) return null;
    // en un proyecto la mitad se mide sobre su cabecera (el bloque crece con sus terminales)
    const ref = dragging.type === 'project' ? el.querySelector('.project-head') || el : el;
    const r = ref.getBoundingClientRect();
    return { el, after: e.clientY > r.top + r.height / 2 };
  }
  function dragEvents() {
    return {
      ondragstart: (e) => {
        const el = e.currentTarget;
        if (e.target !== el || !el.draggable) return; // la fila de una terminal ya lo maneja (y corta la propagación)
        e.stopPropagation();
        dragging = { type: el.dataset.drag, key: el.dataset.key, pid: el.dataset.pid, el, pendingRender: false };
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', el.dataset.key);
      },
      ondragover: (e) => {
        const t = dropTarget(e);
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        clearDropMarks();
        t.el.classList.add(t.after ? 'drop-after' : 'drop-before');
      },
      ondrop: (e) => {
        const t = dropTarget(e);
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        applyReorder(dragging, t.el.dataset.key, t.after);
      },
      ondragend: (e) => {
        e.stopPropagation();
        endDrag();
      },
    };
  }
  function endDrag() {
    if (!dragging) return;
    const { el, pendingRender } = dragging;
    el.classList.toggle('dragging', false);
    el.draggable = false;
    dragging = null;
    clearDropMarks();
    if (pendingRender) renderProjects();
  }
  function applyReorder(d, targetKey, after) {
    if (d.type === 'project') {
      const list = state.projects.filter((p) => p.id !== d.key);
      const moved = state.projects.find((p) => p.id === d.key);
      const i = list.findIndex((p) => p.id === targetKey);
      if (!moved || i < 0) return;
      list.splice(after ? i + 1 : i, 0, moved);
      state.projects = list;
    } else {
      const p = project(d.pid);
      if (!p) return;
      const keys = projectItems(p.id).map((it) => it.key).filter((k) => k !== d.key);
      const i = keys.indexOf(targetKey);
      if (i < 0) return;
      keys.splice(after ? i + 1 : i, 0, d.key);
      p.order = keys; // solo lo que existe hoy: lo cerrado se va solo
    }
    endDrag();
    save();
    renderAll();
  }

  /** Resumen de avisos de un proyecto: {kind: 'waiting'|'done', list} (esperar respuesta tiene prioridad). */
  function projectNotice(pid) {
    const list = sessionsOf(pid).filter((t) => t.info.notice);
    if (!list.length) return null;
    const waiting = list.filter((t) => t.info.notice.kind !== 'done');
    return waiting.length ? { kind: 'waiting', list: waiting } : { kind: 'done', list };
  }
  function toggleCollapse(p) {
    p.collapsed = !p.collapsed;
    save();
    renderProjects();
  }
  /** Clic en el nombre: colapsada → se abre (y se selecciona); abierta y actual → se colapsa; otra → solo se selecciona. */
  function clickProjectName(p) {
    const wasActive = p.id === state.activeProject;
    if (p.collapsed) { p.collapsed = false; save(); }
    else if (wasActive) { toggleCollapse(p); return; }
    if (wasActive) renderProjects();
    else selectProject(p.id);
  }

  function renderProjects() {
    if (dragging) { dragging.pendingRender = true; return; } // no romper el arrastre en curso
    hideProjectTip();
    ensureSections();
    const secOn = modOn('left.sections');
    if (secOn) renderSections();
    else $('#sections').replaceChildren(h('span.grow'), sectionAddBtn(false)); // sin secciones: solo el ＋ (abrir carpeta)
    const root = $('#projects');
    root.replaceChildren();
    const sec = secOn ? activeSection() : state.sections[0]; // apagadas: "Todas"
    const shown = sectionProjects(sec);
    if (!state.projects.length) {
      root.append(h('div.empty-list', 'Sin proyectos. Pulsa ＋ para agregar una carpeta.'));
    } else if (!shown.length) {
      root.append(h('div.empty-list', `"${sec.title}" no tiene carpetas. Arrastra una carpeta (asa ⠿) sobre la sección, o edítala con doble clic para elegirlas.`));
    }
    const slots = splitSlots();
    for (const p of shown) {
      const active = p.id === state.activeProject;
      const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
      const collapsed = !!p.collapsed;
      const items = projectItems(p.id);
      // colapsada: los avisos de sus terminales (claude terminó / espera) suben a la carpeta
      const sum = collapsed ? projectNotice(p.id) : null;
      const cls = `project${active ? ' active' : ''}${collapsed ? ' collapsed' : ''}${sum ? ` notice-${sum.kind}` : ''}`;
      root.append(h('div.project', { class: cls, dataset: { drag: 'project', key: p.id }, ...dragEvents() },
        h('div.project-head', {
          onclick: () => selectProject(p.id), ondblclick: () => renameProject(p),
          oncontextmenu: (e) => popMenu(e, [
            { label: '↺ Retomar conversación…', hint: 'claude --resume', action: () => resumeConversationModal(p) },
            '-',
            { label: 'Agregar carpeta…', action: () => addFolder(p) },
            { label: 'Editar (nombre, descripción, URL)…', action: () => renameProject(p) },
            { label: collapsed ? 'Expandir' : 'Colapsar', action: () => toggleCollapse(p) },
            '-',
            { label: 'Eliminar proyecto…', danger: true, action: () => deleteProject(p) },
          ]),
        },
          dragHandle(),
          h('span.pname.grow', {
            title: `${p.folders.join('\n')}\nClic: ${collapsed ? 'abrir' : active ? 'colapsar' : 'seleccionar'} · doble clic: editar`,
            onclick: (e) => { e.stopPropagation(); if (e.detail <= 1) clickProjectName(p); }, // el 2.º clic del doble clic (editar) no cuenta
          }, p.name),
          sum ? h(`span.notice.${sum.kind}`, {
            title: `${sum.list.map((t) => `${termTitle(t)}: ${t.info.notice.kind === 'done' ? 'terminó' : 'espera tu respuesta'}`).join('\n')}\nClic: abrir`,
            onclick: stop(() => activate(sum.list[0].sid)),
          }, sum.kind === 'done' ? `✓ terminó${sum.list.length > 1 ? ` ${sum.list.length}` : ''}` : `● espera${sum.list.length > 1 ? ` ${sum.list.length}` : ''}`) : null,
          collapsed && items.length ? h('span.pcount', { title: `${items.length} abierto${items.length === 1 ? '' : 's'} (colapsada)` }, String(items.length)) : null,
          p.showInfo !== false ? h('button.icon.pinfo', {
            'aria-label': 'Información del proyecto',
            onclick: stop(() => {}),
            onmouseenter: (e) => showProjectTip(p, e.currentTarget),
            onmouseleave: hideProjectTip,
            onfocus: (e) => showProjectTip(p, e.currentTarget),
            onblur: hideProjectTip,
          }, '👁') : null,
          p.url ? h('button.icon.pinfo', { title: `Abrir ${p.url} en otra pestaña`, onclick: stop(() => openProjectUrl(p)) }, '🌐') : null,
          h('span.acts',
            h('button.icon', { title: 'Retomar una conversación de claude de este proyecto', onclick: stop(() => resumeConversationModal(p)) }, '↺'),
            h('button.icon', { title: 'Agregar carpeta', onclick: stop(() => addFolder(p)) }, '⊕'),
            h('button.icon', { title: 'Editar (nombre, descripción, URL)', onclick: stop(() => renameProject(p)) }, '✎'),
            h('button.icon.pcollapse', { title: collapsed ? 'Expandir' : 'Colapsar', onclick: stop(() => toggleCollapse(p)) }, collapsed ? '▸' : '▾'),
            h('button.icon', { title: 'Eliminar proyecto', onclick: stop(() => deleteProject(p)) }, '✕'))),
        active && !collapsed && h('div.folders', p.folders.map((f, i) =>
          h('div.folder', { title: f },
            h('span', (i === 0 ? '▸ ' : '+ ') + tilde(f)),
            h('button.icon.mini', { title: 'Quitar carpeta', onclick: () => removeFolder(p, f) }, '✕')))),
        collapsed ? null : h('div.terms', items.map((it) => (it.t ? termItem(it.t, slots.get(it.t.sid), p.id) : viewItem(it.v))))));
    }
    const orphans = sec.id === 'all' ? orphanSessions() : [];
    if (orphans.length) {
      root.append(h('div.project',
        h('div.project-head', h('span.pname.muted', 'Sin proyecto')),
        h('div.terms', orphans.map((t) => termItem(t)))));
    }
  }

  /** Arriba a la izquierda de cada terminal: su ícono y su nombre (clic: renombrar), como la persona a la derecha. */
  function renderTermName(t) {
    let chip = t.pane.querySelector('.term-name');
    if (!chip) { chip = h('div.term-name'); t.pane.append(chip); }
    const name = termTitle(t);
    const ic = termIcon(t);
    if (chip.dataset.key === `${ic}|${name}`) return;
    chip.dataset.key = `${ic}|${name}`;
    chip.replaceChildren(h('button.term-name-btn', { title: `${termLiveHint(t)}${name}\nClic: renombrar o cambiar el ícono`, onmousedown: (e) => e.preventDefault(), onclick: () => renameTerm(t.sid) },
      ic ? iconNode(ic, 'span.term-name-ico') : null, h('span.term-name-txt', name)));
  }
  function renderTabs() {
    for (const t of terms.values()) renderTermName(t);
    const tabs = $('#tabs');
    const keepLeft = tabs.scrollLeft; // al vaciar, el scroll vuelve a 0: se restaura al final
    const prevActive = tabs.dataset.active || '';
    tabs.replaceChildren();
    const at = activeTerm();
    if (at && termKind(at) === 'action') {
      // log de una acción: pestaña temporal, cerrarla no detiene la acción
      tabs.append(h('div.tab.active', { dataset: { sid: at.sid }, title: 'Log de la acción' },
        h('span', { class: dotClass(at) }),
        h('span.tname', `⚡ ${termTitle(at)}`),
        h('span.x', { title: 'Cerrar log (la acción sigue)', onclick: (e) => { e.stopPropagation(); leaveActionLog(); } }, '✕')));
    }
    const slots = splitSlots();
    const tabTerms = tabSessions();
    const orphanTabs = !!project() && tabTerms.some((t) => !project((t.info.meta || {}).projectId));
    for (const t of tabTerms) {
      const slot = slots.get(t.sid);
      tabs.append(h(`div.tab${t.sid === state.activeSid ? '.active' : ''}${slot != null ? '.grouped' : ''}`, {
        dataset: { sid: t.sid },
        title: `${termLiveHint(t)}${(t.info.meta || {}).cwd || ''}\nDoble clic: renombrar`,
        onclick: () => activate(t.sid),
        ondblclick: () => renameTerm(t.sid),
        onauxclick: (e) => { if (e.button === 1) closeTerm(t.sid); },
      },
      h('span', { class: dotClass(t) }),
      slot != null ? h('span.slot', String(slot + 1)) : null,
      kindIcon(termKind(t)),
      termIcon(t) ? iconNode(termIcon(t)) : null,
      h('span.tname', termTitle(t)),
      t.info.notice ? h(`span.notice-dot.${t.info.notice.kind}`, { title: t.info.notice.kind === 'done' ? 'Terminó' : 'Espera tu respuesta' }) : null,
      h('span.x', { title: 'Cerrar', onclick: (e) => { e.stopPropagation(); closeTerm(t.sid); } }, '✕')));
    }
    for (const id of state.openPages) {
      const pg = pageById(id);
      if (!pg) continue;
      const vid = PAGE_PREFIX + id;
      tabs.append(h(`div.tab.page-tab${vid === state.activeSid ? '.active' : ''}`, {
        dataset: { sid: vid },
        title: pg.url,
        onclick: () => openPageIframe(pg),
        onauxclick: (e) => { if (e.button === 1) closePageView(id); },
      },
      h('span.tname', `🌐 ${pg.name}`),
      h('span.x', { title: 'Cerrar', onclick: (e) => { e.stopPropagation(); closePageView(id); } }, '✕')));
    }
    // git, DB y Archivos del proyecto (o de "Sin proyecto" no hay: necesitan una carpeta)
    for (const v of project() && !orphanTabs ? openViewsOf(state.activeProject) : []) {
      const sid = vSid(v);
      tabs.append(h(`div.tab.${v.kind}-tab${state.activeSid === sid ? '.active' : ''}`, {
        dataset: { sid }, title: VIEW_TITLE[v.kind],
        onclick: () => openViewSid(sid),
        onauxclick: (e) => { if (e.button === 1) closeView(v); },
      },
      v.kind === 'sftp' ? null : kindIcon(v.kind),
      h('span.tname', { git: 'Git', db: 'DB', sftp: '⇅ Archivos', notes: 'Notas', code: 'Código', api: 'API' }[v.kind]),
      h('span.x', { title: 'Cerrar', onclick: (e) => { e.stopPropagation(); closeView(v); } }, '✕')));
    }
    tabs.scrollLeft = keepLeft;
    // si cambió la pestaña activa, que quede a la vista
    const active = tabs.querySelector('.tab.active');
    tabs.dataset.active = state.activeSid || '';
    if (active && prevActive !== tabs.dataset.active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  // rueda del ratón sobre la barra de pestañas: desplaza en horizontal (antes solo se podía con Shift o el touchpad)
  $('#tabs').addEventListener('wheel', (e) => {
    const tabs = e.currentTarget;
    if (tabs.scrollWidth <= tabs.clientWidth) return;
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (!d) return;
    e.preventDefault();
    tabs.scrollLeft += e.deltaMode === 1 ? d * 30 : d; // deltaMode 1 = líneas
  }, { passive: false });

  // ---------- pantalla dividida ----------
  // Muestra a la vez las primeras N terminales (shell/agentes/ssh) del proyecto activo.
  // Ciclo del botón: 1 → 2 (1 arriba, 1 abajo) → 3 (2 arriba, 1 abajo) → 4 (2×2) → 1.
  const SPLIT_KINDS = ['shell', 'claude', 'codex', 'opencode', 'ssh'];
  const SPLIT_MAX = 4;
  const SPLIT_MIN = 12; // % mínimo de alto/ancho de un panel al arrastrar un divisor
  /** Tamaños ajustables (divisores arrastrables): y = alto de la fila de arriba, xTop/xBot = ancho de la columna izquierda. */
  const splitSizes = () => {
    const z = state.ui.splitSizes || {};
    const ok = (v) => (Number.isFinite(v) ? Math.min(100 - SPLIT_MIN, Math.max(SPLIT_MIN, v)) : 50);
    return { y: ok(z.y), xTop: ok(z.xTop), xBot: ok(z.xBot) };
  };
  /** [left, top, width, height] en % de cada panel. */
  function splitRects(n) {
    const { y, xTop: a, xBot: b } = splitSizes();
    if (n === 2) return [[0, 0, 100, y], [0, y, 100, 100 - y]];
    if (n === 3) return [[0, 0, a, y], [a, 0, 100 - a, y], [0, y, 100, 100 - y]];
    if (n === 4) return [[0, 0, a, y], [a, 0, 100 - a, y], [0, y, b, 100 - y], [b, y, 100 - b, 100 - y]];
    return null;
  }

  // Divisores entre paneles: aparecen al pasar el mouse (cursor e ícono de 2 flechas). Doble clic: 50/50.
  let splitHandles = null;
  let splitDragging = false;
  function ensureSplitHandles() {
    if (splitHandles) return splitHandles;
    const mk = (key, dir) => {
      const el = h(`div.split-handle.${dir}`, {
        title: `Arrastra para ajustar ${dir === 'row' ? 'el alto' : 'el ancho'} · doble clic: mitad y mitad`,
        onmousedown: (e) => startSplitDrag(e, key),
        // el ícono de flechas sigue al mouse a lo largo del divisor
        onmousemove: (e) => {
          if (splitDragging) return;
          const r = el.getBoundingClientRect();
          el.style.setProperty('--grip', `${dir === 'row' ? e.clientX - r.left : e.clientY - r.top}px`);
        },
        ondblclick: () => { state.ui.splitSizes = { ...splitSizes(), [key]: 50 }; save(); renderPanes(); },
      }, h('span.split-grip', dir === 'row' ? '⇕' : '⇔'));
      $('#term-host').append(el);
      return el;
    };
    splitHandles = { y: mk('y', 'row'), xTop: mk('xTop', 'col'), xBot: mk('xBot', 'col') };
    return splitHandles;
  }
  function renderSplitHandles(n) {
    if (!n && !splitHandles) return;
    const hs = ensureSplitHandles();
    const { y, xTop, xBot } = splitSizes();
    const show = (el, on, style) => { el.classList.toggle('hidden', !on); if (on) Object.assign(el.style, style); };
    show(hs.y, n >= 2, { top: `${y}%`, left: '0', width: '100%', height: '' });
    show(hs.xTop, n >= 3, { left: `${xTop}%`, top: '0', height: `${y}%`, width: '' });
    show(hs.xBot, n === 4, { left: `${xBot}%`, top: `${y}%`, height: `${100 - y}%`, width: '' });
  }
  function startSplitDrag(e, key) {
    if (e.button !== 0) return;
    e.preventDefault();
    const host = $('#term-host').getBoundingClientRect();
    splitDragging = true;
    document.body.classList.add(key === 'y' ? 'split-dragging-row' : 'split-dragging-col');
    splitHandles[key].classList.add('dragging');
    const move = (ev) => {
      const v = key === 'y' ? ((ev.clientY - host.top) / host.height) * 100 : ((ev.clientX - host.left) / host.width) * 100;
      state.ui.splitSizes = { ...splitSizes(), [key]: Math.round(Math.min(100 - SPLIT_MIN, Math.max(SPLIT_MIN, v)) * 10) / 10 };
      renderPanes(); // mueve paneles y divisor; las terminales se reajustan al soltar
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      splitDragging = false;
      document.body.classList.remove('split-dragging-row', 'split-dragging-col');
      splitHandles[key].classList.remove('dragging');
      save();
      for (const t of splitGroup()) fitTerm(t);
      const t = activeTerm();
      if (t) t.term.focus();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }
  const splitN = () => (modOn('center.split') ? Math.min(SPLIT_MAX, Math.max(1, Number(state.ui.split) || 1)) : 1);
  /** Terminales agrupadas (vacío si no hay división o hay menos de 2). */
  function splitGroup() {
    const n = splitN();
    if (n < 2 || !project()) return [];
    const list = sessionsOf(state.activeProject).filter((t) => SPLIT_KINDS.includes(termKind(t))).slice(0, n);
    return list.length > 1 ? list : [];
  }
  const splitSlots = () => new Map(splitGroup().map((t, i) => [t.sid, i]));
  function cycleSplit() {
    state.ui.split = (splitN() % SPLIT_MAX) + 1;
    save();
    const group = splitGroup();
    if (group.length && !group.some((t) => t.sid === state.activeSid)) { activate(group[0].sid); return; }
    renderAll();
    const t = activeTerm();
    if (t) requestAnimationFrame(() => t.term.focus());
  }
  function renderSplitBtn() {
    const n = splitN();
    const b = $('#btn-split');
    b.replaceChildren(h('span.split-ico', '⊞'), h('span.split-n', String(n)));
    b.classList.toggle('on', n > 1);
    b.title = `Pantalla dividida: ${n} ${n === 1 ? 'panel' : 'paneles'} (clic para cambiar)\nToma las primeras ${SPLIT_MAX} terminales del proyecto (shell, agentes, ssh)`;
  }

  function renderPanes() {
    // el grupo solo se muestra si la terminal activa es parte de él (git, DB, páginas o una 5.ª terminal van solas)
    let group = splitGroup();
    if (!group.some((t) => t.sid === state.activeSid)) group = [];
    const rects = splitRects(group.length);
    const refit = [];
    const shown = [];
    for (const t of terms.values()) {
      const slot = group.indexOf(t);
      const r = slot >= 0 ? rects[slot] : null;
      const key = r ? r.join(',') : '';
      if (t.rect !== key) {
        t.rect = key;
        Object.assign(t.pane.style, r
          ? { left: `${r[0]}%`, top: `${r[1]}%`, width: `${r[2]}%`, height: `${r[3]}%`, right: 'auto', bottom: 'auto' }
          : { left: '', top: '', width: '', height: '', right: '', bottom: '' });
        refit.push(t);
      }
      t.pane.classList.toggle('split', !!r);
      t.pane.classList.toggle('focused', !!r && t.sid === state.activeSid);
      const vis = r || t.sid === state.activeSid ? 'visible' : 'hidden';
      if (vis === 'visible' && t.pane.style.visibility !== 'visible') shown.push(t); // vuelve a verse: repintar
      t.pane.style.visibility = vis;
    }
    if (refit.length && !splitDragging) requestAnimationFrame(() => refit.forEach(fitTerm));
    if (shown.length) requestAnimationFrame(() => shown.forEach((t) => { fitTerm(t); termRepaint(t); }));
    renderSplitHandles(group.length);
    renderSplitBtn();
    const pg = isPageView(state.activeSid) ? pageById(state.activeSid.slice(PAGE_PREFIX.length)) : null;
    if (pg) ensurePagePane(pg);
    for (const [id, pane] of pagePanes) pane.classList.toggle('hidden', !pg || pg.id !== id);
    const av = activeView();
    if (av) bindView(av);
    const dbActive = !!av && av.kind === 'db';
    if (dbActive) ensureDbPane();
    const gitActive = !!av && av.kind === 'git';
    if (gitActive) { ensureGitPane(); gitSyncProject(); }
    const sftpActive = !!av && av.kind === 'sftp';
    if (sftpActive) ensureSftpPane();
    const notesActive = !!av && av.kind === 'notes';
    if (notesActive) ensureNotesPane();
    const codeActive = !!av && av.kind === 'code';
    if (codeActive) ensureCodePane();
    const apiActive = !!av && av.kind === 'api';
    if (apiActive) ensureApiPane();
    for (const [sid, pane] of viewPanes) {
      const was = pane.root.classList.contains('hidden');
      pane.root.classList.toggle('hidden', sid !== state.activeSid);
      if (was && sid === state.activeSid && pane.kind === 'code') requestAnimationFrame(() => { codeRefreshEditors(); codeRenderStatus(); });
    }
    const p = project();
    $('#empty').classList.toggle('hidden', !!activeTerm() || !!pg || !!av);
    $('#st-project').textContent = p ? p.name : '—';
    const t = activeTerm();
    $('#st-cwd').textContent = apiActive ? `local/api${state.api.active ? `/${state.api.active}` : ''}` : codeActive ? tilde(codeActiveFile() || codeRoots()[0] || '') : notesActive ? tilde(notesFile() || '') : sftpActive ? sftpStatusLine() : gitActive ? (state.git.repo ? tilde(state.git.repo) : 'Git') : dbActive ? dbStatusLine() : pg ? pg.url : t ? tilde((t.info.meta || {}).cwd || '') : p ? p.folders.map(tilde).join('  +  ') : '';
    renderStatusActions();
  }

  function renderAll() {
    renderProjects();
    renderTodos();
    renderIntegrations();
    renderTabs();
    renderPanes();
    updateTitle();
    snapshotTerms();
    renderVoice();
  }

  // ---------- terminales tras apagar o reiniciar el equipo ----------
  // Las sesiones sobreviven al bridge, pero no a un apagado: son procesos. Se guarda una foto de las
  // terminales abiertas (state.lastTerms, persiste en localStorage y state.json). Al conectar, si faltan
  // terminales de la foto, se ofrece reabrirlas en su carpeta (las IA retoman su última conversación).
  let restoreChecked = false; // hasta decidir, la foto no se pisa (si no, al arrancar vacío se perdería)
  let restoreLater = []; // "Ahora no": se siguen ofreciendo la próxima vez
  function termSnapshot() {
    // en el orden del panel izquierdo: al reabrirlas quedan igual
    return state.projects.flatMap((p) => sessionsOf(p.id))
      .filter((t) => termKind(t) !== 'action' && t.info.alive !== false)
      .map((t) => {
        const m = t.info.meta || {};
        return { sid: t.sid, projectId: m.projectId, kind: termKind(t), title: m.title || termKind(t), cwd: m.cwd || '', ...(m.named ? { named: true } : {}), ...(m.sshId ? { sshId: m.sshId } : {}), ...(m.agent && m.agent.session ? { agent: m.agent } : {}), ...(m.person ? { person: m.person } : {}), ...(m.icon ? { icon: m.icon } : {}) };
      });
  }
  function snapshotTerms() {
    if (!restoreChecked || !Bridge.ready) return;
    const snap = [...termSnapshot(), ...restoreLater.filter((t) => project(t.projectId))];
    if (JSON.stringify(snap) === JSON.stringify(state.lastTerms || [])) return;
    state.lastTerms = snap;
    save();
  }
  async function checkRestore() {
    if (restoreChecked) return;
    const lost = (state.lastTerms || []).filter((t) => t && !terms.has(t.sid) && project(t.projectId));
    if (lost.length) {
      const r = await askRestore(lost);
      restoreLater = r === undefined ? lost : [];
      restoreChecked = true;
      if (r && r.chosen.length) {
        if (!sshInfo) await loadSsh();
        await reopenTerminals(r.chosen, r.resume);
      }
    }
    restoreChecked = true;
    snapshotTerms();
  }
  /** null = descartar, undefined = ahora no (se cierra el modal), {chosen, resume} = reabrir. */
  function askRestore(lost) {
    return new Promise((resolve) => {
      const groups = state.projects.map((p) => ({ p, list: lost.filter((t) => t.projectId === p.id) })).filter((g) => g.list.length);
      const cg = checkGroup('Terminales', groups.map((g) => ({
        value: g.p.id, label: g.p.name, sub: g.p.folders.map(tilde).join(', '),
        children: g.list.map((t, i) => ({ value: i, label: t.title, sub: t.kind })),
      })));
      const resume = h('input', { type: 'checkbox' });
      resume.checked = true;
      let done = false;
      const finish = (v) => { if (done) return; done = true; close(true); resolve(v); };
      const close = openModal({
        title: `Se cerraron ${lost.length} terminal${lost.length === 1 ? '' : 'es'}`,
        body: [
          h('p.muted', { style: 'margin:0' }, 'Las terminales viven mientras el equipo está encendido: al apagarlo o reiniciarlo se cierran. ¿Reabrirlas en sus carpetas?'),
          cg.el,
          h('label.xp-item', resume, h('span', 'Retomar la conversación de cada terminal'), h('span.muted', 'claude --resume <la de esa terminal> · codex resume --last · opencode --continue')),
        ],
        foot: [
          h('button', { title: 'No volver a ofrecerlas', onclick: () => finish(null) }, 'Descartar'),
          h('button', { title: 'Seguir ofreciéndolas la próxima vez', onclick: () => finish(undefined) }, 'Ahora no'),
          h('span.grow'),
          h('button.primary', {
            onclick: () => finish({
              resume: resume.checked,
              chosen: cg.selected().map(({ value, children }) => {
                const g = groups.find((x) => x.p.id === value);
                return { p: g.p, terminals: children.map((i) => g.list[i]).filter(Boolean) };
              }).filter((c) => c.terminals.length),
            }),
          }, 'Reabrir'),
        ],
        onClose: () => { if (!done) { done = true; resolve(undefined); } },
      });
    });
  }

  // indicadores de actividad sin re-render completo
  setInterval(() => {
    for (const t of terms.values()) {
      const cls = dotClass(t);
      for (const el of $$(`[data-sid="${t.sid}"] .dot`)) if (el.className !== cls) el.className = cls;
    }
  }, 700);

  // ======================================================================
  // Modales
  // ======================================================================
  let modalClose = null;
  function openModal({ title, body, foot = [], wide = false, onClose }) {
    if (modalClose) modalClose(true);
    $('#modal-title').textContent = title;
    $('#modal-body').replaceChildren(...[].concat(body).flat().filter(Boolean)); // como h(): sin null/false
    $('#modal-foot').replaceChildren(...foot.filter(Boolean));
    $('.modal-card').classList.toggle('wide', wide);
    $('#modal').classList.remove('hidden');
    let closed = false;
    const close = (force) => {
      if (closed) return true;
      if (!force && onClose && onClose() === false) return false;
      closed = true;
      $('#modal').classList.add('hidden');
      modalClose = null;
      const t = activeTerm();
      if (t) t.term.focus();
      return true;
    };
    modalClose = close;
    const first = $('#modal-body input, #modal-body textarea');
    if (first) setTimeout(() => first.focus(), 20);
    return close;
  }
  $('#modal-close').onclick = () => modalClose && modalClose();
  $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal' && modalClose) modalClose(); });

  function askText(title, label, value = '') {
    return new Promise((resolve) => {
      const input = h('input', { value });
      const done = (v) => { close(true); resolve(v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim()); });
      const close = openModal({
        title,
        body: h('div.field', h('label', label), input),
        foot: [h('button', { onclick: () => done(null) }, 'Cancelar'), h('button.primary', { onclick: () => done(input.value.trim()) }, 'Aceptar')],
        onClose: () => { resolve(null); },
      });
      setTimeout(() => input.select(), 30);
    });
  }

  function confirmBox(title, text) {
    return new Promise((resolve) => {
      const done = (v) => { close(true); resolve(v); };
      const close = openModal({
        title,
        body: h('p', text || ''),
        foot: [h('button', { onclick: () => done(false) }, 'Cancelar'), h('button.primary.danger', { onclick: () => done(true) }, 'Confirmar')],
        onClose: () => { resolve(false); },
      });
    });
  }

  /** Selector de carpetas navegando el sistema de archivos vía bridge. */
  function pickFolder(start) {
    if (!Bridge.ready) { toast('Conecta el bridge para elegir carpetas', 'err'); return Promise.resolve(null); }
    return new Promise((resolve) => {
      let current = start || Bridge.info.home;
      const input = h('input', { value: current, spellcheck: 'false' });
      const list = h('div.picker-list');
      const hidden = h('input', { type: 'checkbox' });
      const roots = h('div.picker-roots');
      const ask = h('div.picker-ask.hidden');
      // confirmación dentro del selector (otro modal lo cerraría)
      const confirmHere = (title, text, okLabel) => new Promise((res) => {
        const end = (v) => { ask.classList.add('hidden'); ask.replaceChildren(); res(v); };
        ask.replaceChildren(h('div', h('b', title)), h('div.muted', text),
          h('div.picker-ask-btns', h('button.mini', { onclick: () => end(false) }, 'Cancelar'), h('button.mini.primary', { onclick: () => end(true) }, okLabel)));
        ask.classList.remove('hidden');
      });
      // accesos a las carpetas que FRAP puede abrir: la personal y las extra (p. ej. /var/www)
      async function renderRoots() {
        let r;
        try { r = await Bridge.call('fs.roots'); } catch (_) { roots.replaceChildren(); return; }
        roots.replaceChildren(
          h('button.mini', { title: tilde(r.main), onclick: () => go(r.main) }, `🏠 ${tilde(r.main)}`),
          ...r.extra.map((x) => h('span.picker-root',
            h('button.mini', { title: x.exists ? x.path : `${x.path} (no existe)`, onclick: () => go(x.path) }, `📁 ${x.path}`),
            x.source === 'file' ? h('button.icon.mini', { title: `Dejar de permitir ${x.path}`, onclick: async () => {
              if (!(await confirmHere(`¿Dejar de permitir ${x.path}?`, 'FRAP ya no podrá abrir archivos ni carpetas de ahí (los proyectos que la usen dejarán de poder leerla).', 'Dejar de permitir'))) return;
              try { await Bridge.call('fs.removeRoot', { path: x.path }); renderRoots(); if (current === x.path || current.startsWith(`${x.path}/`)) go(r.main); } catch (e) { toast(e.message, 'err'); }
            } }, '✕') : null)),
          h('button.mini', { title: 'Permitir una carpeta fuera de tu carpeta personal: escribe su ruta arriba (p. ej. /var/www)', onclick: () => {
            const v = input.value.trim();
            if (!v.startsWith('/') || v === r.main || v.startsWith(`${r.main}/`)) { input.value = '/var/www'; input.focus(); input.select(); toast('Escribe arriba la ruta de la carpeta (p. ej. /var/www) y pulsa Ir'); return; }
            go(v);
          } }, '＋ Permitir carpeta…'));
      }
      async function allowRoot(p) {
        try {
          const r = await Bridge.call('fs.addRoot', { path: p });
          toast(r.already ? `${r.path} ya estaba permitida` : `FRAP ya puede abrir ${r.path}`, 'ok');
          await renderRoots();
          await go(r.path);
          return true;
        } catch (e) { toast(e.message, 'err'); return false; }
      }
      async function go(p) {
        try {
          const res = await Bridge.call('fs.list', { path: p, hidden: hidden.checked });
          current = res.path;
          input.value = current;
          list.replaceChildren(...[
            res.parent ? h('div.picker-item.up', { onclick: () => go(res.parent) }, '↑ ..') : null,
            ...res.entries.map((e) => h('div.picker-item', {
              onclick: () => go(`${current}/${e.name}`.replace(/\/\//g, '/')),
            }, `📁 ${e.name}`)),
          ].filter(Boolean));
          list.scrollTop = 0;
        } catch (e) {
          // fuera de las carpetas permitidas: ofrece permitirla (p. ej. /var/www)
          if (/^Ruta fuera de/.test(e.message) && String(p).startsWith('/')) {
            if (await confirmHere(`¿Permitir que FRAP abra ${p}?`, 'Está fuera de tu carpeta personal. Se agrega a las carpetas permitidas (se puede quitar con ✕ en los accesos de arriba). No se permiten carpetas del sistema.', 'Permitir')) await allowRoot(p);
            return;
          }
          toast(e.message, 'err');
        }
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(input.value.trim()); });
      hidden.addEventListener('change', () => go(current));
      const done = (v) => { close(true); resolve(v); };
      const close = openModal({
        title: 'Elegir carpeta',
        body: [
          h('div.picker-path', input, h('button', { onclick: () => go(input.value.trim()) }, 'Ir')),
          roots,
          ask,
          h('label.muted', hidden, ' mostrar ocultas'),
          list,
        ],
        foot: [
          h('button', { onclick: () => done(null) }, 'Cancelar'),
          h('button.primary', { onclick: () => done(current) }, 'Usar esta carpeta'),
        ],
        onClose: () => { resolve(null); },
      });
      renderRoots();
      go(current);
    });
  }

  /** Archivos de configuración abiertos en el editor de código: al guardarlos se valida el JSON y se refresca el panel. */
  const cfgFiles = new Set();
  /** Editor de archivos (agentes, skills, hooks, memoria…). */
  async function openEditor(path, { create = false, template = '', title } = {}) {
    if (launchOn('code') && project()) { // con el editor de código activo (Módulos) se abre en él; si no, en esta modal
      cfgFiles.add(path);
      await openInFrap(path, undefined, undefined, false, undefined, { template: create ? template : '' });
      return;
    }
    let content = template;
    if (!create) {
      try { content = (await Bridge.call('fs.read', { path })).content; } catch (e) {
        if (!/ENOENT/.test(e.message)) { toast(e.message, 'err'); return; }
      }
    }
    const ta = h('textarea.editor', { spellcheck: 'false' });
    ta.value = content;
    const status = h('span.muted.mono', path);
    let dirty = false;
    const isJson = path.endsWith('.json');
    ta.addEventListener('input', () => { dirty = ta.value !== content; status.textContent = (dirty ? '● ' : '') + path; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en } = ta;
        ta.setRangeText('  ', s, en, 'end');
        ta.dispatchEvent(new Event('input'));
      } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        doSave();
      }
    });
    async function doSave() {
      if (isJson) {
        try { JSON.parse(ta.value); } catch (e) { toast(`JSON inválido: ${e.message}`, 'err'); return; }
      }
      try {
        await Bridge.call('fs.write', { path, content: ta.value });
        content = ta.value;
        dirty = false;
        status.textContent = path;
        toast('Guardado', 'ok');
        loadConfig(true);
      } catch (e) { toast(e.message, 'err'); }
    }
    openModal({
      title: title || basename(path),
      wide: true,
      body: ta,
      foot: [status, h('span.grow'), h('button', { onclick: () => modalClose() }, 'Cerrar'), h('button.primary', { onclick: doSave }, 'Guardar (Ctrl+S)')],
      onClose: () => !dirty || window.confirm('Hay cambios sin guardar. ¿Descartarlos?'),
    });
  }

  // ======================================================================
  // Panel derecho
  // ======================================================================
  const RTABS = {
    procs: renderProcs,
    todos: () => renderTodosTab(),
    msgs: () => renderMsgsTab(),
    prompts: renderPrompts,
    actions: renderActions,
    pages: renderPages,
    dbs: renderDbs,
    ssh: renderSsh,
    music: renderMusic,
    timers: renderTimers,
    agents: () => renderConfigList('agents'),
    skills: () => renderConfigList('skills'),
    commands: () => renderConfigList('commands'),
    hooks: renderHooks,
    memory: renderMemory,
    issues: renderIssues,
    scripts: renderScripts,
    tunnels: renderTunnels,
  };
  function setRtab(name) {
    state.ui.rtab = name;
    save();
    for (const b of $$('#rtabs button')) b.classList.toggle('active', b.dataset.rtab === name);
    renderRight();
    if (name === 'procs') pollProcs();
    else if (name === 'issues') loadIssues();
    else if (name === 'tunnels') loadTunnels(true);
    else if (name === 'scripts') { loadScripts(); if (!issuesInfo) loadIssues(); }
    else if (name !== 'prompts' && name !== 'actions' && name !== 'pages' && name !== 'dbs' && name !== 'ssh' && name !== 'music' && name !== 'timers') loadConfig();
    if (name === 'dbs') loadDbs();
    if (name === 'ssh') loadSsh();
    updateDock();
  }
  function renderRight() {
    const body = $('#rbody');
    if (!visibleRtabs().length) {
      body.replaceChildren(h('div.empty-list', 'Todas las pestañas del panel derecho están apagadas. Actívalas en ⚙ Ajustes → Módulos.'));
      return;
    }
    const fn = RTABS[state.ui.rtab] || renderProcs;
    const scroll = body.scrollTop;
    body.replaceChildren(...[].concat(fn()).filter(Boolean));
    body.scrollTop = scroll;
  }
  const section = (title, ...actions) => h('div.section-head', h('h4.grow', title), ...actions);

  // ---------- procesos ----------
  let procs = {};
  let procTimer = null;
  async function pollProcs() {
    clearTimeout(procTimer);
    if (state.ui.rtab !== 'procs' || state.ui.hideRight) return;
    if (Bridge.ready) {
      try { procs = await Bridge.call('ps'); } catch (_) { procs = {}; }
      if (state.ui.rtab === 'procs' && !document.querySelector('.proc-row:hover')) renderRight();
    }
    procTimer = setTimeout(pollProcs, document.hidden ? 8000 : 2500);
  }
  const AGENT_RE = /\b(claude|codex|opencode)\b/;
  function renderProcs() {
    const all = state.ui.procsAll;
    const list = all ? [...terms.values()] : sessionsOf(state.activeProject);
    const out = [section(all ? 'Todas las sesiones' : 'Procesos del proyecto',
      h('button.mini', { onclick: () => { state.ui.procsAll = !all; save(); renderRight(); } }, all ? 'Solo proyecto' : 'Ver todas'))];
    if (!Bridge.ready) return out.concat(h('p.muted', 'Bridge desconectado.'));
    if (!list.length) return out.concat(h('p.muted', 'No hay terminales abiertas en este proyecto.'));
    for (const t of list) {
      const rows = procs[t.sid] || [];
      const agents = rows.filter((r) => AGENT_RE.test(r.args.split(' ')[0]) || AGENT_RE.test(r.args.split(' ').slice(0, 2).join(' ')));
      out.push(h('div.card.proc-sess',
        h('div.title', { style: 'cursor:pointer', onclick: () => activate(t.sid) },
          h('span', { class: dotClass(t) }),
          h('span.name', termTitle(t)),
          agents.length ? h('span.badge.claude', `${agents.length} agente${agents.length > 1 ? 's' : ''}`) : null,
          h(`span.badge.${termKind(t)}`, termKind(t))),
        h('div', { style: 'margin-top:6px' },
          rows.length ? rows.map((r) => h(`div.proc-row${AGENT_RE.test(r.args) ? '.agent' : ''}`, { title: r.args },
            h('span.cmd', { style: `padding-left:${r.depth * 12}px` }, `${r.depth ? '└ ' : ''}${r.args}`),
            h('span.num', `${r.cpu.toFixed(0)}%`),
            h('span.num', fmtMem(r.rss)),
            h('span.num', fmtTime(r.etime)),
            h('button.icon.mini.danger', { title: `Terminar PID ${r.pid}`, onclick: () => killProc(r) }, '✕')))
            : h('p.muted', t.info.alive === false ? 'Terminada.' : 'Sin procesos.'))));
    }
    return out;
  }
  async function killProc(r) {
    if (!(await confirmBox(`¿Terminar PID ${r.pid}?`, r.args))) return;
    try {
      await Bridge.call('proc.kill', { pid: r.pid });
      toast(`SIGTERM enviado a ${r.pid}`, 'ok');
      pollProcs();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- prompts estándar ----------
  let promptFilter = '';
  function expandPrompt(body) {
    const p = project();
    return body
      .replace(/\{\{project\}\}/g, p ? p.name : '')
      .replace(/\{\{folder\}\}/g, p ? p.folders[0] : '')
      .replace(/\{\{folders\}\}/g, p ? p.folders.join(' ') : '');
  }
  function runPrompt(pr, enter = true) {
    if (sendToTerminal(expandPrompt(pr.body), enter)) toast(`${enter ? 'Ejecutado' : 'Insertado'}: ${pr.title}`, 'ok');
  }
  const PROMPT_ICONS = ['', '💬', '📌', '🚀', '🐞', '🔍', '🧪', '📝', '📣', '🤝', '✅', '⚠️', '📊', '🛠️', '🔒', '💡', '🎯', '📦', '🛒', '🚚', '💰', '🗄️', '🌐', '⭐'];
  const promptCat = (id) => state.promptCats.find((c) => c.id === id) || null;
  /** Persona del Equipo de un prompt (solo para distinguirlo; el texto no cambia). */
  const promptPerson = (pr) => (pr.person ? teamPerson(pr.person) : null);
  function promptCard(pr, q) {
    const per = promptPerson(pr);
    const key = `${pr.title}\n${pr.body}\n${per ? per.name : ''}`.toLowerCase();
    return h(`div.card.clickable.prompt-card${key.includes(q) ? '' : '.hidden'}`, {
      dataset: { q: key },
      title: 'Ejecutar en la terminal activa',
      onclick: () => runPrompt(pr, true),
    },
    h('div.title',
      h('span.name', pr.icon ? h('span.prompt-ico', pr.icon) : '▶ ', pr.title),
      per ? h('span.prompt-person', { title: `Para ${per.name} (${per.role})` }, teamAvatar(per, '.sm'), h('span', { style: `color:${teamColor(per)}` }, per.name.split(' ')[0])) : null,
      h('button.icon.mini', { title: 'Insertar sin Enter', onclick: (e) => { e.stopPropagation(); runPrompt(pr, false); } }, '⇥'),
      h('button.icon.mini', { title: 'Editar', onclick: (e) => { e.stopPropagation(); editPrompt(pr); } }, '✎'),
      h('button.icon.mini', { title: 'Eliminar', onclick: (e) => { e.stopPropagation(); deletePrompt(pr); } }, '✕')),
    h('div.body', pr.body));
  }
  function renderPrompts() {
    const filter = h('input.filter', { placeholder: 'Filtrar prompts…', value: promptFilter });
    filter.addEventListener('input', () => {
      promptFilter = filter.value;
      const qq = promptFilter.toLowerCase();
      for (const el of $$('.prompt-card')) el.classList.toggle('hidden', !el.dataset.q.includes(qq));
      for (const g of $$('.prompt-group')) g.classList.toggle('hidden', !!qq && !g.querySelector('.prompt-card:not(.hidden)'));
    });
    const q = promptFilter.toLowerCase();
    const cats = state.promptCats;
    const collapsed = new Set(state.ui.promptCatsCollapsed || []);
    const flip = (id) => { const set = new Set(state.ui.promptCatsCollapsed || []); if (set.has(id)) set.delete(id); else set.add(id); state.ui.promptCatsCollapsed = [...set]; save(); renderRight(); };
    const group = (id, icon, name, list) => {
      const col = collapsed.has(id) && !q;
      return h('div.prompt-group', { class: `prompt-group${q && !list.some((pr) => `${pr.title}\n${pr.body}`.toLowerCase().includes(q)) ? ' hidden' : ''}` },
        h('div.prompt-ghead', { onclick: () => flip(id), title: col ? 'Desplegar' : 'Plegar' },
          h('span.integ-caret', col ? '▸' : '▾'), icon ? h('span.prompt-ico', icon) : null, h('span.grow', name), h('span.integ-count', String(list.length)),
          id !== '__none' ? h('button.icon.mini', { title: 'Nuevo prompt en esta categoría', onclick: (e) => { e.stopPropagation(); editPrompt(null, { cat: id }); } }, '＋') : null),
        col ? null : list.map((pr) => promptCard(pr, q)));
    };
    const known = new Set(cats.map((c) => c.id));
    const none = state.prompts.filter((pr) => !pr.cat || !known.has(pr.cat));
    return [
      section('Prompts estándar',
        h('button.mini', { title: 'Categorías: crear, editar íconos y nombres', onclick: () => promptCatsModal() }, '🗂'),
        h('button.mini', { title: 'Exportar JSON', onclick: exportPrompts }, '⇩'),
        h('button.mini', { title: 'Importar JSON', onclick: importPrompts }, '⇧'),
        h('button.mini.primary', { onclick: () => editPrompt() }, '+ Nuevo')),
      filter,
      h('p.muted', { style: 'margin:0 2px 8px;font-size:11px' }, 'Clic = ejecutar en la terminal activa · ⇥ = insertar sin Enter · variables: {{project}} {{folder}} {{folders}}'),
      ...(cats.length
        ? [...cats.map((c) => group(c.id, c.icon, c.name, state.prompts.filter((pr) => pr.cat === c.id))), none.length ? group('__none', '', 'Sin categoría', none) : null]
        : state.prompts.map((pr) => promptCard(pr, q))),
    ];
  }
  /** Categorías de prompts: nombre e ícono; borrar una deja sus prompts en «Sin categoría». */
  function promptCatsModal() {
    const rows = state.promptCats.map((c) => ({ ...c }));
    const list = h('div.pcat-list');
    const paint = () => list.replaceChildren(...(rows.length ? rows.map((c, i) => h('div.pcat-row',
      h('input.team-icon-in', { value: c.icon || '', maxlength: '8', placeholder: '·', oninput: (e) => { c.icon = e.target.value.trim(); } }),
      h('input.grow', { value: c.name, placeholder: 'Nombre', oninput: (e) => { c.name = e.target.value; } }),
      h('span.muted', `${state.prompts.filter((pr) => pr.cat === c.id).length} prompt(s)`),
      h('button.icon.mini', { title: 'Subir', onclick: () => { if (i > 0) { rows.splice(i - 1, 0, rows.splice(i, 1)[0]); paint(); } } }, '↑'),
      h('button.icon.mini', { title: 'Bajar', onclick: () => { if (i < rows.length - 1) { rows.splice(i + 1, 0, rows.splice(i, 1)[0]); paint(); } } }, '↓'),
      h('button.icon.mini', { title: 'Borrar (sus prompts quedan sin categoría)', onclick: () => { rows.splice(i, 1); paint(); } }, '✕'))) : [h('p.muted', 'Sin categorías. Agrega una abajo.')]));
    paint();
    const picks = h('div.icon-grid', PROMPT_ICONS.filter(Boolean).map((ic) => h('button.icon-pick', { type: 'button', title: 'Usar en la última categoría', onclick: () => { if (rows.length) { rows[rows.length - 1].icon = ic; paint(); } } }, ic)));
    const doSave = () => {
      const clean = rows.filter((c) => c.name.trim()).map((c) => ({ id: c.id, name: c.name.trim().slice(0, 40), icon: (c.icon || '').slice(0, 8) }));
      const ids = new Set(clean.map((c) => c.id));
      for (const pr of state.prompts) if (pr.cat && !ids.has(pr.cat)) delete pr.cat;
      state.promptCats = clean;
      save();
      modalClose(true);
      renderRight();
    };
    openModal({
      title: 'Categorías de prompts',
      body: [list, h('div.field-row', { style: 'margin-top:8px' }, h('button.mini', { onclick: () => { rows.push({ id: uid(), name: '', icon: '' }); paint(); requestAnimationFrame(() => { const ins = list.querySelectorAll('input.grow'); if (ins.length) ins[ins.length - 1].focus(); }); } }, '＋ Nueva categoría')),
        h('p.muted', { style: 'font-size:11px;margin:8px 0 4px' }, 'Íconos rápidos (para la última de la lista):'), picks],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
  }
  function editPrompt(pr, preset = {}) {
    const isNew = !pr;
    const title = h('input', { value: pr ? pr.title : '', placeholder: 'Título' });
    const body = h('textarea.prompt-body', { spellcheck: 'false', placeholder: 'Texto del prompt…' });
    body.value = pr ? pr.body : '';
    const icon = h('input.team-icon-in', { value: (pr && pr.icon) || '', maxlength: '8', placeholder: '·' });
    const picks = h('div.icon-grid', PROMPT_ICONS.map((ic) => h('button.icon-pick', { type: 'button', title: ic ? '' : 'Sin ícono', onclick: () => { icon.value = ic; } }, ic || '∅')));
    // categoría: las existentes, sin categoría o una nueva (nombre e ícono aquí mismo)
    const cat = h('select', h('option', { value: '' }, 'Sin categoría'), ...state.promptCats.map((c) => h('option', { value: c.id }, `${c.icon ? `${c.icon} ` : ''}${c.name}`)), h('option', { value: '__new' }, '＋ Nueva categoría…'));
    cat.value = (pr && pr.cat && promptCat(pr.cat) ? pr.cat : preset.cat) || '';
    const newIcon = h('input.team-icon-in', { maxlength: '8', placeholder: '🗂' });
    const newName = h('input.grow', { placeholder: 'Nombre de la categoría nueva' });
    const newRow = h('div.field-row.hidden', newIcon, newName);
    cat.addEventListener('change', () => { newRow.classList.toggle('hidden', cat.value !== '__new'); if (cat.value === '__new') newName.focus(); });
    // persona del Equipo (solo para distinguirlo)
    const people = (teamInfo && teamInfo.people) || [];
    const person = h('select', h('option', { value: '' }, 'Nadie en particular'), ...people.map((x) => h('option', { value: x.id }, `${x.icon || '👤'} ${x.name} · ${x.role}`)));
    person.value = (pr && pr.person) || '';
    const doSave = (run) => {
      if (!title.value.trim() || !body.value.trim()) { toast('Título y texto son obligatorios', 'err'); return; }
      let catId = cat.value;
      if (catId === '__new') {
        if (!newName.value.trim()) { toast('Escribe el nombre de la categoría nueva', 'err'); newName.focus(); return; }
        const c = { id: uid(), name: newName.value.trim().slice(0, 40), icon: newIcon.value.trim().slice(0, 8) };
        state.promptCats.push(c);
        catId = c.id;
      }
      if (isNew) { pr = { id: uid() }; state.prompts.push(pr); }
      pr.title = title.value.trim();
      pr.body = body.value;
      if (icon.value.trim()) pr.icon = icon.value.trim().slice(0, 8); else delete pr.icon;
      if (catId) pr.cat = catId; else delete pr.cat;
      if (person.value) pr.person = person.value; else delete pr.person;
      save();
      modalClose(true);
      renderRight();
      if (run) runPrompt(pr, true);
    };
    body.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doSave(true); });
    openModal({
      title: isNew ? 'Nuevo prompt' : 'Editar prompt',
      wide: true,
      body: [
        h('div.field-row', h('div.field', { style: 'width:80px' }, h('label', 'Ícono'), icon), h('div.field.grow', h('label', 'Título'), title)),
        picks,
        h('div.field-row',
          h('div.field.grow', h('label', 'Categoría'), cat),
          people.length ? h('div.field.grow', h('label', 'Persona (para distinguirlo)'), person) : null),
        newRow,
        h('div.field', h('label', 'Prompt'), body),
      ],
      foot: [
        h('button', { onclick: () => modalClose(true) }, 'Cancelar'),
        h('button', { onclick: () => doSave(true), title: 'Ctrl+Enter' }, 'Guardar y ejecutar'),
        h('button.primary', { onclick: () => doSave(false) }, 'Guardar'),
      ],
    });
  }
  async function deletePrompt(pr) {
    if (!(await confirmBox(`¿Eliminar "${pr.title}"?`))) return;
    state.prompts = state.prompts.filter((x) => x.id !== pr.id);
    save();
    renderRight();
  }
  function exportPrompts() {
    const blob = new Blob([JSON.stringify(state.prompts.map(({ title, body, icon, cat, person }) => { const c = promptCat(cat); return { title, body, ...(icon ? { icon } : {}), ...(c ? { category: c.name, categoryIcon: c.icon || '' } : {}), ...(person ? { person } : {}) }; }), null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'frap-prompts.json' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importPrompts() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      try {
        const arr = JSON.parse(await input.files[0].text());
        if (!Array.isArray(arr)) throw new Error('Se esperaba un array');
        let n = 0;
        for (const it of arr) {
          if (it && typeof it.title === 'string' && typeof it.body === 'string') {
            let cat;
            if (typeof it.category === 'string' && it.category.trim()) {
              cat = state.promptCats.find((c) => c.name.toLowerCase() === it.category.trim().toLowerCase());
              if (!cat) { cat = { id: uid(), name: it.category.trim().slice(0, 40), icon: String(it.categoryIcon || '').slice(0, 8) }; state.promptCats.push(cat); }
            }
            state.prompts.push({ id: uid(), title: it.title, body: it.body, ...(typeof it.icon === 'string' && it.icon ? { icon: it.icon.slice(0, 8) } : {}), ...(cat ? { cat: cat.id } : {}), ...(typeof it.person === 'string' && it.person ? { person: it.person } : {}) });
            n++;
          }
        }
        save();
        renderRight();
        toast(`${n} prompts importados`, 'ok');
      } catch (e) { toast(`Importación fallida: ${e.message}`, 'err'); }
    };
    input.click();
  }

  // ---------- acciones: comandos con nombre que se encienden / apagan (VPN, servidores…) ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\r/g, '');
  const actionById = (id) => state.actions.find((a) => a.id === id) || null;
  const actionOf = (t) => (termKind(t) === 'action' ? actionById((t.info.meta || {}).actionId) : null);
  const actionSessions = (id) => [...terms.values()]
    .filter((t) => (t.info.meta || {}).actionId === id)
    .sort((a, b) => a.info.created - b.info.created);
  const actionLive = (id) => actionSessions(id).find((t) => t.info.alive !== false) || null;
  const actionLast = (id) => actionSessions(id).pop() || null;

  function actionStatus(a) {
    const t = actionLive(a.id);
    if (!t) {
      const last = actionLast(a.id);
      if (last && !last.stopRequested && last.info.exitCode != null && last.info.exitCode !== 0) return 'error';
      return 'off';
    }
    if (t.stopRequested) return 'stopping';
    if (a.ready && !t.ready) return 'starting';
    return 'on';
  }
  const ACTION_LABEL = { on: 'activa', starting: 'iniciando…', stopping: 'deteniendo…', off: 'apagada', error: 'falló' };

  /** Busca el patrón "lista" de la acción en la salida (para pasar de iniciando → activa). */
  function actionScan(t, d, quiet) {
    const a = actionOf(t);
    if (!a || !a.ready || t.ready) return;
    t.tail = ((t.tail || '') + stripAnsi(d)).slice(-16384);
    let re;
    try { re = new RegExp(a.ready, 'i'); } catch (_) { return; }
    if (!re.test(t.tail)) return;
    t.ready = true;
    if (!quiet) toast(`${a.name}: activa`, 'ok');
    refreshActions();
  }

  function onActionExit(t, code) {
    const a = actionOf(t);
    t.term.write(`\r\n\x1b[2m[acción terminada · código ${code}]\x1b[0m\r\n`);
    if (a) {
      if (t.stopRequested) toast(`${a.name}: desactivada`, 'ok');
      else if (code !== 0) toast(`${a.name}: terminó con código ${code} — revisa el log`, 'err');
      else toast(`${a.name}: terminó`, 'ok');
    }
    renderAll();
    refreshActions();
  }

  function refreshActions() {
    if (state.ui.rtab === 'actions') renderRight();
    renderStatusActions();
  }

  async function startAction(a) {
    if (!Bridge.ready) { toast('Bridge desconectado', 'err'); return; }
    if (actionLive(a.id)) return;
    for (const t of actionSessions(a.id)) disposeTerm(t.sid); // descarta logs de ejecuciones previas
    const shell = (Bridge.info && Bridge.info.shell) || '/bin/bash';
    try {
      // -i: shell interactiva para que funcionen alias y funciones del .bashrc/.zshrc
      const info = await Bridge.call('session.create', {
        cwd: a.cwd || Bridge.info.home,
        cols: 120, rows: 32,
        cmd: [shell, '-ic', a.cmd],
        meta: { kind: 'action', actionId: a.id, title: a.name },
      });
      ensureTerm(info);
      toast(`${a.name}: iniciando…`);
    } catch (e) { toast(e.message, 'err'); }
    refreshActions();
  }

  /** Apagar = Ctrl+C por la terminal (llega aunque el proceso corra con sudo/root). */
  async function stopAction(a) {
    const t = actionLive(a.id);
    if (!t || t.stopRequested) return;
    t.stopRequested = true;
    refreshActions();
    Bridge.send('session.input', { sid: t.sid, data: '\x03' });
    for (let i = 0; i < 50 && t.info.alive !== false; i++) {
      await sleep(200);
      if (i === 20) Bridge.send('session.input', { sid: t.sid, data: '\x03' });
    }
    if (t.info.alive !== false) {
      try { await Bridge.call('session.kill', { sid: t.sid }); } catch (_) { /* ya terminó */ }
      toast(`${a.name}: no respondió a Ctrl+C; se cerró su terminal. Revisa que no haya quedado un proceso como root.`, 'err');
    }
    refreshActions();
  }

  function toggleAction(a) {
    const st = actionStatus(a);
    if (st === 'on' || st === 'starting') stopAction(a);
    else if (st === 'off' || st === 'error') startAction(a);
  }

  function showActionLog(a) {
    const t = actionLast(a.id);
    if (!t) { toast('Esta acción aún no se ha ejecutado'); return; }
    activate(t.sid);
  }
  function leaveActionLog() {
    const list = sessionsOf(state.activeProject);
    state.activeSid = list.length ? list[list.length - 1].sid : null;
    renderAll();
    const t = activeTerm();
    if (t) requestAnimationFrame(() => { fitTerm(t); t.term.focus(); });
  }

  function renderStatusActions() {
    const el = $('#st-actions');
    if (!el) return;
    el.replaceChildren(...state.actions
      .map((a) => [a, actionStatus(a)])
      .filter(([, st]) => st !== 'off')
      .map(([a, st]) => h(`span.st-action.${st}`, {
        title: `${a.name}: ${ACTION_LABEL[st]} — clic para ver acciones`,
        onclick: () => { if (state.ui.hideRight) togglePanel('right'); setRtab('actions'); },
      }, `⚡ ${a.name}`)));
  }

  function renderActions() {
    const head = section('Acciones', h('button.mini.primary', { onclick: () => editAction() }, '+ Nueva'));
    const hint = h('p.muted', { style: 'margin:0 2px 8px;font-size:11px' },
      'Comandos con nombre que enciendes y apagas desde aquí (VPN, servidores, túneles…). Corren en una shell interactiva, así que funcionan tus alias. Apagar envía Ctrl+C.');
    if (!state.actions.length) return [head, hint, h('p.muted', 'Aún no hay acciones. Pulsa "+ Nueva", ponle un nombre y escribe el comando a ejecutar (puede ser un alias o un script).')];
    return [head, hint, ...state.actions.map((a) => {
      const st = actionStatus(a);
      const live = actionLive(a.id);
      const last = actionLast(a.id);
      const label = st === 'error' && last ? `falló (código ${last.info.exitCode})` : ACTION_LABEL[st];
      return h(`div.card.action-card.${st}`,
        h('div.title',
          h(`button.switch.${st}`, {
            title: st === 'on' || st === 'starting' ? 'Apagar' : st === 'stopping' ? 'Deteniendo…' : 'Encender',
            role: 'switch', 'aria-checked': String(st === 'on' || st === 'starting'),
            disabled: !Bridge.ready || st === 'stopping',
            onclick: () => toggleAction(a),
          }),
          h('span.name', a.name),
          h(`span.badge.st-${st}`, label),
          h('button.icon.mini', { title: 'Ver log', disabled: !last, onclick: () => showActionLog(a) }, '☰'),
          h('button.icon.mini', { title: 'Editar', onclick: () => editAction(a) }, '✎'),
          h('button.icon.mini', { title: 'Eliminar', onclick: () => deleteAction(a) }, '✕')),
        h('div.desc.mono', a.cmd),
        live && live.info.created ? h('div.path', `desde ${new Date(live.info.created).toLocaleTimeString()}${a.cwd ? ' · ' + tilde(a.cwd) : ''}`)
          : a.cwd ? h('div.path', tilde(a.cwd)) : null);
    })];
  }

  function editAction(a) {
    const isNew = !a;
    const name = h('input', { value: a ? a.name : '', placeholder: 'Mi acción' });
    const cmd = h('textarea.prompt-body', { spellcheck: 'false', placeholder: 'mi-comando --opcion', style: 'min-height:90px' });
    cmd.value = a ? a.cmd : '';
    const cwd = h('input.mono', { value: a ? a.cwd || '' : '', placeholder: '(carpeta personal)' });
    const ready = h('input.mono', { value: a ? a.ready || '' : '', placeholder: 'texto que indica que ya está lista' });
    const doSave = () => {
      if (!name.value.trim() || !cmd.value.trim()) { toast('Nombre y comando son obligatorios', 'err'); return; }
      if (ready.value.trim()) {
        try { new RegExp(ready.value.trim()); } catch (e) { toast(`Patrón inválido: ${e.message}`, 'err'); return; }
      }
      if (isNew) { a = { id: uid() }; state.actions.push(a); }
      a.name = name.value.trim();
      a.cmd = cmd.value.trim();
      a.cwd = cwd.value.trim();
      a.ready = ready.value.trim();
      save();
      modalClose(true);
      refreshActions();
    };
    openModal({
      title: isNew ? 'Nueva acción' : `Editar acción · ${a.name}`,
      body: [
        h('div.field', h('label', 'Nombre'), name),
        h('div.field', h('label', 'Comando (se ejecuta con tu shell interactiva: alias, funciones y scripts)'), cmd),
        h('div.field', h('label', 'Carpeta (opcional)'), h('div.field-row', h('span.grow', cwd),
          h('button', { onclick: async () => { const f = await pickFolderInline(cwd.value); if (f) cwd.value = f; } }, 'Elegir…'))),
        h('div.field', h('label', 'Marcar "activa" cuando la salida contenga (regex, opcional)'), ready),
        h('p.muted', { style: 'margin:0;font-size:11px' }, 'Sin patrón, la acción se considera activa mientras el proceso corre. Si el comando pide contraseña (sudo), ábrelo con ☰ y escríbela en el log.'),
      ],
      foot: [h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
    cwd.style.width = '100%';
  }

  /** pickFolder reabre el modal; aquí lo usamos desde otro modal, así que se guarda y restaura el formulario. */
  async function pickFolderInline(start) {
    const body = [...$('#modal-body').childNodes];
    const foot = [...$('#modal-foot').childNodes];
    const title = $('#modal-title').textContent;
    const res = await pickFolder(start || undefined);
    openModal({ title, body, foot });
    return res;
  }

  async function deleteAction(a) {
    if (!(await confirmBox(`¿Eliminar la acción "${a.name}"?`, actionLive(a.id) ? 'Está activa: se apagará primero.' : ''))) return;
    if (actionLive(a.id)) await stopAction(a);
    for (const t of actionSessions(a.id)) disposeTerm(t.sid);
    state.actions = state.actions.filter((x) => x.id !== a.id);
    save();
    refreshActions();
    renderAll();
  }

  // ---------- páginas: accesos a URLs (pestaña del navegador o pestaña interna con iframe) ----------
  const PAGE_PREFIX = 'page:';
  const isPageView = (sid) => typeof sid === 'string' && sid.startsWith(PAGE_PREFIX);
  const pageById = (id) => state.pages.find((p) => p.id === id) || null;
  /** id de página -> div.page-pane (iframe + barra). Se crean al activarse por primera vez. */
  const pagePanes = new Map();
  const PAGE_MODE_LABEL = { tab: 'navegador', iframe: 'interna' };
  const pageMode = (pg) => (pg.mode === 'tab' || pg.mode === 'iframe' ? pg.mode : state.settings.pageMode || 'tab');

  /** "localhost:3000" -> "http://localhost:3000", "ejemplo.com" -> "https://ejemplo.com". */
  function normalizeUrl(raw) {
    const u = String(raw || '').trim();
    if (!u) return '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^(localhost|[\d.]+):\d/i.test(u)) return u;
    const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|192\.168\.|10\.)/i.test(u);
    return `${local ? 'http' : 'https'}://${u}`;
  }
  function validUrl(u) {
    try { const x = new URL(u); return ['http:', 'https:', 'file:'].includes(x.protocol); } catch (_) { return false; }
  }

  function openPage(pg, mode = pageMode(pg)) {
    if (mode === 'iframe') openPageIframe(pg);
    else openPageTab(pg);
  }
  function openPageTab(pg) {
    // con 'noopener' window.open siempre devuelve null; se corta opener a mano para poder detectar bloqueos
    const w = window.open(pg.url, '_blank');
    if (w) w.opener = null;
    else toast('El navegador bloqueó la ventana emergente', 'err');
  }
  function openPageIframe(pg) {
    if (!state.openPages.includes(pg.id)) state.openPages.push(pg.id);
    state.activeSid = PAGE_PREFIX + pg.id;
    save();
    renderAll();
  }
  function closePageView(id) {
    state.openPages = state.openPages.filter((x) => x !== id);
    const pane = pagePanes.get(id);
    if (pane) { pane.remove(); pagePanes.delete(id); }
    if (state.activeSid === PAGE_PREFIX + id) {
      const list = sessionsOf(state.activeProject);
      const next = state.openPages[state.openPages.length - 1];
      state.activeSid = list.length ? list[list.length - 1].sid : next ? PAGE_PREFIX + next : null;
    }
    save();
    renderAll();
  }

  function ensurePagePane(pg) {
    let pane = pagePanes.get(pg.id);
    if (pane && pane.dataset.url === pg.url) return pane;
    if (pane) pane.remove();
    const frame = h('iframe', {
      src: pg.url,
      title: pg.name,
      referrerpolicy: 'no-referrer',
      // sin allow-top-navigation: la página no puede sacar a FRAP de la pestaña
      sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads',
      allow: 'clipboard-read; clipboard-write; fullscreen',
    });
    pane = h('div.page-pane', { dataset: { url: pg.url } },
      h('div.page-bar',
        h('span.page-url', pg.url),
        h('span.muted', '¿En blanco? Ese sitio no permite iframes → ábrelo en el navegador'),
        h('button.icon.mini', { title: 'Recargar', onclick: () => { frame.src = pg.url; } }, '⟳'),
        h('button.icon.mini', { title: 'Abrir en pestaña del navegador', onclick: () => openPageTab(pg) }, '↗')),
      frame);
    pagePanes.set(pg.id, pane);
    $('#term-host').append(pane);
    return pane;
  }

  function renderPages() {
    const mode = state.settings.pageMode || 'tab';
    const head = section('Páginas',
      h('button.mini', {
        title: 'Cambiar cómo se abren por defecto (también en Ajustes)',
        onclick: () => { state.settings.pageMode = mode === 'tab' ? 'iframe' : 'tab'; save(); renderRight(); },
      }, `Por defecto: ${PAGE_MODE_LABEL[mode]}`),
      h('button.mini.primary', { onclick: () => editPage() }, '+ Nueva'));
    const hint = h('p.muted', { style: 'margin:0 2px 8px;font-size:11px' },
      'Clic = abrir según su modo · ↗ pestaña del navegador · ▣ pestaña interna (iframe). Muchos sitios públicos bloquean los iframes; los servidores locales suelen funcionar.');
    if (!state.pages.length) return [head, hint, h('p.muted', 'Aún no hay páginas. Pulsa "+ Nueva" y agrega un nombre y una URL.')];
    return [head, hint, ...state.pages.map((pg) => {
      const m = pageMode(pg);
      const open = state.openPages.includes(pg.id);
      return h(`div.card.clickable${open ? '.page-open' : ''}`, { title: `Abrir (${PAGE_MODE_LABEL[m]})`, onclick: () => openPage(pg) },
        h('div.title',
          h('span.name', `🌐 ${pg.name}`),
          h('span.badge', { title: pg.mode === 'default' || !pg.mode ? 'Usa el modo por defecto' : '' },
            PAGE_MODE_LABEL[m] + (pg.mode === 'tab' || pg.mode === 'iframe' ? '' : ' *')),
          h('button.icon.mini', { title: 'Abrir en pestaña del navegador', onclick: (e) => { e.stopPropagation(); openPage(pg, 'tab'); } }, '↗'),
          h('button.icon.mini', { title: 'Abrir como pestaña interna (iframe)', onclick: (e) => { e.stopPropagation(); openPage(pg, 'iframe'); } }, '▣'),
          h('button.icon.mini', { title: 'Editar', onclick: (e) => { e.stopPropagation(); editPage(pg); } }, '✎'),
          h('button.icon.mini', { title: 'Eliminar', onclick: (e) => { e.stopPropagation(); deletePage(pg); } }, '✕')),
        h('div.path', pg.url));
    })];
  }

  function editPage(pg) {
    const isNew = !pg;
    const name = h('input', { value: pg ? pg.name : '', placeholder: 'Mi página' });
    const url = h('input.mono', { value: pg ? pg.url : '', placeholder: 'https://ejemplo.com o localhost:3000' });
    const mode = h('select',
      h('option', { value: 'default' }, `Por defecto (${PAGE_MODE_LABEL[state.settings.pageMode || 'tab']})`),
      h('option', { value: 'tab' }, 'Pestaña del navegador'),
      h('option', { value: 'iframe' }, 'Pestaña interna (iframe)'));
    mode.value = pg && pg.mode ? pg.mode : 'default';
    const doSave = () => {
      const u = normalizeUrl(url.value);
      if (!name.value.trim() || !u) { toast('Nombre y URL son obligatorios', 'err'); return; }
      if (!validUrl(u)) { toast('URL inválida (usa http, https o file)', 'err'); return; }
      if (isNew) { pg = { id: uid() }; state.pages.push(pg); }
      pg.name = name.value.trim();
      pg.url = u;
      pg.mode = mode.value;
      save();
      modalClose(true);
      renderAll();
      if (state.ui.rtab === 'pages') renderRight();
    };
    [name, url].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); }));
    openModal({
      title: isNew ? 'Nueva página' : `Editar página · ${pg.name}`,
      body: [
        h('div.field', h('label', 'Nombre'), name),
        h('div.field', h('label', 'URL'), url),
        h('div.field', h('label', 'Abrir en'), mode),
      ],
      foot: [h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
  }

  async function deletePage(pg) {
    if (!(await confirmBox(`¿Eliminar la página "${pg.name}"?`, pg.url))) return;
    if (state.openPages.includes(pg.id)) closePageView(pg.id);
    state.pages = state.pages.filter((x) => x.id !== pg.id);
    save();
    renderAll();
    renderRight();
  }

  // ---------- git: interfaz guiada (status, add, commit, ramas, pull/push…) en el panel central ----------
  let gitPane = null; // panel de la vista git enlazada (ver "vistas por proyecto")
  const newGitRt = () => ({
    repos: [], // repos detectados en las carpetas del proyecto
    projectId: null,
    status: null, // { branch, upstream, ahead, behind, staged, unstaged, untracked, noCommits, detached }
    branches: [],
    remotes: [],
    log: [],
    out: [], // salida de comandos ejecutados (la "guía")
    busy: false,
    selected: null, // { path, area } del diff mostrado
  });
  let Git = newGitRt(); // memoria de la vista git enlazada
  const gitArgsLabel = (args) => 'git ' + args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

  /**
   * Ejecuta git en el repo actual. log=true lo registra en "Salida" (comandos que hace el usuario).
   * rt/repo: los fija gitAction para que una acción siga en su repo aunque se cambie de vista a mitad.
   */
  async function git(args, { log = true, repo = state.git.repo, quiet = false, rt = Git } = {}) {
    if (!Bridge.ready) throw new Error('Bridge desconectado');
    if (!repo) throw new Error('No hay repositorio seleccionado');
    const r = await Bridge.call('git.run', { cwd: repo, args });
    if (log) {
      rt.out.push({ cmd: gitArgsLabel(args), code: r.code, text: (r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '')).trimEnd(), at: Date.now() });
      if (rt.out.length > 100) rt.out.shift();
      if (Git === rt && state.git.tab === 'out') renderGitRight();
      if (r.code !== 0 && !quiet) {
        const msg = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' · ');
        toast(`${gitArgsLabel(args)} → ${msg || 'código ' + r.code}`, 'err');
      }
    }
    return r;
  }

  /** Abre (o enfoca) la vista git del proyecto activo. */
  function openGitView() {
    if (!needProject()) return;
    showView('git');
    gitRefresh();
  }

  /** Detecta los repos de las carpetas del proyecto activo (cuando cambia el proyecto). */
  async function gitSyncProject(force = false) {
    const p = project();
    if (!p || !Bridge.ready) return;
    if (!force && Git.projectId === p.id) return;
    const rt = Git;
    const gs = state.git;
    rt.projectId = p.id;
    const repos = [];
    for (const f of p.folders) {
      try {
        const r = await git(['rev-parse', '--show-toplevel'], { log: false, repo: f, rt });
        const top = r.stdout.trim();
        if (r.code === 0 && top && !repos.includes(top)) repos.push(top);
      } catch (_) { /* sin acceso */ }
    }
    // repos internos: la carpeta puede no tener git pero sí una subcarpeta (o tener varios)
    try { for (const r of await Bridge.call('git.findRepos', { paths: p.folders, depth: 3 })) if (!repos.includes(r)) repos.push(r); } catch (_) { /* bridge viejo */ }
    rt.repos = repos;
    if (!repos.includes(gs.repo)) gs.repo = repos[0] || null;
    save();
    if (Git === rt) { gitRefresh(); renderProjects(); }
  }

  function parseGitStatus(out) {
    const parts = out.split('\0');
    const st = { branch: '', upstream: '', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], noCommits: false, detached: false };
    let i = 0;
    if (parts[0] && parts[0].startsWith('## ')) {
      const line = parts[0].slice(3);
      i = 1;
      let m;
      if ((m = line.match(/^No commits yet on (.+)$/)) || (m = line.match(/^Initial commit on (.+)$/))) { st.branch = m[1]; st.noCommits = true; }
      else if (line.startsWith('HEAD (no branch)')) { st.branch = 'HEAD'; st.detached = true; }
      else {
        m = line.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
        if (m) {
          st.branch = m[1];
          st.upstream = m[2] || '';
          const a = (m[3] || '').match(/ahead (\d+)/);
          const b = (m[3] || '').match(/behind (\d+)/);
          st.ahead = a ? +a[1] : 0;
          st.behind = b ? +b[1] : 0;
        }
      }
    }
    for (; i < parts.length; i++) {
      const e = parts[i];
      if (!e || e.length < 4) continue;
      const x = e[0];
      const y = e[1];
      const file = e.slice(3);
      if (x === 'R' || x === 'C') i++; // -z: el origen del renombrado va en la siguiente entrada
      if (x === '?' && y === '?') { st.untracked.push({ path: file, code: '?' }); continue; }
      const conflict = x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
      if (conflict) { st.unstaged.push({ path: file, code: 'U', conflict: true }); continue; }
      if (x !== ' ') st.staged.push({ path: file, code: x });
      if (y !== ' ') st.unstaged.push({ path: file, code: y });
    }
    return st;
  }

  async function gitRefresh() {
    if (!gitPane || viewKind(state.activeSid) !== 'git') return;
    if (!state.git.repo) { Git.status = null; renderGit(); return; }
    const rt = Git;
    const o = { log: false, rt, repo: state.git.repo };
    try {
      const [st, br, rbr, rem, lg, head] = await Promise.all([
        git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], o),
        git(['branch', '--format=%(HEAD)%09%(refname:short)%09%(upstream:short)%09%(upstream:track)'], o),
        git(['branch', '-r', '--format=%(refname:short)'], o),
        git(['remote'], o),
        git(['log', '-n', '60', '--pretty=format:%h%x1f%an%x1f%ar%x1f%D%x1f%s'], o),
        git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], o).catch(() => ({ code: 1, stdout: '' })), // rama principal del remoto
      ]);
      if (Git !== rt) return; // se cambió de vista mientras git respondía
      if (st.code !== 0) { Git.status = { error: st.stderr.trim() }; renderGit(); return; }
      Git.status = parseGitStatus(st.stdout);
      Git.branches = br.stdout.split('\n').filter(Boolean).map((l) => {
        const [head, name, upstream, track] = l.split('\t');
        return { name, current: head === '*', upstream, track };
      });
      Git.remoteBranches = rbr.stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD') && s.includes('/'));
      Git.remotes = rem.stdout.split('\n').filter(Boolean);
      const dh = head.code === 0 ? head.stdout.trim() : '';
      Git.defaultBranch = dh.startsWith('origin/') ? dh.slice(7) : ['main', 'master', 'develop'].find((n) => Git.branches.some((b) => b.name === n) || (Git.remoteBranches || []).includes(`origin/${n}`)) || '';
      Git.log = lg.code === 0 ? lg.stdout.split('\n').filter(Boolean).map((l) => {
        const [hash, author, when, refs, subject] = l.split('\x1f');
        return { hash, author, when, refs, subject };
      }) : [];
    } catch (e) { if (Git !== rt) return; Git.status = { error: e.message }; }
    renderGit();
  }

  /**
   * Ejecuta una acción guiada: bloquea botones, refresca al terminar. fn(g, pane): `g` es git() fijado
   * al repo y la memoria de esta vista, así la acción no salta de repo si se cambia de proyecto a mitad.
   */
  async function gitAction(label, fn) {
    const rt = Git;
    const pane = gitPane;
    const repo = state.git.repo;
    if (!pane || rt.busy) return;
    rt.busy = true;
    pane.root.classList.add('busy');
    pane.busy.textContent = `${label}…`;
    const g = (args, opts = {}) => git(args, { repo, rt, ...opts });
    try { await fn(g, pane); } catch (e) { toast(e.message, 'err'); }
    rt.busy = false;
    pane.root.classList.remove('busy');
    pane.busy.textContent = '';
    if (Git === rt) await gitRefresh();
  }
  const okToast = (r, msg) => { if (r.code === 0) toast(msg, 'ok'); return r.code === 0; };

  // ----- acciones -----
  const gitAdd = (paths) => gitAction('git add', async (g) => okToast(await g(['add', '--', ...paths]), paths.length > 1 ? `${paths.length} archivos agregados` : `Agregado: ${paths[0]}`));
  const gitAddAll = () => gitAction('git add -A', async (g) => okToast(await g(['add', '-A']), 'Todos los cambios agregados'));
  const gitUnstage = (paths) => gitAction('git restore --staged', async (g) => {
    const r = Git.status && Git.status.noCommits ? await g(['rm', '--cached', '-r', '-q', '--', ...paths]) : await g(['restore', '--staged', '--', ...paths]);
    okToast(r, paths.length > 1 ? `${paths.length} archivos quitados del stage` : `Quitado del stage: ${paths[0]}`);
  });
  async function gitDiscard(f) {
    const untracked = f.code === '?';
    if (!(await confirmBox(`¿Descartar los cambios de "${f.path}"?`, untracked ? 'El archivo sin seguimiento se BORRARÁ del disco (git clean -f). No se puede deshacer.' : 'Se perderán los cambios sin preparar (git restore). No se puede deshacer.'))) return;
    gitAction('descartar', async (g) => okToast(untracked ? await g(['clean', '-f', '--', f.path]) : await g(['restore', '--', f.path]), `Descartado: ${f.path}`));
  }
  async function gitCommit(andPush) {
    const msg = gitPane.msg.value.trim();
    if (!msg) { toast('Escribe un mensaje de commit', 'err'); gitPane.msg.focus(); return; }
    const st = Git.status || {};
    const rt = Git;
    let addAll = false;
    if (!(st.staged || []).length) {
      if (!(st.unstaged || []).length && !(st.untracked || []).length) { toast('No hay cambios para commitear'); return; }
      if (!(await confirmBox('No hay archivos preparados', '¿Agregar TODOS los cambios (git add -A) y hacer commit?'))) return;
      addAll = true;
    }
    gitAction('git commit', async (g, pane) => {
      if (addAll && (await g(['add', '-A'])).code !== 0) return;
      const r = await g(['commit', '-m', msg]);
      if (r.code !== 0) return;
      pane.msg.value = '';
      toast(`Commit creado: ${msg.split('\n')[0]}`, 'ok');
      if (andPush) await doPush(g, rt);
    });
  }
  async function doPush(g, rt) {
    const st = rt.status || {};
    if (!rt.remotes.length) { toast('El repositorio no tiene remotos (git remote add origin <url>)', 'err'); return; }
    // sin upstream: publica la rama en el primer remoto y la enlaza
    const args = st.upstream ? ['push'] : ['push', '-u', rt.remotes.includes('origin') ? 'origin' : rt.remotes[0], 'HEAD'];
    okToast(await g(args), 'Push completado');
  }
  const gitPush = () => { const rt = Git; gitAction('git push', (g) => doPush(g, rt)); };
  const gitPull = () => gitAction('git pull', async (g) => okToast(await g(['pull', '--no-edit']), 'Pull completado'));
  const gitFetch = () => gitAction('git fetch', async (g) => okToast(await g(['fetch', '--all', '--prune']), 'Fetch completado'));
  const gitStash = () => gitAction('git stash', async (g) => okToast(await g(['stash', 'push', '-u', '-m', `FRAP ${new Date().toLocaleString()}`]), 'Cambios guardados en el stash'));
  const gitStashPop = () => gitAction('git stash pop', async (g) => okToast(await g(['stash', 'pop']), 'Stash aplicado'));
  const gitInit = () => gitAction('git init', async (g) => {
    const p = project();
    if (!p) return;
    if ((await g(['init'], { repo: p.folders[0] })).code === 0) { toast('Repositorio creado', 'ok'); await gitSyncProject(true); }
  });

  async function gitCheckout(name, isRemote) {
    const st = Git.status || {};
    if ((st.staged || []).length || (st.unstaged || []).length) {
      if (!(await confirmBox(`¿Cambiar a "${name}" con cambios sin commitear?`, 'Git los llevará a la otra rama si no hay conflicto; si lo hay, el cambio fallará y nada se pierde. También puedes usar Stash antes.'))) return;
    }
    // rama remota (origin/x) -> rama local que la sigue
    const args = isRemote ? ['checkout', '--track', name] : ['checkout', name];
    gitAction(gitArgsLabel(args), async (g) => okToast(await g(args), `Ahora en ${isRemote ? name.split('/').slice(1).join('/') : name}`));
  }
  function gitNewBranch() {
    const name = gitPane.newBranch.value.trim();
    if (!name) { toast('Escribe el nombre de la nueva rama', 'err'); gitPane.newBranch.focus(); return; }
    if (!/^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]+(?<![./])$/.test(name)) { toast('Nombre de rama inválido', 'err'); return; }
    gitAction('git checkout -b', async (g, pane) => {
      if (okToast(await g(['checkout', '-b', name]), `Rama "${name}" creada`)) pane.newBranch.value = '';
    });
  }
  async function gitDeleteBranch(b, force) {
    if (!(await confirmBox(`¿${force ? 'Forzar la eliminación de' : 'Eliminar'} la rama "${b.name}"?`, force
      ? 'git branch -D: se borra aunque tenga commits sin fusionar (esos commits se pierden, salvo que estén en otra rama).'
      : 'Usa git branch -d: si tiene commits sin fusionar, git se negará y no se pierde nada.'))) return;
    gitAction(`git branch ${force ? '-D' : '-d'}`, async (g) => okToast(await g(['branch', force ? '-D' : '-d', b.name]), `Rama "${b.name}" eliminada`));
  }

  /** Comando libre: "git log --oneline -5" o "log --oneline -5". */
  function splitArgs(s) {
    const out = [];
    let cur = '';
    let q = null;
    let any = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q) q = null; else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += c; continue; }
      if (c === '"' || c === "'") { q = c; any = true; continue; }
      if (/\s/.test(c)) { if (cur || any) { out.push(cur); cur = ''; any = false; } continue; }
      cur += c;
    }
    if (cur || any) out.push(cur);
    return out;
  }
  function gitFree() {
    let args = splitArgs(gitPane.free.value.trim());
    if (args[0] === 'git') args = args.slice(1);
    if (!args.length) return;
    state.git.tab = 'out';
    gitAction(gitArgsLabel(args), async (g, pane) => {
      const r = await g(args, { quiet: true });
      if (r.code === 0) pane.free.value = '';
      if (gitPane === pane) renderGitRight();
    });
  }

  // ----- diff / historial -----
  async function gitShowDiff(f, area) {
    Git.selected = { path: f.path, area };
    state.git.tab = 'diff';
    let args;
    if (area === 'untracked') args = ['diff', '--no-index', '--', '/dev/null', f.path];
    else if (area === 'staged') args = ['diff', '--cached', '--', f.path];
    else args = ['diff', '--', f.path];
    const rt = Git;
    const r = await git(args, { log: false });
    if (Git !== rt) return;
    Git.diff = { title: `${f.path} · ${area === 'staged' ? 'preparado' : area === 'untracked' ? 'nuevo' : 'sin preparar'}`, cmd: gitArgsLabel(args), text: r.stdout || r.stderr || '(sin diferencias)' };
    renderGit();
  }
  async function gitShowCommit(c) {
    state.git.tab = 'diff';
    Git.selected = null;
    const args = ['show', '--stat', '--patch', '--format=commit %H%nAutor: %an <%ae>%nFecha: %ad%n%n    %s%n%n%b', c.hash];
    const rt = Git;
    const r = await git(args, { log: false });
    if (Git !== rt) return;
    Git.diff = { title: `${c.hash} · ${c.subject}`, cmd: gitArgsLabel(args), text: r.stdout || r.stderr };
    renderGit();
  }

  function diffView(text) {
    const pre = h('pre.git-diff');
    const lines = text.split('\n').slice(0, 5000);
    for (const l of lines) {
      let cls = '';
      if (/^(\+\+\+|---) /.test(l) || /^(diff|index|commit|Autor|Fecha|new file|deleted file|similarity|rename) /.test(l)) cls = 'meta';
      else if (l.startsWith('@@')) cls = 'hunk';
      else if (l.startsWith('+')) cls = 'add';
      else if (l.startsWith('-')) cls = 'del';
      pre.append(h(`span${cls ? '.' + cls : ''}`, l + '\n'));
    }
    if (text.split('\n').length > 5000) pre.append(h('span.meta', '… (diff truncado a 5000 líneas)\n'));
    return pre;
  }

  // ----- render -----
  function ensureGitPane() {
    if (gitPane) return gitPane;
    const repo = h('select.git-repo', { title: 'Repositorio' });
    repo.addEventListener('change', () => { state.git.repo = repo.value; Git.diff = null; save(); gitRefresh(); renderPanes(); renderProjects(); });
    const btn = (label, title, fn, cls = '') => h(`button${cls}`, { title, onclick: fn }, label);
    const branch = h('span.git-branch');
    const busy = h('span.git-busy.muted');
    const msg = h('textarea.git-msg', { placeholder: 'Mensaje del commit (Ctrl+Enter = commit)', spellcheck: 'true' });
    msg.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); gitCommit(false); } });
    const newBranch = h('input.mono', { placeholder: 'nueva-rama', spellcheck: 'false' });
    newBranch.addEventListener('keydown', (e) => { if (e.key === 'Enter') gitNewBranch(); });
    const free = h('input.mono.grow', { placeholder: 'status · log --oneline -10 · diff HEAD~1 · branch -a …', spellcheck: 'false' });
    free.addEventListener('keydown', (e) => { if (e.key === 'Enter') gitFree(); });
    const relSlot = h('span.git-rel'); // botón «🚀 Versión» si el repo tiene npm run push-v
    const left = h('div.git-left');
    const rtabs = h('div.git-rtabs');
    const right = h('div.git-right-body');
    const root = h('div.git-pane.hidden',
      h('div.git-bar',
        repo,
        btn('🔍', 'Buscar de nuevo los repos del proyecto (también los de subcarpetas)', () => gitSyncProject(true), '.icon'),
        branch,
        h('span.grow'), busy, relSlot,
        btn('⟳', 'Actualizar (git status)', () => gitRefresh(), '.icon'),
        btn('⤓ Fetch', 'git fetch --all --prune', gitFetch),
        btn('⬇ Pull', 'git pull --no-edit', gitPull),
        btn('⬆ Push', 'git push (o push -u origin HEAD si la rama no tiene upstream)', gitPush),
        btn('📦 Stash', 'git stash push -u (guarda los cambios y limpia el directorio)', gitStash),
        btn('📤 Pop', 'git stash pop (recupera lo último guardado)', gitStashPop),
        btn('↗ Repo', 'Abrir el repositorio remoto (origin) en otra pestaña del navegador', gitOpenRemote)),
      h('div.git-main',
        left,
        h('div.git-right', rtabs, right,
          h('div.git-free', h('span.mono.muted', '$ git'), free, h('button', { onclick: gitFree, title: 'Ejecutar el comando (Enter)' }, 'Ejecutar')))));
    $('#term-host').append(root);
    gitPane = { root, repo, branch, busy, msg, newBranch, free, left, rtabs, right, relSlot };
    viewPanes.set(bound.git, gitPane);
    return gitPane;
  }
  // refresco automático mientras una vista git está visible
  setInterval(() => { if (viewKind(state.activeSid) === 'git' && !document.hidden && !Git.busy && !modalClose) gitRefresh(); }, 5000);
  window.addEventListener('focus', () => { if (viewKind(state.activeSid) === 'git') gitRefresh(); });

  function fileRow(f, area) {
    const sel = Git.selected && Git.selected.path === f.path && Git.selected.area === area;
    const acts = [];
    if (area === 'staged') acts.push(h('button.icon.mini', { title: `git restore --staged -- ${f.path}`, onclick: (e) => { e.stopPropagation(); gitUnstage([f.path]); } }, '−'));
    else {
      acts.push(h('button.icon.mini.danger', { title: area === 'untracked' ? `git clean -f -- ${f.path} (borra el archivo)` : `git restore -- ${f.path} (descarta cambios)`, onclick: (e) => { e.stopPropagation(); gitDiscard(f); } }, '↶'));
      acts.push(h('button.icon.mini', { title: `git add -- ${f.path}`, onclick: (e) => { e.stopPropagation(); gitAdd([f.path]); } }, '+'));
    }
    const slash = f.path.lastIndexOf('/');
    return h(`div.git-file${sel ? '.sel' : ''}${f.conflict ? '.conflict' : ''}`, { title: `${f.path}\nClic: ver diff · clic derecho: más opciones`, onclick: () => gitShowDiff(f, area), oncontextmenu: (e) => gitFileMenu(e, f, area) },
      h(`span.git-code.c-${f.code === '?' ? 'U2' : f.code}`, f.code === '?' ? 'U' : f.code),
      h('span.git-fname', slash === -1 ? f.path : f.path.slice(slash + 1)),
      slash === -1 ? null : h('span.git-fdir', f.path.slice(0, slash)),
      h('span.grow'),
      ...acts);
  }
  /** URL web de un remoto git: git@host:u/r.git, ssh://git@host/u/r.git o https://user@host/u/r.git → https://host/u/r */
  function remoteWebUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return null;
    let m = u.match(/^[\w.-]+@([\w.-]+):(.+)$/); // scp: git@github.com:usuario/repo.git
    if (m) u = `https://${m[1]}/${m[2]}`;
    else if ((m = u.match(/^(?:ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/))) u = `https://${m[1]}/${m[2]}`;
    else if (!/^https?:\/\//i.test(u)) return null; // ruta local u otro esquema
    try {
      const x = new URL(u);
      x.username = '';
      x.password = ''; // nunca abrir (ni mostrar) un token embebido en la URL del remoto
      return `${x.protocol}//${x.host}${x.pathname.replace(/\.git\/?$/, '').replace(/\/+$/, '')}`;
    } catch (_) { return null; }
  }
  /** {name, url} web del remoto `want` (o origin, o el primero). Avisa y devuelve null si no hay. */
  async function gitRemoteWeb(want) {
    const r = await git(['remote', '-v'], { log: false });
    const lines = r.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((x) => x.length >= 2);
    const pick = (want && lines.find((x) => x[0] === want)) || lines.find((x) => x[0] === 'origin') || lines[0];
    if (!pick) { toast('Este repositorio no tiene remoto (git remote add origin …)', 'err'); return null; }
    const url = remoteWebUrl(pick[1]);
    if (!url) { toast(`No se puede abrir el remoto «${pick[0]}» en el navegador`, 'err'); return null; }
    return { name: pick[0], url };
  }
  async function gitOpenRemote() {
    if (!state.git.repo) { toast('No hay repositorio seleccionado', 'err'); return; }
    try { const w = await gitRemoteWeb(); if (w) openPageTab({ url: w.url }); } catch (e) { toast(e.message, 'err'); }
  }
  /** URL web de una rama (y de su pull/merge request nueva) según el servicio: GitHub, GitLab, Bitbucket u otro. */
  function branchWebUrls(base, branch, target) {
    const e = (x) => x.split('/').map(encodeURIComponent).join('/');
    const host = (() => { try { return new URL(base).host; } catch (_) { return ''; } })();
    if (/gitlab/i.test(host)) return { list: `${base}/-/merge_requests`, tree: `${base}/-/tree/${e(branch)}`, pr: `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}${target ? `&merge_request%5Btarget_branch%5D=${encodeURIComponent(target)}` : ''}` };
    if (/bitbucket/i.test(host)) return { list: `${base}/pull-requests`, tree: `${base}/src/${e(branch)}`, pr: `${base}/pull-requests/new?source=${encodeURIComponent(branch)}${target ? `&dest=${encodeURIComponent(target)}` : ''}` };
    return { list: `${base}/pulls`, tree: `${base}/tree/${e(branch)}`, pr: `${base}/compare/${target ? `${e(target)}...` : ''}${e(branch)}?expand=1` }; // GitHub (y Gitea, que usa lo mismo)
  }
  /** Rama local o remota → {remote, branch} en el servidor ("origin/feat" → origin, feat; local con upstream → su upstream). */
  function branchOnRemote(b, isRemote) {
    const ref = isRemote ? b : b.upstream || '';
    if (ref && ref.includes('/')) { const [remote, ...rest] = ref.split('/'); return { remote, branch: rest.join('/') }; }
    return { remote: null, branch: isRemote ? b : b.name };
  }
  async function gitBranchOnline(b, isRemote, pr) {
    try {
      const { remote, branch } = branchOnRemote(b, isRemote);
      const w = await gitRemoteWeb(remote);
      if (!w) return;
      // el PR va contra la rama principal del remoto (origin/HEAD: la "default" de GitHub); si la rama ES la
      // principal, no hay PR que crear: se abre la lista de pull requests del repo
      const target = Git.defaultBranch || '';
      const urls = branchWebUrls(w.url, branch, target);
      openPageTab({ url: !pr ? urls.tree : branch === target ? urls.list : urls.pr });
    } catch (e) { toast(e.message, 'err'); }
  }
  /** Clic derecho en una rama (local o remota "origin/x"). */
  function gitBranchMenu(ev, b, isRemote) {
    const name = isRemote ? b : b.name;
    const cur = (Git.branches.find((x) => x.current) || {}).name || 'HEAD';
    const isCur = !isRemote && b.current;
    const short = isRemote ? name.split('/').slice(1).join('/') : name;
    const compare = () => gitAction(`comparar ${name}`, async (g) => {
      await g(['log', '--oneline', '--no-merges', `${cur}..${name}`]); // lo que trae esa rama
      await g(['log', '--oneline', '--no-merges', `${name}..${cur}`]); // lo que tiene la actual y esa no
      await g(['diff', '--stat', `${cur}...${name}`]);
      state.git.tab = 'out';
      save();
    });
    popMenu(ev, [
      !isCur && { label: isRemote ? `Cambiar a ${short} (seguir la remota)` : 'Cambiar a esta rama', hint: 'checkout', action: () => gitCheckout(name, isRemote) },
      { label: '↗ Abrir en línea', action: () => gitBranchOnline(b, isRemote, false) },
      short === Git.defaultBranch
        ? { label: '↗ Ver pull requests', hint: 'es la rama principal', action: () => gitBranchOnline(b, isRemote, true) }
        : { label: `↗ Crear pull request en línea${Git.defaultBranch ? ` (hacia ${Git.defaultBranch})` : ''}`, action: () => gitBranchOnline(b, isRemote, true) },
      '-',
      !isCur && { label: `Fusionar en «${cur}» (la actual)…`, hint: `git merge ${name}`, action: () => gitMergeBranch(name, cur) },
      !isCur && { label: `Comparar con «${cur}»`, hint: 'log y diff --stat', action: compare },
      { label: 'Crear rama desde aquí…', action: () => gitBranchFrom(name) },
      !isRemote && { label: 'Renombrar…', action: () => gitRenameBranch(b) },
      !isRemote && { label: b.upstream ? 'Publicar (push)' : 'Publicar en el remoto (push -u)', action: () => gitAction(`git push ${name}`, async (g) => okToast(await g(b.upstream ? ['push', b.upstream.split('/')[0], name] : ['push', '-u', 'origin', name]), `Rama "${name}" publicada`)) },
      '-',
      { label: 'Copiar nombre', action: () => codeCopy(short) },
      '-',
      !isRemote && !isCur && { label: 'Eliminar…', hint: 'branch -d', danger: true, action: () => gitDeleteBranch(b) },
      !isRemote && !isCur && { label: 'Forzar eliminación…', hint: 'branch -D: pierde commits sin fusionar', danger: true, action: () => gitDeleteBranch(b, true) },
      isRemote && { label: 'Eliminar la rama del remoto…', hint: 'push --delete', danger: true, action: () => gitDeleteRemoteBranch(name) },
    ]);
  }
  async function gitMergeBranch(name, cur) {
    const st = Git.status || {};
    const dirty = (st.staged || []).length + (st.unstaged || []).length;
    if (!(await confirmBox(`¿Fusionar «${name}» en «${cur}»?`, `git merge ${name}${dirty ? `\n\n⚠ Hay ${dirty} archivo(s) con cambios sin commit: si la fusión los toca, git se negará (no se pierde nada).` : ''}\n\nSi hay conflictos, aparecen en la lista de cambios para resolverlos y luego hacer commit.`))) return;
    gitAction(`git merge ${name}`, async (g) => {
      const r = await g(['merge', '--no-edit', name]);
      if (r.code === 0) toast(/Already up to date|Ya está actualizado/i.test(r.stdout) ? `«${cur}» ya tenía todo lo de «${name}»` : `«${name}» fusionada en «${cur}»`, 'ok');
      else if (/CONFLICT|conflicto/i.test(r.stdout + r.stderr)) { toast('Fusión con conflictos: resuélvelos en los archivos marcados y haz commit (o git merge --abort en la caja de comandos)', 'err'); }
    });
  }
  async function gitBranchFrom(name) {
    const nb = await askText('Nueva rama', `Nombre (se crea desde ${name} y te cambias a ella)`, '');
    if (!nb) return;
    if (!/^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]+(?<![./])$/.test(nb)) { toast('Nombre de rama inválido', 'err'); return; }
    gitAction('git checkout -b', async (g) => okToast(await g(['checkout', '-b', nb, name]), `Rama "${nb}" creada desde ${name}`));
  }
  async function gitRenameBranch(b) {
    const nb = await askText('Renombrar rama', 'Nuevo nombre', b.name);
    if (!nb || nb === b.name) return;
    if (!/^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]+(?<![./])$/.test(nb)) { toast('Nombre de rama inválido', 'err'); return; }
    gitAction('git branch -m', async (g) => okToast(await g(['branch', '-m', b.name, nb]), `Rama renombrada a "${nb}"${b.upstream ? ' (en el remoto sigue con el nombre anterior)' : ''}`));
  }
  async function gitDeleteRemoteBranch(ref) {
    const [remote, ...rest] = ref.split('/');
    const br = rest.join('/');
    if (!(await confirmBox(`¿Eliminar «${br}» del remoto «${remote}»?`, `git push ${remote} --delete ${br}\n\nSe borra en el servidor para todo el equipo. Las copias locales no se tocan.`))) return;
    gitAction('git push --delete', async (g) => okToast(await g(['push', remote, '--delete', br]), `Rama «${br}» eliminada de ${remote}`));
  }
  /** Clic derecho en un archivo con cambios: abrirlo (editor, explorador, editor externo), rutas, IA y acciones de git. */
  function gitFileMenu(ev, f, area) {
    const repo = state.git.repo;
    if (!repo) return;
    const isDir = f.path.endsWith('/'); // git status lista así las carpetas nuevas sin seguimiento
    const rel = f.path.replace(/\/+$/, '');
    const abs = `${repo}/${rel}`;
    const gone = f.code === 'D'; // borrado: ya no está en disco
    const runLog = async (args) => { try { await git(args); state.git.tab = 'out'; save(); renderGit(); } catch (e) { toast(e.message, 'err'); } };
    popMenu(ev, [
      { label: 'Ver diff', action: () => gitShowDiff(f, area) },
      !gone && !isDir && launchOn('code') && { label: 'Abrir en el editor de código', action: () => openInFrap(abs) },
      !gone && isDir && launchOn('code') && { label: 'Ver la carpeta en el editor de código', action: () => openInFrap(abs, null, null, true) },
      !gone && { label: isDir ? 'Abrir en el explorador de archivos' : 'Mostrar en el explorador de archivos', action: () => openInFileManager(abs) },
      gone && { label: 'Mostrar la carpeta en el explorador de archivos', action: () => openInFileManager(abs.slice(0, abs.lastIndexOf('/'))) },
      !gone && { label: `Abrir en ${extEditorName()}`, action: () => openExternal(abs) },
      '-',
      { label: 'Copiar ruta', action: () => codeCopy(abs) },
      { label: 'Copiar ruta relativa al repo', action: () => codeCopy(rel) },
      !gone && !isDir && { label: 'Enviar ruta a la IA', action: () => codeSendToAi(abs) },
      '-',
      area === 'staged'
        ? { label: 'Quitar del área de preparación', hint: 'restore --staged', action: () => gitUnstage([f.path]) }
        : { label: 'Agregar', hint: 'git add', action: () => gitAdd([f.path]) },
      area !== 'staged' && { label: area === 'untracked' ? 'Borrar (no tiene seguimiento)…' : 'Descartar cambios…', danger: true, action: () => gitDiscard(f) },
      area !== 'untracked' && !isDir && { label: 'Historial del archivo', hint: 'git log', action: () => runLog(['log', '--oneline', '-20', '--follow', '--', rel]) },
      area !== 'untracked' && !isDir && !gone && { label: 'Quién cambió cada línea', hint: 'git blame', action: () => runLog(['blame', '--date=short', '--', rel]) },
    ]);
  }
  function fileSection(title, files, area, bulk) {
    if (!files.length) return null;
    return h('div.git-sec',
      h('div.git-sec-head', h('span.grow', `${title} (${files.length})`), bulk),
      files.map((f) => fileRow(f, area)));
  }

  /**
   * Re-renderiza sin robar el foco: replaceChildren saca del DOM los inputs reutilizados
   * (mensaje del commit, nueva rama) y el navegador les quita el foco. Se restaura foco, cursor y scroll.
   */
  function keepFocus(container, fn) {
    const el = document.activeElement;
    const inside = el && el !== document.body && container.contains(el);
    const sel = inside && typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd, el.selectionDirection] : null;
    const scroll = container.scrollTop;
    fn();
    container.scrollTop = scroll;
    if (inside && el.isConnected && document.activeElement !== el) {
      el.focus({ preventScroll: true });
      if (sel) { try { el.setSelectionRange(...sel); } catch (_) { /* inputs sin selección */ } }
    }
  }

  /** Nombre del repo relativo a la carpeta del proyecto que lo contiene: "frap" o "frap/integrations/x". */
  function gitRepoLabel(r) {
    const p = project();
    const f = p && p.folders.map((x) => x.replace(/\/+$/, '')).filter((x) => r === x || r.startsWith(`${x}/`)).sort((a, b) => b.length - a.length)[0];
    return f ? (r === f ? basename(f) : `${basename(f)}/${r.slice(f.length + 1)}`) : basename(r);
  }

  // ----- publicar versión: npm run push-v -- major|minor|patch (o "deploy" si llama a bump-version) -----
  const gitReleaseCache = new Map(); // repo → {script, version, at} | {none, at}
  async function gitReleaseInfo(repo) {
    const c = gitReleaseCache.get(repo);
    if (c && Date.now() - c.at < 20000) return c;
    let info = { none: true, at: Date.now() };
    try {
      const pkg = JSON.parse((await Bridge.call('fs.read', { path: `${repo}/package.json` })).content);
      const sc = pkg.scripts || {};
      const script = sc['push-v'] ? 'push-v' : sc.deploy && /bump-version/.test(sc.deploy) ? 'deploy' : null;
      if (script) {
        let version = pkg.version || '';
        if (/index\.php/.test(sc.v || '') || /bump-version/.test(sc[script])) { // la versión vive en la cabecera de index.php
          try { const php = (await Bridge.call('fs.read', { path: `${repo}/index.php` })).content; const m = php.match(/^\s*\*?\s*Version:\s*([0-9][\w.-]*)/im); if (m) version = m[1]; } catch (_) { /* sin index.php */ }
        }
        info = { script, version, at: Date.now() };
      }
    } catch (_) { /* sin package.json */ }
    gitReleaseCache.set(repo, info);
    return info;
  }
  function renderGitRelease() {
    const p = gitPane;
    const repo = state.git.repo;
    if (!p || !p.relSlot) return;
    if (!repo) { p.relSlot.replaceChildren(); return; }
    gitReleaseInfo(repo).then((i) => {
      if (gitPane !== p || state.git.repo !== repo) return;
      p.relSlot.replaceChildren(i.none ? '' : h('button', { disabled: Git.releasing || null, title: `Publicar versión: npm run ${i.script} -- major|minor|patch${i.version ? ` (actual ${i.version})` : ''}`, onclick: () => gitReleaseModal(repo, i) }, `🚀 Versión${i.version ? ` ${i.version}` : ''}`));
    });
  }
  // la salida de «Publicar versión» llega en vivo (evento 'release') a la pestaña Salida de la vista Git
  const relRuns = new Map(); // rid → {entry, rt}
  const renderGitRightSoon = debounce(() => { if (gitPane && (state.git.tab || 'diff') === 'out') renderGitRight(); }, 80);
  Bridge.on('release', ({ rid, d }) => {
    const run = relRuns.get(rid);
    if (!run) return;
    run.entry.text += stripAnsi(String(d)); // (la existente también quita los \r de las barras de progreso)
    if (Git === run.rt) renderGitRightSoon();
  });
  async function gitRunRelease(repo, info, kind) {
    const rt = Git;
    if (rt.releasing) { toast('Ya hay una publicación en curso', 'err'); return; }
    const rid = uid();
    const entry = { cmd: `npm run ${info.script} -- ${kind}`, code: null, text: '', at: Date.now(), repo };
    rt.out.push(entry);
    if (rt.out.length > 100) rt.out.shift();
    relRuns.set(rid, { entry, rt });
    rt.releasing = true;
    state.git.tab = 'out';
    save();
    renderGit();
    try {
      const r = await Bridge.call('git.release', { cwd: repo, script: info.script, kind, rid });
      entry.code = r.code;
      entry.text = entry.text.trimEnd();
      toast(r.code === 0 ? `${gitRepoLabel(repo)}: versión publicada (${Math.round(r.ms / 1000)} s)` : `${gitRepoLabel(repo)}: ${entry.cmd} falló (código ${r.code}); mira la Salida`, r.code === 0 ? 'ok' : 'err');
    } catch (e) {
      entry.code = 1;
      entry.text += `${entry.text ? '\n' : ''}${e.message}`;
      toast(e.message, 'err');
    }
    relRuns.delete(rid);
    rt.releasing = false;
    gitReleaseCache.delete(repo);
    if (Git === rt) { renderGit(); gitRefresh(); }
  }
  function bumpVersion(v, kind) {
    const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return '';
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return kind === 'major' ? `${a + 1}.0.0` : kind === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
  }
  function gitReleaseModal(repo, info) {
    let kind = 'patch';
    const st = Git.status;
    const dirty = st && !st.error ? st.staged.length + st.unstaged.length + st.untracked.length : 0;
    const DESC = { patch: 'Correcciones (bugs), sin cambios de uso', minor: 'Funciones nuevas compatibles', major: 'Cambios que rompen compatibilidad' };
    const cards = h('div.rel-kinds');
    const cmd = h('code.rel-cmd');
    const paint = () => {
      cards.replaceChildren(...['patch', 'minor', 'major'].map((k) => h(`button.rel-kind${k === kind ? '.on' : ''}`, { onclick: () => { kind = k; paint(); } },
        h('b', k), h('span.rel-next', info.version ? `${info.version} → ${bumpVersion(info.version, k) || '?'}` : ''), h('span.muted', DESC[k]))));
      cmd.textContent = `npm run ${info.script} -- ${kind}`;
    };
    paint();
    const go = () => { modalClose(true); gitRunRelease(repo, info, kind); };
    openModal({
      title: `Publicar versión · ${gitRepoLabel(repo)}`,
      body: [
        h('p.muted', { style: 'margin:0 0 8px' }, info.version ? `Versión actual: ${info.version}. ` : '', 'Se ejecuta en ', h('span.mono', tilde(repo)), ' y su salida aparece en vivo en la pestaña «Salida» de Git (sube la versión, hace commit, tag y push según su script).'),
        cards,
        h('div.rel-cmdrow', h('span.muted', 'Comando:'), cmd),
        dirty ? h('p.rel-warn', `⚠ Hay ${dirty} archivo(s) con cambios sin commit: el script puede incluirlos o fallar. Revisa antes de publicar.`) : null,
      ],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: go }, '🚀 Publicar')],
    });
  }

  function renderGit() {
    if (!gitPane) return;
    keepFocus(gitPane.root, renderGitInner);
  }
  function renderGitInner() {
    const p = gitPane;
    const st = Git.status;
    p.repo.replaceChildren(...(Git.repos.length ? Git.repos.map((r) => h('option', { value: r, title: tilde(r) }, `📁 ${gitRepoLabel(r)}`)) : [h('option', { value: '' }, 'Sin repositorio')]));
    p.repo.value = state.git.repo || '';
    p.repo.title = state.git.repo ? tilde(state.git.repo) : '';
    renderGitRelease();
    if (!st || st.error || !state.git.repo) {
      p.branch.replaceChildren();
      const proj = project();
      p.left.replaceChildren(h('div.git-empty',
        st && st.error ? h('p', { style: 'color:var(--err)' }, st.error) : h('p.muted', proj ? 'Las carpetas de este proyecto no son un repositorio git.' : 'Selecciona un proyecto.'),
        proj && !state.git.repo ? h('button.primary', { onclick: gitInit, title: `git init en ${proj.folders[0]}` }, `git init en ${basename(proj.folders[0])}`) : null));
      renderGitRight();
      return;
    }
    const sync = [];
    if (st.ahead) sync.push(h('span.git-ahead', { title: `${st.ahead} commit(s) por subir` }, `↑${st.ahead}`));
    if (st.behind) sync.push(h('span.git-behind', { title: `${st.behind} commit(s) por bajar` }, `↓${st.behind}`));
    p.branch.replaceChildren(
      h('span.git-branch-name', { title: st.upstream ? `sigue a ${st.upstream}` : 'sin upstream (el primer push lo publica)' }, `⎇ ${st.branch}`),
      st.upstream ? h('span.muted', `→ ${st.upstream}`) : h('span.badge', 'sin upstream'),
      ...sync);
    const total = st.staged.length + st.unstaged.length + st.untracked.length;
    const unstagedPaths = [...new Set(st.unstaged.map((f) => f.path))];
    p.left.replaceChildren(...[
      h('div.git-commit',
        p.msg,
        h('div.field-row',
          h('button.primary.grow', { onclick: () => gitCommit(false), title: 'git commit -m "<mensaje>"' }, `✓ Commit${st.staged.length ? ` (${st.staged.length})` : ''}`),
          h('button', { onclick: () => gitCommit(true), title: 'git commit -m "<mensaje>" && git push' }, 'Commit y push'))),
      total ? null : h('p.muted.git-clean', '✓ Sin cambios: el árbol de trabajo está limpio.'),
      fileSection('Preparados', st.staged, 'staged',
        h('button.mini', { title: 'git restore --staged -- <todos>', onclick: () => gitUnstage(st.staged.map((f) => f.path)) }, '− todos')),
      fileSection('Cambios', st.unstaged, 'unstaged',
        h('button.mini', { title: 'git add -- <todos los modificados>', onclick: () => gitAdd(unstagedPaths) }, '+ todos')),
      fileSection('Sin seguimiento', st.untracked, 'untracked',
        h('button.mini', { title: 'git add -- <todos los nuevos>', onclick: () => gitAdd(st.untracked.map((f) => f.path)) }, '+ todos')),
      total > 1 ? h('div.git-addall', h('button.mini', { title: 'git add -A', onclick: gitAddAll }, '+ Agregar todo (git add -A)')) : null,
      h('div.git-sec',
        h('div.git-sec-head', h('span.grow', 'Ramas')),
        h('div.field-row.git-newbranch', p.newBranch, h('button.mini', { onclick: gitNewBranch, title: 'git checkout -b <nueva-rama>' }, 'checkout -b')),
        // la rama principal primero (con su color), la actual segunda y el resto en su orden
        [...Git.branches].sort((a, b) => {
          const rank = (x) => (x.name === Git.defaultBranch ? 0 : x.current ? 1 : 2);
          return rank(a) - rank(b);
        }).map((b) => h(`div.git-branch-row${b.current ? '.current' : ''}${b.name === Git.defaultBranch ? '.main' : ''}`, {
          title: `${b.current ? 'Rama actual' : `Clic: git checkout ${b.name}`}${b.upstream ? `\nSigue a ${b.upstream}` : ''}\nClic derecho: más opciones`,
          onclick: () => { if (!b.current) gitCheckout(b.name, false); },
          oncontextmenu: (e) => gitBranchMenu(e, b, false),
        },
        h('span', b.current ? '●' : '○'),
        h('span.grow.mono', b.name),
        b.track ? h('span.muted.mono', b.track) : null,
        b.current ? null : h('button.icon.mini', { title: `git branch -d ${b.name}`, onclick: (e) => { e.stopPropagation(); gitDeleteBranch(b); } }, '✕'))),
        (Git.remoteBranches || []).filter((r) => !Git.branches.some((b) => b.name === r.split('/').slice(1).join('/'))).length
          ? h('details.git-remotes',
            h('summary.muted', 'Ramas remotas'),
            Git.remoteBranches
              .filter((r) => !Git.branches.some((b) => b.name === r.split('/').slice(1).join('/')))
              .map((r) => h('div.git-branch-row', { title: `Clic: git checkout --track ${r}\nClic derecho: más opciones`, onclick: () => gitCheckout(r, true), oncontextmenu: (e) => gitBranchMenu(e, r, true) }, h('span', '☁'), h('span.grow.mono', r))))
          : null),
    ].filter(Boolean));
    renderGitRight();
  }

  /** Texto con sus URL http(s) como enlaces que se abren en otra pestaña (p. ej. el "pull/new/rama" que da git push). */
  function linkifyText(text) {
    const out = [];
    const re = /https?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const url = m[0];
      out.push(h('a.out-link', { href: url, title: `Abrir ${url}`, onclick: (e) => { e.preventDefault(); openPageTab({ url }); } }, url));
      last = m.index + url.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }
  function renderGitRight() {
    if (!gitPane) return;
    const p = gitPane;
    const tab = state.git.tab || 'diff';
    const tb = (id, label) => h(`button${tab === id ? '.active' : ''}`, { onclick: () => { state.git.tab = id; save(); renderGitRight(); } }, label);
    p.rtabs.replaceChildren(tb('diff', 'Diff'), tb('log', `Historial${Git.log.length ? ` (${Git.log.length})` : ''}`), tb('out', `Salida${Git.out.length ? ` (${Git.out.length})` : ''}`));
    let body;
    if (tab === 'diff') {
      body = Git.diff
        ? [h('div.git-diff-head', h('span.grow', Git.diff.title), h('span.mono.muted', `$ ${Git.diff.cmd}`)), diffView(Git.diff.text)]
        : [h('p.muted.git-hint', 'Haz clic en un archivo de la izquierda para ver sus cambios, o en un commit del historial.')];
    } else if (tab === 'log') {
      body = Git.log.length
        ? [h('div.git-log', Git.log.map((c) => h('div.git-commit-row', { title: 'Ver el commit (git show)', onclick: () => gitShowCommit(c) },
          h('span.mono.git-hash', c.hash),
          h('span.git-subject', c.subject, c.refs ? h('span.git-refs', c.refs) : null),
          h('span.muted.git-when', `${c.author} · ${c.when}`))))]
        : [h('p.muted.git-hint', 'Aún no hay commits.')];
    } else {
      body = Git.out.length
        ? [h('div.git-out', [...Git.out].reverse().map((o) => h('div.git-out-item',
          h('div.mono', o.code == null ? h('span.git-run', '⏳') : h(`span.${o.code === 0 ? 'ok' : 'err'}`, o.code === 0 ? '✓' : '✗'), ` $ ${o.cmd}`, o.code == null ? h('span.muted', '  ejecutando…') : null),
          o.text ? h('pre', linkifyText(o.text)) : null)))]
        : [h('p.muted.git-hint', 'Aquí aparece cada comando git que ejecutes desde esta vista, con su salida. Así ves exactamente qué hace cada botón.')];
    }
    p.right.replaceChildren(...body);
  }

  // ---------- voz: dictar a claude / codex / opencode (panel derecho, sobre el reproductor) ----------
  // Graba con el micrófono, arma un WAV 16 kHz mono en el navegador (sin ffmpeg) y el bridge lo transcribe
  // con whisper.cpp local. El texto se pega en la terminal de IA activa, sin Enter, para revisarlo antes de enviar.
  const VOICE_KINDS = ['claude', 'codex', 'opencode'];
  const VOICE_MAX_MS = 5 * 60 * 1000;
  const VOICE_LANGS = { es: 'Español', en: 'English', auto: 'Auto' };
  const voice = { rec: null, stream: null, ctx: null, analyser: null, chunks: [], started: 0, timer: null, busy: false, status: null, last: '', cancel: false };
  const voiceTarget = () => { const t = activeTerm(); return t && t.info.alive !== false && VOICE_KINDS.includes(termKind(t)) ? t : null; };
  const VOICE_INCOMPATIBLE = 'Ventana no compatible con el sistema de voz: abre una terminal de claude, codex u opencode.';

  async function voiceStatus(force) {
    if (voice.status && voice.status.ready && !force) return voice.status;
    voice.status = await Bridge.call('voice.status');
    return voice.status;
  }
  function voiceInstallHelp(st) {
    openModal({
      title: 'Instalar el motor de voz (whisper.cpp)',
      body: [
        h('p', { style: 'margin-top:0' }, 'La voz se transcribe en tu equipo con whisper.cpp: privado y sin internet. Falta instalarlo (compila en 1-2 minutos y baja un modelo de ~142 MB). Corre en una terminal:'),
        h('pre.mono', { style: 'white-space:pre-wrap;user-select:all;background:var(--bg);padding:8px;border-radius:4px' }, st.install),
        h('p.muted', `Queda en ${tilde(st.dir)}. Después vuelve a pulsar 🎤.`),
      ],
      foot: [
        h('span.grow'),
        h('button', { onclick: () => { copyText(st.install); toast('Comando copiado', 'ok'); } }, 'Copiar comando'),
        h('button.primary', { onclick: () => modalClose(true) }, 'Entendido'),
      ],
    });
  }

  async function voiceToggle() {
    if (voice.rec) { voiceStop(false); return; }
    if (voice.busy) return;
    if (!voiceTarget()) { toast(VOICE_INCOMPATIBLE, 'err'); return; }
    if (!Bridge.ready) { toast('Bridge desconectado', 'err'); return; }
    let st;
    try { st = await voiceStatus(); } catch (e) { toast(e.message, 'err'); return; }
    if (!st.ready) { voiceInstallHelp(st); renderVoice(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      toast('Este navegador no permite usar el micrófono aquí', 'err');
      return;
    }
    try {
      voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      toast(e.name === 'NotAllowedError' ? 'Permiso de micrófono denegado: actívalo en el navegador para esta página' : `No se pudo usar el micrófono: ${e.message}`, 'err');
      return;
    }
    voice.chunks = [];
    voice.cancel = false;
    voice.rec = new MediaRecorder(voice.stream);
    voice.rec.ondataavailable = (e) => { if (e.data && e.data.size) voice.chunks.push(e.data); };
    voice.rec.onstop = () => voiceProcess();
    // medidor de nivel
    try {
      voice.ctx = new (window.AudioContext || window.webkitAudioContext)();
      voice.analyser = voice.ctx.createAnalyser();
      voice.analyser.fftSize = 512;
      voice.ctx.createMediaStreamSource(voice.stream).connect(voice.analyser);
    } catch (_) { voice.analyser = null; }
    voice.started = Date.now();
    voice.rec.start(250);
    voice.timer = setInterval(voiceTick, 100);
    document.addEventListener('keydown', voiceEsc, true);
    renderVoice();
  }
  function voiceEsc(e) {
    if (e.key === 'Escape' && voice.rec) { e.preventDefault(); e.stopPropagation(); voiceStop(true); }
  }
  function voiceTick() {
    const ms = Date.now() - voice.started;
    if (ms >= VOICE_MAX_MS) { voiceStop(false); return; }
    const btn = $('#voice-dock .voice-btn');
    if (btn) btn.lastChild.textContent = ` Detener · ${fmtClock(ms)}`;
    const bar = $('#voice-dock .voice-level > span');
    if (bar && voice.analyser) {
      const data = new Uint8Array(voice.analyser.fftSize);
      voice.analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      bar.style.width = `${Math.min(100, Math.round((peak / 128) * 160))}%`;
    }
  }
  const fmtClock = (ms) => { const sec = Math.floor(ms / 1000); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
  /** cancel = descartar lo grabado (Esc). */
  function voiceStop(cancel) {
    if (!voice.rec) return;
    voice.cancel = cancel;
    clearInterval(voice.timer);
    document.removeEventListener('keydown', voiceEsc, true);
    try { voice.rec.stop(); } catch (_) { /* ya parado */ }
    for (const tr of voice.stream.getTracks()) tr.stop();
    if (voice.ctx) voice.ctx.close().catch(() => {});
    voice.ctx = null;
    voice.analyser = null;
    if (cancel) toast('Grabación descartada');
  }
  async function voiceProcess() {
    const chunks = voice.chunks;
    const ms = Date.now() - voice.started;
    voice.rec = null;
    voice.stream = null;
    if (voice.cancel || !chunks.length) { renderVoice(); return; }
    if (ms < 400) { toast('Muy corto: mantén la grabación un poco más'); renderVoice(); return; }
    voice.busy = true;
    renderVoice();
    try {
      const wav = await toWav16k(new Blob(chunks, { type: chunks[0].type }));
      const r = await Bridge.call('voice.transcribe', { audio: bytesToBase64(wav), lang: state.voice.lang || 'es' });
      if (!r.text) { toast('No se entendió nada: habla más cerca del micrófono'); return; }
      voice.last = r.text;
      const t = voiceTarget(); // la ventana donde estás al terminar
      if (t) {
        sendToTerminal(r.text, false);
        toast(`Pegado en ${termTitle(t)} (${(r.ms / 1000).toFixed(1)} s)`, 'ok');
      } else {
        toast(`${VOICE_INCOMPATIBLE} El texto quedó en el módulo de voz.`, 'err');
      }
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      voice.busy = false;
      renderVoice();
    }
  }
  /** Audio grabado (webm/opus…) → WAV PCM 16 bits, 16 kHz, mono (lo que espera whisper.cpp). */
  async function toWav16k(blob) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let decoded;
    try { decoded = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close().catch(() => {}); }
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const str = (o, txt) => { for (let i = 0; i < txt.length; i++) out.setUint8(o + i, txt.charCodeAt(i)); };
    str(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) {
      const v = Math.max(-1, Math.min(1, pcm[i]));
      out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Uint8Array(out.buffer);
  }
  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function renderVoice() {
    const dock = $('#voice-dock');
    if (!dock) return;
    const t = voiceTarget();
    const rec = !!voice.rec;
    const st = voice.status;
    const btn = h('button.voice-btn', {
      class: `voice-btn${rec ? ' rec' : ''}${!t && !rec ? ' incompatible' : ''}`,
      disabled: voice.busy,
      title: rec ? 'Detener y transcribir (Alt+Shift+V) · Esc: descartar'
        : t ? `Hablar: el texto se pega en "${termTitle(t)}" (Alt+Shift+V)` : VOICE_INCOMPATIBLE,
      onclick: voiceToggle,
    }, h('span.voice-ico', rec ? '■' : '🎤'), document.createTextNode(rec ? ` Detener · ${fmtClock(Date.now() - voice.started)}` : voice.busy ? ' Transcribiendo…' : ' Hablar'));
    const lang = h('select.voice-lang', { title: 'Idioma de la transcripción', disabled: rec || voice.busy },
      Object.entries(VOICE_LANGS).map(([v, label]) => h('option', { value: v }, label)));
    lang.value = state.voice.lang || 'es';
    lang.addEventListener('change', () => { state.voice.lang = lang.value; save(); });
    dock.replaceChildren(...[
      h('div.voice-row',
        btn,
        h('span.voice-target.grow', { class: `voice-target grow${t ? '' : ' muted'}`, title: t ? (t.info.meta || {}).cwd || '' : VOICE_INCOMPATIBLE },
          rec ? h('span.voice-level', h('span')) : t ? `→ ${termTitle(t)}` : 'no compatible'),
        lang),
      st && !st.ready ? h('div.voice-warn', 'Motor de voz sin instalar · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); voiceInstallHelp(st); } }, 'cómo instalar')) : null,
      voice.last && !rec ? h('div.voice-last',
        h('span.grow', { title: voice.last }, `“${voice.last}”`),
        h('button.icon.mini', { title: 'Copiar', onclick: () => { copyText(voice.last); toast('Copiado', 'ok'); } }, '⧉'),
        t ? h('button.icon.mini', { title: `Pegar otra vez en "${termTitle(t)}"`, onclick: () => sendToTerminal(voice.last, false) }, '⤶') : null,
        h('button.icon.mini', { title: 'Quitar', onclick: () => { voice.last = ''; renderVoice(); } }, '✕')) : null,
    ].filter(Boolean)); // replaceChildren(null) insertaría el texto "null"
  }

  // ---------- editor de código: vista por proyecto (CodeMirror 5 en src/vendor/codemirror) ----------
  // Árbol de las carpetas del proyecto + hasta 4 grupos (paneles) con pestañas. Un mismo archivo abierto en
  // varios grupos comparte el documento (linkedDoc). Los archivos se leen/escriben con fs.read / fs.write y se
  // vigilan con fs.stat: si una IA cambia un archivo abierto sin cambios locales, se recarga solo.
  // state.code (= views[i].data): {groups: [{tabs: [ruta], active}], focus, expanded: [dirs], side: 'tree'|'search'|null,
  //   hidden, wrap, cursors: {ruta: [línea, col]}}
  let codePane = null; // panel de la vista Código enlazada
  const CODE_MAX_GROUPS = 4;
  // ---------- vista previa de archivos (editor de código y notas) ----------
  // Con botón (alternan con el editor): Markdown, CSV/TSV, SVG y HTML. Automática (no se editan): imágenes, video, audio y PDF.
  // Todo se arma con h() (nada de innerHTML). El HTML va en un iframe con sandbox sin allow-same-origin: no puede tocar FRAP.
  const PREVIEW_RE = /\.(md|markdown|mdx|csv|tsv|svg|html?)$/i;
  const canPreview = (file) => PREVIEW_RE.test(file || '');
  const MEDIA = [
    ['image', /\.(png|jpe?g|gif|webp|ico|bmp|avif)$/i],
    ['video', /\.(mp4|webm|ogv|mov|m4v|mkv)$/i],
    ['audio', /\.(mp3|wav|ogg|oga|m4a|flac|aac|opus)$/i],
    ['pdf', /\.pdf$/i],
  ];
  const mediaKind = (file) => { const m = MEDIA.find(([, re]) => re.test(file || '')); return m ? m[0] : null; };
  const fileUrl = (p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`;
  const dirOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
  /** Ruta relativa de un enlace del archivo → absoluta (sin ?query ni #ancla). */
  function resolveRel(dir, rel) {
    let r = rel.replace(/[?#].*$/, '');
    try { r = decodeURI(r); } catch (_) { /* tal cual */ }
    const parts = (r.startsWith('/') ? r : `${dir}/${r}`).split('/');
    const out = [];
    for (const s of parts) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); }
    return `/${out.join('/')}`;
  }
  const isExternal = (u) => /^(https?:|mailto:)/i.test(u);

  /** Visor de imagen / video / audio / PDF (se carga directo del disco como file://). */
  function renderMedia(file, kind) {
    const src = fileUrl(file);
    const fail = (el) => { el.onerror = () => el.replaceWith(h('p.muted', 'No se pudo cargar el archivo (FRAP debe abrirse como file:// para ver archivos locales).')); return el; };
    if (kind === 'image') return h('div.fp-media.fp-image', fail(h('img', { src, alt: basename(file) })));
    if (kind === 'video') return h('div.fp-media', fail(h('video', { src, controls: true, preload: 'metadata' })));
    if (kind === 'audio') return h('div.fp-media.fp-audio', h('div.fp-audio-name', `🎵 ${basename(file)}`), fail(h('audio', { src, controls: true, preload: 'metadata' })));
    return h('div.fp-media.fp-pdf', h('iframe', { src, title: basename(file) }));
  }

  /** Vista previa de un archivo de texto (md, csv, svg, html) con su contenido actual (aunque no esté guardado). */
  /**
   * opts.edit(text => nuevoTexto): si viene, la vista previa se puede editar (celdas del CSV, casillas [ ] del Markdown);
   * recibe una función que transforma el texto actual del archivo y la aplica (al documento del editor o a las notas).
   */
  function renderPreview(file, text, opts = {}) {
    const ext = (file.match(/\.(\w+)$/) || [])[1].toLowerCase();
    const dir = dirOf(file);
    if (ext === 'csv' || ext === 'tsv') return renderCsv(text, ext === 'tsv' ? '\t' : null, opts.edit);
    if (ext === 'svg') {
      const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' })); // en <img> el SVG no ejecuta scripts
      const img = h('img', { src: url, alt: basename(file) });
      img.onload = () => URL.revokeObjectURL(url);
      img.onerror = () => { URL.revokeObjectURL(url); img.replaceWith(h('p.muted', 'SVG inválido.')); };
      return h('div.fp-media.fp-image', img);
    }
    if (ext === 'html' || ext === 'htm') {
      // sandbox SIN allow-same-origin: origen opaco, así la página no puede leer el localStorage de file:// (donde vive el
      // token del bridge). Como ese origen no puede cargar file://, sus css/js/imágenes relativos se incrustan (htmlInline).
      const frame = h('iframe.fp-html', { sandbox: 'allow-scripts allow-forms allow-popups allow-modals', title: basename(file) });
      htmlInline(text, dir).then((doc) => { frame.srcdoc = doc; }).catch(() => { frame.srcdoc = text; });
      return h('div.fp-htmlwrap', frame);
    }
    return h('div.md-body', mdBlocks(text, dir, { edit: opts.edit }));
  }

  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav' };
  /** HTML con sus recursos relativos incrustados: <link stylesheet> → <style>, <script src> → inline, imágenes → data:. */
  async function htmlInline(text, dir) {
    const doc = new DOMParser().parseFromString(text, 'text/html'); // documento inerte: aquí no se ejecuta nada
    const local = (u) => u && !/^([a-z][\w+.-]*:|\/\/|#)/i.test(u.trim());
    const read = async (rel, b64) => {
      const r = await Bridge.call('fs.read', { path: resolveRel(dir, rel.trim()), ...(b64 ? { encoding: 'base64' } : {}) });
      if (b64 && r.encoding !== 'base64') throw new Error('bridge viejo');
      return r.content;
    };
    const dataUrl = async (rel) => {
      const ext = (rel.replace(/[?#].*$/, '').match(/\.(\w+)$/) || [])[1];
      return `data:${MIME[(ext || '').toLowerCase()] || 'application/octet-stream'};base64,${await read(rel, true)}`;
    };
    // url(...) relativas dentro del CSS (fondos, fuentes): relativas a la carpeta del .css
    const cssUrls = async (css, cssDir) => {
      const urls = [...new Set([...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((m) => m[2]).filter(local))].slice(0, 30);
      for (const u of urls) {
        try {
          const abs = resolveRel(cssDir, u);
          const d = await dataUrl(abs);
          css = css.split(u).join(d);
        } catch (_) { /* se deja como está */ }
      }
      return css;
    };
    const jobs = [];
    let n = 0;
    for (const l of doc.querySelectorAll('link[href]')) {
      const href = l.getAttribute('href');
      if (!local(href) || ++n > 60) continue;
      if (/\bstylesheet\b/i.test(l.rel)) {
        jobs.push(read(href).then(async (css) => {
          const st = doc.createElement('style');
          st.textContent = await cssUrls(css, dirOf(resolveRel(dir, href)));
          l.replaceWith(st);
        }).catch(() => {}));
      } else if (/\bicon\b/i.test(l.rel)) jobs.push(dataUrl(href).then((d) => l.setAttribute('href', d)).catch(() => {}));
    }
    for (const sc of doc.querySelectorAll('script[src]')) {
      const src = sc.getAttribute('src');
      if (!local(src) || ++n > 60) continue;
      jobs.push(read(src).then((js) => { sc.removeAttribute('src'); sc.textContent = js; }).catch(() => {}));
    }
    for (const [sel, attr] of [['img[src]', 'src'], ['source[src]', 'src'], ['video[poster]', 'poster'], ['input[type=image][src]', 'src'], ['image[href]', 'href']]) {
      for (const el of doc.querySelectorAll(sel)) {
        const v = el.getAttribute(attr);
        if (!local(v) || ++n > 60) continue;
        jobs.push(dataUrl(v).then((d) => el.setAttribute(attr, d)).catch(() => {}));
      }
    }
    for (const st of doc.querySelectorAll('style')) jobs.push(cssUrls(st.textContent, dir).then((css) => { st.textContent = css; }).catch(() => {}));
    await Promise.all(jobs);
    return `<!doctype html>\n${doc.documentElement.outerHTML}`;
  }

  // ----- CSV -----
  /**
   * rows: valores; spans[r][c] = {s, e, q}: posición del campo crudo en el texto (q = venía entre comillas);
   * ends[r] = posición donde empieza la fila siguiente (después del salto de línea).
   */
  function parseCsv(text, delim, max) {
    const rows = [];
    const spans = [];
    const ends = [];
    let row = [];
    let sp = [];
    let field = '';
    let q = false;
    let quoted = false;
    let start = 0;
    const endField = (i) => { row.push(field); sp.push({ s: start, e: i, q: quoted }); field = ''; quoted = false; start = i + 1; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
      } else if (c === '"' && field === '' && i === start) { q = true; quoted = true; }
      else if (c === delim) endField(i);
      else if (c === '\n' || c === '\r') {
        endField(i);
        if (c === '\r' && text[i + 1] === '\n') i++;
        start = i + 1;
        rows.push(row); spans.push(sp); ends.push(i + 1); row = []; sp = [];
        if (rows.length >= max) return { rows, spans, ends, more: i < text.length - 1 };
      } else field += c;
    }
    if (field || row.length || quoted) { endField(text.length); rows.push(row); spans.push(sp); ends.push(text.length); }
    return { rows, spans, ends, more: false };
  }
  function csvDelim(text) {
    const first = text.slice(0, text.indexOf('\n') >>> 0 || text.length);
    const counts = [',', ';', '\t', '|'].map((d) => [d, first.split(d).length]);
    return counts.sort((a, b) => b[1] - a[1])[0][0];
  }
  /** Valor → campo crudo: entre comillas si lo necesita (o si ya las tenía). */
  const csvField = (v, delim, wasQuoted) => (wasQuoted || v.includes(delim) || /["\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  /** edit(fn): si viene, las celdas se editan (solo cambia el campo tocado; el resto del archivo queda igual). */
  function renderCsv(text, delim, edit) {
    delim = delim || csvDelim(text);
    const MAX = 3000;
    const { rows, more } = parseCsv(text, delim, MAX + 1);
    if (!rows.length && !edit) return h('div.fp-csv', h('p.muted', 'Archivo vacío.'));
    const [head = [], ...body] = rows;
    const cols = Math.max(1, ...rows.map((r) => r.length));
    const pad = (r) => Array.from({ length: cols }, (_, i) => r[i] ?? '');
    const num = (v) => /^-?[\d.,]+%?$/.test(v.trim()) && v.trim() !== '';
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    // reemplaza el campo [r][c] sobre el texto ACTUAL (se vuelve a parsear: lo de antes pudo cambiar)
    const setCell = (r, c, v) => edit((cur) => {
      const P = parseCsv(cur, delim, r + 2);
      if (r >= P.rows.length) { // fila que no existía: se agrega al final
        const fields = Array.from({ length: cols }, (_, k) => (k === c ? csvField(v, delim) : ''));
        return `${cur}${cur && !/\r?\n$/.test(cur) ? eol : ''}${fields.join(delim)}${eol}`;
      }
      const sp = P.spans[r];
      if (c < sp.length) return cur.slice(0, sp[c].s) + csvField(v, delim, sp[c].q) + cur.slice(sp[c].e);
      const last = sp[sp.length - 1]; // columna que la fila no tenía: se rellena hasta ella
      return cur.slice(0, last.e) + delim.repeat(c - sp.length + 1) + csvField(v, delim) + cur.slice(last.e);
    });
    const rowOp = (r, op) => edit((cur) => {
      const P = parseCsv(cur, delim, r + 2);
      if (r >= P.rows.length) return cur;
      const s0 = r ? P.ends[r - 1] : 0;
      const e0 = P.ends[r];
      if (op === 'delete') return cur.slice(0, s0) + cur.slice(e0);
      const blank = `${delim.repeat(cols - 1)}`;
      const lineEnd = /\r?\n$/.test(cur.slice(s0, e0)) ? '' : eol;
      return op === 'above' ? cur.slice(0, s0) + blank + eol + cur.slice(s0) : cur.slice(0, e0) + lineEnd + blank + eol + cur.slice(e0);
    });
    const cell = (tag, v, r, c) => {
      if (!edit) return h(num(v) && tag === 'td' ? 'td.num' : tag, v);
      const el = h(`${tag}${num(v) && tag === 'td' ? '.num' : ''}.fp-edit`, { contenteditable: 'plaintext-only', spellcheck: 'false', dataset: { r: String(r), c: String(c) } }, v);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
        else if (e.key === 'Escape') { el.textContent = v; el.blur(); }
      });
      el.addEventListener('blur', () => {
        const nv = el.textContent.replace(/\r/g, '');
        if (nv !== v) { v = nv; setCell(r, c, nv); }
      });
      return el;
    };
    const rnMenu = (e, r) => popMenu(e, [
      { label: 'Insertar fila arriba', action: () => rowOp(r, 'above') },
      { label: 'Insertar fila debajo', action: () => rowOp(r, 'below') },
      '-',
      { label: 'Eliminar fila', danger: true, action: () => rowOp(r, 'delete') },
    ]);
    return h(`div.fp-csv${edit ? '.editable' : ''}`,
      h('div.fp-csv-info.muted', `${body.length}${more ? '+' : ''} fila${body.length === 1 ? '' : 's'} · ${cols} columna${cols === 1 ? '' : 's'} · separador "${delim === '\t' ? 'tab' : delim}"${more ? ` · se muestran las primeras ${MAX}` : ''}${edit ? ' · clic en una celda para editarla (Enter confirma, Esc deshace) · Ctrl+S guarda' : ''}`),
      h('table.fp-table',
        h('thead', h('tr', h('th.fp-rn', '#'), pad(head).map((c, k) => cell('th', c, 0, k)))),
        h('tbody', body.slice(0, MAX).map((r, i) => h('tr',
          h('td.fp-rn', edit ? { title: 'Clic: insertar o eliminar fila', onclick: (e) => rnMenu(e, i + 1) } : null, String(i + 1)),
          pad(r).map((c, k) => cell('td', c, i + 1, k)))))),
      edit && !more ? h('button.mini.fp-addrow', { onclick: () => rowOp(rows.length - 1, 'below'), title: 'Agregar una fila vacía al final' }, '+ fila') : null);
  }

  // ----- Markdown (subconjunto de GFM: títulos, listas y tareas, citas, código, tablas, enlaces, imágenes) -----
  const MD_BLOCK_START = /^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s+|\s*([-*_])(\s*\3){2,}\s*$)/;
  const mdSlug = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
  const MD_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  /** ctx.edit: casillas [ ] clicables (cambian esa línea del archivo); base: línea del archivo donde empieza src. */
  function mdBlocks(src, dir, ctx = {}, base = 0) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    const blank = (l) => !l.trim();
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if (blank(l)) { i++; continue; }
      if ((m = l.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/))) {
        const fence = m[1];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        i++;
        out.push(h('pre.md-code', m[2] ? { title: m[2] } : null, h('code', body.join('\n'))));
        continue;
      }
      if ((m = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) { out.push(h(`h${m[1].length}`, { id: mdSlug(m[2]) }, mdInline(m[2], dir))); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push(h('hr')); i++; continue; }
      if (/^\s*>/.test(l)) {
        const body = [];
        const at = i;
        while (i < lines.length && !blank(lines[i]) && (/^\s*>/.test(lines[i]) || !MD_BLOCK_START.test(lines[i]))) body.push(lines[i++].replace(/^\s*> ?/, ''));
        out.push(h('blockquote', mdBlocks(body.join('\n'), dir, ctx, base + at)));
        continue;
      }
      if (l.includes('|') && i + 1 < lines.length && MD_TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const cells = (r) => r.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
        const head = cells(l);
        const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : null));
        i += 2;
        const rows = [];
        while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(cells(lines[i++]));
        const st = (k) => (align[k] ? { style: `text-align:${align[k]}` } : null);
        out.push(h('div.md-tablewrap', h('table',
          h('thead', h('tr', head.map((c, k) => h('th', st(k), mdInline(c, dir))))),
          h('tbody', rows.map((r) => h('tr', head.map((_, k) => h('td', st(k), mdInline(r[k] || '', dir)))))))));
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) { const [el, ni] = mdList(lines, i, dir, ctx, base); out.push(el); i = ni; continue; }
      const body = [];
      while (i < lines.length && !blank(lines[i]) && (!body.length || !MD_BLOCK_START.test(lines[i]))) body.push(lines[i++]);
      out.push(h('p', mdInline(body.join('\n'), dir)));
    }
    return out;
  }
  function mdList(lines, i, dir, ctx = {}, base = 0) {
    const indent = lines[i].match(/^\s*/)[0].length;
    const ordered = /^\s*\d+[.)]/.test(lines[i]);
    const start = ordered ? parseInt(lines[i].trim(), 10) : 1;
    const items = [];
    while (i < lines.length) {
      const l = lines[i];
      const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      const ind = l.match(/^\s*/)[0].length;
      if (m && ind === indent) { items.push({ text: [m[3]], sub: [], line: base + i }); i++; continue; }
      if (m && ind > indent && items.length) { const [el, ni] = mdList(lines, i, dir, ctx, base); items[items.length - 1].sub.push(el); i = ni; continue; }
      if (!m && l.trim() && items.length && (ind > indent || !MD_BLOCK_START.test(l))) {
        if (ind > indent && /^\s*(```|~~~)/.test(l)) { // bloque de código dentro del ítem
          const block = [];
          const fence = l.trim().match(/^(```+|~~~+)/)[1];
          block.push(l.slice(Math.min(ind, indent + 2)));
          i++;
          while (i < lines.length && !lines[i].trim().startsWith(fence)) block.push(lines[i++].slice(Math.min(ind, indent + 2)));
          if (i < lines.length) block.push(lines[i++].trim());
          items[items.length - 1].sub.push(...mdBlocks(block.join('\n'), dir));
          continue;
        }
        items[items.length - 1].text.push(l.trim());
        i++;
        continue;
      }
      // línea en blanco dentro de la lista: sigue si lo próximo es otro ítem o está indentado
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nx = lines[j];
        if (nx != null && (nx.match(/^\s*/)[0].length > indent || (nx.match(/^\s*/)[0].length === indent && /^\s*([-*+]|\d+[.)])\s+/.test(nx) && /^\s*\d+[.)]/.test(nx) === ordered))) { i = j; continue; }
      }
      break;
    }
    const lis = items.map((it) => {
      const t = it.text.join('\n');
      const task = t.match(/^\[([ xX])\]\s+([\s\S]*)$/);
      if (task) {
        const box = h('input', { type: 'checkbox', disabled: !ctx.edit, checked: task[1] !== ' ', title: ctx.edit ? 'Marcar / desmarcar (cambia el archivo)' : null });
        if (ctx.edit) box.addEventListener('change', () => mdToggleTask(ctx.edit, it.line, box.checked));
        return h(`li.md-task${task[1] !== ' ' ? '.done' : ''}`, box, ' ', mdInline(task[2], dir), it.sub);
      }
      return h('li', mdInline(t, dir), it.sub);
    });
    return [h(ordered ? 'ol' : 'ul', ordered && start !== 1 ? { start: String(start) } : null, lis), i];
  }
  /** Cambia "[ ]" ⇄ "[x]" en la línea `line` del archivo (la del ítem de la lista). */
  function mdToggleTask(edit, line, checked) {
    edit((cur) => {
      const ls = cur.split('\n');
      if (line >= ls.length) return cur;
      const nl = ls[line].replace(/^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[[ xX]\]/, `$1[${checked ? 'x' : ' '}]`);
      if (nl === ls[line]) return cur;
      ls[line] = nl;
      return ls.join('\n');
    });
  }
  const MD_INLINE = new RegExp([
    /\\([\\`*_{}[\]()#+\-.!|~>])/.source, // 1 escape
    /(`+)([\s\S]*?[^`])\2(?!`)/.source, // 2-3 código
    /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.source, // 4-5 imagen
    /\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/.source, // 6-7 enlace
    /<((?:https?:\/\/|mailto:)[^>\s]+)>/.source, // 8 autoenlace
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 9 negrita
    /(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/.source, // 10 negrita
    /\*(?=[^\s*])([\s\S]*?[^\s*])\*/.source, // 11 cursiva
    /(?<!\w)_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/.source, // 12 cursiva
    /~~(?=\S)([\s\S]*?\S)~~/.source, // 13 tachado
    /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/.source, // 14 URL suelta
    /( {2,}|\\)\n/.source, // 15 salto de línea
  ].join('|'), 'g');
  function mdLink(href, kids, dir) {
    if (href.startsWith('#')) {
      return h('a', { href, onclick: (e) => { e.preventDefault(); const t = e.currentTarget.closest('.md-body'); const el = t && t.querySelector(`[id="${CSS.escape(href.slice(1))}"]`); if (el) el.scrollIntoView({ block: 'start' }); } }, kids);
    }
    if (isExternal(href)) return h('a', { href, target: '_blank', rel: 'noopener noreferrer', title: href }, kids);
    if (/^[a-z][\w+.-]*:/i.test(href)) return h('span', kids); // javascript:, data:… no se enlazan
    const abs = resolveRel(dir, href);
    const line = (href.match(/#L(\d+)/) || [])[1];
    return h('a', { href: fileUrl(abs), title: `${tilde(abs)} · clic: abrir en el editor`, onclick: (e) => { e.preventDefault(); openInFrap(abs, line ? Number(line) : undefined); } }, kids);
  }
  function mdInline(s, dir) {
    const out = [];
    let last = 0;
    let m;
    const re = new RegExp(MD_INLINE.source, 'g'); // uno por llamada: es recursiva y lastIndex no se puede compartir
    const text = (t) => { if (t) out.push(t.replace(/\n/g, ' ')); };
    while ((m = re.exec(s))) {
      text(s.slice(last, m.index));
      last = re.lastIndex;
      if (m[1] != null) out.push(m[1]);
      else if (m[3] != null) out.push(h('code', m[3].replace(/^ (.*) $/, '$1')));
      else if (m[5] != null) {
        const src = m[5];
        const ok = isExternal(src) || /^data:image\//i.test(src);
        out.push(/^[a-z][\w+.-]*:/i.test(src) && !ok ? h('span.muted', `[imagen: ${m[4]}]`) : h('img', { src: ok ? src : fileUrl(resolveRel(dir, src)), alt: m[4], loading: 'lazy' }));
      } else if (m[7] != null) out.push(mdLink(m[7], mdInline(m[6], dir), dir));
      else if (m[8] != null) out.push(mdLink(m[8], m[8].replace(/^mailto:/, ''), dir));
      else if (m[9] != null || m[10] != null) out.push(h('strong', mdInline(m[9] ?? m[10], dir)));
      else if (m[11] != null || m[12] != null) out.push(h('em', mdInline(m[11] ?? m[12], dir)));
      else if (m[13] != null) out.push(h('del', mdInline(m[13], dir)));
      else if (m[14] != null) out.push(mdLink(m[14], m[14], dir));
      else out.push(h('br'));
    }
    text(s.slice(last));
    return out;
  }

  const CM_PHRASES = {
    'Search:': 'Buscar:', 'With:': 'Con:', 'Replace?': '¿Reemplazar?', Yes: 'Sí', No: 'No', All: 'Todas', Stop: 'Parar',
    'Replace all:': 'Reemplazar todas:', 'Replace:': 'Reemplazar:', 'Replace with:': 'Reemplazar con:',
    '(Use /re/ syntax for regexp search)': '(usa /re/ para expresiones regulares)', 'Jump to line:': 'Ir a la línea:',
    '(Use line:column or scroll% syntax)': '(línea:columna o porcentaje%)',
  };
  const hasCM = () => typeof window.CodeMirror === 'function';

  /** Abre (o enfoca) el editor del proyecto activo. */
  function openCodeView() {
    if (!needProject()) return;
    const { fresh } = showView('code');
    if (!fresh) codeRenderAll();
    requestAnimationFrame(() => codeFocusEditor());
  }
  /** Carpetas raíz del proyecto (sin barra final). */
  const codeRoots = (pid = state.activeProject) => { const p = project(pid); return p ? p.folders.map((f) => f.replace(/\/+$/, '') || '/') : []; };
  /** Ruta para mostrar/copiar: relativa a la carpeta del proyecto que la contiene (o con ~). */
  function codeRel(file) {
    for (const r of codeRoots()) if (file.startsWith(`${r}/`)) return codeRoots().length > 1 ? `${basename(r)}/${file.slice(r.length + 1)}` : file.slice(r.length + 1);
    return tilde(file);
  }
  /** Para la IA: relativa a la carpeta de su terminal si está dentro; si no, absoluta. */
  function codeRelTo(file, cwd) {
    const c = (cwd || '').replace(/\/+$/, '');
    return c && file.startsWith(`${c}/`) ? file.slice(c.length + 1) : file;
  }
  function codeModeFor(file) {
    const name = basename(file);
    if (/^\.env(\..*)?$|\.(env|ini|conf|cfg)$/i.test(name)) return 'text/x-properties';
    if (/^(\.gitignore|\.dockerignore|\.npmrc|\.editorconfig)$/.test(name)) return 'text/x-properties';
    if (/\.(sh|bash|zsh)$|^\.(bashrc|zshrc|profile)$/.test(name)) return 'text/x-sh';
    if (/\.(ts|mts|cts)$/i.test(name)) return 'application/typescript';
    if (/\.tsx$/i.test(name)) return 'text/typescript-jsx';
    if (/\.(jsx)$/i.test(name)) return 'text/jsx';
    if (/\.(json|jsonc)$|^\.?(babelrc|eslintrc|prettierrc)$/i.test(name)) return 'application/json';
    if (/\.(md|markdown)$/i.test(name)) return 'text/x-gfm';
    const m = hasCM() && CodeMirror.findModeByFileName ? CodeMirror.findModeByFileName(name) : null;
    return m ? (m.mime || (m.mimes && m.mimes[0]) || m.mode) : 'text/plain';
  }
  function codeModeName(mime) {
    if (!hasCM() || !CodeMirror.findModeByMIME) return mime;
    const m = CodeMirror.findModeByMIME(mime);
    return m ? m.name : mime === 'text/plain' ? 'Texto' : mime;
  }

  function ensureCodePane() {
    if (codePane) return codePane;
    const treeEl = h('div.code-tree.scroll');
    const searchEl = h('div.code-search');
    const side = h('div.code-side', h('div.code-side-head'), treeEl, searchEl);
    const groupsEl = h('div.code-groups');
    const statusEl = h('div.code-status');
    const root = h('div.code-pane.hidden',
      h('div.code-main', side, h('div.code-right', groupsEl, statusEl)));
    $('#term-host').append(root);
    codePane = {
      kind: 'code', root, side, treeEl, searchEl, groupsEl, statusEl,
      groups: [], // {el, tabsEl, bodyEl, banner, cm, preview, docs: Map(ruta -> Doc enlazado)}
      files: new Map(), // ruta -> {master, saved, gen, mtime, exists, error, binary, image, mode, conflict, loading}
      dirs: new Map(), // carpeta -> {entries, at}
      quick: null, // {at, list: [{abs, rel}]}
      search: { query: '', regex: false, caseSensitive: false, results: null, busy: false, truncated: false },
      dragTab: null,
    };
    if (!state.code.groups || !state.code.groups.length) state.code.groups = [{ tabs: [], active: null }];
    viewPanes.set(bound.code, codePane);
    codeRenderAll();
    return codePane;
  }

  /** Grupos válidos (1-4) y foco dentro de rango. */
  function codeNormalize() {
    const c = state.code;
    c.groups = (c.groups || []).filter((g) => g && Array.isArray(g.tabs)).slice(0, CODE_MAX_GROUPS);
    if (!c.groups.length) c.groups = [{ tabs: [], active: null }];
    for (const g of c.groups) { g.tabs = [...new Set(g.tabs.filter((x) => typeof x === 'string'))]; if (!g.tabs.includes(g.active)) g.active = g.tabs[g.tabs.length - 1] || null; }
    c.focus = Math.min(Math.max(0, Number(c.focus) || 0), c.groups.length - 1);
    if (!Array.isArray(c.expanded)) c.expanded = [];
    if (!c.cursors || typeof c.cursors !== 'object') c.cursors = {};
    if (c.side === undefined) c.side = 'tree';
  }

  function codeRenderAll() {
    const P = codePane;
    if (!P) return;
    codeNormalize();
    P.root.classList.toggle('no-side', !state.code.side);
    codeRenderSide();
    codeRenderGroups();
    codeRenderStatus();
  }

  // ----- árbol de archivos -----
  function codeRenderSide() {
    const P = codePane;
    const c = state.code;
    const head = P.side.firstChild;
    head.replaceChildren(...[
      h(`button.code-side-tab${c.side === 'tree' ? '.active' : ''}`, { title: 'Archivos', onclick: () => codeSetSide('tree') }, 'Archivos'),
      h(`button.code-side-tab${c.side === 'search' ? '.active' : ''}`, { title: 'Buscar en archivos (Ctrl+Shift+F)', onclick: () => codeSetSide('search') }, 'Buscar'),
      h('span.grow'),
      c.side === 'tree' ? [
        h('button.icon.mini', { title: 'Nuevo archivo', onclick: () => codeNewFile(codeTargetDir()) }, '＋'),
        h('button.icon.mini', { title: 'Nueva carpeta', onclick: () => codeNewDir(codeTargetDir()) }, '▣'),
        h('button.icon.mini', { title: 'Revelar el archivo activo', onclick: () => codeReveal(codeActiveFile()) }, '◎'),
        h('button.icon.mini', { title: c.hidden ? 'Ocultar archivos ocultos' : 'Mostrar archivos ocultos', class: `icon mini${c.hidden ? ' on' : ''}`, onclick: () => { c.hidden = !c.hidden; P.dirs.clear(); save(); codeRenderTree(); codeRenderSide(); } }, '•'),
        h('button.icon.mini', { title: 'Contraer todo', onclick: () => { c.expanded = []; save(); codeRenderTree(); } }, '⊟'),
        h('button.icon.mini', { title: 'Recargar', onclick: () => { P.dirs.clear(); P.quick = null; codeRenderTree(); } }, '⟳'),
      ] : null,
      h('button.icon.mini', { title: 'Ocultar panel lateral', onclick: () => codeSetSide(null) }, '⟨')].flat().filter(Boolean)); // replaceChildren no aplana ni ignora null
    P.treeEl.classList.toggle('hidden', c.side !== 'tree');
    P.searchEl.classList.toggle('hidden', c.side !== 'search');
    if (c.side === 'tree') codeRenderTree();
    else if (c.side === 'search') codeRenderSearch();
  }
  function codeSetSide(side) {
    state.code.side = side;
    save();
    codeRenderAll();
    if (side === 'search') requestAnimationFrame(() => { const i = codePane && codePane.searchEl.querySelector('input'); if (i) { i.focus(); i.select(); } });
    codeRefreshEditors();
  }
  /** Carpeta donde crear: la del archivo activo si está en el proyecto; si no, la primera carpeta. */
  function codeTargetDir() {
    const f = codeActiveFile();
    const roots = codeRoots();
    if (f && roots.some((r) => f.startsWith(`${r}/`))) return f.slice(0, f.lastIndexOf('/'));
    return roots[0];
  }
  async function codeListDir(dir, force) {
    const P = codePane;
    const c = P.dirs.get(dir);
    if (c && !force) return c.entries;
    const r = await Bridge.call('fs.list', { path: dir, dirsOnly: false, hidden: !!state.code.hidden });
    const entries = r.entries.filter((e) => !(e.dir && e.name === '.git'));
    P.dirs.set(dir, { entries, at: Date.now() });
    return entries;
  }
  /** Raíces del árbol: las carpetas del proyecto y, aparte, la carpeta de cada archivo abierto que quede fuera de ellas. */
  function codeTreeRoots() {
    const roots = codeRoots();
    const inside = (f, list) => list.some((r) => f === r || f.startsWith(`${r}/`));
    // carpetas abiertas desde fuera del proyecto (clic en una ruta de la terminal): se quitan con clic derecho
    const ext = (state.code.extDirs || []).filter((d) => !inside(d, roots));
    for (const g of state.code.groups || []) for (const f of g.tabs) {
      if (inside(f, roots) || inside(f, ext) || !f.includes('/')) continue;
      const d = f.slice(0, f.lastIndexOf('/')) || '/';
      if (!ext.includes(d)) ext.push(d);
    }
    return { roots, ext };
  }
  let codeTreeSeq = 0;
  async function codeRenderTree() {
    const P = codePane;
    if (!P || !Bridge.ready) { if (P) P.treeEl.replaceChildren(h('p.muted.code-hint', 'Bridge desconectado')); return; }
    const seq = ++codeTreeSeq;
    const expanded = new Set(state.code.expanded);
    const active = codeActiveFile();
    const build = async (dir, depth) => {
      let entries;
      try { entries = await codeListDir(dir); } catch (e) { return [h('div.code-node.err', { style: `padding-left:${8 + depth * 12}px` }, e.message)]; }
      const out = [];
      for (const e of entries) {
        const abs = `${dir}/${e.name}`;
        const open = e.dir && expanded.has(abs);
        out.push(h(`div.code-node${e.dir ? '.dir' : ''}${abs === active ? '.active' : ''}`, {
          style: `padding-left:${8 + depth * 12}px`, title: tilde(abs), dataset: { path: abs },
          draggable: 'true', // arrastrar a un panel del editor lo abre ahí
          ondragstart: (ev) => { ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData('text/x-frap-path', abs); ev.dataTransfer.setData('text/plain', abs); },
          onclick: () => (e.dir ? codeToggleDir(abs) : codeOpenFile(abs)),
          oncontextmenu: (ev) => codeTreeMenu(ev, abs, e.dir),
        }, h('span.code-twisty', e.dir ? (open ? '▾' : '▸') : ''), h('span.code-fname', e.name)));
        if (open) out.push(...await build(abs, depth + 1));
      }
      if (!entries.length) out.push(h('div.code-node.muted', { style: `padding-left:${20 + depth * 12}px` }, '(vacía)'));
      return out;
    };
    const { roots, ext } = codeTreeRoots();
    const parts = [];
    for (const r of [...roots, ...ext]) {
      const open = !expanded.has(`!${r}`); // las raíces empiezan abiertas ("!ruta" = contraída)
      const isExt = !roots.includes(r);
      parts.push(h(`div.code-node.dir.code-root${isExt ? '.code-ext' : ''}`, {
        title: isExt ? `Fuera de las carpetas del proyecto: ${tilde(r)}` : tilde(r), dataset: { path: r },
        onclick: () => codeToggleDir(`!${r}`),
        oncontextmenu: (ev) => codeTreeMenu(ev, r, true, true, isExt),
      }, h('span.code-twisty', open ? '▾' : '▸'), h('span.code-fname', isExt ? `↗ ${tilde(r)}` : (basename(r) || r))));
      if (open) parts.push(...await build(r, 1));
    }
    if (seq !== codeTreeSeq || codePane !== P) return;
    const top = P.treeEl.scrollTop;
    P.treeEl.replaceChildren(...parts);
    P.treeEl.scrollTop = top;
  }
  function codeToggleDir(abs) {
    const c = state.code;
    c.expanded = c.expanded.includes(abs) ? c.expanded.filter((x) => x !== abs) : [...c.expanded, abs];
    save();
    codeRenderTree();
  }
  /** Expande el árbol hasta el archivo y lo deja visible. */
  async function codeReveal(file, quiet) {
    if (!file || !codePane) return;
    const { roots, ext } = codeTreeRoots();
    const r = [...roots, ...ext].sort((a, b) => b.length - a.length).find((x) => file.startsWith(`${x}/`));
    if (!r) { if (!quiet) toast('El archivo no está dentro de las carpetas del proyecto', 'err'); return; }
    const c = state.code;
    const add = new Set(c.expanded);
    add.delete(`!${r}`);
    let d = file.slice(0, file.lastIndexOf('/'));
    while (d.length > r.length) { add.add(d); d = d.slice(0, d.lastIndexOf('/')); }
    c.expanded = [...add];
    if (!quiet && c.side !== 'tree') c.side = 'tree';
    save();
    if (!quiet) codeRenderSide();
    if (c.side !== 'tree') return;
    await codeRenderTree();
    if (!codePane) return;
    const el = [...codePane.treeEl.querySelectorAll('.code-node')].find((n) => n.dataset.path === file);
    if (el) el.scrollIntoView({ block: quiet ? 'nearest' : 'center' });
  }
  function codeTreeMenu(ev, abs, isDir, isRoot, isExt) {
    const dir = isDir ? abs : abs.slice(0, abs.lastIndexOf('/'));
    popMenu(ev, [
      isExt && (state.code.extDirs || []).includes(abs) && { label: 'Quitar del árbol', hint: 'fuera del proyecto', action: () => { state.code.extDirs = state.code.extDirs.filter((d) => d !== abs); save(); codeRenderTree(); } },
      isExt && '-',
      !isDir && { label: 'Abrir', action: () => codeOpenFile(abs) },
      isDir && { label: 'Ver sus archivos en el editor', action: () => codeOpenDir(abs) },
      !isDir && state.code.groups.length < CODE_MAX_GROUPS && { label: 'Abrir a la derecha', action: () => codeOpenFile(abs, { group: state.code.groups.length }) },
      { label: 'Nuevo archivo…', action: () => codeNewFile(dir) },
      { label: 'Nueva carpeta…', action: () => codeNewDir(dir) },
      '-',
      { label: 'Copiar ruta', action: () => codeCopy(abs) },
      { label: 'Copiar ruta relativa', action: () => codeCopy(codeRel(abs)) },
      !isDir && { label: 'Enviar ruta a la IA', action: () => codeSendToAi(abs) },
      '-',
      !isRoot && { label: 'Renombrar…', action: () => codeRename(abs) },
      !isRoot && { label: 'Mover a la papelera', danger: true, action: () => codeTrash(abs, isDir) },
      isDir && { label: 'Abrir terminal aquí', action: () => launch('shell', { cwd: abs, title: basename(abs) }) },
      (isDir || /\.(html?|svg|pdf|png|jpe?g|gif|webp|mp4|webm)$/i.test(abs)) && rtabOn('tunnels') && { label: 'Compartir por túnel…', action: () => { setRtab('tunnels'); editTunnel(null, { kind: 'path', path: abs, name: basename(abs) }); } },
      { label: isDir ? 'Abrir en el explorador de archivos' : 'Mostrar en el explorador de archivos', action: () => openInFileManager(abs) },
      { label: `Abrir en ${extEditorName()}`, action: () => openExternal(abs) },
    ]);
  }
  /** Abre la carpeta (o la carpeta del archivo, con él seleccionado) en el explorador de archivos del sistema. */
  async function openInFileManager(p) {
    try {
      const r = await Bridge.call('open.folder', { path: p });
      toast(r.how === 'select' ? `Mostrando ${basename(p)} en el explorador` : `Abriendo ${tilde(r.opened)} en el explorador`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  async function codeNewFile(dir) {
    if (!dir) return;
    const name = await askText('Nuevo archivo', `En ${tilde(dir)}/ (puede incluir subcarpetas: a/b.js)`);
    if (!name) return;
    const abs = `${dir}/${name.replace(/^\/+/, '')}`;
    try {
      if (await Bridge.call('fs.exists', { path: abs })) { toast(`Ya existe: ${tilde(abs)}`, 'err'); codeOpenFile(abs); return; }
      await Bridge.call('fs.write', { path: abs, content: '' });
      codeInvalidateDirs(abs);
      await codeOpenFile(abs);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function codeNewDir(dir) {
    if (!dir) return;
    const name = await askText('Nueva carpeta', `En ${tilde(dir)}/`);
    if (!name) return;
    const abs = `${dir}/${name.replace(/^\/+|\/+$/g, '')}`;
    try {
      await Bridge.call('fs.mkdir', { path: abs });
      codeInvalidateDirs(abs);
      state.code.expanded = [...new Set([...state.code.expanded, dir, abs])];
      save();
      codeRenderTree();
    } catch (e) { toast(e.message, 'err'); }
  }
  function codeInvalidateDirs(abs) {
    if (!codePane) return;
    for (const d of [...codePane.dirs.keys()]) if (abs.startsWith(`${d}/`) || abs === d) codePane.dirs.delete(d);
    codePane.quick = null;
  }
  async function codeRename(abs) {
    const name = await askText('Renombrar', `Nuevo nombre (o ruta relativa a ${tilde(abs.slice(0, abs.lastIndexOf('/')))}/)`, basename(abs));
    if (!name || name === basename(abs)) return;
    const to = name.startsWith('/') ? name : `${abs.slice(0, abs.lastIndexOf('/'))}/${name}`;
    try {
      await Bridge.call('fs.rename', { from: abs, to });
      codeInvalidateDirs(abs);
      codeInvalidateDirs(to);
      codeMovePaths(abs, to);
      codeRenderAll();
      toast(`Renombrado a ${tilde(to)}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  /** Tras renombrar/mover: las pestañas y documentos abiertos siguen al archivo. */
  function codeMovePaths(from, to) {
    const P = codePane;
    const map = (x) => (x === from ? to : x.startsWith(`${from}/`) ? to + x.slice(from.length) : x);
    for (const g of state.code.groups) { g.tabs = g.tabs.map(map); g.active = g.active && map(g.active); }
    if (P) {
      for (const [k, f] of [...P.files]) { const n = map(k); if (n !== k) { P.files.delete(k); P.files.set(n, f); } }
      for (const g of P.groups) for (const [k, d] of [...g.docs]) { const n = map(k); if (n !== k) { g.docs.delete(k); g.docs.set(n, d); } }
    }
    save();
  }
  async function codeTrash(abs, isDir) {
    const open = codeOpenPaths().filter((x) => x === abs || x.startsWith(`${abs}/`));
    const dirty = open.filter(codeIsDirty);
    const ok = await confirmBox('Mover a la papelera', `${isDir ? 'La carpeta' : 'El archivo'} ${tilde(abs)} se moverá a la papelera (se puede recuperar desde el gestor de archivos).${dirty.length ? ` Hay ${dirty.length} archivo(s) con cambios sin guardar que se perderán.` : ''}`);
    if (!ok) return;
    try {
      await Bridge.call('fs.trash', { path: abs });
      for (const f of open) codeCloseEverywhere(f);
      codeInvalidateDirs(abs);
      codeRenderAll();
      toast(`${basename(abs)} movido a la papelera`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  // ----- búsqueda en archivos -----
  function codeRenderSearch() {
    const P = codePane;
    const S = P.search;
    let input = P.searchEl.querySelector('input.code-q');
    if (!input) {
      input = h('input.code-q', { placeholder: 'Buscar en el proyecto… (Enter)', spellcheck: 'false' });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { S.query = input.value; codeRunSearch(); } else if (e.key === 'Escape') codeFocusEditor(); });
      const flag = (key, label, title) => h(`button.mini.code-flag${S[key] ? '.on' : ''}`, { title, onclick: (e) => { S[key] = !S[key]; e.currentTarget.classList.toggle('on', S[key]); if (S.query) codeRunSearch(); } }, label);
      P.searchEl.append(h('div.code-search-bar', input, flag('caseSensitive', 'Aa', 'Distinguir mayúsculas'), flag('regex', '.*', 'Expresión regular')), h('div.code-results.scroll'));
    }
    const box = P.searchEl.querySelector('.code-results');
    if (S.busy) { box.replaceChildren(h('p.muted.code-hint', 'Buscando…')); return; }
    if (!S.results) { box.replaceChildren(h('p.muted.code-hint', 'Busca texto en todas las carpetas del proyecto (respeta .gitignore en repos git).')); return; }
    if (!S.results.length) { box.replaceChildren(h('p.muted.code-hint', 'Sin resultados')); return; }
    const byFile = new Map();
    for (const r of S.results) { if (!byFile.has(r.abs)) byFile.set(r.abs, []); byFile.get(r.abs).push(r); }
    box.replaceChildren(
      h('p.muted.code-hint', `${S.results.length}${S.truncated ? '+' : ''} resultado${S.results.length === 1 ? '' : 's'} en ${byFile.size} archivo${byFile.size === 1 ? '' : 's'}`),
      ...[...byFile].map(([abs, list]) => h('div.code-rfile',
        h('div.code-rname', { title: tilde(abs), onclick: () => codeOpenFile(abs) }, h('span', basename(abs)), h('span.muted', ` ${codeRel(abs).replace(/[^/]*$/, '')}`), h('span.pcount', String(list.length))),
        list.map((r) => h('div.code-rline', { title: `${codeRel(abs)}:${r.line}`, onclick: () => codeOpenFile(abs, { line: r.line, col: r.col, len: r.len }) },
          h('span.muted', `${r.line}`), h('span.mono', r.text.trim()))))));
  }
  async function codeRunSearch() {
    const P = codePane;
    const S = P.search;
    if (!S.query) { S.results = null; codeRenderSearch(); return; }
    S.busy = true;
    codeRenderSearch();
    const all = [];
    let trunc = false;
    try {
      for (const r of codeRoots()) {
        const res = await Bridge.call('code.search', { root: r, query: S.query, regex: S.regex, caseSensitive: S.caseSensitive });
        trunc = trunc || res.truncated;
        for (const x of res.results) all.push({ ...x, abs: `${res.root}/${x.file}`, len: S.regex ? 0 : S.query.length });
      }
    } catch (e) { toast(e.message, 'err'); }
    if (codePane !== P) return;
    S.busy = false;
    S.results = all;
    S.truncated = trunc;
    codeRenderSearch();
  }

  // ----- Ctrl+P: abrir archivo por nombre -----
  async function codeQuickOpen() {
    const P = codePane;
    if (!P || !Bridge.ready) return;
    const input = h('input.mono', { placeholder: 'Nombre del archivo (admite ruta:línea)', spellcheck: 'false' });
    const list = h('div.code-quick.scroll');
    let items = [];
    let sel = 0;
    const close = openModal({ title: 'Abrir archivo', body: [input, list], wide: true });
    const render = () => {
      const raw = input.value.trim();
      const m = /^(.*?)(?::(\d+))?$/.exec(raw);
      const q = (m[1] || '').toLowerCase();
      const all = (P.quick && P.quick.list) || [];
      const scored = [];
      for (const f of all) {
        const s = fuzzyScore(f.rel.toLowerCase(), q);
        if (s > -1) scored.push([s, f]);
        if (scored.length > 4000) break;
      }
      scored.sort((a, b) => b[0] - a[0] || a[1].rel.length - b[1].rel.length);
      items = scored.slice(0, 80).map((x) => ({ ...x[1], line: m[2] ? Number(m[2]) : 0 }));
      sel = Math.min(sel, Math.max(0, items.length - 1));
      list.replaceChildren(...(P.quick ? items.map((it, i) => h(`div.code-qitem${i === sel ? '.active' : ''}`, { onclick: () => pick(it) },
        h('span', basename(it.rel)), h('span.muted', ` ${it.rel.replace(/[^/]*$/, '')}`))) : [h('p.muted', 'Cargando lista de archivos…')]));
      const a = list.querySelector('.active');
      if (a) a.scrollIntoView({ block: 'nearest' });
    };
    const pick = (it) => { close(true); codeOpenFile(it.abs, { line: it.line }); };
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); render(); } else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); } else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); pick(items[sel]); }
    });
    render();
    if (!P.quick || Date.now() - P.quick.at > 30000) {
      try {
        const roots = codeRoots();
        const lists = [];
        for (const r of roots) {
          const res = await Bridge.call('code.files', { root: r });
          for (const f of res.files) lists.push({ abs: `${res.root}/${f}`, rel: roots.length > 1 ? `${basename(r)}/${f}` : f });
        }
        P.quick = { at: Date.now(), list: lists };
      } catch (e) { toast(e.message, 'err'); P.quick = { at: Date.now(), list: [] }; }
      render();
    }
  }
  /** Coincidencia difusa: -1 = no; más alto = mejor (consecutivas y en el nombre del archivo valen más). */
  function fuzzyScore(text, q) {
    if (!q) return 0;
    let ti = 0;
    let score = 0;
    let streak = 0;
    const nameStart = text.lastIndexOf('/') + 1;
    for (const ch of q) {
      const i = text.indexOf(ch, ti);
      if (i < 0) return -1;
      streak = i === ti ? streak + 1 : 0;
      score += 1 + streak * 2 + (i >= nameStart ? 2 : 0) + (i === nameStart || text[i - 1] === '/' || text[i - 1] === '.' || text[i - 1] === '-' || text[i - 1] === '_' ? 3 : 0);
      ti = i + 1;
    }
    if (text.slice(nameStart).includes(q)) score += 20;
    return score;
  }

  // ----- documentos -----
  const codeOpenPaths = () => [...new Set(state.code.groups.flatMap((g) => g.tabs))];
  const codeActiveFile = () => { const g = state.code.groups && state.code.groups[state.code.focus]; return g ? g.active : null; };
  function codeIsDirty(file) {
    const f = codePane && codePane.files.get(file);
    return !!(f && f.master && !f.master.isClean(f.gen));
  }
  /** Carga (una vez) el documento maestro de un archivo. */
  function codeLoad(file, force) {
    const P = codePane;
    let f = P.files.get(file);
    if (f && f.loading) return f.promise; // ya se está cargando: se espera esa misma carga
    if (f && !force && (f.master || f.error || f.binary || f.media || f.dirList)) return Promise.resolve(f);
    if (!f) { f = {}; P.files.set(file, f); }
    f.loading = true;
    f.promise = codeLoadNow(P, file, f);
    return f.promise;
  }
  /** Contenido inicial de archivos que se abren para crearlos (ver openEditor). */
  const codeTemplates = new Map();
  async function codeLoadNow(P, file, f) {
    if (!Bridge.ready) { P.files.delete(file); f.loading = false; return f; } // al conectar se vuelve a pintar (ver Bridge.on('open'))
    if (f.isDir) return codeLoadDir(f, file);
    f.media = mediaKind(file); // imagen, video, audio o PDF: se ven directo del disco, no se cargan como texto
    if (f.media) { f.loading = false; f.exists = true; return f; }
    try {
      const r = await Bridge.call('fs.read', { path: file });
      codeTemplates.delete(file);
      const text = r.content;
      if (text.slice(0, 8000).includes('\0')) { Object.assign(f, { binary: true, loading: false, error: null }); return f; }
      f.mode = codeModeFor(file);
      if (f.master) {
        codeReplaceText(file, f, text);
      } else {
        f.master = new CodeMirror.Doc(text, f.mode);
      }
      Object.assign(f, { saved: text, gen: f.master.changeGeneration(true), mtime: r.mtime, exists: true, error: null, binary: false, loading: false, conflict: null });
    } catch (e) {
      const tpl = codeTemplates.get(file);
      if (tpl != null && /ENOENT|no such file/i.test(e.message)) { // archivo nuevo (skill, memoria…): sin guardar hasta Ctrl+S
        f.mode = codeModeFor(file);
        f.master = new CodeMirror.Doc('', f.mode);
        Object.assign(f, { saved: '', gen: f.master.changeGeneration(true), mtime: 0, exists: false, error: null, binary: false, loading: false, conflict: null });
        codeTemplates.delete(file);
        if (tpl) f.master.setValue(tpl);
        return f;
      }
      if (/EISDIR|illegal operation on a directory/i.test(e.message)) return codeLoadDir(f, file); // es una carpeta: vista de sus archivos
      Object.assign(f, { loading: false, error: /ENOENT|no such file/i.test(e.message) ? 'El archivo no existe (¿lo borraron o renombraron?)' : e.message });
    }
    return f;
  }
  /** Pestaña de carpeta: su contenido (se abre al hacer clic en una ruta de carpeta o desde el árbol). */
  async function codeLoadDir(f, dir) {
    try {
      const r = await Bridge.call('fs.list', { path: dir, dirsOnly: false, hidden: !!state.code.hidden, details: true });
      Object.assign(f, { isDir: true, dirList: r.entries.filter((e) => !(e.dir && e.name === '.git')), dirParent: r.parent, loading: false, error: null, exists: true, media: null, binary: false });
      if (codePane) requestAnimationFrame(() => codePane && codeRenderTabsOnly()); // la pestaña pasa a mostrar 📁
    } catch (e) {
      Object.assign(f, { dirList: null, loading: false, error: /ENOENT|no such file/i.test(e.message) ? 'La carpeta no existe (¿la borraron o renombraron?)' : e.message });
    }
    return f;
  }
  /** En una pestaña de carpeta, entra en otra carpeta (la misma pestaña pasa a mostrarla). */
  async function codeDirNavigate(gi, from, to) {
    const g = state.code.groups[gi];
    if (!g) return;
    to = String(to).replace(/\/+$/, '') || '/';
    const i = g.tabs.indexOf(from);
    if (g.tabs.includes(to)) { if (i >= 0) g.tabs.splice(i, 1); }
    else if (i >= 0) g.tabs[i] = to; else g.tabs.push(to);
    g.active = to;
    if (!state.code.groups.some((x) => x.tabs.includes(from))) codePane.files.delete(from);
    codePane.files.set(to, { isDir: true });
    save();
    codeRenderGroups();
    await codeLoad(to, true);
    codeShowActive(gi);
    codeRenderTabsOnly();
    if (state.code.side === 'tree') { codeMarkTreeActive(); codeRevealDir(to, true); }
  }
  function renderDirView(gi, dir, f) {
    const items = f.dirList;
    const fmt = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
    const open = (e) => { const abs = `${dir === '/' ? '' : dir}/${e.name}`; if (e.dir) codeDirNavigate(gi, dir, abs); else codeOpenFile(abs, { group: gi }); };
    const imgs = items.filter((e) => !e.dir && mediaKind(e.name) === 'image').length;
    return h('div.code-dir',
      h('div.code-dir-head',
        f.dirParent ? h('button.icon.mini', { title: 'Carpeta de arriba', onclick: () => codeDirNavigate(gi, dir, f.dirParent) }, '↑') : null,
        h('span.code-dir-path.mono', { title: dir }, `📁 ${tilde(dir)}`),
        h('span.muted', `${items.filter((e) => e.dir).length} carpeta(s) · ${items.filter((e) => !e.dir).length} archivo(s)${imgs ? ` · ${imgs} imagen(es)` : ''}`),
        h('span.grow'),
        h('button.icon.mini', { title: 'Recargar', onclick: async () => { await codeLoad(dir, true); codeShowActive(gi); } }, '⟳'),
        h('button.mini', { title: 'Abrir una terminal en esta carpeta', onclick: () => launch('shell', { cwd: dir, title: basename(dir) }) }, '>_ Terminal'),
        h('button.mini', { title: 'Abrir en el explorador de archivos', onclick: () => openInFileManager(dir) }, '↗ Explorador')),
      items.length ? h('div.code-dir-list', items.map((e) => {
        const abs = `${dir === '/' ? '' : dir}/${e.name}`;
        const img = !e.dir && mediaKind(e.name) === 'image';
        return h('div.code-dir-item', {
          title: `${tilde(abs)}${e.dir ? '' : ` · ${fmt(e.size || 0)}`}\nClic: abrir`,
          onclick: () => open(e),
          oncontextmenu: (ev) => codeTreeMenu(ev, abs, e.dir),
        },
        img ? h('img.code-dir-thumb', { src: fileUrl(abs), alt: '', loading: 'lazy', onerror: (ev) => ev.target.replaceWith(h('span.code-dir-ico', '🖼️')) })
          : h('span.code-dir-ico', e.dir ? '📁' : e.link ? '🔗' : '📄'),
        h('span.code-dir-name', e.name),
        h('span.muted.code-dir-size', e.dir ? '' : fmt(e.size || 0)),
        h('span.muted.code-dir-date', e.mtime ? new Date(e.mtime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : ''));
      })) : h('p.muted', { style: 'padding:12px' }, 'Carpeta vacía.'));
  }
  /** Reemplaza el texto de un documento conservando cursor y scroll de cada grupo. */
  function codeReplaceText(file, f, text) {
    const keep = codePane.groups.filter((G) => G.cm && G.shown === file).map((G) => ({ G, cur: G.cm.getCursor(), scroll: G.cm.getScrollInfo() }));
    f.master.setValue(text);
    for (const k of keep) { k.G.cm.setCursor(k.cur); k.G.cm.scrollTo(k.scroll.left, k.scroll.top); }
  }
  /** Documento enlazado del archivo para un grupo (los grupos comparten contenido e historial). */
  function codeDocFor(g, file, f) {
    let d = g.docs.get(file);
    if (!d) { d = f.master.linkedDoc({ sharedHist: true }); g.docs.set(file, d); }
    return d;
  }

  /** Abre un archivo en el grupo con foco (o `opts.group`) y, si viene, va a la línea/columna. */
  async function codeOpenFile(file, opts = {}) {
    if (!codePane) return;
    const c = state.code;
    codeNormalize();
    let gi = opts.group != null ? opts.group : c.focus;
    if (gi >= c.groups.length) { if (c.groups.length >= CODE_MAX_GROUPS) gi = c.groups.length - 1; else { c.groups.push({ tabs: [], active: null }); gi = c.groups.length - 1; } }
    const g = c.groups[gi];
    if (opts.template != null) { const f0 = codePane.files.get(file); if (!f0 || f0.error) { codePane.files.delete(file); codeTemplates.set(file, opts.template); } } // si no existe se crea al guardar
    if (!g.tabs.includes(file)) {
      const i = g.active ? g.tabs.indexOf(g.active) : -1;
      g.tabs.splice(i + 1, 0, file);
    }
    g.active = file;
    c.focus = gi;
    save();
    codeRenderGroups();
    await codeLoad(file);
    if (!codePane) return;
    codeShowActive(gi);
    codeRenderTabsOnly(); // ya cargado: un archivo nuevo con plantilla queda marcado «sin guardar»
    if (opts.line) codeGoTo(gi, opts.line, opts.col, opts.len);
    codeRenderStatus();
    if (state.code.side === 'tree') { codeMarkTreeActive(); codeReveal(file, true); } // despliega las carpetas hasta el archivo
    requestAnimationFrame(() => codeFocusEditor(gi));
  }
  function codeGoTo(gi, line, col, len) {
    const G = codePane.groups[gi];
    if (!G || !G.cm) return;
    const ln = Math.max(0, Math.min(G.cm.lineCount() - 1, (Number(line) || 1) - 1));
    const ch = Math.max(0, (Number(col) || 1) - 1);
    if (len) G.cm.setSelection({ line: ln, ch: ch + len }, { line: ln, ch });
    else G.cm.setCursor({ line: ln, ch });
    const h2 = G.cm.getScrollInfo().clientHeight;
    G.cm.scrollIntoView({ line: ln, ch }, h2 / 3);
    const mark = G.cm.addLineClass(ln, 'background', 'code-flash');
    setTimeout(() => G.cm.removeLineClass(mark, 'background', 'code-flash'), 1400);
  }
  function codeMarkTreeActive() {
    const a = codeActiveFile();
    for (const n of codePane.treeEl.querySelectorAll('.code-node')) n.classList.toggle('active', n.dataset.path === a);
  }

  // ----- grupos (hasta 4 paneles) -----
  function codeMakeGroup(gi) {
    const tabsEl = h('div.code-tabs');
    const banner = h('div.code-banner.hidden');
    const bodyEl = h('div.code-body');
    const el = h('div.code-group', {
      onmousedown: () => { if (state.code.focus !== G.index) { state.code.focus = G.index; save(); codeRenderFocus(); codeRenderStatus(); } },
      ondragover: (e) => { if (codePane.dragTab || codeDropKind(e)) { e.preventDefault(); e.dataTransfer.dropEffect = codePane.dragTab ? 'move' : 'copy'; el.classList.add('drop'); } },
      ondragleave: (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); },
      ondrop: (e) => {
        el.classList.remove('drop');
        const d = codePane.dragTab;
        if (d) { e.preventDefault(); codeMoveTab(d.gi, d.file, G.index); return; }
        if (codeDropKind(e)) { e.preventDefault(); e.stopPropagation(); codeHandleDrop(e.dataTransfer, G.index); }
      },
    }, tabsEl, banner, bodyEl);
    const G = { index: gi, el, tabsEl, banner, bodyEl, cm: null, preview: null, docs: new Map(), shown: null };
    return G;
  }
  // ----- arrastrar archivos al editor para abrirlos -----
  /** ¿Lo que se arrastra es algo que el editor sabe abrir? (archivos del sistema, rutas, o del árbol de FRAP) */
  function codeDropKind(e) {
    const t = [...((e.dataTransfer && e.dataTransfer.types) || [])];
    if (t.includes('text/x-frap-path')) return 'frap';
    if (t.includes('Files')) return 'files';
    if (t.includes('text/uri-list')) return 'uri';
    return null;
  }
  /** Ruta absoluta de un file://… (o una ruta absoluta en texto). */
  function pathFromUri(u) {
    const s = String(u || '').trim();
    if (s.startsWith('file://')) { try { return decodeURIComponent(new URL(s).pathname); } catch (_) { return null; } }
    return s.startsWith('/') && !s.includes('\n') ? s : null;
  }
  async function codeOpenDropped(abs, gi) {
    let st;
    try { st = (await Bridge.call('fs.stat', { paths: [abs] }))[0]; } catch (e) { toast(e.message, 'err'); return false; }
    if (!st || !st.exists) { toast(`No existe: ${tilde(abs)}`, 'err'); return false; }
    if (st.dir) { await codeRevealDir(abs); await codeOpenDir(abs); } else await codeOpenFile(st.path, { group: gi });
    return true;
  }
  /** Busca en las carpetas del proyecto un archivo con ese nombre y tamaño (el navegador no da la ruta de lo arrastrado). */
  async function codeFindDropped(file) {
    const hits = [];
    for (const root of codeRoots()) {
      let r;
      try { r = await Bridge.call('code.files', { root }); } catch (_) { continue; }
      for (const rel of r.files) if (rel === file.name || rel.endsWith(`/${file.name}`)) hits.push(`${r.root}/${rel}`);
    }
    if (hits.length <= 1) return hits[0] || null;
    try {
      const st = await Bridge.call('fs.stat', { paths: hits.slice(0, 200) });
      const same = st.filter((x) => x.exists && !x.dir && x.size === file.size);
      if (same.length === 1) return same[0].path;
      return (same.sort((a, b) => Math.abs(b.mtime - file.lastModified) - Math.abs(a.mtime - file.lastModified)).pop() || {}).path || hits[0];
    } catch (_) { return hits[0]; }
  }
  async function codeHandleDrop(dt, gi) {
    if (!Bridge.ready) { toast('Bridge desconectado', 'err'); return; }
    const frap = dt.getData('text/x-frap-path');
    if (frap) { await codeOpenDropped(frap, gi); return; }
    // desde el gestor de archivos: la ruta llega como file:// si el navegador la da
    const uris = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map(pathFromUri).filter(Boolean);
    if (uris.length) { for (const p of uris.slice(0, 10)) await codeOpenDropped(p, gi); return; }
    const files = [...(dt.files || [])].slice(0, 10);
    if (!files.length) { const p = pathFromUri(dt.getData('text/plain')); if (p) await codeOpenDropped(p, gi); return; }
    for (const f of files) {
      const found = await codeFindDropped(f);
      if (found) { await codeOpenFile(found, { group: gi }); continue; }
      // no está en el proyecto: se abre como archivo nuevo (sin guardar) en la carpeta del proyecto
      const root = codeRoots()[0];
      if (!root) { toast(`No encontré ${f.name} en el proyecto`, 'err'); continue; }
      if (f.size > 2 * 1024 * 1024) { toast(`${f.name}: no está en el proyecto y pesa más de 2 MB; ábrelo desde su carpeta`, 'err'); continue; }
      const text = await f.text();
      if (text.slice(0, 8000).includes('\0')) { toast(`${f.name}: no está en el proyecto y es binario`, 'err'); continue; }
      const target = `${root}/${f.name}`;
      await codeOpenFile(target, { group: gi, template: text });
      toast(`${f.name} no está en las carpetas del proyecto: lo abrí como archivo nuevo en ${tilde(root)} (Ctrl+S para guardarlo ahí)`, 'ok');
    }
  }
  // soltar un archivo fuera de donde se acepta no debe hacer que el navegador navegue a él (se perdería FRAP)
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files') && !e.defaultPrevented) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; } });
  window.addEventListener('drop', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files') && !e.defaultPrevented) e.preventDefault(); });
  /** URL (http/https) bajo el puntero en el editor: {url, line, from, to} o null. */
  function codeUrlAt(cm, e) {
    const pos = cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
    const text = cm.getLine(pos.line) || '';
    const re = /https?:\/\/[^\s<>"'`()\[\]{}]+[^\s<>"'`()\[\]{}.,;:!?]/g;
    let m;
    while ((m = re.exec(text))) if (pos.ch >= m.index && pos.ch <= m.index + m[0].length) return { url: m[0], line: pos.line, from: m.index, to: m.index + m[0].length };
    return null;
  }
  /** Ctrl+clic (Cmd en Mac) en una URL del editor la abre en una pestaña del navegador; con Ctrl pulsado se subraya. */
  function codeUrlLinks(cm) {
    const wrap = cm.getWrapperElement();
    let mark = null;
    const clear = () => { if (mark) { mark.clear(); mark = null; } wrap.classList.remove('cm-url-hover'); };
    cm.on('mousedown', (_cm, e) => {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
      const u = codeUrlAt(cm, e);
      if (!u) return; // Ctrl+clic fuera de una URL: varios cursores, como siempre
      e.preventDefault(); // CodeMirror no pone un cursor extra
      clear();
      openPageTab({ url: u.url });
    });
    wrap.addEventListener('mousemove', (e) => {
      if (!(e.ctrlKey || e.metaKey)) { if (mark) clear(); return; }
      const u = codeUrlAt(cm, e);
      if (!u) { if (mark) clear(); return; }
      const cur = mark && mark.find();
      if (cur && cur.from.line === u.line && cur.from.ch === u.from) return;
      clear();
      mark = cm.markText({ line: u.line, ch: u.from }, { line: u.line, ch: u.to }, { className: 'cm-url-link', title: `Ctrl+clic: abrir ${u.url}` });
      wrap.classList.add('cm-url-hover');
    });
    wrap.addEventListener('mouseleave', clear);
    window.addEventListener('keyup', (e) => { if ((e.key === 'Control' || e.key === 'Meta') && mark) clear(); });
  }
  function codeEnsureCm(G) {
    if (G.cm || !hasCM()) return G.cm;
    G.cm = CodeMirror(G.bodyEl, {
      value: '',
      lineNumbers: true,
      theme: 'frap',
      indentUnit: 2,
      tabSize: 2,
      keyMap: 'sublime',
      lineWrapping: !!state.code.wrap,
      matchBrackets: true,
      autoCloseBrackets: true,
      matchTags: { bothTags: true },
      autoCloseTags: true,
      styleActiveLine: true,
      showTrailingSpace: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      highlightSelectionMatches: { showToken: /\w/, annotateScrollbar: true },
      scrollPastEnd: true,
      dragDrop: false,
      phrases: CM_PHRASES,
      extraKeys: {
        'Ctrl-S': () => codeSave(G.index), 'Cmd-S': () => codeSave(G.index),
        'Ctrl-Alt-S': () => codeSaveAll(),
        'Ctrl-P': () => codeQuickOpen(), 'Cmd-P': () => codeQuickOpen(),
        'Shift-Ctrl-F': () => codeSearchSelection(G), 'Shift-Cmd-F': () => codeSearchSelection(G),
        'Ctrl-H': 'replace', 'Ctrl-G': 'jumpToLine', 'Cmd-G': 'jumpToLine',
        'Ctrl-/': 'toggleComment', 'Cmd-/': 'toggleComment',
        'Ctrl-\\': () => codeSplit(G.index), // Ctrl+W no: el navegador cierra la pestaña sin dejar interceptarlo
        'Alt-Z': () => codeToggleWrap(),
        'Shift-Ctrl-V': () => codeTogglePreview(G.index),
        'Ctrl-Alt-C': () => codeCopyRef(G, false), 'Shift-Ctrl-Alt-C': () => codeCopyRef(G, true),
        'Ctrl-Alt-I': () => codeSendSel(G),
        'Ctrl-Space': 'autocomplete',
        'Ctrl-Q': (cm) => cm.foldCode(cm.getCursor()),
        Esc: (cm) => { if (cm.state.completionActive) return CodeMirror.Pass; cm.execCommand('clearSearch'); return CodeMirror.Pass; },
      },
    });
    G.cm.getWrapperElement().style.fontSize = `${state.settings.fontSize}px`;
    G.cm.on('cursorActivity', () => { if (G.index === state.code.focus) codeRenderStatusSoon(); codeRememberCursor(G); });
    G.cm.on('changes', () => codeRenderDirtySoon());
    G.cm.on('focus', () => { if (state.code.focus !== G.index) { state.code.focus = G.index; save(); codeRenderFocus(); codeRenderStatus(); } });
    G.cm.getWrapperElement().addEventListener('contextmenu', (e) => codeEditorMenu(e, G));
    codeUrlLinks(G.cm);
    return G.cm;
  }
  const codeRememberCursor = debounce((G) => {
    const g = state.code.groups[G.index];
    if (!G.cm || !g || !g.active || G.shown !== g.active) return;
    const cur = G.cm.getCursor();
    state.code.cursors[g.active] = [cur.line, cur.ch];
    const keys = Object.keys(state.code.cursors);
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete state.code.cursors[k];
    save();
  }, 600);
  const codeRenderStatusSoon = debounce(() => codeRenderStatus(), 50);
  const codeRenderDirtySoon = debounce(() => { codeRenderTabsOnly(); codeRenderStatus(); }, 120);

  function codeRenderGroups() {
    const P = codePane;
    if (!P) return;
    const gs = state.code.groups;
    while (P.groups.length < gs.length) { const G = codeMakeGroup(P.groups.length); P.groups.push(G); P.groupsEl.append(G.el); }
    while (P.groups.length > gs.length) { const G = P.groups.pop(); for (const [k, d] of G.docs) { const f = P.files.get(k); if (f && f.master) f.master.unlinkDoc(d); } G.el.remove(); }
    P.groups.forEach((G, i) => { G.index = i; });
    P.groupsEl.dataset.n = String(gs.length);
    codeRenderTabsOnly();
    codeRenderFocus();
    gs.forEach((g, i) => { if (P.groups[i].shown !== g.active || !g.active) codeShowActive(i); });
    codeGcDocs();
  }
  function codeRenderFocus() {
    const P = codePane;
    P.groups.forEach((G, i) => G.el.classList.toggle('focused', i === state.code.focus && P.groups.length > 1));
  }
  function codeRenderTabsOnly() {
    const P = codePane;
    if (!P) return;
    state.code.groups.forEach((g, gi) => {
      const G = P.groups[gi];
      if (!G) return;
      const names = new Map();
      for (const t of g.tabs) names.set(basename(t), (names.get(basename(t)) || 0) + 1);
      G.tabsEl.replaceChildren(
        ...g.tabs.map((file) => {
          const dirty = codeIsDirty(file);
          const f = P.files.get(file);
          const dup = names.get(basename(file)) > 1;
          return h(`div.ed-tab${file === g.active ? '.active' : ''}${dirty ? '.dirty' : ''}${f && f.conflict ? '.conflict' : ''}`, {
            title: `${tilde(file)}${dirty ? ' (sin guardar)' : ''}`,
            draggable: 'true',
            onclick: () => { g.active = file; state.code.focus = gi; save(); codeShowActive(gi); codeRenderTabsOnly(); codeRenderFocus(); codeRenderStatus(); codeMarkTreeActive(); if (state.code.side === 'tree') codeReveal(file, true); codeFocusEditor(gi); },
            onauxclick: (e) => { if (e.button === 1) codeCloseTab(gi, file); },
            oncontextmenu: (e) => codeTabMenu(e, gi, file),
            ondragstart: (e) => { P.dragTab = { gi, file }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', file); },
            ondragend: () => { P.dragTab = null; },
          },
          h('span.code-tname', `${f && f.isDir ? '📁 ' : ''}${basename(file) || file}`),
          dup ? h('span.muted.code-tdir', basename(file.slice(0, file.lastIndexOf('/')))) : null,
          h('span.x', { title: dirty ? 'Sin guardar · cerrar' : 'Cerrar (clic central también)', onclick: (e) => { e.stopPropagation(); codeCloseTab(gi, file); } }, dirty ? '●' : '✕'));
        }),
        h('span.grow'),
        h('div.code-gbtns',
          g.active && canPreview(g.active) ? h(`button.mini.code-prevbtn${codePreviewOn(g.active) ? '.on' : ''}`, {
            title: `${codePreviewOn(g.active) ? 'Volver al editor' : 'Ver el archivo renderizado'} (Ctrl+Shift+V)`,
            onclick: () => codeTogglePreview(gi),
          }, codePreviewOn(g.active) ? '✎ Editar' : '👁 Vista previa') : null,
          gs_len() < CODE_MAX_GROUPS ? h('button.icon.mini', { title: 'Dividir: abrir en un panel nuevo (Ctrl+\\, máx. 4)', onclick: () => codeSplit(gi) }, '◫') : null,
          gs_len() > 1 ? h('button.icon.mini', { title: 'Cerrar este panel', onclick: () => codeCloseGroup(gi) }, '✕') : null));
      const a = G.tabsEl.querySelector('.ed-tab.active');
      if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  const gs_len = () => state.code.groups.length;
  const codePreviewOn = (file) => !!(state.code.preview && state.code.preview[file]) && canPreview(file);
  /** Alterna editor ⇄ vista previa del archivo activo del panel (se recuerda por archivo). */
  function codeTogglePreview(gi = state.code.focus) {
    const g = state.code.groups[gi];
    if (!g || !g.active || !canPreview(g.active)) return;
    const pv = state.code.preview || (state.code.preview = {});
    if (pv[g.active]) delete pv[g.active]; else pv[g.active] = true;
    save();
    state.code.groups.forEach((gg, i) => { if (gg.active === g.active) codeShowActive(i); });
    codeRenderTabsOnly();
    if (!pv[g.active]) codeFocusEditor(gi);
  }

  /** Muestra en el grupo su pestaña activa (editor, imagen, binario, error o bienvenida). */
  function codeShowActive(gi) {
    const P = codePane;
    const g = state.code.groups[gi];
    const G = P.groups[gi];
    if (!g || !G) return;
    const file = g.active;
    G.shown = file;
    const f = file ? P.files.get(file) : null;
    const keepScroll = G.preview && G.preview.dataset.file === file ? G.preview.scrollTop : 0; // repintar la vista previa sin saltar arriba
    if (G.preview) { G.preview.remove(); G.preview = null; }
    const showMsg = (...kids) => { G.preview = h('div.code-msg', ...kids); G.bodyEl.append(G.preview); if (G.cm) G.cm.getWrapperElement().classList.add('hidden'); };
    codeRenderBanner(gi);
    if (!file) {
      showMsg(h('div.code-welcome',
        h('h3', 'Editor'),
        h('p.muted', 'Abre un archivo desde el árbol, o:'),
        h('p', h('kbd', 'Ctrl+P'), ' abrir por nombre · ', h('kbd', 'Ctrl+Shift+F'), ' buscar en archivos'),
        h('p', h('kbd', 'Ctrl+S'), ' guardar · ', h('kbd', 'Ctrl+F'), ' buscar · ', h('kbd', 'Ctrl+H'), ' reemplazar · ', h('kbd', 'Ctrl+G'), ' ir a línea'),
        h('p', h('kbd', 'Ctrl+\\'), ' dividir (hasta 4) · ', h('kbd', 'Ctrl+D'), ' siguiente coincidencia · ', h('kbd', 'Ctrl+/'), ' comentar'),
        h('p', h('kbd', 'Ctrl+Alt+C'), ' copiar ruta:línea · ', h('kbd', 'Ctrl+Alt+I'), ' enviar a la IA · clic derecho: más'),
        h('p.muted', 'Las rutas que muestran claude/codex/opencode en la terminal se abren aquí con un clic.')));
      return;
    }
    if (!Bridge.ready && (!f || f.loading)) { showMsg(h('p.muted', 'Esperando al bridge…')); return; }
    if (!f || f.loading || (f.isDir && !f.dirList && !f.error)) {
      showMsg(h('p.muted', 'Cargando…'));
      codeLoad(file).then(() => { const gg = state.code.groups[gi]; if (codePane === P && gg && gg.active === file) codeShowActive(gi); });
      return;
    }
    if (f.error) { showMsg(h('p', f.error), h('p.muted.mono', tilde(file)), h('button', { onclick: async () => { f.error = null; await codeLoad(file, true); codeShowActive(gi); } }, 'Reintentar')); return; }
    if (f.dirList) {
      G.preview = h('div.code-preview.code-dirwrap', renderDirView(gi, file, f));
      G.bodyEl.append(G.preview);
      if (G.cm) G.cm.getWrapperElement().classList.add('hidden');
      return;
    }
    if (f.media) {
      G.preview = h('div.code-preview.code-media', renderMedia(file, f.media));
      G.bodyEl.append(G.preview);
      if (G.cm) G.cm.getWrapperElement().classList.add('hidden');
      return;
    }
    if (f.binary) { showMsg(h('p', 'Archivo binario: no se puede editar aquí.'), h('p.muted.mono', tilde(file)), h('button', { onclick: () => openExternal(file) }, `Abrir en ${extEditorName()}`)); return; }
    if (codePreviewOn(file)) {
      if (!f.previewHook) {
        // cambios en el texto (tecleo, recarga del disco al editarlo una IA): se repinta la vista previa
        f.previewHook = debounce(() => state.code.groups.forEach((gg, i) => {
          if (!codePane || gg.active !== file || !codePreviewOn(file)) return;
          const P = codePane.groups[i];
          if (P && P.preview && P.preview.contains(document.activeElement) && document.activeElement.isContentEditable) return; // editando una celda
          codeShowActive(i);
        }), 350);
        f.master.on('change', f.previewHook);
      }
      // la vista previa edita el documento (como teclear): queda "sin guardar" y se guarda con Ctrl+S
      const edit = (fn) => {
        const cur = f.master.getValue();
        const next = fn(cur);
        if (next == null || next === cur) return;
        // solo el tramo que cambió (cursor, historial y deshacer como una edición normal)
        let a = 0;
        while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
        let b = 0;
        while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
        f.master.replaceRange(next.slice(a, next.length - b), f.master.posFromIndex(a), f.master.posFromIndex(cur.length - b), '+preview');
        codeRenderTabsOnly();
        codeRenderStatus();
      };
      G.preview = h('div.code-preview', { tabindex: '-1' }, renderPreview(file, f.master.getValue(), { edit }));
      G.preview.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); codeSave(gi); }
        else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !e.target.isContentEditable) { e.preventDefault(); f.master.undo(); }
      });
      G.preview.dataset.file = file;
      G.bodyEl.append(G.preview);
      if (keepScroll) G.preview.scrollTop = keepScroll;
      if (G.cm) G.cm.getWrapperElement().classList.add('hidden');
      return;
    }
    const cm = codeEnsureCm(G);
    if (!cm) { showMsg(h('p', 'No se cargó CodeMirror (src/vendor/codemirror).')); return; }
    cm.getWrapperElement().classList.remove('hidden');
    const d = codeDocFor(G, file, f);
    if (cm.getDoc() !== d) {
      cm.swapDoc(d);
      const fresh = !d.frapSeen;
      d.frapSeen = true;
      const cur = state.code.cursors[file];
      if (fresh && cur) { cm.setCursor({ line: cur[0], ch: cur[1] }); requestAnimationFrame(() => cm.scrollIntoView(null, cm.getScrollInfo().clientHeight / 3)); }
    }
    cm.setOption('readOnly', false);
    requestAnimationFrame(() => cm.refresh());
  }
  function codeRenderBanner(gi) {
    const G = codePane.groups[gi];
    const g = state.code.groups[gi];
    const f = g && g.active ? codePane.files.get(g.active) : null;
    if (!f || !f.conflict) { G.banner.classList.add('hidden'); return; }
    G.banner.classList.remove('hidden');
    G.banner.replaceChildren(...[
      h('span', f.conflict.gone ? '⚠ El archivo ya no existe en disco.' : '⚠ El archivo cambió en disco (¿una IA?) y aquí tienes cambios sin guardar.'),
      h('span.grow'),
      f.conflict.gone ? null : h('button.mini', { onclick: () => codeResolve(g.active, 'disk') }, 'Usar la del disco'),
      h('button.mini', { onclick: () => codeResolve(g.active, 'mine') }, f.conflict.gone ? 'Guardar de nuevo' : 'Guardar la mía'),
      h('button.mini', { onclick: () => codeResolve(g.active, 'later') }, 'Decidir luego')].filter(Boolean));
  }
  async function codeResolve(file, how) {
    const f = codePane.files.get(file);
    if (!f || !f.conflict) return;
    const disk = f.conflict;
    f.conflict = null;
    if (how === 'disk') {
      codeReplaceText(file, f, disk.content);
      Object.assign(f, { saved: disk.content, gen: f.master.changeGeneration(true), mtime: disk.mtime });
    } else if (how === 'mine') {
      f.mtime = disk.mtime || 0;
      await codeSaveFile(file, true);
    } else f.ignoreMtime = disk.mtime;
    codeRenderGroupsFor(file);
  }
  function codeRenderGroupsFor(file) {
    state.code.groups.forEach((g, i) => { if (g.active === file) codeRenderBanner(i); });
    codeRenderTabsOnly();
    codeRenderStatus();
  }

  function codeSplit(gi) {
    const c = state.code;
    if (c.groups.length >= CODE_MAX_GROUPS) { toast('Máximo 4 paneles', 'err'); return; }
    const cur = c.groups[gi] && c.groups[gi].active;
    c.groups.splice(gi + 1, 0, { tabs: cur ? [cur] : [], active: cur });
    c.focus = gi + 1;
    save();
    codeRebuildGroups();
    requestAnimationFrame(() => codeFocusEditor(gi + 1));
  }
  /** Tras insertar/quitar grupos en medio: se rehacen los paneles (los documentos maestros se conservan). */
  function codeRebuildGroups() {
    const P = codePane;
    for (const G of P.groups) { for (const [k, d] of G.docs) { const f = P.files.get(k); if (f && f.master) f.master.unlinkDoc(d); } G.el.remove(); }
    P.groups = [];
    codeRenderGroups();
    codeRenderStatus();
  }
  async function codeCloseGroup(gi) {
    const c = state.code;
    const g = c.groups[gi];
    if (!g) return;
    const lost = g.tabs.filter((f) => codeIsDirty(f) && !c.groups.some((o, j) => j !== gi && o.tabs.includes(f)));
    if (lost.length && !(await confirmBox('Cerrar panel', `Hay cambios sin guardar en ${lost.map(basename).join(', ')}. ¿Cerrar y descartarlos?`))) return;
    c.groups.splice(gi, 1);
    if (!c.groups.length) c.groups.push({ tabs: [], active: null });
    c.focus = Math.min(c.focus, c.groups.length - 1);
    save();
    codeRebuildGroups();
  }
  function codeMoveTab(from, file, to) {
    const c = state.code;
    if (from === to || !c.groups[from] || !c.groups[to]) return;
    const a = c.groups[from];
    a.tabs = a.tabs.filter((x) => x !== file);
    if (a.active === file) a.active = a.tabs[a.tabs.length - 1] || null;
    const b = c.groups[to];
    if (!b.tabs.includes(file)) b.tabs.push(file);
    b.active = file;
    c.focus = to;
    if (!a.tabs.length && c.groups.length > 1) c.groups.splice(from, 1);
    c.focus = Math.min(c.focus, c.groups.length - 1);
    save();
    codeRebuildGroups();
  }
  async function codeCloseTab(gi, file) {
    const c = state.code;
    const g = c.groups[gi];
    if (!g || !file) return;
    const elsewhere = c.groups.some((o, j) => j !== gi && o.tabs.includes(file));
    if (!elsewhere && codeIsDirty(file)) {
      const ok = await confirmBox('Cerrar sin guardar', `${basename(file)} tiene cambios sin guardar. ¿Cerrar y descartarlos?`);
      if (!ok) return;
    }
    const i = g.tabs.indexOf(file);
    g.tabs = g.tabs.filter((x) => x !== file);
    if (g.active === file) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] || null;
    const G = codePane.groups[gi];
    const d = G && G.docs.get(file);
    if (d) { const f = codePane.files.get(file); if (f && f.master) f.master.unlinkDoc(d); G.docs.delete(file); if (G.cm && G.cm.getDoc() === d) { G.cm.swapDoc(new CodeMirror.Doc('')); G.shown = null; } }
    if (!g.tabs.length && c.groups.length > 1) { c.groups.splice(gi, 1); c.focus = Math.min(c.focus, c.groups.length - 1); save(); codeRebuildGroups(); return; }
    save();
    codeRenderGroups();
    codeRenderStatus();
  }
  function codeCloseEverywhere(file) {
    for (const g of state.code.groups) { g.tabs = g.tabs.filter((x) => x !== file); if (g.active === file) g.active = g.tabs[g.tabs.length - 1] || null; }
    const P = codePane;
    for (const G of P.groups) { const d = G.docs.get(file); if (d) { if (G.cm && G.cm.getDoc() === d) { G.cm.swapDoc(new CodeMirror.Doc('')); G.shown = null; } G.docs.delete(file); } }
    P.files.delete(file);
    save();
  }
  /** Suelta los documentos que ya no están abiertos en ninguna pestaña. */
  function codeGcDocs() {
    const P = codePane;
    const open = new Set(codeOpenPaths());
    for (const G of P.groups) for (const [k, d] of [...G.docs]) if (!state.code.groups[G.index] || !state.code.groups[G.index].tabs.includes(k)) { const f = P.files.get(k); if (f && f.master) f.master.unlinkDoc(d); G.docs.delete(k); }
    for (const k of [...P.files.keys()]) if (!open.has(k)) P.files.delete(k);
  }
  function codeTabMenu(ev, gi, file) {
    const c = state.code;
    popMenu(ev, [
      { label: 'Guardar', hint: 'Ctrl+S', disabled: !codeIsDirty(file), action: () => codeSaveFile(file, true) },
      '-',
      { label: 'Copiar ruta', action: () => codeCopy(file) },
      { label: 'Copiar ruta relativa', action: () => codeCopy(codeRel(file)) },
      { label: 'Enviar ruta a la IA', hint: 'Ctrl+Alt+I', action: () => codeSendToAi(file) },
      { label: 'Revelar en el árbol', action: () => codeReveal(file) },
      { label: 'Mostrar en el explorador de archivos', action: () => openInFileManager(file) },
      '-',
      c.groups.length < CODE_MAX_GROUPS && { label: 'Dividir: abrir en panel nuevo', hint: 'Ctrl+\\', action: () => { c.groups[gi].active = file; codeSplit(gi); } },
      ...c.groups.map((_, j) => j !== gi && { label: `Mover al panel ${j + 1}`, action: () => codeMoveTab(gi, file, j) }),
      { label: `Abrir en ${extEditorName()}`, action: () => openExternal(file) },
      '-',
      { label: 'Cerrar', action: () => codeCloseTab(gi, file) },
      { label: 'Cerrar las demás', action: async () => { for (const t of c.groups[gi].tabs.filter((x) => x !== file)) await codeCloseTab(gi, t); } },
    ]);
  }

  // ----- copiar rutas / pasar a la IA -----
  function codeCopy(text) { copyText(text); toast(`Copiado: ${text.length > 80 ? `${text.slice(0, 77)}…` : text}`, 'ok'); }
  /** "ruta:12" o "ruta:12-20" según la selección del grupo. */
  function codeLineRef(G, file, rel) {
    const p = rel ? codeRel(file) : file;
    if (!G || !G.cm) return p;
    const a = G.cm.getCursor('from');
    const b = G.cm.getCursor('to');
    const endLine = b.ch === 0 && b.line > a.line ? b.line : b.line + 1; // selección hasta el inicio de la línea siguiente
    return a.line + 1 === endLine ? `${p}:${a.line + 1}` : `${p}:${a.line + 1}-${endLine}`;
  }
  /** Ctrl+Alt+C: ruta:línea(s) · Ctrl+Shift+Alt+C: ruta:líneas + el código seleccionado en un bloque ``` . */
  function codeCopyRef(G, withCode) {
    const file = state.code.groups[G.index] && state.code.groups[G.index].active;
    if (!file) return;
    const ref = codeLineRef(G, file, true);
    if (!withCode) { codeCopy(ref); return; }
    const sel = G.cm.getSelection() || G.cm.getLine(G.cm.getCursor().line);
    const lang = (codeModeName(codeModeFor(file)) || '').toLowerCase().replace(/[^a-z0-9+#-]/g, '');
    codeCopy(`${ref}\n\`\`\`${lang}\n${sel.replace(/\n$/, '')}\n\`\`\``);
  }
  /** Terminal de IA a la que mandar referencias: la última IA usada del proyecto (o cualquiera viva). */
  function codeAiTarget() {
    const list = sessionsOf(state.activeProject).filter((t) => VOICE_KINDS.includes(termKind(t)) && t.info.alive !== false);
    return list.find((t) => t.sid === lastAiSid) || list[list.length - 1] || null;
  }
  function codeSendToAi(file, ref) {
    const t = codeAiTarget();
    if (!t) { toast('No hay ninguna terminal de claude, codex u opencode abierta en este proyecto', 'err'); return; }
    const cwd = (t.info.meta || {}).cwd || '';
    const text = ref ? ref.replace(file, codeRelTo(file, cwd)) : codeRelTo(file, cwd);
    activate(t.sid);
    Bridge.send('session.input', { sid: t.sid, data: `${text} ` });
    toast(`Enviado a ${termTitle(t)}: ${text}`, 'ok');
  }
  /** Ctrl+Alt+I: manda "ruta:líneas" a la IA (ella lee el archivo). */
  function codeSendSel(G) {
    const file = state.code.groups[G.index] && state.code.groups[G.index].active;
    if (file) codeSendToAi(file, codeLineRef(G, file, false));
  }
  function codeEditorMenu(ev, G) {
    const file = state.code.groups[G.index] && state.code.groups[G.index].active;
    if (!file || !G.cm) return;
    const cm = G.cm;
    const has = cm.somethingSelected();
    popMenu(ev, [
      { label: 'Copiar', hint: 'Ctrl+C', disabled: !has, action: () => { copyText(cm.getSelection()); cm.focus(); } },
      { label: 'Cortar', hint: 'Ctrl+X', disabled: !has, action: () => { copyText(cm.getSelection()); cm.replaceSelection(''); cm.focus(); } },
      { label: 'Pegar', hint: 'Ctrl+V', action: async () => { try { cm.replaceSelection(await navigator.clipboard.readText()); } catch (_) { toast('El navegador no permite pegar desde el menú: usa Ctrl+V', 'err'); } cm.focus(); } },
      '-',
      { label: `Copiar ${codeLineRef(G, file, true)}`, hint: 'Ctrl+Alt+C', action: () => codeCopyRef(G, false) },
      { label: 'Copiar referencia + código', hint: 'Ctrl+Shift+Alt+C', action: () => codeCopyRef(G, true) },
      { label: 'Copiar ruta absoluta', action: () => codeCopy(file) },
      { label: 'Enviar a la IA (ruta:líneas)', hint: 'Ctrl+Alt+I', action: () => codeSendSel(G) },
      '-',
      { label: 'Buscar', hint: 'Ctrl+F', action: () => cm.execCommand('find') },
      { label: 'Reemplazar', hint: 'Ctrl+H', action: () => cm.execCommand('replace') },
      { label: 'Buscar en archivos', hint: 'Ctrl+Shift+F', action: () => codeSearchSelection(G) },
      { label: 'Ir a la línea', hint: 'Ctrl+G', action: () => cm.execCommand('jumpToLine') },
      { label: 'Comentar / descomentar', hint: 'Ctrl+/', action: () => cm.execCommand('toggleComment') },
      { label: state.code.wrap ? 'Sin ajuste de línea' : 'Ajustar líneas', hint: 'Alt+Z', action: () => codeToggleWrap() },
    ]);
  }
  function codeSearchSelection(G) {
    const sel = G && G.cm ? G.cm.getSelection() : '';
    if (sel && !sel.includes('\n')) { codePane.search.query = sel; const i = codePane.searchEl.querySelector('input.code-q'); if (i) i.value = sel; }
    codeSetSide('search');
    if (sel && !sel.includes('\n')) codeRunSearch();
  }
  function codeToggleWrap() {
    state.code.wrap = !state.code.wrap;
    save();
    for (const G of codePane.groups) if (G.cm) G.cm.setOption('lineWrapping', state.code.wrap);
    codeRenderStatus();
  }

  // ----- guardar y vigilar cambios en disco -----
  async function codeSave(gi) {
    const g = state.code.groups[gi];
    if (g && g.active) await codeSaveFile(g.active, true);
  }
  async function codeSaveAll() {
    const dirty = codeOpenPaths().filter(codeIsDirty);
    for (const f of dirty) await codeSaveFile(f, true);
    if (!dirty.length) toast('No hay cambios sin guardar', 'ok');
  }
  async function codeSaveFile(file, explicit) {
    const P = codePane;
    const f = P && P.files.get(file);
    if (!f || !f.master) return false;
    const text = f.master.getValue();
    if (cfgFiles.has(file) && file.endsWith('.json')) {
      try { JSON.parse(text); } catch (e) { toast(`JSON inválido: ${e.message}`, 'err'); return false; }
    }
    try {
      if (f.mtime) {
        const st = (await Bridge.call('fs.stat', { paths: [file] }))[0];
        if (st && st.exists && st.mtime !== f.mtime && st.mtime !== f.ignoreMtime && !f.conflict) {
          const disk = await Bridge.call('fs.read', { path: file });
          if (disk.content !== f.saved) { f.conflict = disk; codeRenderGroupsFor(file); toast(`${basename(file)} cambió en disco: elige qué versión quedarse`, 'err'); return false; }
        }
      }
      const gen = f.master.changeGeneration(true);
      const r = await Bridge.call('fs.write', { path: file, content: text });
      Object.assign(f, { saved: text, gen, mtime: r.mtime, exists: true, conflict: null, ignoreMtime: null });
      if (explicit) toast(`Guardado ${basename(file)}`, 'ok');
      codeRenderGroupsFor(file);
      if (cfgFiles.has(file)) loadConfig(true); // agentes, skills, hooks, memoria: refresca el panel derecho
      return true;
    } catch (e) { toast(e.message, 'err'); return false; }
  }
  async function codePoll() {
    const P = codePane;
    if (!P || viewKind(state.activeSid) !== 'code' || document.hidden || !Bridge.ready || modalClose) return;
    const files = [...P.files.entries()].filter(([, f]) => f.master && f.mtime && !f.loading).map(([k]) => k);
    if (!files.length) return;
    let stats;
    try { stats = await Bridge.call('fs.stat', { paths: files }); } catch (_) { return; }
    if (codePane !== P) return;
    for (const st of stats) {
      const f = P.files.get(st.path);
      if (!f || !f.master || f.conflict) continue;
      if (!st.exists) {
        if (!f.gone) { f.gone = true; if (codeIsDirty(st.path)) { f.conflict = { gone: true }; codeRenderGroupsFor(st.path); } else toast(`${basename(st.path)} ya no existe en disco`, 'err'); }
        continue;
      }
      f.gone = false;
      if (st.mtime === f.mtime || st.mtime === f.ignoreMtime) continue;
      let disk;
      try { disk = await Bridge.call('fs.read', { path: st.path }); } catch (_) { continue; }
      if (codePane !== P || !P.files.has(st.path)) return;
      if (disk.content === f.saved) { f.mtime = disk.mtime; continue; }
      if (codeIsDirty(st.path)) { f.conflict = disk; codeRenderGroupsFor(st.path); continue; }
      codeReplaceText(st.path, f, disk.content);
      Object.assign(f, { saved: disk.content, gen: f.master.changeGeneration(true), mtime: disk.mtime });
      codeRenderGroupsFor(st.path);
    }
  }
  setInterval(codePoll, 2500);
  // al (re)conectar el bridge: árbol y pestañas que no pudieron cargarse
  Bridge.on('open', () => {
    for (const p of viewPanes.values()) {
      if (!p || p.kind !== 'code') continue;
      for (const [k, f] of [...p.files]) if (f.error && /Bridge desconectado/.test(f.error)) p.files.delete(k);
      p.dirs.clear();
      for (const G of p.groups) G.shown = undefined;
    }
    if (codePane) codeRenderAll();
  });
  window.addEventListener('focus', codePoll);
  window.addEventListener('beforeunload', (e) => {
    if (!codePane) return;
    const anyDirty = [...viewPanes.values()].some((p) => p && p.kind === 'code' && [...p.files.values()].some((f) => f.master && !f.master.isClean(f.gen)));
    if (anyDirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ----- barra de estado y foco -----
  function codeRenderStatus() {
    const P = codePane;
    if (!P) return;
    const gi = state.code.focus;
    const g = state.code.groups[gi];
    const G = P.groups[gi];
    const file = g && g.active;
    const f = file ? P.files.get(file) : null;
    const dirtyN = codeOpenPaths().filter(codeIsDirty).length;
    const parts = [];
    if (file) {
      parts.push(h('span.mono.code-spath', { title: `${file}\nClic: copiar ruta:línea`, onclick: () => G && codeCopyRef(G, false) }, codeRel(file)));
      if (G && G.cm && f && f.master) {
        const cur = G.cm.getCursor();
        const sel = G.cm.getSelection();
        parts.push(h('span', `Ln ${cur.line + 1}, Col ${cur.ch + 1}${sel ? ` (${sel.length} sel.)` : ''}`));
        parts.push(h('span', codeModeName(f.mode)));
        parts.push(h('span', { title: 'Ajuste de línea (Alt+Z)', class: `code-sbtn${state.code.wrap ? ' on' : ''}`, onclick: () => codeToggleWrap() }, 'Ajustar'));
      }
    }
    parts.push(h('span.grow'));
    if (dirtyN) parts.push(h('span.code-sbtn.dirty', { title: 'Guardar todo (Ctrl+Alt+S)', onclick: () => codeSaveAll() }, `● ${dirtyN} sin guardar`));
    const ai = codeAiTarget();
    parts.push(h('span.muted', { title: 'Ctrl+Alt+I envía ruta:líneas a esta terminal' }, ai ? `IA: ${termTitle(ai)}` : 'sin IA abierta'));
    if (!state.code.side) parts.push(h('span.code-sbtn', { title: 'Mostrar el árbol de archivos', onclick: () => codeSetSide('tree') }, 'Archivos'));
    P.statusEl.replaceChildren(...parts);
    if (viewKind(state.activeSid) === 'code') $('#st-cwd').textContent = file ? tilde(file) : codeRoots().map(tilde).join('  +  ');
  }
  function codeFocusEditor(gi = state.code && state.code.focus) {
    const P = codePane;
    if (!P || viewKind(state.activeSid) !== 'code') return;
    const G = P.groups[gi];
    if (!G) return;
    if (state.code.focus !== gi) { state.code.focus = gi; save(); codeRenderFocus(); codeRenderStatus(); }
    if (G.cm && !G.cm.getWrapperElement().classList.contains('hidden')) G.cm.focus();
  }
  /** Tras cambiar de tamaño o volver a mostrarse (CodeMirror mide al dibujar). */
  function codeRefreshEditors() {
    for (const p of viewPanes.values()) if (p && p.kind === 'code' && p.root && !p.root.classList.contains('hidden')) for (const G of p.groups) if (G.cm) G.cm.refresh();
  }

  /** Abre un archivo en el editor de FRAP (clic en una ruta de la terminal). pid: proyecto de la terminal. */
  async function openInFrap(file, line, col, isDir, pid, extra = {}) {
    const owner = state.projects.find((p) => p.folders.some((f) => file === f.replace(/\/+$/, '') || file.startsWith(`${f.replace(/\/+$/, '')}/`)));
    const target = (pid && project(pid)) || owner || project();
    if (!target) { toast('Primero crea o selecciona un proyecto', 'err'); return; }
    state.activeProject = target.id;
    openCodeView();
    ensureCodePane();
    if (isDir) {
      const dir = String(file).replace(/\/+$/, '') || '/';
      await codeRevealDir(dir);
      await codeOpenDir(dir);
      return;
    }
    await codeOpenFile(file, { line, col, ...extra });
  }
  /** Abre una carpeta como pestaña del editor (vista de sus archivos). */
  async function codeOpenDir(dir) {
    const f0 = codePane.files.get(dir);
    if (!f0 || !f0.isDir) codePane.files.set(dir, { isDir: true });
    await codeOpenFile(dir);
  }
  async function codeRevealDir(dir, quiet) {
    dir = String(dir).replace(/\/+$/, '') || '/';
    let { roots, ext } = codeTreeRoots();
    if (![...roots, ...ext].some((x) => dir === x || dir.startsWith(`${x}/`))) {
      // fuera del proyecto: se muestra como raíz aparte en el árbol (↗ ruta)
      state.code.extDirs = [...(state.code.extDirs || []).filter((d) => !d.startsWith(`${dir}/`)), dir];
      ({ roots, ext } = codeTreeRoots());
    }
    const r = [...roots, ...ext].sort((a, b) => b.length - a.length).find((x) => dir === x || dir.startsWith(`${x}/`));
    if (!r) { toast('No se pudo mostrar la carpeta', 'err'); return; }
    const add = new Set(state.code.expanded);
    add.delete(`!${r}`);
    let d = dir;
    while (d.length > r.length) { add.add(d); d = d.slice(0, d.lastIndexOf('/')); }
    state.code.expanded = [...add];
    if (!quiet) state.code.side = 'tree';
    save();
    if (!quiet) codeRenderSide();
    if (state.code.side !== 'tree') return;
    await codeRenderTree();
    const el = [...codePane.treeEl.querySelectorAll('.code-node')].find((n) => n.dataset.path === dir);
    if (el) el.scrollIntoView({ block: quiet ? 'nearest' : 'center' });
  }

  /** ¿Hay cambios sin guardar en el editor de una vista? (para avisar al cerrarla). */
  function codeViewDirty(v) {
    const p = viewPanes.get(vSid(v));
    return !!(p && p.kind === 'code' && [...p.files.values()].some((f) => f.master && !f.master.isClean(f.gen)));
  }

  // ----- menú contextual genérico -----
  let popMenuEl = null;
  function closePopMenu() { if (popMenuEl) { popMenuEl.remove(); popMenuEl = null; } }
  /** items: [{label, hint, action, disabled, danger} | '-' | falsy]. */
  function popMenu(ev, items) {
    ev.preventDefault();
    ev.stopPropagation();
    closePopMenu();
    const list = items.filter(Boolean).filter((it, i, a) => it !== '-' || (i > 0 && a[i - 1] !== '-' && i < a.length - 1));
    const m = h('div.popmenu', { oncontextmenu: (e) => e.preventDefault() }, list.map((it) => (it === '-' ? h('div.popmenu-sep') : h(`button${it.danger ? '.danger' : ''}`, {
      disabled: it.disabled || null,
      onclick: () => { closePopMenu(); it.action(); },
    }, h('span', it.label), it.hint ? h('span.muted', it.hint) : null))));
    document.body.append(m);
    const r = m.getBoundingClientRect();
    m.style.left = `${Math.max(4, Math.min(ev.clientX, innerWidth - r.width - 4))}px`;
    m.style.top = `${Math.max(4, Math.min(ev.clientY, innerHeight - r.height - 4))}px`;
    popMenuEl = m;
  }
  document.addEventListener('mousedown', (e) => { if (popMenuEl && !popMenuEl.contains(e.target)) closePopMenu(); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popMenuEl) { closePopMenu(); e.stopPropagation(); } }, true);
  window.addEventListener('blur', closePopMenu);

  // ---------- Pendientes (panel izquierdo): tareas locales con prioridad, estado, dependencias y su sesión de IA ----------
  // Viven en local/pendientes/pendientes.json. La IA los crea desde su sesión con la skill frap-pendientes (frap-todo add):
  // quedan vinculados a esa sesión, y el botón → la vuelve a abrir en el panel central (o la reabre si ya no existe).
  let todosInfo = null;
  let todosSkillSynced = null;
  let todoOpen = null; // id del pendiente desplegado
  const TODO_ESTADOS = [['pendiente', '○', 'Pendiente'], ['en curso', '◐', 'En curso'], ['bloqueado', '⛔', 'Bloqueado'], ['hecho', '✓', 'Hecho']];
  const todoEstado = (e) => TODO_ESTADOS.find((x) => x[0] === e) || TODO_ESTADOS[0];
  const TODO_ICONS = ['', '🔧', '🐛', '🚀', '📝', '🔍', '🧪', '📦', '🗄️', '🌐', '💬', '📞', '📧', '⚠️', '💡', '🔒', '🎨', '📊'];
  async function loadTodos() {
    if (!Bridge.ready || !rtabOn('todos')) { renderTodos(); return; }
    try { todosInfo = await Bridge.call('todos.list'); } catch (e) { todosInfo = { error: e.message, todos: [] }; }
    renderTodos();
  }
  async function syncTodosSkill(force) {
    if (!Bridge.ready) return;
    const on = rtabOn('todos');
    if (!force && todosSkillSynced === on) return;
    try {
      const r = await Bridge.call('todos.setSkill', { on });
      todosSkillSynced = on;
      if (r.changed.length) toast(on ? 'Skill frap-pendientes lista en claude y codex' : 'Skill frap-pendientes quitada de claude y codex', 'ok');
    } catch (e) { toast(`Skill frap-pendientes: ${e.message}`, 'err'); }
  }
  async function todoSave(todo, quiet) {
    const prev = todo.id != null && todosInfo ? (todosInfo.todos || []).find((x) => x.id === Number(todo.id)) : null;
    try {
      const t = await Bridge.call('todos.save', { todo });
      await loadTodos();
      if (!quiet) toast(`Pendiente #${t.id} guardado`, 'ok');
      if (t.estado === 'hecho' && prev && prev.estado !== 'hecho') todoNotifyDone(t); // lo marcó el usuario: avisar a su sesión de IA
      return t;
    } catch (e) { toast(e.message, 'err'); return null; }
  }
  /** Avisa a la sesión de IA del pendiente que el usuario lo marcó como hecho (y qué pendientes de esa sesión quedan libres). */
  function todoNotifyDone(t) {
    const sid = t.session && t.session.sid;
    if (!sid) return;
    const term = terms.get(sid);
    if (!term || term.info.alive === false) { toast(`#${t.id} hecho · su sesión de IA ya no está abierta: no se le avisó`); return; }
    const all = (todosInfo && todosInfo.todos) || [];
    const freed = all.filter((x) => x.estado !== 'hecho' && (x.depends || []).includes(t.id) && !(x.blockedBy || []).length && x.session && x.session.sid === sid);
    const msg = `✅ Aviso de FRAP: el usuario marcó como hecho el pendiente #${t.id} «${t.title}» (skill frap-pendientes).${freed.length ? ` Ya se pueden empezar: ${freed.map((x) => `#${x.id} «${x.title}»`).join(', ')}.` : ''} Tenlo en cuenta; si estabas trabajando en él, no sigas con eso.`;
    Bridge.send('session.input', { sid, data: msg });
    setTimeout(() => Bridge.send('session.input', { sid, data: '\r' }), 120);
    toast(`#${t.id} hecho · aviso enviado a «${termTitle(term)}»`, 'ok');
  }
  /** Proyecto de un pendiente: el de su sesión o el que contiene su carpeta. */
  function todoProject(t) {
    const s = t.session;
    if (!s) return null;
    return project(s.projectId) || state.projects.find((p) => p.folders.some((f) => s.cwd === f || (s.cwd || '').startsWith(`${f.replace(/\/+$/, '')}/`))) || null;
  }
  /** → sesión: si sigue abierta la activa; si no, la reabre en su carpeta retomando su conversación de claude. */
  async function todoGoSession(t, onNew) {
    const s = t.session;
    if (!s) { toast('Este pendiente no está vinculado a una sesión de IA', 'err'); return; }
    if (s.sid && terms.has(s.sid)) {
      const p = todoProject(t);
      if (p && modOn('left.sections')) { const sec = activeSection(); if (!sectionProjects(sec).some((x) => x.id === p.id)) { state.ui.section = 'all'; } }
      activate(s.sid);
      return;
    }
    const p = todoProject(t);
    if (!p) { toast(`La sesión ya no existe y su carpeta (${tilde(s.cwd || '?')}) no es de ningún proyecto`, 'err'); return; }
    if (!(await confirmBox(`¿Reabrir la sesión «${s.title || 'claude'}»?`, `Ya no está abierta. Se abre una terminal de ${s.kind || 'claude'} en ${tilde(s.cwd || p.folders[0])}${s.agent && s.agent.session ? ' retomando su conversación (claude --resume)' : ''}.`))) return;
    state.activeProject = p.id;
    if (modOn('left.sections') && !sectionProjects(activeSection()).some((x) => x.id === p.id)) state.ui.section = 'all';
    const kind = ['claude', 'codex', 'opencode'].includes(s.kind) ? s.kind : 'claude';
    const resume = s.agent && s.agent.tool === 'claude' && /^[0-9a-f-]{36}$/i.test(s.agent.session || '') ? `${buildLaunch('claude', p)} --resume ${s.agent.session}` : undefined;
    await launch(kind, { cwd: s.cwd || p.folders[0], title: s.title || undefined, init: resume });
    const nt = activeTerm();
    if (nt) await (onNew ? onNew({ ...s, sid: nt.sid, projectId: p.id }) : todoSave({ id: t.id, session: { ...s, sid: nt.sid, projectId: p.id } }, true)); // queda con la sesión nueva
  }
  /** 📌 en las terminales de IA: le pide a la IA guardar su última lista como pendientes (se escribe sin Enter). */
  function todoAskSave(t) {
    Bridge.send('session.input', { sid: t.sid, data: 'Guarda la lista de pasos que acabas de darme como pendientes (skill frap-pendientes): uno por paso, con prioridad y dependencias.' });
    activate(t.sid);
    toast('Escrito en la terminal: revísalo y pulsa Enter', 'ok');
  }
  function todoMenuEstado(ev, t) {
    ev.stopPropagation();
    popMenu(ev, TODO_ESTADOS.map(([k, ico, label]) => ({ label: `${t.estado === k ? '✓ ' : ''}${ico} ${label}`, action: () => todoSave({ id: t.id, estado: k }, true) })));
  }
  function todoMenuPrio(ev, t) {
    ev.stopPropagation();
    popMenu(ev, ISSUE_PRIORITIES.map((p) => ({ label: `${t.priority === p.key ? '✓ ' : ''}${p.icon} ${p.label}`, hint: p.en, action: () => todoSave({ id: t.id, priority: p.key }, true) })));
  }
  function todoModal(t, preset = {}) {
    const all = (todosInfo && todosInfo.todos) || [];
    const cur = t || { title: '', descripcion: '', icon: '', priority: 'none', estado: 'pendiente', depends: [], session: null, ...preset };
    const title = h('input', { value: cur.title, placeholder: 'Qué hay que hacer (empieza por un verbo)' });
    const icon = h('input.team-icon-in', { value: cur.icon || '', maxlength: '8', placeholder: '·' });
    const prio = h('select', ISSUE_PRIORITIES.map((p) => h('option', { value: p.key }, `${p.icon} ${p.label}`)));
    prio.value = cur.priority;
    const estado = h('select', TODO_ESTADOS.map(([k, ico, label]) => h('option', { value: k }, `${ico} ${label}`)));
    estado.value = cur.estado;
    const desc = h('textarea.team-desc', { rows: '5', placeholder: 'Detalle para retomarlo: archivos, comandos, criterio de listo…' });
    desc.value = cur.descripcion || '';
    const deps = new Set(cur.depends || []);
    const depList = h('div.todo-deps', all.filter((x) => !t || x.id !== t.id).length ? all.filter((x) => !t || x.id !== t.id).map((x) => h('label.todo-dep',
      h('input', { type: 'checkbox', checked: deps.has(x.id), onchange: (e) => { if (e.target.checked) deps.add(x.id); else deps.delete(x.id); } }),
      ` #${x.id} ${x.icon ? `${x.icon} ` : ''}${x.title}`, x.estado === 'hecho' ? h('span.muted', ' (hecho)') : null)) : h('span.muted', 'No hay otros pendientes.'));
    let session = cur.session || null;
    const sessBox = h('div.todo-sess');
    const at = activeTerm();
    const paintSess = () => sessBox.replaceChildren(
      session ? h('span', `🤖 ${session.title || session.kind || 'sesión'} · ${tilde(session.cwd || '')}`) : h('span.muted', 'Sin sesión vinculada'),
      at && isAgentTerm(at) && (!session || session.sid !== at.sid) ? h('button.mini', { type: 'button', onclick: () => { const m = at.info.meta || {}; session = { sid: at.sid, projectId: m.projectId || null, cwd: m.cwd || '', title: termTitle(at), kind: termKind(at), ...(m.agent ? { agent: m.agent } : {}), ...(m.icon ? { icon: m.icon } : {}), ...(m.person ? { person: m.person } : {}) }; paintSess(); } }, `Vincular a «${termTitle(at)}»`) : null,
      session ? h('button.mini', { type: 'button', onclick: () => { session = null; paintSess(); } }, 'Desvincular') : null);
    paintSess();
    const picks = h('div.icon-grid', TODO_ICONS.map((ic) => h('button.icon-pick', { type: 'button', title: ic ? '' : 'Sin ícono', onclick: () => { icon.value = ic; } }, ic || '∅')));
    const doSave = async () => {
      const saved = await todoSave({ ...(t ? { id: t.id } : {}), title: title.value, icon: icon.value, priority: prio.value, estado: estado.value, descripcion: desc.value, depends: [...deps], session });
      if (saved) modalClose(true);
    };
    openModal({
      title: t ? `Pendiente #${t.id}` : 'Nuevo pendiente',
      wide: true,
      body: [
        h('div.field-row', h('div.field', { style: 'width:70px' }, h('label', 'Ícono'), icon), h('div.field.grow', h('label', 'Nombre'), title)),
        picks,
        h('div.field-row', h('div.field.grow', h('label', 'Prioridad'), prio), h('div.field.grow', h('label', 'Estado'), estado)),
        h('div.field', h('label', 'Descripción'), desc),
        h('div.field', h('label', 'Depende de (se hace después de estos)'), depList),
        h('div.field', h('label', 'Sesión de IA'), sessBox),
      ],
      foot: [t ? h('button.danger', { onclick: async () => { if (!(await confirmBox(`¿Borrar el pendiente #${t.id}?`, t.title))) { todoModal(t); return; } try { await Bridge.call('todos.delete', { id: t.id }); await loadTodos(); } catch (e) { toast(e.message, 'err'); } } }, 'Borrar') : null,
        h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
    requestAnimationFrame(() => title.focus());
  }
  /** Repinta la pestaña Pendientes si está a la vista. */
  function renderTodos() { if (state.ui.rtab === 'todos' && !state.ui.hideRight) renderRight(); }
  /** Pestaña «Pendientes» del panel derecho. */
  /** Sesión de un pendiente con lo que se sabe hoy de ella: título, ícono y persona (de la terminal si sigue abierta). */
  function todoSessInfo(t) {
    const s = t.session || {};
    const live = s.sid ? terms.get(s.sid) : null;
    const m = live ? live.info.meta || {} : {};
    return {
      alive: !!live,
      title: live ? termTitle(live) : s.title || s.kind || 'IA',
      icon: live ? termIcon(live) : s.icon || '',
      person: teamPerson(live ? m.person : s.person),
    };
  }
  /** Ícono de la sesión y avatar de su persona, junto al «→» del pendiente. */
  function todoSessBadge(t) {
    const si = todoSessInfo(t);
    if (!si.icon && !si.person) return null;
    return h('span.todo-sess-badge', { title: `Sesión: ${si.title}${si.person ? `\nPersona: ${si.person.name} (${si.person.role})` : ''}` },
      si.icon ? iconNode(si.icon, 'span.todo-sess-ico') : null, si.person ? teamAvatar(si.person, '.todo-sess-av') : null);
  }
  function renderTodosTab() {
    const onlyProj = !!state.ui.todosOnlyProject;
    const showDone = !!state.ui.todosShowDone;
    const all = (todosInfo && todosInfo.todos) || [];
    const proj = project();
    const byProj = onlyProj && proj ? all.filter((t) => { const p = todoProject(t); return p && p.id === proj.id; }) : all;
    // filtro por sesión: las sesiones de los pendientes visibles, con su ícono y la persona asignada
    const sessKey = (t) => (t.session ? t.session.sid || t.session.cwd || '?' : '__none');
    const sessions = new Map();
    for (const t of byProj.filter((x) => showDone || x.estado !== 'hecho')) {
      const k = sessKey(t);
      if (!sessions.has(k)) sessions.set(k, { k, t, n: 0 });
      sessions.get(k).n++;
    }
    let sessSel = state.ui.todosSession || '';
    if (sessSel && !sessions.has(sessSel)) sessSel = '';
    const scoped = sessSel ? byProj.filter((t) => sessKey(t) === sessSel) : byProj;
    const openN = scoped.filter((t) => t.estado !== 'hecho').length;
    const sessPick = sessions.size > 1 || sessSel ? (() => {
      const sel = h('select.todo-sess-sel', { title: 'Ver solo los pendientes de una sesión', onclick: (e) => e.stopPropagation(), onchange: () => { state.ui.todosSession = sel.value; save(); renderTodos(); } },
        h('option', { value: '' }, `🤖 Todas las sesiones (${[...sessions.values()].reduce((a, x) => a + x.n, 0)})`),
        ...[...sessions.values()].sort((a, b) => (a.k === '__none') - (b.k === '__none') || b.n - a.n).map(({ k, t, n }) => {
          if (k === '__none') return h('option', { value: k }, `∅ Sin sesión (${n})`);
          const si = todoSessInfo(t);
          return h('option', { value: k }, `${si.icon ? `${iconText(si.icon)} ` : ''}${si.title}${si.person ? ` · ${si.person.icon || '👤'} ${si.person.name}` : ''}${si.alive ? '' : ' (cerrada)'} (${n})`);
        }));
      sel.value = sessSel;
      return h('div.todo-sess', sel);
    })() : null;
    const flip = (k) => (e) => { e.stopPropagation(); state.ui[k] = !state.ui[k]; save(); renderTodos(); };
    const head = section(`Pendientes${openN ? ` (${openN})` : ''}`,
      h(`button.mini${onlyProj ? '.on' : ''}`, { title: onlyProj ? 'Mostrando solo los de este proyecto · clic: todos' : 'Mostrar solo los de este proyecto', onclick: flip('todosOnlyProject') }, onlyProj ? '📁 Este proyecto' : '📁 Todos'),
      h(`button.mini${showDone ? '.on' : ''}`, { title: showDone ? 'Ocultar los hechos' : 'Mostrar también los hechos', onclick: flip('todosShowDone') }, showDone ? '✓ Con hechos' : '✓ Sin hechos'),
      h('button.mini.primary', { title: 'Nuevo pendiente', onclick: (e) => { e.stopPropagation(); todoModal(null); } }, '＋ Nuevo'));
    if (!todosInfo) { if (Bridge.ready) loadTodos(); return [head, h('div.empty-list', Bridge.ready ? 'Cargando…' : 'Bridge desconectado.')]; }
    if (todosInfo.error) return [head, h('div.empty-list', todosInfo.error)];
    const list = scoped.filter((t) => showDone || t.estado !== 'hecho');
    const rows = list.map((t) => {
      const pr = issuePrio(t.priority);
      const [, eico, elabel] = todoEstado(t.estado);
      const blocked = t.blockedBy && t.blockedBy.length;
      const open = todoOpen === t.id;
      const alive = t.session && t.session.sid && terms.has(t.session.sid);
      const p = todoProject(t);
      return h(`div.todo${t.estado === 'hecho' ? '.done' : ''}${blocked ? '.blocked' : ''}${open ? '.open' : ''}`, {
        title: `#${t.id} · ${pr.label} · ${elabel}${blocked ? ` · espera a #${t.blockedBy.join(', #')}` : ''}${p ? `\nProyecto: ${p.name}` : ''}\nClic: ver detalle · doble clic: editar`,
        onclick: () => { todoOpen = open ? null : t.id; renderTodos(); },
        ondblclick: () => todoModal(t),
        oncontextmenu: (e) => popMenu(e, [
          { label: 'Editar…', action: () => todoModal(t) },
          t.session && { label: alive ? '→ Ir a la sesión' : '→ Reabrir la sesión', action: () => todoGoSession(t) },
          '-',
          ...TODO_ESTADOS.map(([k, ico, label]) => ({ label: `${t.estado === k ? '✓ ' : ''}${ico} ${label}`, action: () => todoSave({ id: t.id, estado: k }, true) })),
          '-',
          { label: 'Nuevo pendiente que dependa de este…', action: () => todoModal(null, { depends: [t.id], session: t.session }) },
          { label: 'Borrar…', danger: true, action: async () => { if (await confirmBox(`¿Borrar el pendiente #${t.id}?`, t.title)) { try { await Bridge.call('todos.delete', { id: t.id }); await loadTodos(); } catch (e) { toast(e.message, 'err'); } } } },
        ]),
      },
      h('div.todo-row',
        h('button.todo-estado', { title: `${elabel} · clic: cambiar estado`, onclick: (e) => todoMenuEstado(e, t) }, eico),
        h('button.iss-prio', { title: `Prioridad: ${pr.label} · clic: cambiarla`, onclick: (e) => todoMenuPrio(e, t) }, pr.icon),
        t.icon ? h('span.todo-ico', t.icon) : null,
        h('span.todo-title', t.title),
        t.session ? todoSessBadge(t) : null,
        t.session ? h(`button.icon.mini.todo-go${alive ? '.alive' : ''}`, { title: alive ? `Ir a la sesión «${t.session.title || 'IA'}»` : `Reabrir la sesión «${t.session.title || 'IA'}» (ya no está abierta)`, onclick: (e) => { e.stopPropagation(); todoGoSession(t); } }, '→') : null),
      blocked ? h('div.todo-sub.muted', `⏳ espera a #${t.blockedBy.join(', #')}`) : null,
      open ? h('div.todo-detail',
        t.descripcion ? h('div.todo-desc', t.descripcion) : h('div.muted', 'Sin descripción.'),
        t.depends && t.depends.length ? h('div.muted', `Depende de: ${t.depends.map((d) => { const x = all.find((y) => y.id === d); return `#${d}${x ? ` ${x.title}` : ''}${x && x.estado === 'hecho' ? ' ✓' : ''}`; }).join(' · ')}`) : null,
        t.session ? h('div.muted', `🤖 ${t.session.title || t.session.kind} · ${tilde(t.session.cwd || '')}${p ? ` · ${p.name}` : ''}`) : null,
        h('div.todo-acts',
          h('button.mini', { onclick: (e) => { e.stopPropagation(); todoModal(t); } }, '✎ Editar'),
          t.estado !== 'hecho' ? h('button.mini', { onclick: (e) => { e.stopPropagation(); todoSave({ id: t.id, estado: 'hecho' }, true); } }, '✓ Hecho') : null,
          t.session ? h('button.mini', { onclick: (e) => { e.stopPropagation(); todoGoSession(t); } }, alive ? '→ Ir a la sesión' : '→ Reabrir sesión') : null)) : null);
    });
    return [head, sessPick,
      h('p.muted.todo-hint', 'Lo que espera a otro pendiente va después de él. «→» abre la sesión de IA donde salió. La IA los guarda con 📌 (arriba a la derecha de su terminal) o si le dices «guárdalo como pendientes».'),
      rows.length ? h('div.todo-list', rows) : h('div.empty-list', all.length ? (onlyProj ? 'Nada pendiente en este proyecto.' : 'Todo hecho ✓') : 'Sin pendientes. Pídele a la IA «guárdalo como pendientes» (📌 en la terminal) o crea uno con ＋ Nuevo.')];
  }
  Bridge.on('todos', () => loadTodos());

  // ---------- Mensajes (pestaña del panel derecho): para personas y de pull requests ----------
  // La IA los guarda con frap-msg (skill frap-mensajes) en local/mensajes/mensajes.json, vinculados a su sesión.
  // Aquí se filtran por persona, sesión y tipo, se editan, se copian con formato de WhatsApp y se marcan enviados
  // (los enviados se ocultan salvo con el filtro «Enviados»).
  let msgsInfo = null; // respuesta de msgs.list
  let msgsSkillSynced = null;
  let msgOpen = null; // id del mensaje desplegado
  const msgCopied = new Set(); // ids copiados en esta sesión de la página (el botón pasa a naranja)
  const msgsOn = () => rtabOn('msgs');
  const MSG_PR_ACC = { review: ['👀', 'Pedir review'], aprobado: ['✅', 'Aprobado'], cambios: ['✏️', 'Pedir cambios'], comentario: ['💬', 'Comentario'], merge: ['🔀', 'Merge'], nuevo: ['🆕', 'Crear PR'] };
  async function loadMsgs() {
    if (!Bridge.ready || !msgsOn()) { renderMessages(); return; }
    try { msgsInfo = await Bridge.call('msgs.list'); } catch (e) { msgsInfo = { error: e.message, mensajes: [] }; }
    renderMessages();
  }
  async function syncMsgsSkill(force) {
    if (!Bridge.ready) return;
    const on = msgsOn();
    if (!force && msgsSkillSynced === on) return;
    try {
      const r = await Bridge.call('msgs.setSkill', { on });
      msgsSkillSynced = on;
      if (r.changed.length) toast(on ? 'Skill frap-mensajes lista en claude y codex' : 'Skill frap-mensajes quitada de claude y codex', 'ok');
    } catch (e) { toast(`Skill frap-mensajes: ${e.message}`, 'err'); }
  }
  Bridge.on('msgs', () => loadMsgs());
  // Respaldo: si la IA escribió el mensaje en un archivo (…/mensajes/<…>.md, como pedía antes la skill frap-equipo)
  // en vez de usar frap-msg, al ver su ruta en la terminal se importa a Mensajes vinculado a esa sesión.
  const MSG_FILE_PATH_RE = /(?:^|[\s'"`(<\[])((?:~|\/)[^\s'"`)<>\]]*\/mensajes?\/[^\s'"`)<>\]/]+\.(?:md|txt))(?=$|[\s'"`)>\].,;:])/g;
  const MSG_PR_URL_RE = /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/(?:compare\/.+|pull\/(?:new\/.+|\d+)|pull-requests\/(?:new|\d+)|-\/merge_requests\/(?:new|\d+))/;
  const MSG_PR_DESC_RE = /(?:^|[\s'"`(<\[])((?:~|\/)[^\s'"`)<>\]]*\/(?:pr|mr)[-_][^\s'"`)<>\]/]*\.md)(?=$|[\s'"`)>\].,;:])/gi;
  const msgFileScanSoon = (t) => { if (!isAgentTerm(t) || !msgsOn()) return; clearTimeout(t.msgTimer); t.msgTimer = setTimeout(() => msgFileScan(t), 600); };
  async function msgFileScan(t) {
    if (!terms.has(t.sid) || !Bridge.ready) return;
    const b = t.term.buffer.active;
    const end = Math.min(b.length, b.baseY + b.cursorY + 1);
    const lines = [];
    for (let i = Math.max(0, end - 60); i < end; i++) {
      const l = b.getLine(i);
      if (!l) continue;
      const txt = l.translateToString(true);
      if (l.isWrapped && lines.length) lines[lines.length - 1] += txt; else lines.push(txt);
    }
    t.msgFiles = t.msgFiles || new Set();
    const found = new Set();
    let m;
    const text = lines.join('\n');
    MSG_FILE_PATH_RE.lastIndex = 0;
    while ((m = MSG_FILE_PATH_RE.exec(text))) found.add(m[1]);
    const mm = t.info.meta || {};
    const session = { sid: t.sid, projectId: mm.projectId || null, cwd: mm.cwd || '', title: termTitle(t), kind: termKind(t), ...(mm.agent ? { agent: mm.agent } : {}), ...(mm.icon ? { icon: mm.icon } : {}), ...(mm.person ? { person: mm.person } : {}) };
    for (const f of found) {
      if (t.msgFiles.has(f)) continue;
      t.msgFiles.add(f);
      try {
        const r = await Bridge.call('msgs.importFile', { path: f, session });
        if (r.created) toast(`✉ Mensaje guardado en Mensajes${r.msg.para ? ` (para ${r.msg.para})` : ''}${r.msg.pr ? ` · PR #${r.msg.pr.numero || ''}` : ''}`, 'ok');
      } catch (_) { // aún no existe o no es un mensaje: se reintenta un par de veces si vuelve a salir
        t.msgFail = t.msgFail || new Map();
        const n = (t.msgFail.get(f) || 0) + 1;
        t.msgFail.set(f, n);
        if (n < 3) t.msgFiles.delete(f);
      }
    }
    // después de los archivos (traen más datos): enlaces de PR (para crearlo o uno existente): su mensaje de PR, con la descripción pr-*.md que nombre la IA
    t.prSeen = t.prSeen || new Set();
    const descs = [];
    MSG_PR_DESC_RE.lastIndex = 0;
    while ((m = MSG_PR_DESC_RE.exec(text))) descs.push(m[1]);
    for (const raw of text.match(/https?:\/\/[^\s'"`<>)\]]+/g) || []) {
      const url = raw.replace(/[.,;:!?]+$/, '');
      if (t.prSeen.has(url) || !MSG_PR_URL_RE.test(url)) continue;
      t.prSeen.add(url);
      const isNew = /\/compare\/|\/pull\/new\/|\/merge_requests\/new|\/pull-requests\/new/.test(url);
      try {
        const r = await Bridge.call('msgs.importPr', { url, session, ...(isNew && descs.length ? { desc: descs[descs.length - 1] } : {}) });
        if (r.created) toast(`🔀 ${r.msg.titulo} · en Mensajes`, 'ok');
      } catch (_) { /* no es un PR */ }
    }
  }
  async function msgSave(msg, quiet) {
    try {
      const m = await Bridge.call('msgs.save', { msg });
      await loadMsgs();
      if (!quiet) toast(`Mensaje #${m.id} guardado`, 'ok');
      return m;
    } catch (e) { toast(e.message, 'err'); return null; }
  }
  /** Persona destinataria (del Equipo si está; si no, solo el nombre). */
  const msgPerson = (m) => teamPerson(m.person) || (m.para ? { name: m.para, icon: '👤', role: '' } : null);
  /** Texto para pegar en WhatsApp: ícono y nombre de la sesión en negrita, salto de línea y el mensaje. */
  function msgClipboard(m) {
    const si = m.session ? todoSessInfo(m) : null;
    const name = si ? String(si.title || '').replace(/^[^\p{L}\p{N}]+/u, '').trim() : ''; // sin el ✳ de actividad de claude
    let body = toWhatsApp(m.texto);
    if (m.pr && m.pr.url && !m.texto.includes(m.pr.url)) body += `\n${m.pr.url}`;
    return `${name ? `${iconText(si.icon) || '📌'} *${name}*\n` : ''}${body}`;
  }
  function msgCopy(m) {
    copyText(msgClipboard(m));
    msgCopied.add(m.id);
    renderMessages();
    toast(`Mensaje${m.para ? ` para ${m.para}` : ''} copiado · cuando lo envíes, márcalo con ✓`, 'ok');
  }
  const msgSetSent = (m, sent) => msgSave({ id: m.id, estado: sent ? 'enviado' : 'pendiente' }, true);
  function msgGoSession(m) { todoGoSession(m, (session) => msgSave({ id: m.id, session }, true)); }
  /** Crear o editar un mensaje. */
  function msgModal(m) {
    const cur = m || { tipo: 'persona', texto: '', titulo: '', para: '', pr: null, estado: 'pendiente', session: null };
    const tipo = h('select', h('option', { value: 'persona' }, '✉ Para una persona'), h('option', { value: 'pr' }, '🔀 Pull request'));
    tipo.value = cur.tipo;
    const people = (teamInfo && teamInfo.people) || [];
    const para = h('input', { value: cur.para || '', placeholder: 'Nombre (o elige del equipo)', list: 'msg-people' });
    const dl = h('datalist#msg-people', people.map((p) => h('option', { value: p.name }, p.role)));
    const titulo = h('input', { value: cur.titulo || '', placeholder: 'Tema corto (vacío: la primera línea)' });
    const texto = h('textarea.msg-text-in', { rows: '10', spellcheck: 'true', placeholder: 'El mensaje tal cual se envía (markdown simple: **negrita**, listas)' });
    texto.value = cur.texto || '';
    const url = h('input.mono', { value: (cur.pr && cur.pr.url) || '', placeholder: 'https://github.com/org/repo/pull/123' });
    const accion = h('select', Object.entries(MSG_PR_ACC).map(([k, [ico, label]]) => h('option', { value: k }, `${ico} ${label}`)));
    accion.value = (cur.pr && cur.pr.accion) || 'review';
    const estado = h('select', h('option', { value: 'pendiente' }, '⏳ Pendiente de enviar'), h('option', { value: 'enviado' }, '✓ Enviado'));
    estado.value = cur.estado || 'pendiente';
    const prBox = h('div.field-row', h('div.field.grow', h('label', 'URL del PR'), url), h('div.field', { style: 'width:170px' }, h('label', 'Acción'), accion));
    const syncTipo = () => prBox.classList.toggle('hidden', tipo.value !== 'pr');
    tipo.addEventListener('change', syncTipo);
    syncTipo();
    const si = cur.session ? todoSessInfo(cur) : null;
    const doSave = async () => {
      const msg = { ...(m ? { id: m.id } : {}), tipo: tipo.value, titulo: titulo.value, texto: texto.value, para: para.value, estado: estado.value, ...(tipo.value === 'pr' ? { pr: { url: url.value, accion: accion.value } } : {}) };
      if (!m && activeTerm() && isAgentTerm(activeTerm())) { const at = activeTerm(); const mm = at.info.meta || {}; msg.session = { sid: at.sid, projectId: mm.projectId || null, cwd: mm.cwd || '', title: termTitle(at), kind: termKind(at), ...(mm.agent ? { agent: mm.agent } : {}), ...(mm.icon ? { icon: mm.icon } : {}), ...(mm.person ? { person: mm.person } : {}) }; }
      const saved = await msgSave(msg);
      if (saved) modalClose(true);
    };
    openModal({
      title: m ? `Mensaje #${m.id}` : 'Nuevo mensaje',
      wide: true,
      body: [
        h('div.field-row', h('div.field', { style: 'width:190px' }, h('label', 'Tipo'), tipo), h('div.field.grow', h('label', 'Para'), para, dl), h('div.field', { style: 'width:190px' }, h('label', 'Estado'), estado)),
        prBox,
        h('div.field', h('label', 'Tema'), titulo),
        h('div.field', h('label', 'Mensaje'), texto),
        si ? h('p.muted', { style: 'font-size:11px;margin:4px 0 0' }, `Sesión: ${si.icon ? `${iconText(si.icon)} ` : ''}${si.title}${si.alive ? '' : ' (cerrada)'}`) : null,
      ],
      foot: [
        m ? h('button.danger', { onclick: async () => { if (!(await confirmBox(`¿Borrar el mensaje #${m.id}?`, m.titulo))) { msgModal(m); return; } try { await Bridge.call('msgs.delete', { id: m.id }); await loadMsgs(); } catch (e) { toast(e.message, 'err'); } } }, 'Borrar') : null,
        m ? h('button', { onclick: () => { msgCopy({ ...m, texto: texto.value }); } }, '📋 Copiar') : null,
        h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar'),
      ],
    });
    requestAnimationFrame(() => (m ? texto : para).focus());
  }
  function msgMenu(ev, m) {
    popMenu(ev, [
      { label: '📋 Copiar (WhatsApp)', action: () => msgCopy(m) },
      { label: '⧉ Copiar solo el texto', action: () => { copyText(m.texto); toast('Texto copiado', 'ok'); } },
      m.estado === 'enviado' ? { label: '⏳ Marcar pendiente', action: () => msgSetSent(m, false) } : { label: '✓ Marcar enviado', action: () => msgSetSent(m, true) },
      { label: '✎ Editar…', action: () => msgModal(m) },
      m.pr && m.pr.url && { label: `↗ Abrir PR${m.pr.numero ? ` #${m.pr.numero}` : ''}`, action: () => openPageTab({ url: m.pr.url }) },
      m.session && { label: m.session.sid && terms.has(m.session.sid) ? '→ Ir a la sesión' : '→ Reabrir la sesión', action: () => msgGoSession(m) },
      '-',
      { label: '🗑 Borrar…', danger: true, action: async () => { if (await confirmBox(`¿Borrar el mensaje #${m.id}?`, m.titulo)) { try { await Bridge.call('msgs.delete', { id: m.id }); await loadMsgs(); } catch (e) { toast(e.message, 'err'); } } } },
    ]);
  }
  function renderMessages() { if (state.ui.rtab === 'msgs' && !state.ui.hideRight) renderRight(); }
  function renderMsgsTab() {
    const f = state.ui.msgFilter || (state.ui.msgFilter = { person: '', session: '', tipo: '', sent: false, section: false });
    const all = (msgsInfo && msgsInfo.mensajes) || [];
    const pendingN = all.filter((m) => m.estado !== 'enviado').length;
    const head = section(`Mensajes${pendingN ? ` (${pendingN})` : ''}`,
      h('button.mini.primary', { title: 'Nuevo mensaje', onclick: () => msgModal(null) }, '＋ Nuevo'));
    if (!msgsInfo) { if (Bridge.ready) loadMsgs(); return [head, h('div.empty-list', Bridge.ready ? 'Cargando…' : 'Bridge desconectado.')]; }
    if (msgsInfo.error) return [head, h('div.empty-list', msgsInfo.error)];
    const personKey = (m) => m.person || (m.para ? `@${m.para.toLowerCase()}` : '__none');
    const sessKey = (m) => (m.session ? m.session.sid || m.session.cwd || '?' : '__none');
    // «🗂 Sección»: solo los de las carpetas de la sección activa (con «Todas», no filtra)
    const sec = modOn('left.sections') ? activeSection() : null;
    const secProjects = sec && sec.id !== 'all' ? new Set(sectionProjects(sec).map((p) => p.id)) : null;
    const inSection = (m) => { if (!secProjects) return true; const p = todoProject(m); return !!p && secProjects.has(p.id); };
    const base = all.filter((m) => (f.sent || m.estado !== 'enviado') && (!f.tipo || m.tipo === f.tipo) && (!f.section || inSection(m)));
    // opciones de persona y sesión: las de los mensajes visibles con los demás filtros
    const people = new Map();
    const sessions = new Map();
    for (const m of base) {
      const pk = personKey(m);
      if (!people.has(pk)) people.set(pk, { m, n: 0 });
      people.get(pk).n++;
      const sk = sessKey(m);
      if (!sessions.has(sk)) sessions.set(sk, { m, n: 0 });
      sessions.get(sk).n++;
    }
    if (f.person && !people.has(f.person)) f.person = '';
    if (f.session && !sessions.has(f.session)) f.session = '';
    const list = base.filter((m) => (!f.person || personKey(m) === f.person) && (!f.session || sessKey(m) === f.session));
    const setF = (k, v) => { f[k] = v; save(); renderMessages(); };
    const selPerson = h('select.msg-filter', { title: 'Filtrar por persona', onchange: (e) => setF('person', e.target.value) },
      h('option', { value: '' }, `👥 Todas las personas`),
      ...[...people.entries()].sort((a, b) => (a[0] === '__none') - (b[0] === '__none') || b[1].n - a[1].n).map(([k, { m, n }]) => {
        const p = msgPerson(m);
        return h('option', { value: k }, k === '__none' ? `∅ Sin persona (${n})` : `${p.icon || '👤'} ${p.name} (${n})`);
      }));
    selPerson.value = f.person;
    const selSess = h('select.msg-filter', { title: 'Filtrar por sesión', onchange: (e) => setF('session', e.target.value) },
      h('option', { value: '' }, '🤖 Todas las sesiones'),
      ...[...sessions.entries()].sort((a, b) => (a[0] === '__none') - (b[0] === '__none') || b[1].n - a[1].n).map(([k, { m, n }]) => {
        if (k === '__none') return h('option', { value: k }, `∅ Sin sesión (${n})`);
        const si = todoSessInfo(m);
        return h('option', { value: k }, `${si.icon ? `${iconText(si.icon)} ` : ''}${si.title}${si.person ? ` · ${si.person.name}` : ''}${si.alive ? '' : ' (cerrada)'} (${n})`);
      }));
    selSess.value = f.session;
    const chip = (k, v, label, title) => h(`button.mini.msg-chip${f[k] === v ? '.on' : ''}`, { title, onclick: () => setF(k, f[k] === v ? (typeof v === 'boolean' ? false : '') : v) }, label);
    const filters = h('div.msg-filters',
      h('div.msg-frow', selPerson, selSess),
      h('div.msg-frow',
        chip('tipo', 'persona', '✉ Personas', 'Solo mensajes para personas'),
        chip('tipo', 'pr', '🔀 PR', 'Solo mensajes de pull requests'),
        modOn('left.sections') ? chip('section', true, '🗂 Sección', 'Solo los de las carpetas de la sección activa') : null,
        h('span.grow'),
        chip('sent', true, '✓ Enviados', f.sent ? 'Ocultar los enviados' : 'Mostrar también los enviados')));
    const rows = list.map((m) => {
      const open = msgOpen === m.id;
      const p = msgPerson(m);
      const tp = teamPerson(m.person);
      const sent = m.estado === 'enviado';
      const acc = m.pr ? MSG_PR_ACC[m.pr.accion] || ['🔀', 'PR'] : null;
      const si = m.session ? todoSessInfo(m) : null;
      return h(`div.msg${sent ? '.sent' : ''}${open ? '.open' : ''}${msgCopied.has(m.id) ? '.copied' : ''}`, {
        title: `#${m.id} · ${m.tipo === 'pr' ? `PR · ${acc[1]}` : 'Para una persona'}${m.para ? ` · para ${m.para}` : ''}${si ? `\nSesión: ${si.title}` : ''}\n${sent ? `Enviado ${String(m.sentAt || '').slice(0, 16).replace('T', ' ')}` : 'Pendiente de enviar'}\nClic: ver · doble clic: editar · clic derecho: más`,
        onclick: () => { msgOpen = open ? null : m.id; renderMessages(); },
        ondblclick: () => msgModal(m),
        oncontextmenu: (e) => msgMenu(e, m),
      },
      h('div.msg-row1',
        h('span.msg-kind', { title: m.tipo === 'pr' ? acc[1] : 'Mensaje para una persona' }, m.tipo === 'pr' ? acc[0] : '✉'),
        h('span.msg-title', m.titulo || m.texto.slice(0, 60)),
        si && si.icon ? iconNode(si.icon, 'span.msg-sess-ico') : null),
      h('div.msg-row2',
        p ? h('span.msg-to', { style: tp ? `color:${teamColor(tp)}` : '' }, tp ? teamAvatar(tp, '.sm') : '👤', ` ${p.name.split(' ')[0]}`) : null,
        m.pr ? h('a.msg-pr', { href: m.pr.url, title: `Abrir ${m.pr.url}`, onclick: (e) => { e.preventDefault(); e.stopPropagation(); openPageTab({ url: m.pr.url }); } }, m.pr.accion === 'nuevo' && !m.pr.numero ? '🔀 Crear PR' : `↗ PR${m.pr.numero ? ` #${m.pr.numero}` : ''}`) : null,
        h('span.grow'),
        h(`button.mini.msg-copy${msgCopied.has(m.id) ? '.done' : ''}`, { title: 'Copiar con formato de WhatsApp (con el nombre de la sesión arriba)', onclick: (e) => { e.stopPropagation(); msgCopy(m); } }, msgCopied.has(m.id) ? '✓ Copiado' : '📋 Copiar'),
        h(`button.icon.mini.msg-sent${sent ? '.on' : ''}`, { title: sent ? 'Enviado · clic: volver a pendiente' : 'Marcar como enviado', onclick: (e) => { e.stopPropagation(); msgSetSent(m, !sent); } }, sent ? '✓' : '○')),
      open ? h('div.msg-detail',
        h('div.msg-body', m.texto),
        h('div.msg-acts',
          h('button.mini', { onclick: (e) => { e.stopPropagation(); msgModal(m); } }, '✎ Editar'),
          m.session ? h('button.mini', { onclick: (e) => { e.stopPropagation(); msgGoSession(m); } }, si && si.alive ? '→ Ir a la sesión' : '→ Reabrir sesión') : null,
          h('button.mini', { onclick: (e) => { e.stopPropagation(); msgMenu(e, m); } }, '⋯'))) : null);
    });
    return [head, all.length ? filters : null,
      rows.length ? h('div.msg-list', rows)
        : h('div.empty-list', all.length ? (f.sent ? 'Nada con estos filtros.' : 'Nada pendiente de enviar con estos filtros (✓ Enviados muestra los ya enviados).') : 'Sin mensajes. Pídele a la IA «dame el mensaje para …» y aparece aquí (skill frap-mensajes), o crea uno con ＋ Nuevo.')];
  }

  // ---------- Equipo: personas y a quién está asignada cada sesión de IA ----------
  // Arriba a la derecha de cada terminal de IA: la persona asignada (o «＋ Asignar sesión»). Ambos abren un menú con el
  // equipo por rol. El equipo vive en local/equipo/equipo.json y la asignación en la meta de la sesión (meta.person):
  // la IA los lee con la skill frap-equipo (frap-team quien / list / show) y escribe para esa persona.
  let teamInfo = null; // respuesta de team.list
  let teamSkillSynced = null;
  const TEAM_ICONS = [
    '👤', '👨‍💼', '👩‍💼', '🧑‍💼', '👨‍💻', '👩‍💻', '🧑‍💻', '👨', '👩', '🧑', '👨‍🦱', '👩‍🦱', '👨‍🦰', '👩‍🦰', '👱‍♂️', '👱‍♀️', '👨‍🦳', '👩‍🦳', '🧔', '👴', '👵',
    '🧑‍🎨', '🧑‍🔬', '🧑‍🏫', '🧑‍🔧', '🧑‍⚖️', '🧑‍🚀', '🕵️', '🦸', '🧙', '🥷', '🤖', '👽', '🐱', '🐶', '🦊', '🐼', '🦁', '🐸', '🦉',
    '🧪', '🎨', '🛠️', '🤝', '📣', '💰', '🧭', '⭐', '🔥', '💎', '🚀', '📊',
  ];
  // colores para distinguir a cada persona en el panel izquierdo y en el chip de la terminal
  const TEAM_COLORS = ['#f7768e', '#ff9e64', '#e0af68', '#9ece6a', '#73daca', '#2ac3de', '#7aa2f7', '#bb9af7', '#c0caf5', '#f472b6', '#a3e635', '#fb7185', '#38bdf8', '#facc15'];
  /** Color de la persona: el elegido o uno fijo según su nombre. */
  const teamColor = (p) => (p && /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : TEAM_COLORS[[...String((p && p.name) || '')].reduce((a, c) => (a * 31 + c.codePointAt(0)) >>> 0, 7) % TEAM_COLORS.length]);
  /** Ícono de la persona sobre un círculo de su color. */
  const teamAvatar = (p, cls = '') => h(`span.team-av${cls}`, { style: `--pc:${teamColor(p)}` }, (p && p.icon) || '👤');
  const teamOn = () => modOn('center.team');
  const isAgentTerm = (t) => ['claude', 'codex', 'opencode'].includes(termKind(t)) || !!((t.info.meta || {}).agent);
  const teamPerson = (id) => (teamInfo && id ? teamInfo.people.find((p) => p.id === id) || null : null);
  async function loadTeam() {
    if (!Bridge.ready || !teamOn()) { renderTeamChips(); return; }
    try { teamInfo = await Bridge.call('team.list'); } catch (_) { teamInfo = teamInfo || { people: [], roles: [] }; }
    renderTeamChips();
  }
  async function syncTeamSkill(force) {
    if (!Bridge.ready) return;
    const on = teamOn();
    if (!force && teamSkillSynced === on) return;
    try {
      const r = await Bridge.call('team.setSkill', { on });
      teamSkillSynced = on;
      if (r.changed.length) toast(on ? 'Skill frap-equipo lista en claude y codex' : 'Skill frap-equipo quitada de claude y codex', 'ok');
    } catch (e) { toast(`Skill frap-equipo: ${e.message}`, 'err'); }
  }
  /** Chip de la persona (o botón para asignar) arriba a la derecha de una terminal de IA. */
  function renderTeamChip(t) {
    let chip = t.pane.querySelector('.term-person');
    const showPin = rtabOn('todos') && isAgentTerm(t);
    const showPerson = teamOn() && isAgentTerm(t);
    if (!showPin && !showPerson) { if (chip) chip.remove(); return; }
    if (!chip) { chip = h('div.term-person'); t.pane.append(chip); }
    chip.classList.toggle('with-tools', !!t.pane.querySelector('.term-tools'));
    const p = teamPerson((t.info.meta || {}).person);
    const pin = showPin ? h('button.term-pin', { title: 'Guardar como pendientes la lista que te dio la IA (escribe la petición en la terminal; tú pulsas Enter)', onmousedown: (e) => e.preventDefault(), onclick: () => todoAskSave(t) }, '📌') : null;
    chip.replaceChildren(...[pin, !showPerson ? null : p
      ? h('button.term-person-btn', { style: `--pc:${teamColor(p)}`, title: `Sesión asignada a ${p.name} (${p.role})${p.descripcion ? `\n${p.descripcion}` : ''}\nLa IA lo sabe con la skill frap-equipo. Clic: cambiar`, onmousedown: (e) => e.preventDefault(), onclick: (e) => teamMenu(e, t) },
        teamAvatar(p, '.term-person-ico'), h('span.term-person-name', { style: `color:${teamColor(p)}` }, p.name), h('span.muted.term-person-role', p.role))
      : h('button.term-person-btn.unassigned', { title: 'Asignar esta sesión a una persona del equipo (p. ej. todo lo de tu jefe): la IA escribirá para ella', onmousedown: (e) => e.preventDefault(), onclick: (e) => teamMenu(e, t) }, '＋ Asignar sesión')].filter(Boolean));
  }
  function renderTeamChips() { for (const t of terms.values()) renderTeamChip(t); }
  /** Menú del equipo por rol: asignar, quitar, agregar persona o ver el equipo. */
  function teamMenu(ev, t) {
    const cur = (t.info.meta || {}).person || null;
    const people = (teamInfo && teamInfo.people) || [];
    const roles = (teamInfo && teamInfo.roles) || [];
    const items = [];
    for (const r of roles) {
      const of = people.filter((p) => p.role === r);
      if (!of.length) continue;
      items.push({ label: r, disabled: true });
      for (const p of of) items.push({ label: `${p.id === cur ? '✓ ' : ''}${p.icon || '👤'} ${p.name}`, hint: p.descripcion ? p.descripcion.split('\n')[0].slice(0, 40) : '', action: () => teamAssign(t, p.id) });
    }
    if (!people.length) items.push({ label: 'Todavía no hay nadie en el equipo', disabled: true });
    items.push('-');
    if (cur) items.push({ label: 'Quitar asignación', action: () => teamAssign(t, null) });
    items.push({ label: '＋ Agregar persona…', action: () => teamModal(null, t) });
    if (people.length) items.push({ label: '👥 Ver equipo…', action: () => teamModal() });
    const r = ev.currentTarget.getBoundingClientRect();
    popMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, items);
  }
  async function teamAssign(t, personId) {
    try {
      const info = await Bridge.call('session.meta', { sid: t.sid, meta: { person: personId } });
      t.info.meta = info.meta;
      renderTeamChip(t);
      renderProjects();
      const p = teamPerson(personId);
      toast(p ? `Sesión asignada a ${p.name}: la IA lo tendrá en cuenta (skill frap-equipo)` : 'Sesión sin asignar', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  /** Modal del equipo: lista por rol con editar/borrar y formulario para crear o editar. `assignTo`: al crear, asignar esa sesión (solo si no tiene persona). */
  function teamModal(edit, assignTo) {
    const people = (teamInfo && teamInfo.people) || [];
    const roles = (teamInfo && teamInfo.roles) || [];
    const p = edit || null;
    const name = h('input', { value: p ? p.name : '', placeholder: 'Juan Pérez' });
    const icon = h('input.team-icon-in', { value: p ? p.icon : '👤', maxlength: '8' });
    const role = h('input', { value: p ? p.role : '', placeholder: 'Jefe, Project manager, Desarrollador…', list: 'team-roles' });
    const desc = h('textarea.team-desc', { rows: '4', placeholder: 'Lo que la IA debe saber: cómo le gusta que le pidan las cosas, qué no hace (p. ej. no le gusta que le pidan cosas por ssh), idioma, nivel técnico…' });
    desc.value = p ? p.descripcion || '' : '';
    let color = p && p.color ? p.color : '';
    const preview = h('span');
    const paintPreview = () => preview.replaceChildren(teamAvatar({ name: name.value || 'x', icon: icon.value, color }, '.lg'));
    const picks = h('div.icon-grid.team-icons', TEAM_ICONS.map((ic) => h('button.icon-pick', { type: 'button', onclick: () => { icon.value = ic; paintPreview(); } }, ic)));
    const colors = h('div.team-colors');
    const paintColors = () => colors.replaceChildren(
      h('button.team-color.auto' + (!color ? '.sel' : ''), { type: 'button', title: 'Automático (según el nombre)', onclick: () => { color = ''; paintColors(); paintPreview(); } }, 'A'),
      ...TEAM_COLORS.map((c) => h(`button.team-color${color === c ? '.sel' : ''}`, { type: 'button', style: `background:${c}`, title: c, onclick: () => { color = c; paintColors(); paintPreview(); } })));
    paintColors();
    name.addEventListener('input', paintPreview);
    icon.addEventListener('input', paintPreview);
    paintPreview();
    const doSave = async () => {
      try {
        const saved = await Bridge.call('team.save', { person: { id: p ? p.id : undefined, name: name.value, icon: icon.value, role: role.value || 'Otro', descripcion: desc.value, color } });
        await loadTeam();
        // solo se asigna a la sesión desde la que se abrió si no tenía a nadie: nunca pisa una asignación
        if (assignTo && !p && !(assignTo.info.meta || {}).person) await teamAssign(assignTo, saved.id);
        toast(`${saved.name} ${p ? 'actualizado' : 'agregado al equipo'}`, 'ok');
        teamModal(null, null); // vuelve a la lista
      } catch (e) { toast(e.message, 'err'); }
    };
    const del = async (x) => {
      if (!(await confirmBox(`¿Quitar a ${x.name} del equipo?`, 'Las sesiones asignadas a esta persona quedan sin asignar.'))) { teamModal(); return; }
      try { await Bridge.call('team.delete', { id: x.id }); await loadTeam(); } catch (e) { toast(e.message, 'err'); }
      teamModal();
    };
    const list = people.length ? h('div.team-list', roles.filter((r) => people.some((x) => x.role === r)).map((r) => h('div.team-group',
      h('div.team-role', r),
      people.filter((x) => x.role === r).map((x) => h(`div.team-row${p && p.id === x.id ? '.editing' : ''}`,
        teamAvatar(x, '.lg'),
        h('div.team-row-main', h('b', { style: `color:${teamColor(x)}` }, x.name), x.descripcion ? h('div.muted.team-row-desc', x.descripcion) : null),
        h('button.icon.mini', { title: 'Editar', onclick: () => teamModal(x, null) }, '✎'),
        h('button.icon.mini', { title: 'Quitar del equipo', onclick: () => del(x) }, '✕')))))) : h('p.muted', 'Todavía no hay nadie. Agrega a tu jefe, PM, compañeros o clientes: la IA escribirá para cada uno respetando su descripción.');
    openModal({
      title: p ? `Editar · ${p.name}` : 'Equipo',
      wide: true,
      body: [
        list,
        h('div.team-form',
          h('div.team-form-title', p ? `Editar a ${p.name}` : '＋ Nueva persona'),
          h('div.field-row', h('div.team-preview', preview), h('div.field', { style: 'width:80px' }, h('label', 'Ícono'), icon), h('div.field.grow', h('label', 'Nombre'), name), h('div.field.grow', h('label', 'Rol'), role)),
          h('datalist', { id: 'team-roles' }, roles.map((r) => h('option', { value: r }))),
          picks,
          h('label.muted.team-sub', 'Color (para distinguirla en el panel izquierdo)'), colors,
          h('div.field', h('label', 'Descripción (la lee la IA)'), desc)),
        h('p.muted', { style: 'font-size:11px;margin:6px 0 0' }, 'Se guarda en local/equipo (fuera de git) y viaja en el zip de local/. La IA lo consulta con la skill frap-equipo.'),
      ],
      foot: [p ? h('button', { onclick: () => teamModal(null, assignTo) }, 'Cancelar edición') : null, h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cerrar'), h('button.primary', { onclick: doSave }, p ? 'Guardar cambios' : 'Agregar')],
    });
    requestAnimationFrame(() => name.focus());
  }

  // ---------- API: peticiones HTTP guardadas en local/api (como Postman) ----------
  // Árbol de carpetas y peticiones a la izquierda; a la derecha, pestañas con el editor (método, URL, parámetros,
  // cabeceras, cuerpo, descripción, variables) y la respuesta. Las variables {{x}} se resuelven en el bridge
  // (carpeta de la petición → carpetas padre → globales). Las IA usan lo mismo con la skill frap-api (frap-api.js).
  let apiPane = null; // panel de la vista API enlazada
  let apiInfo = null; // árbol (común a todas las vistas API: local/api es uno solo)
  let apiSkillSynced = null;
  const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const API_MODES = [['none', 'Ninguno'], ['json', 'JSON'], ['text', 'Texto'], ['urlencoded', 'x-www-form-urlencoded'], ['form', 'form-data']];
  const apiMethodTag = (m) => h(`span.api-m.m-${String(m || 'GET').toLowerCase()}`, String(m || 'GET'));
  const apiParent = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
  const apiDefaultFolder = () => { const p = project(); return p ? (basename(p.folders[0] || '') || p.name).replace(/[^\w.-]+/g, '-') : ''; };

  function openApiView() {
    if (!needProject()) return;
    showView('api');
    apiLoadTree();
    if (apiPane && state.api.active) apiRenderEditor();
  }
  async function syncApiSkill(force) {
    if (!Bridge.ready) return;
    const on = launchOn('api');
    if (!force && apiSkillSynced === on) return;
    try {
      const r = await Bridge.call('api.setSkill', { on });
      apiSkillSynced = on;
      if (r.changed.length) toast(on ? 'Skill frap-api lista en claude y codex' : 'Skill frap-api quitada de claude y codex', 'ok');
    } catch (e) { toast(`Skill frap-api: ${e.message}`, 'err'); }
  }
  async function apiLoadTree() {
    if (!Bridge.ready) return;
    try { apiInfo = await Bridge.call('api.tree'); } catch (e) { apiInfo = { error: e.message, tree: [] }; }
    if (apiPane) apiRenderTree();
  }

  function ensureApiPane() {
    if (apiPane) return apiPane;
    const filter = h('input.api-filter', { placeholder: 'Filtrar…', spellcheck: 'false' });
    filter.addEventListener('input', () => apiRenderTree());
    const treeEl = h('div.api-tree');
    const tabsEl = h('div.api-tabs');
    const bodyEl = h('div.api-body');
    const root = h('div.api-pane.hidden',
      h('div.api-side',
        h('div.api-side-head',
          h('span.api-title', 'API'),
          h('span.grow'),
          h('button.icon.mini', { title: 'Nueva petición', onclick: () => apiNewRequest(null) }, '＋'),
          h('button.icon.mini', { title: 'Nueva carpeta', onclick: () => apiNewFolder('') }, '📁'),
          h('button.icon.mini', { title: 'Variables globales (las ven todas las peticiones)', onclick: () => apiVarsModal('') }, '🌐'),
          h('button.icon.mini', { title: 'Recargar', onclick: () => apiLoadTree() }, '⟳')),
        filter, treeEl),
      h('div.api-main', tabsEl, bodyEl));
    $('#term-host').append(root);
    apiPane = { kind: 'api', root, filter, treeEl, tabsEl, bodyEl, docs: new Map() };
    viewPanes.set(bound.api, apiPane);
    if (!state.api.expanded.length && apiDefaultFolder()) state.api.expanded = [apiDefaultFolder()];
    apiRenderTree();
    apiRenderEditor();
    return apiPane;
  }

  // ----- árbol -----
  function apiRenderTree() {
    const P = apiPane;
    if (!P) return;
    if (!apiInfo) { P.treeEl.replaceChildren(h('p.muted.api-hint', Bridge.ready ? 'Cargando…' : 'Bridge desconectado')); if (Bridge.ready) apiLoadTree(); return; }
    if (apiInfo.error) { P.treeEl.replaceChildren(h('pre.db-error', apiInfo.error)); return; }
    const q = P.filter.value.trim().toLowerCase();
    const exp = new Set(state.api.expanded);
    const match = (n) => !q || n.path.toLowerCase().includes(q) || (n.url || '').toLowerCase().includes(q) || (n.children || []).some(match);
    const build = (nodes, depth) => nodes.filter(match).flatMap((n) => {
      const pad = { style: `padding-left:${6 + depth * 12}px` };
      if (n.type === 'folder') {
        const open = q ? true : exp.has(n.path);
        return [h('div.api-node.api-folder', {
          ...pad, title: `${n.path}${n.vars ? `\n${n.vars} variable(s)` : ''}\nClic derecho: más opciones`,
          onclick: () => { const s = new Set(state.api.expanded); if (s.has(n.path)) s.delete(n.path); else s.add(n.path); state.api.expanded = [...s]; save(); apiRenderTree(); },
          oncontextmenu: (e) => apiFolderMenu(e, n),
        }, h('span.code-twisty', open ? '▾' : '▸'), h('span.api-name', `📁 ${n.name}`), n.vars ? h('span.api-vars', { title: 'Variables de la carpeta' }, `{${n.vars}}`) : null),
        ...(open ? build(n.children, depth + 1) : [])];
      }
      return [h(`div.api-node.api-rnode${state.api.active === n.path ? '.active' : ''}`, {
        ...pad, title: `${n.method} ${n.url}${n.hasRes ? '' : '\n(sin ejecutar)'}`,
        onclick: () => apiOpen(n.path), oncontextmenu: (e) => apiReqMenu(e, n),
      }, h('span.code-twisty', ''), apiMethodTag(n.method), h('span.api-name', n.name))];
    });
    const rows = build(apiInfo.tree, 0);
    P.treeEl.replaceChildren(...(rows.length ? rows : [h('div.api-empty',
      h('p', q ? 'Nada coincide.' : 'Sin peticiones todavía.'),
      q ? null : h('p.muted', 'Crea una con ＋, o pídele a la IA que la cree (skill frap-api): las guarda en una carpeta con el ID de la issue o el nombre del proyecto.'))]));
  }
  function apiFolderMenu(e, n) {
    popMenu(e, [
      { label: 'Nueva petición aquí', action: () => apiNewRequest(n.path) },
      { label: 'Nueva carpeta aquí', action: () => apiNewFolder(n.path) },
      { label: `Variables de la carpeta${n.vars ? ` (${n.vars})` : ''}…`, action: () => apiVarsModal(n.path) },
      '-',
      { label: 'Renombrar / mover…', action: () => apiRename(n.path, 'folder') },
      { label: 'Copiar ruta', action: () => codeCopy(`${apiInfo.dir}/${n.path}`) },
      '-',
      { label: 'Mover a la papelera', danger: true, action: () => apiDelete(n.path, 'folder') },
    ]);
  }
  function apiReqMenu(e, n) {
    popMenu(e, [
      { label: 'Abrir', action: () => apiOpen(n.path) },
      { label: '▶ Enviar', action: async () => { await apiOpen(n.path); apiSend(); } },
      { label: 'Duplicar', action: () => apiDuplicate(n.path) },
      { label: 'Renombrar / mover…', action: () => apiRename(n.path, 'request') },
      '-',
      { label: 'Copiar comando para la IA', hint: 'frap-api run', action: () => codeCopy(`node ${apiInfo.cli} run ${n.path}`) },
      { label: 'Copiar ruta del archivo', action: () => codeCopy(`${apiInfo.dir}/${n.path}.req.json`) },
      '-',
      { label: 'Mover a la papelera', danger: true, action: () => apiDelete(n.path, 'request') },
    ]);
  }
  async function apiNewFolder(parent) {
    const name = await askText('Nueva carpeta', `Nombre${parent ? ` (dentro de ${parent})` : ''} — p. ej. el ID de la issue`, parent ? '' : apiDefaultFolder());
    if (!name) return;
    const rel = `${parent ? `${parent}/` : ''}${name.replace(/^\/+|\/+$/g, '')}`;
    try {
      await Bridge.call('api.mkdir', { path: rel });
      state.api.expanded = [...new Set([...state.api.expanded, parent, rel].filter(Boolean))];
      save();
      await apiLoadTree();
    } catch (e) { toast(e.message, 'err'); }
  }
  async function apiNewRequest(folder) {
    const base = folder != null ? folder : apiDefaultFolder();
    const name = await askText('Nueva petición', 'Carpeta/nombre (las carpetas se crean solas)', `${base ? `${base}/` : ''}nueva-peticion`);
    if (!name) return;
    const rel = name.replace(/^\/+|\/+$/g, '');
    try {
      await Bridge.call('api.save', { path: rel, create: true, request: { method: 'GET', url: '{{base}}/', headers: [{ key: 'Accept', value: 'application/json' }] } });
      state.api.expanded = [...new Set([...state.api.expanded, ...rel.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))])];
      save();
      await apiLoadTree();
      apiOpen(rel);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function apiDuplicate(rel) {
    try {
      const r = await Bridge.call('api.read', { path: rel });
      const to = await askText('Duplicar petición', 'Carpeta/nombre de la copia', `${rel}-copia`);
      if (!to) return;
      await Bridge.call('api.save', { path: to, request: r.request, create: true });
      await apiLoadTree();
      apiOpen(to.replace(/^\/+|\/+$/g, ''));
    } catch (e) { toast(e.message, 'err'); }
  }
  async function apiRename(rel, type) {
    const to = await askText(type === 'folder' ? 'Renombrar carpeta' : 'Renombrar petición', 'Nueva ruta (carpeta/nombre)', rel);
    if (!to || to === rel) return;
    try {
      const r = await Bridge.call('api.rename', { from: rel, to: to.replace(/^\/+|\/+$/g, ''), type });
      // pestañas abiertas siguen a lo renombrado
      const P = apiPane;
      const move = (p) => (type === 'folder' ? (p === rel || p.startsWith(`${rel}/`) ? r.path + p.slice(rel.length) : p) : p === rel ? r.path : p);
      state.api.tabs = state.api.tabs.map(move);
      if (state.api.active) state.api.active = move(state.api.active);
      if (P) for (const [k, d] of [...P.docs]) { const nk = move(k); if (nk !== k) { P.docs.delete(k); P.docs.set(nk, d); } }
      save();
      await apiLoadTree();
      apiRenderEditor();
    } catch (e) { toast(e.message, 'err'); }
  }
  async function apiDelete(rel, type) {
    if (!(await confirmBox(type === 'folder' ? `¿Mover la carpeta «${rel}» a la papelera?` : `¿Mover la petición «${rel}» a la papelera?`, type === 'folder' ? 'Con todas sus peticiones y variables. Se puede recuperar desde la papelera del sistema.' : 'Con su última respuesta. Se puede recuperar desde la papelera del sistema.'))) return;
    try {
      await Bridge.call('api.delete', { path: rel, type });
      const gone = (p) => (type === 'folder' ? p === rel || p.startsWith(`${rel}/`) : p === rel);
      state.api.tabs = state.api.tabs.filter((p) => !gone(p));
      if (state.api.active && gone(state.api.active)) state.api.active = state.api.tabs[state.api.tabs.length - 1] || null;
      if (apiPane) for (const k of [...apiPane.docs.keys()]) if (gone(k)) apiPane.docs.delete(k);
      save();
      await apiLoadTree();
      apiRenderEditor();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ----- variables -----
  /** Editor clave/valor (filas con interruptor, clave, valor y ✕; siempre queda una fila vacía al final). */
  function kvEditor(list, onChange, { placeholders = ['clave', 'valor'], toggles = true } = {}) {
    const box = h('div.kv');
    const paint = () => {
      const rows = list.map((it, i) => h(`div.kv-row${it.off ? '.off' : ''}`,
        toggles ? h('input', { type: 'checkbox', checked: !it.off, title: 'Activa', onchange: (e) => { if (e.target.checked) delete it.off; else it.off = true; onChange(); paint(); } }) : h('span'),
        h('input.mono', { value: it.key, placeholder: placeholders[0], spellcheck: 'false', oninput: (e) => { it.key = e.target.value; onChange(); } }),
        h('input.mono', { value: it.value, placeholder: placeholders[1], spellcheck: 'false', oninput: (e) => { it.value = e.target.value; onChange(); } }),
        h('button.icon.mini', { title: 'Quitar', onclick: () => { list.splice(i, 1); onChange(); paint(); } }, '✕')));
      const add = h('button.mini.kv-add', { onclick: () => { list.push({ key: '', value: '' }); onChange(); paint(); const ins = box.querySelectorAll('.kv-row input.mono'); if (ins.length) ins[ins.length - 2].focus(); } }, '＋ Agregar');
      box.replaceChildren(...rows, add);
    };
    paint();
    return box;
  }
  async function apiVarsModal(folder) {
    let cur;
    try { cur = await Bridge.call('api.vars', { folder }); } catch (e) { toast(e.message, 'err'); return; }
    const list = Object.entries(cur.variables).map(([key, value]) => ({ key, value }));
    const desc = h('textarea.api-desc', { rows: '2', placeholder: 'Descripción (opcional)' });
    desc.value = cur.descripcion || '';
    const doSave = async () => {
      const vars = {};
      for (const it of list) if (it.key.trim()) vars[it.key.trim()] = it.value;
      try {
        await Bridge.call('api.setVars', { folder, variables: vars, ...(folder ? { descripcion: desc.value } : {}) });
        modalClose(true);
        toast(`Variables ${folder ? `de ${folder}` : 'globales'} guardadas`, 'ok');
        await apiLoadTree();
        if (apiPane && state.api.active) apiRefreshScope();
      } catch (e) { toast(e.message, 'err'); }
    };
    openModal({
      title: folder ? `Variables · ${folder}` : 'Variables globales',
      wide: true,
      body: [
        h('p.muted', { style: 'margin:0 0 8px' }, folder
          ? `Las ven las peticiones de «${folder}» y de sus subcarpetas (y tapan a las globales con el mismo nombre). Úsalas como {{nombre}} en URL, parámetros, cabeceras y cuerpo.`
          : 'Las ven todas las peticiones (una carpeta puede taparlas con una variable del mismo nombre). Úsalas como {{nombre}}.'),
        kvEditor(list, () => {}, { toggles: false, placeholders: ['nombre (p. ej. base)', 'valor (p. ej. https://api.ejemplo.com)'] }),
        folder ? desc : null,
        h('p.muted', { style: 'font-size:11px;margin:8px 0 0' }, 'Se guardan en local/api (fuera de git) y viajan en el zip de local/. Variables con nombre de token, clave o password se ocultan al mostrárselas a la IA.'),
      ],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
  }

  // ----- pestañas y editor -----
  const apiDoc = (rel) => apiPane && apiPane.docs.get(rel);
  const apiDirty = (d) => !!d && !!d.req && JSON.stringify(d.req) !== d.saved;
  async function apiOpen(rel) {
    const P = apiPane || ensureApiPane();
    if (!state.api.tabs.includes(rel)) state.api.tabs.push(rel);
    state.api.active = rel;
    save();
    if (!P.docs.has(rel)) {
      P.docs.set(rel, { loading: true });
      apiRenderEditor();
      try {
        const r = await Bridge.call('api.read', { path: rel });
        P.docs.set(rel, { req: r.request, saved: JSON.stringify(r.request), response: r.response, scope: null });
      } catch (e) { P.docs.set(rel, { error: e.message }); }
    }
    apiRenderTree();
    apiRenderEditor();
    apiRefreshScope();
    renderTabs();
  }
  async function apiRefreshScope() {
    const rel = state.api.active;
    const d = apiDoc(rel);
    if (!d || !d.req) return;
    try { d.scope = (await Bridge.call('api.vars', { folder: apiParent(rel), path: rel })).scope; } catch (_) { d.scope = null; }
    if (state.api.active === rel) apiRenderResolved();
  }
  async function apiCloseTab(rel) {
    const d = apiDoc(rel);
    if (apiDirty(d) && !(await confirmBox('Cerrar petición', `«${rel}» tiene cambios sin guardar. ¿Cerrarla y descartarlos?`))) return;
    const i = state.api.tabs.indexOf(rel);
    state.api.tabs = state.api.tabs.filter((x) => x !== rel);
    if (apiPane) apiPane.docs.delete(rel);
    if (state.api.active === rel) state.api.active = state.api.tabs[Math.min(i, state.api.tabs.length - 1)] || null;
    save();
    apiRenderTree();
    apiRenderEditor();
    renderTabs();
  }
  function apiRenderTabs() {
    const P = apiPane;
    if (!P) return;
    P.tabsEl.replaceChildren(...state.api.tabs.map((rel) => {
      const d = apiDoc(rel);
      const dirty = apiDirty(d);
      return h(`div.ed-tab${rel === state.api.active ? '.active' : ''}${dirty ? '.dirty' : ''}`, {
        title: `${rel}${dirty ? ' (sin guardar)' : ''}`,
        onclick: () => { if (state.api.active !== rel) apiOpen(rel); },
        onauxclick: (e) => { if (e.button === 1) apiCloseTab(rel); },
      },
      d && d.req ? apiMethodTag(d.req.method) : null,
      h('span.code-tname', basename(rel)),
      h('span.x', { title: dirty ? 'Sin guardar · cerrar' : 'Cerrar', onclick: (e) => { e.stopPropagation(); apiCloseTab(rel); } }, dirty ? '●' : '✕'));
    }));
  }
  const apiMarkDirty = debounce(() => { apiRenderTabs(); const d = apiDoc(state.api.active); if (apiPane && apiPane.saveBtn) apiPane.saveBtn.disabled = !apiDirty(d); apiRenderResolved(); }, 120);

  /** Resuelve {{var}} con las variables que ve la petición (solo para mostrar; el envío lo resuelve el bridge). */
  function apiPreviewUrl(d) {
    const vars = (d.scope && d.scope.vars) || {};
    const missing = new Set();
    const I = (t) => String(t || '').replace(/{{\s*([$\w.-]+)\s*}}/g, (m, k) => (k.startsWith('$') ? m : Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : (missing.add(k), m)));
    let url = I(d.req.url);
    const qs = d.req.query.filter((x) => !x.off && x.key).map((x) => `${encodeURIComponent(I(x.key))}=${encodeURIComponent(I(x.value))}`).join('&');
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    for (const x of [...d.req.headers, ...(d.req.body.form || [])]) { I(x.key); I(x.value); }
    I(d.req.body.text);
    return { url, missing: [...missing] };
  }
  function apiRenderResolved() {
    const P = apiPane;
    const d = apiDoc(state.api.active);
    if (!P || !P.resolvedEl || !d || !d.req) return;
    const { url, missing } = apiPreviewUrl(d);
    P.resolvedEl.replaceChildren(...[
      h('span.muted', '→ '), h('span.mono', url || '(sin URL)'),
      missing.length ? h('span.api-missing', { title: 'Defínelas en las variables de la carpeta o globales' }, `  ⚠ sin definir: ${missing.join(', ')}`) : null].filter(Boolean));
  }

  function apiRenderEditor() {
    const P = apiPane;
    if (!P) return;
    apiRenderTabs();
    P.saveBtn = null;
    P.resolvedEl = null;
    const rel = state.api.active;
    const d = rel ? apiDoc(rel) : null;
    if (!rel) {
      P.bodyEl.replaceChildren(h('div.api-welcome',
        h('h3', 'API'),
        h('p.muted', 'Peticiones HTTP guardadas en local/api, como en Postman: carpetas, variables {{así}} por carpeta y globales, y la última respuesta de cada una.'),
        h('p', h('button.primary', { onclick: () => apiNewRequest(null) }, '＋ Nueva petición'), ' ', h('button', { onclick: () => apiVarsModal('') }, '🌐 Variables globales')),
        h('p.muted', h('kbd', 'Ctrl+Enter'), ' enviar · ', h('kbd', 'Ctrl+S'), ' guardar · las IA las crean y ejecutan con la skill frap-api, en una carpeta con el ID de la issue o el nombre del proyecto.')));
      return;
    }
    if (!d || d.loading) {
      if (!Bridge.ready) { P.bodyEl.replaceChildren(h('p.muted.api-hint', 'Esperando al bridge…')); return; } // al conectar se vuelve a pintar
      if (!d) apiOpen(rel);
      P.bodyEl.replaceChildren(h('p.muted.api-hint', 'Cargando…'));
      return;
    }
    if (d.error) { P.bodyEl.replaceChildren(h('div.api-hint', h('p', d.error), h('button', { onclick: () => { P.docs.delete(rel); apiOpen(rel); } }, 'Reintentar'), ' ', h('button', { onclick: () => apiCloseTab(rel) }, 'Cerrar'))); return; }
    const req = d.req;
    const changed = () => apiMarkDirty();
    const method = h('select.api-method', { onchange: (e) => { req.method = e.target.value; method.className = `api-method m-${req.method.toLowerCase()}`; changed(); } }, API_METHODS.map((m) => h('option', { value: m }, m)));
    method.value = req.method;
    method.className = `api-method m-${req.method.toLowerCase()}`;
    const url = h('input.api-url.mono', { value: req.url, placeholder: '{{base}}/ruta  ·  https://…', spellcheck: 'false', oninput: (e) => { req.url = e.target.value; changed(); } });
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apiSend(); } });
    const sendBtn = h('button.primary.api-send', { title: 'Enviar (Ctrl+Enter). Guarda la petición antes de enviarla', onclick: () => apiSend() }, d.sending ? '⏳ Enviando…' : '▶ Enviar');
    if (d.sending) sendBtn.disabled = true;
    P.saveBtn = h('button', { title: 'Guardar (Ctrl+S)', onclick: () => apiSave() }, 'Guardar');
    P.saveBtn.disabled = !apiDirty(d);
    P.resolvedEl = h('div.api-resolved');
    const count = (l) => l.filter((x) => !x.off && x.key).length;
    const tabs = [['params', `Parámetros${count(req.query) ? ` (${count(req.query)})` : ''}`], ['headers', `Cabeceras${count(req.headers) ? ` (${count(req.headers)})` : ''}`], ['body', `Cuerpo${req.body.mode !== 'none' ? ' ●' : ''}`], ['desc', 'Descripción'], ['vars', 'Variables']];
    const cur = state.api.reqTab || 'params';
    let pane;
    if (cur === 'params') pane = kvEditor(req.query, changed, { placeholders: ['parámetro', 'valor ({{var}} vale)'] });
    else if (cur === 'headers') pane = kvEditor(req.headers, changed, { placeholders: ['cabecera (p. ej. Authorization)', 'valor (p. ej. Bearer {{token}})'] });
    else if (cur === 'body') {
      const ta = h('textarea.api-bodytext.mono', { spellcheck: 'false', placeholder: req.body.mode === 'json' ? '{\n  "clave": "{{valor}}"\n}' : 'texto', oninput: (e) => { req.body.text = e.target.value; changed(); } });
      ta.value = req.body.text || '';
      ta.addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); req.body.text = ta.value; changed(); } });
      pane = h('div.api-bodybox',
        h('div.api-modes', API_MODES.map(([m, label]) => h('label', h('input', { type: 'radio', name: `apimode-${rel}`, checked: req.body.mode === m, onchange: () => { req.body.mode = m; if ((m === 'urlencoded' || m === 'form') && !Array.isArray(req.body.form)) req.body.form = []; changed(); apiRenderEditor(); } }), ` ${label}`)),
          req.body.mode === 'json' ? h('button.mini', { title: 'Formatear el JSON', onclick: () => { try { const t = req.body.text.replace(/{{\s*([$\w.-]+)\s*}}/g, '"__FRAP_VAR_$1__"'); req.body.text = JSON.stringify(JSON.parse(t), null, 2).replace(/"__FRAP_VAR_([$\w.-]+)__"/g, '{{$1}}'); ta.value = req.body.text; changed(); } catch (err) { toast(`JSON inválido: ${err.message}`, 'err'); } } }, '{ } Formatear') : null),
        req.body.mode === 'json' || req.body.mode === 'text' ? ta
          : req.body.mode === 'none' ? h('p.muted', 'Sin cuerpo.') : kvEditor(req.body.form, changed, { placeholders: ['campo', 'valor'] }));
    } else if (cur === 'desc') {
      const ta = h('textarea.api-desc', { rows: '6', placeholder: 'Para qué sirve, de qué issue viene, qué devuelve…', oninput: (e) => { req.descripcion = e.target.value; changed(); } });
      ta.value = req.descripcion || '';
      pane = ta;
    } else {
      const sc = d.scope;
      pane = h('div.api-scope',
        h('div.api-scope-btns',
          h('button.mini', { onclick: () => apiVarsModal(apiParent(rel)) }, `✎ Variables de ${apiParent(rel) || 'la raíz (globales)'}`),
          apiParent(rel) ? h('button.mini', { onclick: () => apiVarsModal('') }, '🌐 Globales') : null),
        !sc ? h('p.muted', 'Cargando…') : !Object.keys(sc.vars).length ? h('p.muted', 'Esta petición no ve ninguna variable todavía.')
          : h('div.api-scope-list', Object.entries(sc.vars).map(([k, v]) => h('div.api-scope-row',
            h('span.mono', `{{${k}}}`), h('span.mono.api-scope-val', { title: v }, /token|secret|pass|clave|key|auth/i.test(k) && v ? `•••${String(v).slice(-3)}` : v), h('span.muted', sc.from[k])))));
    }
    const reqEl = h('div.api-req',
      h('div.api-urlrow', method, url, sendBtn, P.saveBtn),
      P.resolvedEl,
      h('div.api-subtabs', tabs.map(([id, label]) => h(`button${cur === id ? '.active' : ''}`, { onclick: () => { state.api.reqTab = id; save(); apiRenderEditor(); } }, label))),
      h('div.api-subbody', pane));
    P.bodyEl.replaceChildren(reqEl, apiResponseView(d));
    apiRenderResolved();
  }
  function apiFmtSize(n) { return n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
  function apiResponseView(d) {
    const r = d.response;
    if (d.sending) return h('div.api-res', h('p.muted.api-hint', '⏳ Esperando respuesta…'));
    if (!r) return h('div.api-res', h('p.muted.api-hint', 'Sin respuesta todavía: pulsa ▶ Enviar (o Ctrl+Enter).'));
    if (r.error) return h('div.api-res', h('div.api-reshead', h('span.api-status.s-err', 'Error'), h('span.muted', r.at ? new Date(r.at).toLocaleString() : '')), h('pre.db-error', r.error), r.request ? h('p.muted.mono', `${r.request.method} ${r.request.url}`) : null);
    const tab = state.api.resTab || 'body';
    const cls = r.status >= 500 ? 's-err' : r.status >= 400 ? 's-warn' : r.status >= 300 ? 's-redir' : 's-ok';
    const ctype = r.contentType || (r.headers && r.headers['content-type']) || '';
    let body;
    if (tab === 'headers') {
      body = h('div.api-headers', Object.entries(r.headers || {}).map(([k, v]) => h('div.api-hrow', h('span.mono.api-hk', k), h('span.mono', Array.isArray(v) ? v.join(', ') : String(v)))));
    } else if (tab === 'sent') {
      const s = r.request || {};
      body = h('div', h('p.mono', `${s.method} ${s.url}`), h('div.api-headers', Object.entries(s.headers || {}).map(([k, v]) => h('div.api-hrow', h('span.mono.api-hk', k), h('span.mono', /authorization|token|cookie|key/i.test(k) && v ? `${String(v).slice(0, 10)}•••` : String(v))))), s.body ? h('pre.api-pre', s.body) : null);
    } else if (r.encoding === 'base64') {
      body = /^image\//i.test(ctype) && r.size < 5 * 1048576 ? h('img.api-img', { src: `data:${ctype.split(';')[0]};base64,${r.body}`, alt: 'respuesta' }) : h('p.muted', `Binario (${apiFmtSize(r.size)}, ${ctype || 'sin tipo'}).`);
    } else {
      let text = r.body || '';
      const pretty = state.api.raw !== true && /json/i.test(ctype);
      if (pretty) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) { /* no es JSON válido: tal cual */ } }
      const cut = text.length > 400000;
      body = h('div',
        cut ? h('p.muted', `Se muestran los primeros 400 KB de ${apiFmtSize(text.length)}.`) : null,
        /html/i.test(ctype) && state.api.htmlView ? h('iframe.api-html', { sandbox: '', srcdoc: text.slice(0, 2000000), title: 'Vista HTML (sin scripts)' }) : h('pre.api-pre', cut ? text.slice(0, 400000) : text));
    }
    const rt = (id, label) => h(`button${tab === id ? '.active' : ''}`, { onclick: () => { state.api.resTab = id; save(); apiRenderEditor(); } }, label);
    return h('div.api-res',
      h('div.api-reshead',
        h(`span.api-status.${cls}`, `${r.status} ${r.statusText || ''}`.trim()),
        h('span.muted', `${r.ms} ms · ${apiFmtSize(r.size)}${r.truncated ? ' · truncada' : ''}${r.redirects && r.redirects.length ? ` · ${r.redirects.length} redirección(es)` : ''}`),
        h('span.grow'),
        h('span.muted', { title: r.at }, r.at ? new Date(r.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' }) : '')),
      h('div.api-subtabs', rt('body', 'Cuerpo'), rt('headers', `Cabeceras (${Object.keys(r.headers || {}).length})`), rt('sent', 'Enviado'), h('span.grow'),
        tab === 'body' && /json/i.test(ctype) ? h('button.mini', { onclick: () => { state.api.raw = !state.api.raw; save(); apiRenderEditor(); } }, state.api.raw ? 'Formateado' : 'Sin formato') : null,
        tab === 'body' && /html/i.test(ctype) ? h('button.mini', { onclick: () => { state.api.htmlView = !state.api.htmlView; save(); apiRenderEditor(); } }, state.api.htmlView ? 'Código' : 'Ver HTML') : null,
        tab === 'body' && r.encoding !== 'base64' ? h('button.mini', { onclick: () => { copyText(r.body || ''); toast('Respuesta copiada', 'ok'); } }, '⧉ Copiar') : null),
      h('div.api-resbody', body));
  }
  async function apiSave() {
    const rel = state.api.active;
    const d = apiDoc(rel);
    if (!d || !d.req) return false;
    try {
      const r = await Bridge.call('api.save', { path: rel, request: d.req });
      d.req = r.request;
      d.saved = JSON.stringify(r.request);
      apiRenderTabs();
      if (apiPane && apiPane.saveBtn) apiPane.saveBtn.disabled = true;
      apiLoadTree();
      return true;
    } catch (e) { toast(e.message, 'err'); return false; }
  }
  async function apiSend() {
    const rel = state.api.active;
    const d = apiDoc(rel);
    if (!d || !d.req || d.sending) return;
    if (apiDirty(d) && !(await apiSave())) return;
    d.sending = true;
    apiRenderEditor();
    try {
      const r = await Bridge.call('api.send', { path: rel });
      d.response = { at: new Date().toISOString(), request: r.request, ...r.response };
      if (r.missing && r.missing.length) toast(`Variables sin definir: ${r.missing.join(', ')}`, 'err');
    } catch (e) { d.response = { error: e.message, at: new Date().toISOString() }; }
    d.sending = false;
    if (state.api.active === rel) apiRenderEditor();
    apiLoadTree();
  }
  // atajos dentro de la vista API
  document.addEventListener('keydown', (e) => {
    if (viewKind(state.activeSid) !== 'api' || !apiPane || modalClose || !apiPane.root.contains(document.activeElement)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apiSend(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); apiSave(); }
  }, true);

  // ---------- notas: NOTES.md de la carpeta del proyecto (vista por proyecto) ----------
  // Se edita a mano (autoguardado) o desde una IA con la skill frap-notes ("guarda esto en notas" / "lee las notas").
  // Si la carpeta está en un repo git, un switch agrega/quita "/NOTES.md" del .gitignore de esa carpeta.
  let notesPane = null; // panel de la vista Notas enlazada
  let notesSkill = null; // {claude, codex}: ¿skill frap-notes instalada?
  const NOTES_IGNORE = '/NOTES.md';
  const notesFile = (p = project()) => (p && p.folders[0] ? `${p.folders[0].replace(/\/+$/, '')}/NOTES.md` : null);
  const notesDir = (p = project()) => (p && p.folders[0] ? p.folders[0].replace(/\/+$/, '') : null);

  /** Abre (o enfoca) las notas del proyecto activo. */
  function openNotesView() {
    if (!needProject()) return;
    const { fresh } = showView('notes');
    if (!fresh) notesLoad();
    requestAnimationFrame(() => { if (notesPane && notesPane.exists) notesPane.ta.focus(); });
  }

  function ensureNotesPane() {
    if (notesPane) return notesPane;
    const ignoreBtn = h('button', { class: 'switch on', role: 'switch', onclick: () => notesSetIgnore(state.notes.gitignore === false) });
    const ignoreInfo = h('span.muted.notes-ig-info');
    const ignore = h('label.notes-ig.hidden', { title: 'Agrega "/NOTES.md" al .gitignore de esta carpeta para que las notas no se suban al repo' },
      ignoreBtn, h('span', 'git-ignore'), ignoreInfo);
    const pathEl = h('span.mono.muted.notes-path');
    const status = h('span.muted.notes-status');
    const skillBtn = h('button.mini', { onclick: () => notesInstallSkill(true) });
    const ta = h('textarea.notes-ta', { spellcheck: 'true', placeholder: '# Notas\n\nEscribe aquí, o pídele a una IA "guarda esto en notas".' });
    const autosave = debounce(() => notesSave(false), 800);
    ta.addEventListener('input', () => { renderNotesStatus(); autosave(); });
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); notesSave(true); }
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyV') { e.preventDefault(); notesTogglePreview(); }
      else if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
    });
    const banner = h('div.notes-banner.hidden');
    const empty = h('div.notes-empty.hidden');
    const previewEl = h('div.notes-preview.hidden');
    const previewBtn = h('button.mini.notes-prevbtn', { onclick: () => notesTogglePreview() });
    const root = h('div.notes-pane.hidden',
      h('div.db-bar.notes-bar',
        ignore,
        pathEl,
        h('span.grow'),
        status,
        previewBtn,
        skillBtn,
        h('button.icon', { title: 'Recargar del disco', onclick: () => notesLoad() }, '⟳'),
        h('button.primary.notes-save', { title: 'Guardar (Ctrl+S). También se guarda solo al dejar de escribir.', onclick: () => notesSave(true) }, '💾 Guardar')),
      banner,
      empty,
      ta,
      previewEl);
    $('#term-host').append(root);
    notesPane = { root, ignore, ignoreBtn, ignoreInfo, pathEl, status, skillBtn, ta, banner, empty, previewEl, previewBtn, previewText: null, file: null, exists: false, saved: '', mtime: 0, savedAt: 0, conflict: null, repo: null, ignored: false, tracked: false };
    viewPanes.set(bound.notes, notesPane);
    notesLoad();
    return notesPane;
  }

  /** Lee NOTES.md (y el estado de git/skill). Sin cambios locales pendientes, pisa el editor. */
  async function notesLoad() {
    const p = notesPane;
    if (!p) return;
    p.file = notesFile();
    p.conflict = null;
    if (!p.file || !Bridge.ready) { renderNotes(); return; }
    try {
      const r = await notesReadDisk(p.file);
      if (notesPane !== p) return;
      p.exists = !!r;
      p.saved = r ? r.content : '';
      p.mtime = r ? r.mtime : 0;
      p.ta.value = p.saved;
    } catch (e) { toast(e.message, 'err'); }
    renderNotes();
    notesGitInfo();
    if (!notesSkill) Bridge.call('notes.skill').then((x) => { notesSkill = x; renderNotes(); }).catch(() => {});
  }
  /** {content, mtime} o null si no existe. */
  async function notesReadDisk(file) {
    if (!(await Bridge.call('fs.exists', { path: file }))) return null;
    return Bridge.call('fs.read', { path: file });
  }

  async function notesCreate() {
    const p = notesPane;
    const pr = project();
    if (!p || !pr) return;
    try {
      const r = await Bridge.call('fs.write', { path: p.file, content: `# Notas — ${pr.name}\n\n` });
      toast(`Creado ${tilde(r.path)}`, 'ok');
      await notesLoad();
      await notesApplyIgnore();
      notesInstallSkill(false);
      p.ta.focus();
      p.ta.setSelectionRange(p.ta.value.length, p.ta.value.length);
    } catch (e) { toast(e.message, 'err'); }
  }

  /** Guarda si hay cambios. Si el archivo cambió en disco desde que se leyó, no pisa: muestra el aviso. */
  async function notesSave(explicit) {
    const p = notesPane;
    if (!p || !p.exists || !p.file) return;
    const content = p.ta.value;
    if (content === p.saved && !p.conflict) { if (explicit) toast('Sin cambios', 'ok'); return; }
    if (p.conflict && !explicit) return; // se decide en el aviso
    try {
      if (!p.conflict) {
        const disk = await notesReadDisk(p.file);
        if (disk && disk.mtime !== p.mtime && disk.content !== p.saved) { p.conflict = disk; renderNotes(); return; }
      }
      const r = await Bridge.call('fs.write', { path: p.file, content });
      p.saved = content;
      p.mtime = r.mtime;
      p.savedAt = Date.now();
      p.conflict = null;
      if (notesPane === p) { renderNotes(); notesApplyIgnore(); }
    } catch (e) { toast(e.message, 'err'); }
  }

  /** Refresco mientras la vista está visible: trae lo que escribió una IA (si no hay cambios locales). */
  async function notesPoll() {
    const p = notesPane;
    if (!p || !p.file || viewKind(state.activeSid) !== 'notes' || document.hidden || !Bridge.ready || modalClose) return;
    try {
      const disk = await notesReadDisk(p.file);
      if (notesPane !== p) return;
      const exists = !!disk;
      if (exists === p.exists && (!disk || disk.mtime === p.mtime)) return;
      const dirty = p.ta.value !== p.saved;
      if (!exists) { if (!dirty) { p.exists = false; p.saved = ''; p.mtime = 0; renderNotes(); } return; }
      if (disk.content === p.saved) { p.mtime = disk.mtime; return; }
      if (dirty && p.exists) { p.conflict = disk; renderNotes(); return; }
      // sin cambios locales: se carga lo del disco conservando el cursor y el scroll
      const { selectionStart: a, selectionEnd: b } = p.ta;
      const top = p.ta.scrollTop;
      const created = !p.exists;
      p.exists = true;
      p.saved = disk.content;
      p.mtime = disk.mtime;
      p.ta.value = disk.content;
      p.ta.setSelectionRange(Math.min(a, disk.content.length), Math.min(b, disk.content.length));
      p.ta.scrollTop = top;
      renderNotes();
      if (created) notesGitInfo();
      toast('Notas actualizadas desde el disco', 'ok');
    } catch (_) { /* reintenta en el próximo ciclo */ }
  }
  setInterval(notesPoll, 3000);
  window.addEventListener('focus', notesPoll);

  // ----- git-ignore -----
  /** ¿La carpeta está en un repo? ¿NOTES.md está en su .gitignore? ¿Ya está versionado? */
  async function notesGitInfo() {
    const p = notesPane;
    const dir = notesDir();
    if (!p || !dir || !Bridge.ready) return;
    try {
      const top = await Bridge.call('git.run', { cwd: dir, args: ['rev-parse', '--show-toplevel'] });
      if (notesPane !== p) return;
      p.repo = top.code === 0 ? top.stdout.trim() : null;
      p.ignored = p.repo ? (await notesIgnoreLines()).some(isNotesIgnoreLine) : false;
      p.tracked = p.repo && p.exists ? (await Bridge.call('git.run', { cwd: dir, args: ['ls-files', '--error-unmatch', '--', 'NOTES.md'] })).code === 0 : false;
    } catch (_) { p.repo = null; }
    if (notesPane === p) renderNotes();
  }
  const isNotesIgnoreLine = (l) => ['/NOTES.md', 'NOTES.md'].includes(l.trim());
  async function notesIgnoreLines() {
    const gi = `${notesDir()}/.gitignore`;
    const r = await notesReadDisk(gi);
    return r ? r.content.split('\n') : [];
  }
  /** Agrega (add) o quita la línea de NOTES.md en el .gitignore de la carpeta. Devuelve si cambió. */
  async function notesWriteIgnore(add) {
    const gi = `${notesDir()}/.gitignore`;
    const r = await notesReadDisk(gi);
    let text = r ? r.content : '';
    const lines = text.split('\n');
    const has = lines.some(isNotesIgnoreLine);
    if (add && !has) text = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${NOTES_IGNORE}\n`;
    else if (!add && has) text = lines.filter((l) => !isNotesIgnoreLine(l)).join('\n');
    else return false;
    await Bridge.call('fs.write', { path: gi, content: text });
    return true;
  }
  /** Tras crear o guardar: si el switch está activo y hay repo, se asegura la línea en el .gitignore. */
  async function notesApplyIgnore() {
    const p = notesPane;
    if (!p || state.notes.gitignore === false) return;
    if (!p.repo) await notesGitInfo();
    if (!p.repo || p.ignored) return;
    try {
      if (await notesWriteIgnore(true)) toast(`NOTES.md agregado a ${tilde(notesDir())}/.gitignore`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
    notesGitInfo();
  }
  async function notesSetIgnore(on) {
    state.notes.gitignore = on;
    save();
    renderNotes();
    try {
      const changed = await notesWriteIgnore(on);
      if (changed) toast(on ? 'NOTES.md agregado al .gitignore' : 'NOTES.md quitado del .gitignore', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    notesGitInfo();
  }

  // ----- skill para las IA -----
  async function notesInstallSkill(explicit) {
    try {
      if (!explicit) {
        notesSkill = notesSkill || await Bridge.call('notes.skill');
        if (notesSkill.claude && notesSkill.codex) return;
      }
      const files = await Bridge.call('notes.installSkill', { tools: ['claude', 'codex'] });
      notesSkill = { claude: true, codex: true };
      toast(`Skill frap-notes instalada (${files.map(tilde).join(', ')}): dile a la IA "guarda esto en notas" o "lee las notas"`, 'ok');
      renderNotes();
      loadConfig(true);
    } catch (e) { toast(e.message, 'err'); }
  }

  // ----- render -----
  function renderNotes() {
    const p = notesPane;
    if (!p) return;
    p.pathEl.textContent = p.file ? tilde(p.file) : '';
    p.pathEl.title = p.file || '';
    const on = state.notes.gitignore !== false;
    p.ignore.classList.toggle('hidden', !p.repo || !p.exists);
    p.ignoreBtn.className = `switch ${on ? 'on' : 'off'}`;
    p.ignoreBtn.setAttribute('aria-checked', String(on));
    p.ignoreInfo.textContent = !on ? '' : p.tracked ? '⚠ ya versionado' : p.ignored ? '✓' : '';
    p.ignoreInfo.title = p.tracked ? 'NOTES.md ya está en el repo: el .gitignore no lo saca. Para dejar de versionarlo: git rm --cached NOTES.md' : '';
    const sk = notesSkill && notesSkill.claude && notesSkill.codex;
    p.skillBtn.textContent = sk ? '🤖 IA ✓' : '🤖 Activar IA';
    p.skillBtn.title = sk
      ? 'Skill frap-notes instalada para claude y codex: diles "guarda esto en notas" o "lee las notas" (también en Prompts). Clic: reinstalar.'
      : 'Instala la skill frap-notes en ~/.claude/skills y ~/.codex/skills para que la IA entienda "guarda esto en notas" y "lee las notas"';
    const pv = p.exists && !!state.notes.preview;
    p.ta.classList.toggle('hidden', !p.exists || pv);
    p.previewEl.classList.toggle('hidden', !pv);
    p.previewBtn.classList.toggle('hidden', !p.exists);
    p.previewBtn.classList.toggle('on', pv);
    p.previewBtn.textContent = pv ? '✎ Editar' : '👁 Vista previa';
    p.previewBtn.title = pv ? 'Volver a editar (Ctrl+Shift+V)' : 'Ver NOTES.md renderizado (Ctrl+Shift+V)';
    if (pv) notesRenderPreview();
    p.empty.classList.toggle('hidden', p.exists);
    p.root.querySelector('.notes-save').classList.toggle('hidden', !p.exists);
    if (!p.exists) {
      p.empty.replaceChildren(
        h('div.notes-empty-ico', kindIcon('notes')),
        h('p', 'Esta carpeta todavía no tiene NOTES.md.'),
        h('p.muted', 'Ahí van el contexto, las decisiones y los pendientes del proyecto. Lo puedes editar aquí o pedirle a una IA "guarda esto en notas".'),
        h('button.primary', { onclick: notesCreate, disabled: !p.file || !Bridge.ready }, '＋ Crear NOTES.md'));
    }
    if (p.conflict) {
      p.banner.replaceChildren(
        h('span', '⚠ NOTES.md cambió en el disco (¿lo editó una IA?) mientras tenías cambios sin guardar.'),
        h('span.grow'),
        h('button.mini', { onclick: () => { p.ta.value = p.conflict.content; p.saved = p.conflict.content; p.mtime = p.conflict.mtime; p.conflict = null; renderNotes(); } }, 'Usar la del disco'),
        h('button.mini.danger', { onclick: () => notesSave(true) }, 'Guardar la mía'));
    }
    p.banner.classList.toggle('hidden', !p.conflict);
    renderNotesStatus();
  }
  /** Pinta el Markdown de las notas (solo si cambió el texto; conserva el scroll). */
  function notesRenderPreview() {
    const p = notesPane;
    if (!p || !p.file || p.previewText === p.ta.value) return;
    p.previewText = p.ta.value;
    const top = p.previewEl.scrollTop;
    p.previewEl.replaceChildren(renderPreview(p.file, p.ta.value, {
      edit: (fn) => {
        const next = fn(p.ta.value);
        if (next == null || next === p.ta.value) return;
        p.ta.value = next;
        p.ta.dispatchEvent(new Event('input')); // estado "sin guardar" + autoguardado
        notesRenderPreview();
      },
    }));
    p.previewEl.scrollTop = top;
  }
  function notesTogglePreview() {
    const p = notesPane;
    if (!p || !p.exists) return;
    state.notes.preview = !state.notes.preview;
    save();
    renderNotes();
    if (!state.notes.preview) p.ta.focus();
  }
  function renderNotesStatus() {
    const p = notesPane;
    if (!p) return;
    const dirty = p.exists && p.ta.value !== p.saved;
    p.status.textContent = !p.exists ? '' : p.conflict ? 'conflicto' : dirty ? 'sin guardar…' : p.savedAt ? `guardado ${new Date(p.savedAt).toLocaleTimeString([], { timeStyle: 'short' })}` : 'guardado';
    p.status.classList.toggle('dirty', dirty || !!p.conflict);
  }

  // ---------- bases de datos: conexiones (.env del bridge) + pestaña DB en el centro ----------
  const isViewSid = (sid) => isPageView(sid) || !!viewBySid(sid);
  const DB_ENGINES = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite' };
  const DB_PORTS = { mysql: '3306', postgres: '5432' };
  /** Respuesta de db.list: { envFile, cli, clients, skills, conns } (sin contraseñas). */
  let dbInfo = null;
  let dbError = null; // error de la última carga (p. ej. bridge desactualizado)
  let dbPane = null; // panel de la vista DB enlazada; dbPane.last = último resultado (para exportar)
  const dbConnById = (id) => (dbInfo ? dbInfo.conns.find((c) => c.id === id) : null) || null;
  const dbTarget = (c) => (c.engine === 'sqlite' ? tilde(c.database) : `${c.user}@${c.host || 'localhost'}:${c.port || DB_PORTS[c.engine]}${c.database ? '/' + c.database : ''}`);

  async function loadDbs() {
    if (!Bridge.ready) return;
    try { dbInfo = await Bridge.call('db.list'); dbError = null; } catch (e) {
      dbError = e.message;
      if (state.ui.rtab === 'dbs') renderRight(); else toast(e.message, 'err');
      return;
    }
    const first = dbInfo.conns.find((c) => c.enabled);
    for (const d of viewDatas('db')) {
      const cur = dbConnById(d.connId);
      if (d.connId && !(cur && cur.enabled)) d.connId = null;
      if (!d.connId && first) d.connId = first.id;
    }
    renderProjects();
    if (state.ui.rtab === 'dbs') renderRight();
    if (dbPane) { renderDbBar(); loadDbTables(); }
  }

  // ----- panel derecho -----
  function renderDbs() {
    const head = section('Bases de datos',
      h('button.mini', { title: 'Recargar', onclick: loadDbs }, '↻'),
      h('button.mini', { title: 'Abrir la pestaña DB (Alt+Shift+D)', onclick: () => openDbView() }, '🗄 Consultar'),
      h('button.mini.primary', { onclick: () => editDb() }, '+ Nueva'));
    if (!Bridge.ready) return [head, h('p.muted', 'Bridge desconectado.')];
    if (!dbInfo) return [head, dbError ? h('p', { style: 'color:var(--err)' }, dbError) : h('p.muted', 'Cargando…')];
    const sk = dbInfo.skills || {};
    const agents = h('div.card.db-agents',
      h('div.title', h('span.name', '🤖 Acceso para agentes (solo lectura)')),
      h('div.desc', { title: 'claude, codex y opencode usan el CLI frap-db: solo lectura y nunca ve contraseñas' }, 'Los agentes solo ven las conexiones con 🤖 Uso por IA.'),
      h('div.path', { title: dbInfo.envFile }, `credenciales: ${tilde(dbInfo.envFile)} (0600)`),
      h('div.acts',
        h('button.mini', { title: 'Escribe la skill frap-db en ~/.claude/skills y ~/.codex/skills', onclick: installDbSkill },
          sk.claude && sk.codex ? '✓ Skill instalada · reinstalar' : 'Instalar skill (claude + codex)'),
        h('button.mini', { title: 'Copiar el comando del CLI', onclick: () => { copyText(`node ${dbInfo.cli} list`); toast('Comando copiado', 'ok'); } }, 'Copiar comando')));
    if (!dbInfo.conns.length) return [head, agents, h('p.muted', 'Aún no hay conexiones. Pulsa "+ Nueva" y agrega host, usuario y contraseña.')];
    return [head, agents, ...dbInfo.conns.map((c) => {
      const missing = dbInfo.clients && !dbInfo.clients[c.engine];
      return h(`div.card.db-card${c.enabled ? '.clickable' : '.off'}`, {
        title: c.enabled ? 'Abrir en la pestaña DB' : 'Conexión desactivada',
        onclick: () => { if (c.enabled) openDbView(c.id); },
      },
        h('div.title',
          h('span.name', `🗄 ${c.name}`),
          h(`span.badge.db-${c.engine}`, c.engine),
          c.uiWrite ? h('span.badge.st-starting', { title: 'La pestaña DB puede ejecutar INSERT, UPDATE, CREATE y ALTER (nunca DELETE, DROP ni TRUNCATE). Los agentes siguen en solo lectura.' }, '✎ escritura') : h('span.badge', '🔒 lectura'),
          h('button.icon.mini', { title: 'Probar conexión', onclick: (e) => { e.stopPropagation(); testDb({ id: c.id }, c.name); } }, '⚡'),
          h('button.icon.mini', { title: 'Editar', onclick: (e) => { e.stopPropagation(); editDb(c); } }, '✎'),
          h('button.icon.mini', { title: 'Eliminar', onclick: (e) => { e.stopPropagation(); deleteDb(c); } }, '✕')),
        h('div.path', { title: c.id }, `${dbTarget(c)} · id: ${c.id}`),
        h('div.db-flags',
          h('label.db-flag', { onclick: (e) => e.stopPropagation() },
            dbSwitch(c, 'enabled', c.enabled ? 'Desactivar la conexión (ni la pestaña DB ni los agentes podrán usarla)' : 'Activar la conexión'),
            h('span', c.enabled ? 'Activa' : 'Desactivada')),
          h('label.db-flag', { onclick: (e) => e.stopPropagation() },
            dbSwitch(c, 'ai', !c.enabled ? 'Activa primero la conexión'
              : c.ai ? 'Quitar el acceso a claude, codex, opencode…' : 'Permitir que claude, codex, opencode… la consulten (solo lectura)', !c.enabled),
            h('span', c.enabled && c.ai ? '🤖 Uso por IA' : '🤖 Sin IA')),
          h('label.db-flag', { onclick: (e) => e.stopPropagation() },
            dbSwitch(c, 'readOnly', !c.enabled ? 'Activa primero la conexión'
              : c.uiWrite ? 'Volver a solo lectura' : 'Permitir INSERT, UPDATE, CREATE y ALTER desde la pestaña DB (nunca eliminaciones)', !c.enabled),
            h('span', c.uiWrite ? '✎ Escritura' : '🔒 Solo lectura'))),
        missing ? h('div.desc', { style: 'color:var(--err)' }, `Falta el cliente ${c.engine === 'postgres' ? 'psql' : c.engine === 'sqlite' ? 'sqlite3' : 'mysql'} en el sistema`) : null);
    })];
  }

  function dbSwitch(c, key, title, disabled) {
    const on = key === 'ai' ? c.enabled && c.ai : key === 'readOnly' ? !c.uiWrite : c.enabled;
    return h('button', {
      class: `switch ${on ? 'on' : 'off'}`,
      role: 'switch', 'aria-checked': String(!!on), title, disabled: !!disabled || !Bridge.ready,
      onclick: (e) => { e.stopPropagation(); toggleDb(c, key); },
    });
  }

  async function toggleDb(c, key) {
    if (key === 'readOnly') {
      if (!c.uiWrite && !(await confirmBox(`¿Quitar "Solo lectura" a "${c.name}"?`,
        'La pestaña DB podrá ejecutar INSERT, UPDATE, CREATE y ALTER en esta conexión (cada escritura pide confirmación). Nunca se permiten eliminaciones: DELETE, DROP ni TRUNCATE. Los agentes siguen en solo lectura.'))) return;
    }
    try {
      const saved = await Bridge.call('db.toggle', key === 'readOnly' ? { id: c.id, uiWrite: !c.uiWrite } : { id: c.id, [key]: !c[key] });
      toast(key === 'enabled' ? `${c.name}: ${saved.enabled ? 'activada' : 'desactivada'}`
        : key === 'readOnly' ? `${c.name}: ${saved.uiWrite ? 'escritura permitida (sin eliminaciones)' : 'solo lectura'}`
        : `${c.name}: ${saved.ai ? 'los agentes pueden consultarla' : 'los agentes ya no pueden usarla'}`, 'ok');
      loadDbs();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function installDbSkill() {
    try {
      const files = await Bridge.call('db.installSkill', { tools: ['claude', 'codex'] });
      toast(`Skill instalada: ${files.map(tilde).join(', ')}`, 'ok');
      loadDbs();
      loadConfig(true);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function testDb(args, label) {
    toast(`Probando ${label || 'conexión'}…`);
    try {
      const r = await Bridge.call('db.test', args);
      toast(`✓ Conecta (${r.ms} ms)${r.version ? ' · ' + String(r.version).slice(0, 60) : ''}`, 'ok');
      return true;
    } catch (e) { toast(`✗ ${e.message}`, 'err'); return false; }
  }

  function editDb(c) {
    if (!Bridge.ready) { toast('Bridge desconectado', 'err'); return; }
    const isNew = !c;
    const name = h('input', { value: c ? c.name : '', placeholder: 'Mi base de datos' });
    const engine = h('select', Object.entries(DB_ENGINES).map(([k, v]) => h('option', { value: k }, v)));
    engine.value = c ? c.engine : 'mysql';
    const host = h('input.mono', { value: c ? c.host : '', placeholder: 'localhost o 10.0.0.5' });
    const port = h('input.mono', { value: c ? c.port : '', style: 'width:100px' });
    const user = h('input.mono', { value: c ? c.user : '', placeholder: 'usuario', autocomplete: 'off' });
    const pass = h('input.mono', { type: 'password', autocomplete: 'new-password', placeholder: c && c.hasPassword ? '•••••• (sin cambios)' : 'contraseña' });
    const showPass = h('button.icon.mini', { title: 'Mostrar/ocultar', onclick: () => { pass.type = pass.type === 'password' ? 'text' : 'password'; } }, '👁');
    const database = h('input.mono', { value: c ? c.database : '' });
    const readOnly = h('input', { type: 'checkbox' });
    readOnly.checked = !(c && c.uiWrite); // por defecto: solo lectura
    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = !c || c.enabled !== false;
    const ai = h('input', { type: 'checkbox' });
    ai.checked = !c || c.ai !== false;
    const netFields = h('div', { style: 'display:flex;flex-direction:column;gap:8px' },
      h('div.field-row', h('div.field.grow', h('label', 'Host'), host), h('div.field', h('label', 'Puerto'), port)),
      h('div.field-row',
        h('div.field.grow', h('label', 'Usuario'), user),
        h('div.field.grow', h('label', 'Contraseña'), h('div.field-row', h('span.grow', pass), showPass))));
    const dbLabel = h('label');
    const sync = () => {
      const sqlite = engine.value === 'sqlite';
      netFields.classList.toggle('hidden', sqlite);
      dbLabel.textContent = sqlite ? 'Archivo SQLite (ruta completa)' : 'Base de datos (opcional en MySQL)';
      database.placeholder = sqlite ? '/home/usuario/proyecto/datos.sqlite' : 'nombre_bd';
      port.placeholder = DB_PORTS[engine.value] || '';
    };
    engine.addEventListener('change', sync);
    sync();
    pass.style.width = '100%';
    const collect = () => ({
      id: c ? c.id : undefined,
      name: name.value.trim(), engine: engine.value, host: host.value.trim(), port: port.value.trim(),
      user: user.value.trim(), password: c && !pass.value ? null : pass.value,
      database: database.value.trim(), uiWrite: !readOnly.checked, enabled: enabled.checked, ai: ai.checked,
    });
    const doSave = async () => {
      try {
        const saved = await Bridge.call('db.save', { conn: collect() });
        modalClose(true);
        toast(`Guardada en ${tilde(dbInfo ? dbInfo.envFile : '.env')}`, 'ok');
        if (isNew) state.db.connId = saved.id;
        save();
        loadDbs();
      } catch (e) { toast(e.message, 'err'); }
    };
    openModal({
      title: isNew ? 'Nueva base de datos' : `Editar · ${c.name}`,
      body: [
        h('div.field-row', h('div.field.grow', h('label', 'Nombre'), name), h('div.field', h('label', 'Motor'), engine)),
        netFields,
        h('div.field', dbLabel, database),
        h('label.muted', enabled, ' Conexión activa (desactivada, ni la pestaña DB ni los agentes pueden usarla)'),
        h('label.muted', ai, ' Uso por IA: claude, codex, opencode… pueden consultarla en solo lectura con frap-db'),
        h('label.muted', readOnly, ' Solo lectura. Desactívalo para ejecutar INSERT, UPDATE, CREATE y ALTER desde la pestaña DB (pide confirmación); nunca DELETE, DROP ni TRUNCATE. Los agentes siempre son solo lectura.'),
        h('p.muted', { style: 'margin:0;font-size:11px' },
          'Se guarda en el .env del bridge (permisos 0600), no en el navegador. Recomendado: un usuario de BD con permisos solo SELECT.'),
      ],
      foot: [
        h('button', { onclick: () => testDb({ conn: collect() }, name.value || 'conexión') }, '⚡ Probar conexión'),
        h('span.grow'),
        h('button', { onclick: () => modalClose(true) }, 'Cancelar'),
        h('button.primary', { onclick: doSave }, 'Guardar'),
      ],
    });
  }

  async function deleteDb(c) {
    if (!(await confirmBox(`¿Eliminar la conexión "${c.name}"?`, 'Se borra del .env; los agentes dejarán de verla.'))) return;
    try {
      await Bridge.call('db.delete', { id: c.id });
      for (const d of viewDatas('db')) if (d.connId === c.id) d.connId = null;
      save();
      loadDbs();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ======================================================================
  // SSH: servidores guardados en FRAP_HOME/ssh.env (contraseñas solo en el bridge)
  // ======================================================================
  let sshInfo = null;
  let sshError = null;
  const sshTarget = (c) => `${c.user}@${c.host}${c.port ? ':' + c.port : ''}`;

  async function loadSsh() {
    if (!Bridge.ready) return;
    try { sshInfo = await Bridge.call('ssh.list'); sshError = null; } catch (e) { sshError = e.message; }
    if (state.ui.rtab === 'ssh') renderRight();
    renderSftpBar();
    renderProjects(); // nombres de servidor en las vistas Archivos
  }

  function renderSsh() {
    const head = section('SSH',
      h('button.mini', { title: 'Recargar', onclick: loadSsh }, '↻'),
      h('button.mini.primary', { onclick: () => editSsh() }, '+ Nuevo'));
    if (!Bridge.ready) return [head, h('p.muted', 'Bridge desconectado.')];
    if (!sshInfo) return [head, sshError ? h('p', { style: 'color:var(--err)' }, sshError) : h('p.muted', 'Cargando…')];
    const sk = sshInfo.skills || {};
    const agents = h('div.card.db-agents',
      h('div.title', h('span.name', '🤖 Acceso para agentes')),
      h('div.desc', { title: 'claude, codex y opencode usan el CLI frap-ssh: ejecutan comandos sin terminal y nunca ven contraseñas' },
        'Los agentes solo ven los servidores con 🤖 Uso por IA y pueden ejecutar comandos en ellos.'),
      h('div.path', { title: sshInfo.envFile }, `credenciales: ${tilde(sshInfo.envFile)} (0600)`),
      h('div.acts',
        h('button.mini', { title: 'Escribe la skill frap-ssh en ~/.claude/skills y ~/.codex/skills', onclick: installSshSkill },
          sk.claude && sk.codex ? '✓ Skill instalada · reinstalar' : 'Instalar skill (claude + codex)'),
        h('button.mini', { title: 'Copiar el comando del CLI', onclick: () => { copyText(`node ${sshInfo.cli} list`); toast('Comando copiado', 'ok'); } }, 'Copiar comando')));
    const warn = sshInfo.client ? null : h('p', { style: 'color:var(--err)' }, 'No se encontró el cliente ssh en el sistema.');
    if (!sshInfo.hosts.length) return [head, agents, warn, h('p.muted', 'Aún no hay servidores. Pulsa "+ Nuevo" y agrega IP, usuario y contraseña o llave.')];
    return [head, agents, warn, ...sshInfo.hosts.map((c) => h(`div.card.db-card${c.enabled ? '.clickable' : '.off'}`, {
      title: c.enabled ? 'Conectar (abre una terminal)' : 'Servidor desactivado',
      onclick: () => { if (c.enabled) connectSsh(c.id); },
    },
      h('div.title',
        h('span.name', `🖧 ${c.name}`),
        c.key ? h('span.badge', { title: c.key }, '🔑 llave') : null,
        h('button.icon.mini', { title: 'Conectar', disabled: !c.enabled, onclick: (e) => { e.stopPropagation(); connectSsh(c.id); } }, '▶'),
        h('button.icon.mini', { title: 'Archivos (SFTP): subir y descargar', disabled: !c.enabled, onclick: (e) => { e.stopPropagation(); openSftpView(c.id); } }, '⇅'),
        h('button.icon.mini', { title: 'Probar conexión', onclick: (e) => { e.stopPropagation(); testSsh({ id: c.id }, c.name); } }, '⚡'),
        h('button.icon.mini', { title: 'Editar', onclick: (e) => { e.stopPropagation(); editSsh(c); } }, '✎'),
        h('button.icon.mini', { title: 'Eliminar', onclick: (e) => { e.stopPropagation(); deleteSsh(c); } }, '✕')),
      h('div.path', { title: c.dir ? `id: ${c.id} · ruta inicial: ${c.dir}` : `id: ${c.id}` }, `${sshTarget(c)}${c.dir ? ` · 📂 ${c.dir}` : ''} · id: ${c.id}`),
      h('div.db-flags',
        h('label.db-flag', { onclick: (e) => e.stopPropagation() },
          sshSwitch(c, 'enabled', c.enabled ? 'Desactivar (no se podrá conectar ni usar por agentes)' : 'Activar'),
          h('span', c.enabled ? 'Activo' : 'Desactivado')),
        h('label.db-flag', { onclick: (e) => e.stopPropagation() },
          sshSwitch(c, 'ai', !c.enabled ? 'Activa primero el servidor'
            : c.ai ? 'Quitar el acceso a claude, codex, opencode…' : 'Permitir que claude, codex, opencode… ejecuten comandos aquí', !c.enabled),
          h('span', c.enabled && c.ai ? '🤖 Uso por IA' : '🤖 Sin IA')))))];
  }

  function sshSwitch(c, key, title, disabled) {
    const on = key === 'ai' ? c.enabled && c.ai : c.enabled;
    return h('button', {
      class: `switch ${on ? 'on' : 'off'}`,
      role: 'switch', 'aria-checked': String(!!on), title, disabled: !!disabled || !Bridge.ready,
      onclick: (e) => { e.stopPropagation(); toggleSsh(c, key); },
    });
  }

  async function toggleSsh(c, key) {
    try {
      const saved = await Bridge.call('ssh.toggle', { id: c.id, [key]: !c[key] });
      toast(key === 'enabled'
        ? `${c.name}: ${saved.enabled ? 'activado' : 'desactivado'}`
        : `${c.name}: ${saved.ai ? 'los agentes pueden ejecutar comandos aquí' : 'los agentes ya no pueden usarlo'}`, 'ok');
      loadSsh();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function installSshSkill() {
    try {
      const files = await Bridge.call('ssh.installSkill', { tools: ['claude', 'codex'] });
      toast(`Skill instalada: ${files.map(tilde).join(', ')}`, 'ok');
      loadSsh();
      loadConfig(true);
    } catch (e) { toast(e.message, 'err'); }
  }

  async function testSsh(args, label) {
    toast(`Probando ${label || 'servidor'}…`);
    try {
      const r = await Bridge.call('ssh.test', args);
      toast(`✓ Conecta (${r.ms} ms)${r.system ? ' · ' + r.system.slice(0, 80) : ''}`, 'ok');
    } catch (e) { toast(`✗ ${e.message}`, 'err'); }
  }

  /** Abre una terminal ssh en el proyecto activo (o "Sin proyecto"). */
  async function connectSsh(id) {
    if (!Bridge.ready) { toast('Bridge desconectado', 'err'); return; }
    const p = project();
    try {
      const info = await Bridge.call('ssh.connect', {
        id, cols: 120, rows: 32,
        projectId: p ? p.id : null,
        cwd: p && p.folders.length ? p.folders[0] : undefined,
      });
      ensureTerm(info);
      activate(info.sid);
    } catch (e) { toast(e.message, 'err'); }
  }

  /** Botón ssh del panel central: conecta directo si hay un solo servidor activo; si no, elige. */
  async function pickSsh() {
    if (!sshInfo) await loadSsh();
    const hosts = sshInfo ? sshInfo.hosts.filter((c) => c.enabled) : [];
    if (!hosts.length) { setRtab('ssh'); toast(sshInfo && sshInfo.hosts.length ? 'Todos los servidores están desactivados' : 'Agrega un servidor SSH en el panel derecho'); return; }
    if (hosts.length === 1) { connectSsh(hosts[0].id); return; }
    openModal({
      title: 'Conectar por SSH',
      body: [h('div.ssh-pick', hosts.map((c) => h('button.ssh-pick-item', {
        onclick: () => { modalClose(true); connectSsh(c.id); },
      }, h('span.name', c.name), h('span.muted.mono', sshTarget(c)))))],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar')],
    });
    requestAnimationFrame(() => { const b = $('.ssh-pick-item'); if (b) b.focus(); });
  }

  function editSsh(c) {
    if (!Bridge.ready) { toast('Bridge desconectado', 'err'); return; }
    const isNew = !c;
    const name = h('input', { value: c ? c.name : '', placeholder: 'Mi servidor' });
    const host = h('input.mono', { value: c ? c.host : '', placeholder: '192.168.0.10 o servidor.ejemplo.com' });
    const port = h('input.mono', { value: c ? c.port : '', placeholder: '22', style: 'width:100px' });
    const user = h('input.mono', { value: c ? c.user : '', placeholder: 'usuario', autocomplete: 'off' });
    const pass = h('input.mono', { type: 'password', autocomplete: 'new-password', placeholder: c && c.hasPassword ? '•••••• (sin cambios)' : 'contraseña (opcional con llave)' });
    pass.style.width = '100%';
    const showPass = h('button.icon.mini', { title: 'Mostrar/ocultar', onclick: () => { pass.type = pass.type === 'password' ? 'text' : 'password'; } }, '👁');
    const key = h('input.mono', { value: c ? c.key : '', placeholder: '~/.ssh/id_ed25519 (opcional)' });
    const dir = h('input.mono', { value: c ? c.dir || '' : '', placeholder: '/var/www/app o ~/proyecto (opcional)' });
    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = !c || c.enabled !== false;
    const ai = h('input', { type: 'checkbox' });
    ai.checked = !!(c && c.ai);
    const collect = () => ({
      id: c ? c.id : undefined,
      name: name.value.trim(), host: host.value.trim(), port: port.value.trim(), user: user.value.trim(),
      password: c && !pass.value ? null : pass.value,
      key: key.value.trim().replace(/^~(?=\/|$)/, (Bridge.info && Bridge.info.home) || '~'),
      dir: dir.value.trim(),
      enabled: enabled.checked, ai: ai.checked,
    });
    const doSave = async () => {
      try {
        const saved = await Bridge.call('ssh.save', { host: collect() });
        if (c && (c.dir || '') !== (saved.dir || '')) { for (const d of viewDatas('sftp')) delete d.remote[saved.id]; save(); } // SFTP arranca en la nueva ruta
        modalClose(true);
        toast(`Guardado en ${tilde(sshInfo ? sshInfo.envFile : 'ssh.env')}`, 'ok');
        loadSsh();
      } catch (e) { toast(e.message, 'err'); }
    };
    openModal({
      title: isNew ? 'Nuevo servidor SSH' : `Editar · ${c.name}`,
      body: [
        h('div.field', h('label', 'Nombre'), name),
        h('div.field-row', h('div.field.grow', h('label', 'IP / host'), host), h('div.field', h('label', 'Puerto'), port)),
        h('div.field-row',
          h('div.field.grow', h('label', 'Usuario'), user),
          h('div.field.grow', h('label', 'Contraseña'), h('div.field-row', h('span.grow', pass), showPass))),
        h('div.field', h('label', 'Llave privada (opcional)'), key),
        h('div.field', h('label', { title: 'Al conectar por SSH se hace cd a esta carpeta; el gestor SFTP abre aquí' }, 'Ruta inicial (opcional): donde empiezan SSH y SFTP'), dir),
        h('label.muted', enabled, ' Activo (desactivado, no se puede conectar ni lo usan los agentes)'),
        h('label.muted', ai, ' Uso por IA: claude, codex, opencode… pueden ejecutar comandos en este servidor con frap-ssh'),
        h('p.muted', { style: 'margin:0;font-size:11px' },
          'Se guarda en el ssh.env del bridge (permisos 0600), no en el navegador. La contraseña se entrega a ssh por SSH_ASKPASS, nunca en la línea de comandos. Si das uso por IA, mejor un usuario con permisos limitados.'),
      ],
      foot: [
        h('button', { onclick: () => testSsh({ host: collect() }, name.value || 'servidor') }, '⚡ Probar conexión'),
        h('span.grow'),
        h('button', { onclick: () => modalClose(true) }, 'Cancelar'),
        h('button.primary', { onclick: doSave }, 'Guardar'),
      ],
    });
  }

  async function deleteSsh(c) {
    if (!(await confirmBox(`¿Eliminar el servidor "${c.name}"?`, 'Se borra del ssh.env; los agentes dejarán de verlo. Las terminales abiertas siguen.'))) return;
    try {
      await Bridge.call('ssh.delete', { id: c.id });
      loadSsh();
    } catch (e) { toast(e.message, 'err'); }
  }

  // ----- pestaña Archivos (SFTP, panel central) -----
  // Dos paneles como FileZilla: local (dentro de FRAP_FS_ROOT) ↔ servidor SSH. Las transferencias van
  // en una cola, de a una, y cada una es un `sftp` del bridge (la contraseña la entrega askpass).
  let sftpPane = null; // panel de la vista Archivos enlazada
  const sftpQueue = []; // cola común a todas las vistas Archivos (una transferencia a la vez) // {tid, up, name, from, to, isDir, hostId, status: wait|run|ok|err|cancel, msg, started, ms}
  let sftpBusy = false;
  const fmtBytes = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
    : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
  const joinRemote = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
  const joinLocal = (dir, name) => `${dir.replace(/\/+$/, '')}/${name}`;
  /** Carpeta de destino abreviada para la cola: "…/www/logs/" (la ruta completa queda en el title). */
  const shortDir = (full) => {
    const parts = full.split('/').slice(0, -1);
    return parts.length > 3 ? `…/${parts.slice(-2).join('/')}/` : `${parts.join('/')}/`;
  };
  const sftpHosts = () => (sshInfo ? sshInfo.hosts.filter((c) => c.enabled) : []);
  const sftpHost = () => sftpHosts().find((c) => c.id === state.sftp.hostId) || null;

  /** Abre (o enfoca) la vista Archivos del proyecto activo; con hostId, cambia a ese servidor. */
  function openSftpView(hostId) {
    if (!needProject()) return;
    bindView(viewFor('sftp')); // enlazar antes de tocar state.sftp
    if (hostId) state.sftp.hostId = hostId;
    const { fresh } = showView('sftp');
    const pane = sftpPane;
    (sshInfo ? Promise.resolve() : loadSsh()).then(() => {
      if (sftpPane !== pane) return;
      renderSftpQueue();
      if (!fresh && !hostId && pane.local.path) { renderSftpBar(); return; } // ya abierta (y cargada): se queda donde estaba
      sftpInitial();
    });
  }
  /** Primera carga de la vista Archivos enlazada: elige servidor y carga ambos lados. */
  function sftpInitial() {
    if (!sftpPane) return;
    const hosts = sftpHosts();
    if (!sftpHost() && hosts.length) state.sftp.hostId = hosts[0].id;
    const c0 = sftpHost();
    if (c0 && c0.dir) delete state.sftp.remote[c0.id]; // al abrir, empieza en la ruta inicial
    renderSftpBar();
    sftpLoad('local');
    sftpLoad('remote');
  }
  function sftpStatusLine() {
    const c = sftpHost();
    return c ? `${sshTarget(c)} · ${state.sftp.remote[c.id] || '~'}` : 'Archivos (SFTP)';
  }

  /** Un lado del gestor: {key, title, path, entries, sel:Set, last, error, loading, els…} */
  function sftpSide(key) {
    const s = { key, path: '', entries: [], sel: new Set(), last: null, error: '', loading: false };
    const remote = key === 'remote';
    s.pathInput = h('input.mono.sftp-path', { spellcheck: 'false', title: 'Ruta (Enter para ir)' });
    s.pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sftpLoad(key, s.pathInput.value.trim()); });
    s.list = h('div.sftp-list', { tabindex: '0' });
    s.list.addEventListener('dragover', (e) => { if (sftpDrag && sftpDrag.from !== key) { e.preventDefault(); s.list.classList.add('drop'); } });
    s.list.addEventListener('dragleave', () => s.list.classList.remove('drop'));
    s.list.addEventListener('drop', (e) => {
      e.preventDefault();
      s.list.classList.remove('drop');
      if (sftpDrag && sftpDrag.from !== key) sftpTransfer(sftpDrag.from, sftpDrag.names);
      sftpDrag = null;
    });
    s.list.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && s.sel.size) { e.preventDefault(); sftpTransfer(key, [...s.sel]); }
      else if (e.key === 'Backspace') { e.preventDefault(); sftpUp(key); }
      else if (e.key === 'Delete') { e.preventDefault(); if (remote) sftpRemove(); else sftpLocalTrash(); }
      else if (e.key === 'F2') { e.preventDefault(); if (remote) sftpRename(); else sftpLocalRename(); }
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = (s.list.querySelector('.sftp-item.sel') || s.list).getBoundingClientRect();
        sftpMenu({ clientX: r.left + 24, clientY: r.top + Math.min(r.height, 20), preventDefault() {} }, key, null);
      }
    });
    // clic derecho en el fondo de la lista: opciones de la carpeta abierta
    s.list.addEventListener('contextmenu', (e) => { if (e.target === s.list || !e.target.closest('.sftp-item')) sftpMenu(e, key, null); });
    s.sendBtn = h('button.primary.mini', {
      title: remote ? 'Descargar lo seleccionado a la carpeta local (o arrastra a la izquierda)' : 'Subir lo seleccionado a la carpeta remota (o arrastra a la derecha)',
      onclick: () => sftpTransfer(key, [...s.sel]),
    }, remote ? '⇦ Descargar' : 'Subir ⇨');
    s.root = h('div.sftp-side',
      h('div.sftp-head',
        h('span.sftp-title', remote ? '🖧 Servidor' : '💻 Local'),
        h('button.icon.mini', { title: 'Subir un nivel (Retroceso)', onclick: () => sftpUp(key) }, '↑'),
        s.pathInput,
        h('button.icon.mini', { title: 'Recargar', onclick: () => sftpLoad(key) }, '⟳'),
        remote ? h('button.icon.mini', { title: 'Ir a la ruta inicial del servidor', onclick: () => sftpLoad('remote', '') }, '⌂') : null),
      h('div.sftp-tools',
        s.sendBtn,
        remote ? h('button.mini', { title: 'Nueva carpeta en el servidor', onclick: sftpMkdir }, '+ Carpeta') : null,
        remote ? h('button.mini', { title: 'Renombrar (F2)', onclick: sftpRename }, '✎ Renombrar') : null,
        remote ? h('button.mini.danger', { title: 'Eliminar archivos o carpetas vacías (Supr)', onclick: sftpRemove }, '✕ Eliminar') : null,
        !remote ? h('button.mini', { title: 'Ir a la carpeta del proyecto', onclick: () => { const p = project(); if (p && p.folders[0]) sftpLoad('local', p.folders[0]); } }, '📁 Proyecto') : null,
        h('span.grow'),
        s.info = h('span.muted.sftp-info')),
      h('div.sftp-row.sftp-cols', h('span.n', 'Nombre'), h('span.sz', 'Tamaño'), h('span.mt', 'Modificado')),
      s.list);
    return s;
  }
  let sftpDrag = null;

  function ensureSftpPane() {
    if (sftpPane) return sftpPane;
    const host = h('select.db-conn', { title: 'Servidor (los de la pestaña SSH que estén activos)' });
    host.addEventListener('change', () => { state.sftp.hostId = host.value; const hc = sftpHost(); if (hc && hc.dir) delete state.sftp.remote[hc.id]; save(); renderSftpBar(); sftpLoad('remote'); renderPanes(); renderProjects(); });
    const hidden = h('input', { type: 'checkbox' });
    hidden.checked = !!state.sftp.hidden;
    hidden.addEventListener('change', () => { state.sftp.hidden = hidden.checked; save(); sftpLoad('local'); renderSftpList('remote'); });
    const local = sftpSide('local');
    const remote = sftpSide('remote');
    const queue = h('div.sftp-queue');
    const clear = h('button.mini', { title: 'Quitar de la lista las transferencias terminadas', onclick: () => {
      for (let i = sftpQueue.length - 1; i >= 0; i--) if (!['wait', 'run'].includes(sftpQueue[i].status)) sftpQueue.splice(i, 1);
      renderSftpQueue();
    } }, 'Limpiar');
    const root = h('div.sftp-pane.hidden',
      h('div.db-bar', host, h('label.muted', { title: 'Mostrar archivos que empiezan por "."' }, hidden, ' ocultos'), h('span.grow'),
        h('span.muted', { style: 'font-size:11px' }, 'Doble clic: abrir carpeta o transferir · arrastra entre paneles · Ctrl/Shift+clic: varios · clic derecho: más opciones')),
      h('div.sftp-main', local.root, remote.root),
      h('div.sftp-qhead', h('span', 'Transferencias'), h('span.grow'), clear),
      queue);
    $('#term-host').append(root);
    sftpPane = { root, host, hidden, local, remote, queue };
    viewPanes.set(bound.sftp, sftpPane);
    renderSftpBar();
    renderSftpQueue();
    return sftpPane;
  }

  function renderSftpBar() {
    if (!sftpPane) return;
    const hosts = sftpHosts();
    sftpPane.host.replaceChildren(...(hosts.length
      ? hosts.map((c) => h('option', { value: c.id }, `${c.name} (${sshTarget(c)})`))
      : [h('option', { value: '' }, sshInfo && sshInfo.hosts.length ? 'Todos los servidores están desactivados' : 'Sin servidores — agrégalos en la pestaña SSH')]));
    sftpPane.host.value = state.sftp.hostId || '';
  }

  async function sftpLoad(key, path) {
    const p = ensureSftpPane();
    const s = p[key];
    const remote = key === 'remote';
    const c = remote ? sftpHost() : null;
    if (remote && !c) { s.entries = []; s.error = 'Elige un servidor activo (pestaña SSH).'; renderSftpList(key); return; }
    if (!Bridge.ready) { s.error = 'Bridge desconectado.'; renderSftpList(key); return; }
    const pr = project();
    const target = path != null ? path : remote ? state.sftp.remote[c.id] || '' : state.sftp.local || (pr && pr.folders[0]) || '~';
    s.loading = true;
    s.info.textContent = 'Cargando…';
    try {
      const r = remote
        ? await Bridge.call('sftp.list', { id: c.id, path: target })
        : await Bridge.call('fs.list', { path: target, dirsOnly: false, hidden: true, details: true });
      if (sftpPane !== p) { s.loading = false; return; } // se cambió de vista mientras cargaba
      if (remote && state.sftp.hostId !== c.id) return; // cambió de servidor mientras cargaba
      if (r.path !== s.path) { s.sel.clear(); s.last = null; }
      s.path = r.path;
      s.parent = r.parent;
      s.entries = r.entries;
      s.error = '';
      if (remote) {
        state.sftp.remote[c.id] = r.path;
        if (r.startError) toast(r.startError, 'err');
      } else state.sftp.local = r.path; // ojo: solo el lado local guarda la carpeta local
      save();
    } catch (e) {
      if (sftpPane !== p) { s.loading = false; return; }
      s.error = e.message;
      if (remote && path == null && state.sftp.remote[c.id]) { delete state.sftp.remote[c.id]; save(); } // la ruta guardada ya no existe
      if (!remote && path == null && state.sftp.local) { // la carpeta local guardada no existe (o era una ruta del servidor): vuelve al proyecto
        delete state.sftp.local;
        save();
        s.loading = false;
        return sftpLoad('local');
      }
    }
    s.loading = false;
    renderSftpList(key);
    if (remote) renderPanes();
  }
  function sftpUp(key) {
    const s = sftpPane && sftpPane[key];
    if (s && s.parent) sftpLoad(key, s.parent);
  }
  const sftpVisible = (s) => s.entries.filter((e) => state.sftp.hidden || !e.name.startsWith('.'));

  function renderSftpList(key) {
    const s = sftpPane[key];
    const remote = key === 'remote';
    s.pathInput.value = s.path ? (remote ? s.path : tilde(s.path)) : '';
    s.pathInput.scrollLeft = s.pathInput.scrollWidth; // rutas largas: se ve el final
    const items = sftpVisible(s);
    for (const n of [...s.sel]) if (!items.some((e) => e.name === n)) s.sel.delete(n);
    if (s.error) { s.list.replaceChildren(h('pre.db-error', s.error)); s.info.textContent = 'Error'; }
    else {
      const rows = items.map((e, i) => h(`div.sftp-row.sftp-item${s.sel.has(e.name) ? '.sel' : ''}${e.dir ? '.dir' : ''}`, {
        draggable: 'true',
        title: remote ? `${e.perm || ''} ${e.owner || ''}`.trim() : '',
        onclick: (ev) => sftpSelect(key, items, i, ev),
        ondblclick: () => sftpOpen(key, e),
        oncontextmenu: (ev) => {
          if (!s.sel.has(e.name)) { s.sel.clear(); s.sel.add(e.name); s.last = e.name; renderSftpList(key); }
          sftpMenu(ev, key, e);
        },
        ondragstart: (ev) => {
          if (!s.sel.has(e.name)) { s.sel.clear(); s.sel.add(e.name); renderSftpList(key); }
          sftpDrag = { from: key, names: [...s.sel] };
          ev.dataTransfer.effectAllowed = 'copy';
          ev.dataTransfer.setData('text/plain', [...s.sel].join('\n'));
        },
        ondragend: () => { sftpDrag = null; },
      },
      h('span.n', `${e.dir ? '📁' : e.link ? '🔗' : '📄'} ${e.name}`),
      h('span.sz', e.dir ? '' : fmtBytes(e.size)),
      h('span.mt', remote ? e.mtime : e.mtime ? new Date(e.mtime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '')));
      s.list.replaceChildren(...(rows.length ? rows : [h('p.muted', { style: 'padding:8px 10px' }, 'Carpeta vacía.')]));
      const selSize = items.filter((e) => s.sel.has(e.name) && !e.dir).reduce((a, e) => a + (e.size || 0), 0);
      s.info.textContent = s.sel.size ? `${s.sel.size} seleccionado${s.sel.size === 1 ? '' : 's'}${selSize ? ' · ' + fmtBytes(selSize) : ''}` : `${items.length} elemento${items.length === 1 ? '' : 's'}`;
    }
    s.sendBtn.disabled = !s.sel.size || !sftpHost();
  }

  function sftpSelect(key, items, i, ev) {
    const s = sftpPane[key];
    const name = items[i].name;
    if (ev.shiftKey && s.last != null) {
      const a = items.findIndex((e) => e.name === s.last);
      const [x, y] = a < 0 ? [i, i] : [Math.min(a, i), Math.max(a, i)];
      if (!ev.ctrlKey && !ev.metaKey) s.sel.clear();
      for (let k = x; k <= y; k++) s.sel.add(items[k].name);
    } else if (ev.ctrlKey || ev.metaKey) {
      if (s.sel.has(name)) s.sel.delete(name); else s.sel.add(name);
      s.last = name;
    } else {
      s.sel.clear();
      s.sel.add(name);
      s.last = name;
    }
    renderSftpList(key);
    s.list.focus();
  }

  async function sftpOpen(key, e) {
    const s = sftpPane[key];
    const full = key === 'remote' ? joinRemote(s.path, e.name) : joinLocal(s.path, e.name);
    if (e.dir) { sftpLoad(key, full); return; }
    if (e.link && key === 'remote') {
      // un enlace puede ser carpeta: se intenta abrir; si no lo es, se transfiere
      try {
        const c = sftpHost();
        const r = await Bridge.call('sftp.list', { id: c.id, path: full });
        if (r.path !== s.path) { sftpLoad(key, full); return; }
      } catch (_) { /* es un archivo */ }
    }
    sftpTransfer(key, [e.name]);
  }

  /** Encola la transferencia de `names` del lado `from` hacia la carpeta abierta del otro lado. */
  async function sftpTransfer(from, names) {
    const p = sftpPane;
    const c = sftpHost();
    if (!p || !c || !names.length) return;
    const src = p[from];
    const dst = p[from === 'local' ? 'remote' : 'local'];
    if (!src.path || !dst.path || dst.error) { toast('Abre una carpeta válida en ambos lados', 'err'); return; }
    const up = from === 'local';
    const ents = names.map((n) => src.entries.find((e) => e.name === n)).filter(Boolean);
    const clash = ents.filter((e) => dst.entries.some((d) => d.name === e.name));
    if (clash.length && !(await confirmBox(`¿Reemplazar ${clash.length === 1 ? `"${clash[0].name}"` : `${clash.length} elementos`} en ${up ? 'el servidor' : 'tu equipo'}?`,
      `Ya existe${clash.length === 1 ? '' : 'n'} en ${up ? dst.path : tilde(dst.path)}: ${clash.slice(0, 8).map((e) => e.name).join(', ')}${clash.length > 8 ? '…' : ''}. Los archivos se sobrescriben.`))) return;
    for (const e of ents) {
      sftpQueue.push({
        tid: uid(), up, name: e.name, isDir: !!e.dir, hostId: c.id, size: e.dir ? null : e.size,
        from: up ? joinLocal(src.path, e.name) : joinRemote(src.path, e.name),
        to: up ? joinRemote(dst.path, e.name) : joinLocal(dst.path, e.name),
        status: 'wait', pane: p,
      });
    }
    renderSftpQueue();
    sftpPump();
  }

  async function sftpPump() {
    if (sftpBusy) return;
    const job = sftpQueue.find((j) => j.status === 'wait');
    if (!job) return;
    sftpBusy = true;
    job.status = 'run';
    job.started = Date.now();
    renderSftpQueue();
    const tick = setInterval(renderSftpQueue, 1000);
    try {
      if (job.up) await Bridge.call('sftp.put', { id: job.hostId, local: job.from, remote: job.to, tid: job.tid });
      else await Bridge.call('sftp.get', { id: job.hostId, remote: job.from, local: job.to, dir: job.isDir, tid: job.tid });
      job.status = 'ok';
    } catch (e) {
      job.status = /cancelada/.test(e.message) ? 'cancel' : 'err';
      job.msg = e.message;
    }
    clearInterval(tick);
    job.ms = Date.now() - job.started;
    sftpBusy = false;
    renderSftpQueue();
    // refresca el lado de destino si sigue abierto en esa carpeta
    if (sftpPane && sftpPane === job.pane && !sftpQueue.some((j) => j.status === 'wait' && j.up === job.up)) {
      const key = job.up ? 'remote' : 'local';
      if (!job.up || state.sftp.hostId === job.hostId) sftpLoad(key, sftpPane[key].path);
    }
    if (job.status === 'err') toast(`${job.up ? 'Subida' : 'Descarga'} de "${job.name}" falló: ${job.msg}`, 'err');
    sftpPump();
  }

  function sftpCancel(job) {
    if (job.status === 'wait') { job.status = 'cancel'; job.msg = 'Cancelada'; renderSftpQueue(); return; }
    if (job.status === 'run') Bridge.call('sftp.cancel', { tid: job.tid }).catch(() => {});
  }

  function renderSftpQueue() {
    if (!sftpPane) return;
    const icon = { wait: '⏳', run: '⇄', ok: '✓', err: '✗', cancel: '⊘' };
    const label = { wait: 'en cola', run: 'transfiriendo…', ok: 'listo', err: 'error', cancel: 'cancelada' };
    const rows = sftpQueue.slice().reverse().map((j) => h(`div.sftp-job.${j.status}`, { title: `${j.from}\n→ ${j.to}${j.msg ? '\n' + j.msg : ''}` },
      h('span.st', icon[j.status]),
      h('span.dirn', j.up ? '⇧' : '⇩'),
      h('span.n', j.name + (j.isDir ? '/' : '')),
      h('span.muted.to', `→ ${shortDir(j.up ? j.to : tilde(j.to))}`),
      h('span.sz', j.size != null ? fmtBytes(j.size) : ''),
      h('span.lbl', j.status === 'err' ? j.msg.split('\n')[0] : label[j.status]),
      h('span.tm', j.started ? (fmtDur((j.ms || (Date.now() - j.started)) / 1000) || '<1 s') : ''),
      ['wait', 'run'].includes(j.status) ? h('button.icon.mini', { title: 'Cancelar', onclick: () => sftpCancel(j) }, '✕') : h('span')));
    sftpPane.queue.replaceChildren(...(rows.length ? rows : [h('p.muted', { style: 'padding:6px 10px;margin:0' }, 'Sin transferencias. Selecciona archivos y pulsa Subir/Descargar, haz doble clic o arrástralos al otro panel.')]));
  }

  /** Clic derecho en el gestor SFTP. e: la fila (ya seleccionada) o null = la carpeta abierta. */
  function sftpMenu(ev, key, e) {
    const p = sftpPane;
    const s = p && p[key];
    if (!s || !s.path || s.error) return;
    const remote = key === 'remote';
    const c = sftpHost();
    const other = p[remote ? 'local' : 'remote'];
    const sel = e ? [...s.sel] : [];
    const n = sel.length;
    const what = n === 1 ? `"${sel[0]}"` : `${n} elementos`;
    const canSend = n && c && other.path && !other.error;
    const full = e ? (remote ? joinRemote(s.path, e.name) : joinLocal(s.path, e.name)) : s.path;
    const isDir = e ? !!e.dir : true;
    if (remote) {
      popMenu(ev, [
        e && e.dir && n === 1 && { label: 'Abrir carpeta', action: () => sftpLoad('remote', full) },
        canSend && { label: `⇦ Descargar ${what} a ${tilde(other.path)}`, action: () => sftpTransfer('remote', sel) },
        e && n === 1 && { label: 'Copiar ruta remota', action: () => codeCopy(full) },
        '-',
        { label: 'Nueva carpeta…', action: sftpMkdir },
        n === 1 && { label: 'Renombrar… (F2)', action: sftpRename },
        n && { label: `Eliminar ${what}… (Supr)`, danger: true, action: sftpRemove },
        '-',
        { label: 'Recargar', action: () => sftpLoad('remote', s.path) },
        !e && { label: 'Copiar ruta remota', action: () => codeCopy(s.path) },
      ]);
      return;
    }
    const isMedia = /\.(html?|svg|pdf|png|jpe?g|gif|webp|mp4|webm)$/i.test(full);
    popMenu(ev, [
      e && !e.dir && n === 1 && launchOn('code') && { label: 'Editar en el editor de código', action: () => openInFrap(full) },
      e && e.dir && n === 1 && { label: 'Abrir carpeta', action: () => sftpLoad('local', full) },
      e && e.dir && n === 1 && launchOn('code') && { label: 'Mostrar en el editor de código', action: () => openInFrap(full, null, null, true) },
      canSend && { label: `Subir ${what} a ${other.path} ⇨`, action: () => sftpTransfer('local', sel) },
      !c && n && { label: 'Subir al servidor (elige un servidor arriba)', disabled: true },
      '-',
      { label: 'Nuevo archivo…', action: () => sftpLocalNew(false) },
      { label: 'Nueva carpeta…', action: () => sftpLocalNew(true) },
      n === 1 && { label: 'Renombrar… (F2)', action: sftpLocalRename },
      n && { label: `Mover ${what} a la papelera (Supr)`, danger: true, action: sftpLocalTrash },
      '-',
      { label: n > 1 ? 'Copiar rutas' : 'Copiar ruta', action: () => codeCopy(n > 1 ? sel.map((x) => joinLocal(s.path, x)).join('\n') : full) },
      e && !e.dir && n === 1 && { label: 'Enviar ruta a la IA', action: () => codeSendToAi(full) },
      (n <= 1) && isDir && { label: 'Abrir terminal aquí', action: () => launch('shell', { cwd: full, title: basename(full) }) },
      (n <= 1) && (isDir || isMedia) && rtabOn('tunnels') && { label: 'Compartir por túnel…', action: () => { setRtab('tunnels'); editTunnel(null, { kind: 'path', path: full, name: basename(full) }); } },
      (n <= 1) && { label: isDir ? 'Abrir en el explorador de archivos' : 'Mostrar en el explorador de archivos', action: () => openInFileManager(full) },
      (n <= 1) && { label: `Abrir en ${extEditorName()}`, action: () => openExternal(full) },
      '-',
      { label: 'Recargar', action: () => sftpLoad('local', s.path) },
      !e && project() && project().folders[0] && { label: 'Ir a la carpeta del proyecto', action: () => sftpLoad('local', project().folders[0]) },
    ]);
  }
  /** Tras cambiar archivos locales desde el gestor: el árbol del editor de código no queda viejo. */
  function sftpLocalChanged(abs) { if (codePane) { codeInvalidateDirs(abs); if (state.code.side === 'tree') codeRenderTree(); } }
  async function sftpLocalNew(isDir) {
    const s = sftpPane && sftpPane.local;
    if (!s || !s.path) return;
    const name = await askText(isDir ? 'Nueva carpeta' : 'Nuevo archivo', `En ${tilde(s.path)}/`);
    if (!name) return;
    if (name.includes('/')) { toast('El nombre no puede llevar "/"', 'err'); return; }
    const abs = joinLocal(s.path, name);
    try {
      if (await Bridge.call('fs.exists', { path: abs })) { toast(`Ya existe: ${tilde(abs)}`, 'err'); return; }
      if (isDir) await Bridge.call('fs.mkdir', { path: abs });
      else await Bridge.call('fs.write', { path: abs, content: '' });
      s.sel = new Set([name]);
      s.last = name;
      sftpLocalChanged(abs);
      await sftpLoad('local', s.path);
      if (!isDir && launchOn('code')) openInFrap(abs);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function sftpLocalRename() {
    const s = sftpPane && sftpPane.local;
    if (!s || s.sel.size !== 1) { toast('Selecciona un solo elemento local', 'err'); return; }
    const old = [...s.sel][0];
    const name = await askText('Renombrar', 'Nuevo nombre', old);
    if (!name || name === old) return;
    if (name.includes('/')) { toast('El nombre no puede llevar "/"', 'err'); return; }
    const from = joinLocal(s.path, old);
    const to = joinLocal(s.path, name);
    try {
      if (await Bridge.call('fs.exists', { path: to })) { toast(`Ya existe: ${tilde(to)}`, 'err'); return; }
      await Bridge.call('fs.rename', { from, to });
      s.sel = new Set([name]);
      s.last = name;
      sftpLocalChanged(from);
      sftpLocalChanged(to);
      sftpLoad('local', s.path);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function sftpLocalTrash() {
    const s = sftpPane && sftpPane.local;
    if (!s || !s.sel.size) { toast('Selecciona qué mover a la papelera', 'err'); return; }
    const ents = [...s.sel].map((n) => s.entries.find((e) => e.name === n)).filter(Boolean);
    if (!(await confirmBox(`¿Mover ${ents.length === 1 ? `"${ents[0].name}"` : `${ents.length} elementos`} a la papelera?`,
      `${ents.slice(0, 10).map((e) => (e.dir ? `${e.name}/` : e.name)).join(', ')}${ents.length > 10 ? '…' : ''}\n\nEn ${tilde(s.path)}. Se puede recuperar desde la papelera del sistema.`))) return;
    let ok = 0;
    for (const e of ents) {
      const abs = joinLocal(s.path, e.name);
      try { await Bridge.call('fs.trash', { path: abs }); ok++; sftpLocalChanged(abs); } catch (err) { toast(`${e.name}: ${err.message}`, 'err'); }
    }
    if (ok) toast(`${ok} movido${ok === 1 ? '' : 's'} a la papelera`, 'ok');
    sftpLoad('local', s.path);
  }

  async function sftpMkdir() {
    const c = sftpHost();
    const s = sftpPane && sftpPane.remote;
    if (!c || !s || !s.path) return;
    const name = await askText('Nueva carpeta en el servidor', `Nombre (dentro de ${s.path})`);
    if (!name) return;
    if (name.includes('/')) { toast('El nombre no puede llevar "/"', 'err'); return; }
    try {
      await Bridge.call('sftp.mkdir', { id: c.id, path: joinRemote(s.path, name) });
      s.sel = new Set([name]);
      sftpLoad('remote', s.path);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function sftpRename() {
    const c = sftpHost();
    const s = sftpPane && sftpPane.remote;
    if (!c || !s || s.sel.size !== 1) { toast('Selecciona un solo elemento del servidor', 'err'); return; }
    const old = [...s.sel][0];
    const name = await askText('Renombrar en el servidor', 'Nuevo nombre', old);
    if (!name || name === old) return;
    if (name.includes('/')) { toast('El nombre no puede llevar "/"', 'err'); return; }
    try {
      await Bridge.call('sftp.rename', { id: c.id, from: joinRemote(s.path, old), to: joinRemote(s.path, name) });
      s.sel = new Set([name]);
      sftpLoad('remote', s.path);
    } catch (e) { toast(e.message, 'err'); }
  }
  async function sftpRemove() {
    const c = sftpHost();
    const s = sftpPane && sftpPane.remote;
    if (!c || !s || !s.sel.size) { toast('Selecciona qué eliminar en el servidor', 'err'); return; }
    const ents = [...s.sel].map((n) => s.entries.find((e) => e.name === n)).filter(Boolean);
    if (!(await confirmBox(`¿Eliminar ${ents.length === 1 ? `"${ents[0].name}"` : `${ents.length} elementos`} del servidor?`,
      `${ents.slice(0, 10).map((e) => (e.dir ? `${e.name}/` : e.name)).join(', ')}${ents.length > 10 ? '…' : ''}\n\nNo se puede deshacer. Las carpetas solo se eliminan si están vacías.`))) return;
    let ok = 0;
    for (const e of ents) {
      try { await Bridge.call('sftp.remove', { id: c.id, path: joinRemote(s.path, e.name), dir: e.dir }); ok++; } catch (err) { toast(`${e.name}: ${err.message}`, 'err'); }
    }
    if (ok) toast(`${ok} eliminado${ok === 1 ? '' : 's'}`, 'ok');
    sftpLoad('remote', s.path);
  }

  // ----- pestaña DB (panel central) -----
  /** Abre (o enfoca) la vista DB del proyecto activo; con connId, cambia a esa conexión. */
  function openDbView(connId) {
    if (!needProject()) return;
    bindView(viewFor('db')); // enlazar antes de tocar state.db
    if (connId) state.db.connId = connId;
    const { fresh } = showView('db');
    if (!dbInfo) loadDbs();
    else if (!fresh || connId) { renderDbBar(); loadDbTables(); }
    requestAnimationFrame(() => dbPane && dbPane.sql.focus());
  }
  function dbStatusLine() {
    const c = dbConnById(state.db.connId);
    return c ? `${c.name} · ${dbTarget(c)}` : 'DB';
  }

  function quoteIdent(engine, name) {
    if (engine === 'mysql') return '`' + name.replace(/`/g, '``') + '`';
    return name.split('.').map((p) => '"' + p.replace(/"/g, '""') + '"').join('.');
  }

  function ensureDbPane() {
    if (dbPane) return dbPane;
    const conn = h('select.db-conn', { title: 'Conexión' });
    conn.addEventListener('change', () => { state.db.connId = conn.value; save(); renderDbBar(); loadDbTables(); renderPanes(); renderProjects(); });
    const mode = h('span.badge');
    const limit = h('select', { title: 'Máximo de filas' }, [100, 500, 1000, 5000, 20000].map((n) => h('option', { value: String(n) }, `${n} filas`)));
    limit.value = String(state.db.limit || 500);
    limit.addEventListener('change', () => { state.db.limit = Number(limit.value); save(); });
    const history = h('select', { title: 'Historial' });
    history.addEventListener('change', () => {
      if (history.value === '') return;
      sql.value = state.db.history[Number(history.value)];
      state.db.sql = sql.value;
      save();
      history.value = '';
      sql.focus();
    });
    const run = h('button.primary', { title: 'Ejecutar (Ctrl+Enter). Con texto seleccionado, ejecuta solo la selección.', onclick: () => runDbQuery() }, '▶ Ejecutar');
    const csv = h('button', { title: 'Descargar el resultado como CSV', onclick: exportDbCsv }, '⇩ CSV');
    const sql = h('textarea.db-sql', { spellcheck: 'false', placeholder: 'SELECT * FROM tabla LIMIT 100;\n\nCtrl+Enter para ejecutar · con texto seleccionado ejecuta solo la selección' });
    sql.value = state.db.sql || '';
    sql.addEventListener('input', debounce(() => { state.db.sql = sql.value; save(); }, 400));
    sql.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runDbQuery(); }
      else if (e.key === 'Tab') { e.preventDefault(); sql.setRangeText('  ', sql.selectionStart, sql.selectionEnd, 'end'); }
    });
    const filter = h('input.filter', { placeholder: 'Filtrar tablas…' });
    filter.addEventListener('input', () => {
      const q = filter.value.toLowerCase();
      for (const el of $$('.db-table', tableList)) el.classList.toggle('hidden', !el.dataset.name.toLowerCase().includes(q));
    });
    const tableList = h('div.db-tables');
    const result = h('div.db-result', h('p.muted', 'Los resultados aparecen aquí.'));
    const status = h('span.db-status.muted');
    const root = h('div.db-pane.hidden',
      h('div.db-bar', conn, mode, limit, history, h('span.grow'), status, csv, run),
      h('div.db-main',
        h('div.db-side', filter, tableList),
        h('div.db-work', sql, result)));
    $('#term-host').append(root);
    dbPane = { root, conn, mode, limit, history, run, sql, tableList, filter, result, status, last: null };
    viewPanes.set(bound.db, dbPane);
    renderDbBar();
    loadDbTables();
    return dbPane;
  }

  function renderDbBar() {
    if (!dbPane) return;
    const { conn, mode, history } = dbPane;
    const conns = dbInfo ? dbInfo.conns.filter((c) => c.enabled) : [];
    conn.replaceChildren(...(conns.length
      ? conns.map((c) => h('option', { value: c.id }, `${c.name} (${c.engine})`))
      : [h('option', { value: '' }, dbInfo && dbInfo.conns.length ? 'Todas las conexiones están desactivadas' : 'Sin conexiones — agrégalas en el panel derecho')]));
    conn.value = state.db.connId || '';
    const cc = dbConnById(state.db.connId);
    const c = cc && cc.enabled ? cc : null;
    const w = !!(c && c.uiWrite);
    mode.className = `badge ${w ? 'st-starting' : 'st-on'}`;
    mode.textContent = w ? '✎ escritura (sin eliminar)' : '🔒 solo lectura';
    mode.title = w
      ? 'Las lecturas corren en solo lectura; INSERT, UPDATE, CREATE y ALTER piden confirmación. DELETE, DROP y TRUNCATE nunca se permiten.'
      : 'Conexión en solo lectura. Para escribir, desactiva "Solo lectura" en la conexión (panel derecho).';
    history.replaceChildren(h('option', { value: '' }, `🕘 Historial (${state.db.history.length})`),
      ...state.db.history.map((q, i) => h('option', { value: String(i) }, q.replace(/\s+/g, ' ').slice(0, 80))));
    dbPane.run.disabled = !c;
  }

  async function loadDbTables() {
    if (!dbPane) return;
    const pane = dbPane;
    const list = pane.tableList;
    const cc = dbConnById(state.db.connId);
    const c = cc && cc.enabled ? cc : null;
    if (!c || !Bridge.ready) { list.replaceChildren(h('p.muted', c ? 'Bridge desconectado.' : 'Elige una conexión activa.')); return; }
    list.replaceChildren(h('p.muted', 'Cargando tablas…'));
    try {
      const tables = await Bridge.call('db.tables', { id: c.id });
      if (dbPane !== pane || state.db.connId !== c.id) return; // cambió de vista o de conexión
      list.replaceChildren(...(tables.length ? tables.map((t) => h('div.db-table', {
        dataset: { name: t.name },
        title: 'Clic: ver 100 filas · doble clic: insertar el nombre',
        onclick: () => {
          dbPane.sql.value = `SELECT * FROM ${quoteIdent(c.engine, t.name)} LIMIT 100;`;
          state.db.sql = dbPane.sql.value;
          save();
          runDbQuery();
        },
        ondblclick: () => { dbPane.sql.setRangeText(quoteIdent(c.engine, t.name), dbPane.sql.selectionStart, dbPane.sql.selectionEnd, 'end'); dbPane.sql.focus(); },
      }, `${t.view ? '◫' : '▦'} ${t.name}`)) : [h('p.muted', 'Sin tablas.')]));
      pane.filter.dispatchEvent(new Event('input'));
    } catch (e) { list.replaceChildren(h('p.muted', { style: 'color:var(--err)' }, e.message)); }
  }

  async function runDbQuery() {
    const p = ensureDbPane();
    const st = state.db; // la consulta sigue en su vista aunque se cambie de proyecto mientras corre
    const c = dbConnById(st.connId);
    if (!c) { toast('Elige una conexión', 'err'); return; }
    const { selectionStart: a, selectionEnd: b } = p.sql;
    const sql = (a !== b ? p.sql.value.slice(a, b) : p.sql.value).trim();
    if (!sql) { toast('Escribe una consulta', 'err'); return; }
    p.run.disabled = true;
    p.status.textContent = 'Ejecutando…';
    p.result.classList.add('running');
    try {
      const args = { id: c.id, sql, limit: st.limit || 500 };
      let r;
      try {
        r = await Bridge.call('db.query', args); // primero siempre en solo lectura
      } catch (e) {
        // no es una lectura: si la conexión permite escribir, se confirma y se reintenta (el bridge bloquea eliminaciones)
        if (!/^Solo lectura/.test(e.message)) throw e;
        if (!c.uiWrite) throw new Error(`${e.message}\n\nEsta conexión está en "Solo lectura". Para ejecutar INSERT, UPDATE, CREATE o ALTER, desactívalo en la conexión (panel derecho → Bases de datos).`);
        await Bridge.call('db.check', { id: c.id, sql }); // lanza el motivo si es una eliminación
        p.status.textContent = 'Esperando confirmación…';
        if (!(await confirmBox(`¿Ejecutar esta escritura en "${c.name}"?`, sql.length > 400 ? sql.slice(0, 400) + '…' : sql))) {
          p.status.textContent = 'Cancelado';
          p.result.classList.remove('running');
          p.run.disabled = false;
          return;
        }
        p.status.textContent = 'Ejecutando…';
        r = await Bridge.call('db.query', { ...args, write: true });
      }
      p.last = r;
      renderDbResult(r, p);
      p.status.textContent = `${r.rowCount} fila${r.rowCount === 1 ? '' : 's'}${r.truncated ? ' (truncado)' : ''} · ${r.ms} ms`;
      st.history = [sql, ...st.history.filter((q) => q !== sql)].slice(0, 30);
      save();
      if (dbPane === p) renderDbBar();
    } catch (e) {
      p.last = null;
      p.result.replaceChildren(h('pre.db-error', e.message));
      p.status.textContent = 'Error';
    }
    p.result.classList.remove('running');
    p.run.disabled = false;
  }

  function renderDbResult(r, p = dbPane) {
    if (!r.columns.length) { p.result.replaceChildren(h('p.muted', r.message || 'Sin filas.')); return; }
    const cell = (v) => {
      if (v === null) return h('td.null', 'NULL');
      const s = String(v);
      return h('td', { title: s.length > 60 ? s.slice(0, 2000) : null }, s.length > 300 ? s.slice(0, 300) + '…' : s);
    };
    const table = h('table.db-table-res',
      h('thead', h('tr', h('th.rn', '#'), r.columns.map((c) => h('th', c)))),
      h('tbody', r.rows.map((row, i) => h('tr', h('td.rn', String(i + 1)), r.columns.map((_, j) => cell(row[j]))))));
    table.addEventListener('click', (e) => {
      const td = e.target.closest('td');
      if (!td || td.classList.contains('rn')) return;
      const tr = td.parentElement;
      const ri = [...tr.parentElement.children].indexOf(tr);
      const ci = [...tr.children].indexOf(td) - 1;
      const v = r.rows[ri][ci];
      copyText(v === null ? 'NULL' : String(v));
      toast('Valor copiado', 'ok');
    });
    // replaceChildren(null) insertaría el texto "null": se filtra
    p.result.replaceChildren(...[
      r.truncated ? h('div.db-warn', `Resultado truncado a ${r.rowCount} filas: sube el límite o usa LIMIT / WHERE.`) : null,
      table,
    ].filter(Boolean));
    p.result.scrollTop = 0;
  }

  function exportDbCsv() {
    const dbLast = dbPane && dbPane.last;
    if (!dbLast || !dbLast.columns.length) { toast('No hay resultados para exportar', 'err'); return; }
    const q = (v) => (v === null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const text = [dbLast.columns.map(q).join(','), ...dbLast.rows.map((r) => r.map(q).join(','))].join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: `${state.db.connId || 'consulta'}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- música: lista con bucle / aleatorio / arrastrar; archivos (IndexedDB) y YouTube ----------
  const fmtDur = (s) => {
    if (!isFinite(s) || s <= 0) return '';
    s = Math.floor(s);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  };
  const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm|weba|mp4)$/i;
  const LOOP_NEXT = { off: 'all', all: 'one', one: 'off' };
  const LOOP_LABEL = { off: 'Sin repetir', all: 'Repetir lista', one: 'Repetir canción' };

  /** Archivos de audio en IndexedDB (sobreviven a recargas; funciona en file://). */
  const MusicStore = {
    db: null,
    mem: new Map(), // respaldo en memoria si IndexedDB no está disponible
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((resolve, reject) => {
        let req;
        try { req = indexedDB.open('frap-music', 1); } catch (e) { reject(e); return; }
        req.onupgradeneeded = () => req.result.createObjectStore('files');
        req.onsuccess = () => { this.db = req.result; resolve(this.db); };
        req.onerror = () => reject(req.error);
      });
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const t = db.transaction('files', mode);
        const r = fn(t.objectStore('files'));
        t.oncomplete = () => resolve(r && r.result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('IndexedDB abortado'));
      });
    },
    async put(id, blob) {
      try { await this.tx('readwrite', (st) => st.put(blob, id)); return true; } catch (_) { this.mem.set(id, blob); return false; }
    },
    async get(id) {
      if (this.mem.has(id)) return this.mem.get(id);
      try { return await this.tx('readonly', (st) => st.get(id)); } catch (_) { return null; }
    },
    async del(id) {
      this.mem.delete(id);
      try { await this.tx('readwrite', (st) => st.delete(id)); } catch (_) { /* nada */ }
    },
  };

  const Player = {
    audio: null, // <audio> para archivos
    yt: null, // iframe del relé /yt-player del bridge
    ytPort: null,
    ytReady: false,
    ytQueue: [],
    kind: null, // 'file' | 'youtube' según la pista actual
    playing: false,
    time: 0,
    duration: 0,
    objectUrl: null,
    played: new Set(), // para aleatorio sin repetir hasta completar la vuelta
    history: [], // para ⏮ en modo aleatorio
    errors: 0, // errores seguidos (evita saltar en bucle si todo falla)
  };
  const M = () => state.music;
  const trackById = (id) => M().tracks.find((t) => t.id === id) || null;
  const currentTrack = () => trackById(M().current);

  function parseYouTubeId(raw) {
    const s = String(raw || '').trim();
    if (/^[\w-]{11}$/.test(s)) return s;
    let u;
    try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch (_) { return null; }
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v');
      else {
        const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/);
        if (m) id = m[2];
      }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }

  // ----- motores -----
  function ensureAudio() {
    if (Player.audio) return Player.audio;
    const a = new Audio();
    a.preload = 'auto';
    a.addEventListener('timeupdate', () => { if (Player.kind === 'file') { Player.time = a.currentTime; updateProgress(); } });
    a.addEventListener('durationchange', () => {
      if (Player.kind !== 'file') return;
      Player.duration = a.duration;
      const t = currentTrack();
      if (t && isFinite(a.duration) && t.duration !== a.duration) { t.duration = a.duration; save(); refreshMusicList(); }
      updateProgress();
    });
    a.addEventListener('play', () => { if (Player.kind === 'file') { Player.playing = true; Player.errors = 0; updateDock(); } });
    a.addEventListener('pause', () => { if (Player.kind === 'file') { Player.playing = false; updateDock(); } });
    a.addEventListener('ended', () => { if (Player.kind === 'file') onTrackEnded(); });
    a.addEventListener('error', () => {
      if (Player.kind !== 'file' || !a.src) return;
      toast(`No se pudo reproducir "${(currentTrack() || {}).title || 'archivo'}"`, 'err');
      onTrackError();
    });
    a.volume = M().volume / 100;
    Player.audio = a;
    return a;
  }

  function ensureYt() {
    if (!Bridge.ready) throw new Error('YouTube necesita el bridge conectado (el navegador no permite incrustarlo desde file://)');
    if (Player.yt && Player.ytPort === conn.port) return Player.yt;
    if (Player.yt) Player.yt.remove();
    Player.ytReady = false;
    Player.ytQueue = [];
    Player.ytPort = conn.port;
    Player.yt = h('iframe.yt-frame', {
      src: `http://127.0.0.1:${conn.port}/yt-player`,
      title: 'YouTube',
      // el reproductor de YouTube pide estos permisos; sin delegarlos llena la consola de avisos
      allow: 'autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope; clipboard-write; web-share',
    });
    $('#music-yt').append(Player.yt);
    return Player.yt;
  }
  function ytSend(m) {
    if (!Player.yt) return;
    if (!Player.ytReady) { Player.ytQueue.push(m); return; }
    Player.yt.contentWindow.postMessage({ ...m, frap: 'yt' }, `http://127.0.0.1:${Player.ytPort}`);
  }
  window.addEventListener('message', (e) => {
    if (!Player.yt || e.source !== Player.yt.contentWindow || e.origin !== `http://127.0.0.1:${Player.ytPort}`) return;
    const m = e.data;
    if (!m || m.frap !== 'yt') return;
    if (m.type === 'ready') {
      Player.ytReady = true;
      Player.ytQueue.splice(0).forEach(ytSend);
      return;
    }
    if (Player.kind !== 'youtube') return;
    if (m.type === 'time') {
      Player.time = m.time;
      Player.duration = m.duration;
      const t = currentTrack();
      if (t && m.duration > 0 && !t.duration) { t.duration = m.duration; save(); refreshMusicList(); }
      updateProgress();
    } else if (m.type === 'state') {
      // -1 sin empezar · 0 terminó · 1 reproduciendo · 2 pausa · 3 cargando · 5 en cola
      const t = currentTrack();
      if (t && m.title && t.videoId === m.videoId && t.title !== m.title && /^YouTube · /.test(t.title)) { t.title = m.title; save(); refreshMusicList(); }
      if (m.state === 1) { Player.playing = true; Player.errors = 0; }
      if (m.state === 2 || m.state === 0 || m.state === -1) Player.playing = false;
      updateDock();
      if (m.state === 0) onTrackEnded();
    } else if (m.type === 'error') {
      const why = { 2: 'ID inválido', 5: 'error del reproductor', 100: 'video no encontrado o privado', 101: 'el autor no permite incrustarlo', 150: 'el autor no permite incrustarlo', 152: 'el autor no permite incrustarlo', 153: 'configuración del reproductor' }[m.code] || `código ${m.code}`;
      toast(`YouTube: ${why} — "${(currentTrack() || {}).title || ''}"`, 'err');
      onTrackError();
    }
  });

  // ----- control -----
  function stopEngines(except) {
    if (except !== 'file' && Player.audio) Player.audio.pause();
    if (except !== 'youtube' && Player.yt) ytSend({ cmd: 'pause' });
  }

  async function playTrack(id, { fromHistory = false } = {}) {
    const t = trackById(id);
    if (!t) return;
    if (!fromHistory && M().current && M().current !== id) Player.history.push(M().current);
    if (Player.history.length > 200) Player.history.shift();
    M().current = id;
    Player.played.add(id);
    Player.time = 0;
    Player.duration = t.duration || 0;
    save();
    if (t.type === 'youtube') {
      stopEngines('youtube');
      Player.kind = 'youtube';
      try { ensureYt(); } catch (e) { toast(e.message, 'err'); Player.playing = false; updateDock(); refreshMusicList(); return; }
      ytSend({ cmd: 'load', id: t.videoId, volume: M().volume });
    } else {
      stopEngines('file');
      Player.kind = 'file';
      const blob = await MusicStore.get(t.id);
      if (!blob) {
        toast(`"${t.title}" ya no está guardado en este navegador: vuelve a agregarlo`, 'err');
        Player.playing = false;
        updateDock();
        refreshMusicList();
        return;
      }
      const a = ensureAudio();
      if (Player.objectUrl) URL.revokeObjectURL(Player.objectUrl);
      Player.objectUrl = URL.createObjectURL(blob);
      a.src = Player.objectUrl;
      a.volume = M().volume / 100;
      try { await a.play(); } catch (e) { if (e.name !== 'AbortError') toast(`No se pudo reproducir: ${e.message}`, 'err'); }
    }
    updateMediaSession();
    updateDock();
    refreshMusicList();
  }

  function togglePlay() {
    const t = currentTrack();
    if (!t) {
      const list = M().tracks;
      if (!list.length) { toast('La lista de música está vacía'); return; }
      playTrack(M().shuffle ? list[Math.floor(Math.random() * list.length)].id : list[0].id);
      return;
    }
    if (Player.kind !== (t.type === 'youtube' ? 'youtube' : 'file')) { playTrack(t.id); return; }
    if (t.type === 'youtube') {
      if (!Player.yt) { playTrack(t.id); return; }
      ytSend({ cmd: Player.playing ? 'pause' : 'play' });
    } else {
      const a = ensureAudio();
      if (!a.src) { playTrack(t.id); return; }
      if (a.paused) a.play().catch(() => {}); else a.pause();
    }
  }

  function nextTrack(auto = false) {
    const list = M().tracks;
    if (!list.length) return;
    const cur = M().current;
    let next;
    if (M().shuffle) {
      let pool = list.filter((t) => !Player.played.has(t.id));
      if (!pool.length) {
        if (auto && M().loop === 'off') { stopPlayback(); return; }
        Player.played.clear();
        pool = list.length > 1 ? list.filter((t) => t.id !== cur) : list;
      }
      next = pool[Math.floor(Math.random() * pool.length)];
    } else {
      const i = list.findIndex((t) => t.id === cur);
      if (i === list.length - 1) {
        if (auto && M().loop === 'off') { stopPlayback(); return; }
        next = list[0];
      } else next = list[i + 1];
    }
    playTrack(next.id);
  }

  function prevTrack() {
    if (Player.time > 3) { seekTo(0); return; }
    const list = M().tracks;
    if (!list.length) return;
    if (M().shuffle && Player.history.length) {
      const id = Player.history.pop();
      if (trackById(id)) { playTrack(id, { fromHistory: true }); return; }
    }
    const i = list.findIndex((t) => t.id === M().current);
    playTrack(list[(i - 1 + list.length) % list.length].id, { fromHistory: true });
  }

  function onTrackEnded() {
    if (M().loop === 'one') {
      seekTo(0);
      if (Player.kind === 'file') Player.audio.play().catch(() => {});
      else ytSend({ cmd: 'play' });
      return;
    }
    nextTrack(true);
  }
  function onTrackError() {
    Player.playing = false;
    Player.errors++;
    updateDock();
    if (Player.errors < M().tracks.length) setTimeout(() => nextTrack(true), 600);
    else { Player.errors = 0; toast('Ninguna pista se pudo reproducir', 'err'); }
  }

  function stopPlayback() {
    stopEngines();
    Player.playing = false;
    Player.time = 0;
    Player.played.clear();
    updateDock();
    refreshMusicList();
  }

  function seekTo(sec) {
    Player.time = sec;
    if (Player.kind === 'file' && Player.audio) Player.audio.currentTime = sec;
    else if (Player.kind === 'youtube') ytSend({ cmd: 'seek', time: sec });
    updateProgress();
  }
  function setVolume(v) {
    M().volume = Math.max(0, Math.min(100, Math.round(v)));
    if (Player.audio) Player.audio.volume = M().volume / 100;
    ytSend({ cmd: 'volume', volume: M().volume });
    save();
  }
  function toggleShuffle() {
    M().shuffle = !M().shuffle;
    Player.played.clear();
    if (M().current) Player.played.add(M().current);
    save();
    updateDock();
    toast(M().shuffle ? 'Aleatorio activado' : 'Aleatorio desactivado');
  }
  function cycleLoop() {
    M().loop = LOOP_NEXT[M().loop] || 'all';
    save();
    updateDock();
    toast(LOOP_LABEL[M().loop]);
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = currentTrack();
    try {
      navigator.mediaSession.metadata = t ? new MediaMetadata({ title: t.title, artist: t.type === 'youtube' ? 'YouTube' : 'FRAP' }) : null;
      navigator.mediaSession.setActionHandler('play', togglePlay);
      navigator.mediaSession.setActionHandler('pause', togglePlay);
      navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack());
      navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
    } catch (_) { /* no soportado */ }
  }

  // ----- agregar / quitar / reordenar -----
  async function addMusicFiles(files) {
    const list = [...files].filter((f) => /^(audio|video)\//.test(f.type) || AUDIO_EXT.test(f.name));
    if (!list.length) { toast('Elige archivos de audio (mp3, m4a, ogg, wav, flac…)', 'err'); return; }
    let memOnly = 0;
    for (const f of list) {
      const id = uid();
      if (!(await MusicStore.put(id, f))) memOnly++;
      M().tracks.push({ id, type: 'file', title: f.name.replace(/\.[^.]+$/, ''), size: f.size });
    }
    save();
    renderRight();
    updateDock();
    toast(`${list.length} archivo${list.length > 1 ? 's' : ''} agregado${list.length > 1 ? 's' : ''}`, 'ok');
    if (memOnly) toast(`${memOnly} archivo(s) solo durarán esta sesión (IndexedDB no disponible)`, 'err');
  }
  function pickMusicFiles() {
    const input = h('input', { type: 'file', accept: 'audio/*,.mp3,.m4a,.ogg,.opus,.wav,.flac,.webm', multiple: true });
    input.onchange = () => addMusicFiles(input.files);
    input.click();
  }
  async function addYoutube(raw) {
    const videoId = parseYouTubeId(raw);
    if (!videoId) { toast('Link de YouTube no válido (youtube.com/watch?v=…, youtu.be/…, shorts…)', 'err'); return false; }
    if (M().tracks.some((t) => t.videoId === videoId)) { toast('Ese video ya está en la lista'); return false; }
    const t = { id: uid(), type: 'youtube', videoId, title: `YouTube · ${videoId}` };
    M().tracks.push(t);
    save();
    renderRight();
    updateDock();
    if (Bridge.ready) {
      Bridge.call('music.ytInfo', { id: videoId })
        .then((info) => { if (info.title) { t.title = info.title; t.author = info.author; save(); refreshMusicList(); updateDock(); } })
        .catch((e) => toast(`YouTube: ${e.message}`, 'err'));
    }
    return true;
  }
  async function removeTrack(id) {
    const t = trackById(id);
    if (!t) return;
    if (M().current === id) {
      stopEngines();
      Player.playing = false;
      M().current = null;
      Player.kind = null;
    }
    if (t.type === 'file') await MusicStore.del(id);
    M().tracks = M().tracks.filter((x) => x.id !== id);
    Player.played.delete(id);
    save();
    renderRight();
    updateDock();
  }
  function moveTrack(id, targetId, after) {
    const list = M().tracks;
    const from = list.findIndex((t) => t.id === id);
    if (from === -1 || id === targetId) return;
    const [t] = list.splice(from, 1);
    let to = list.findIndex((x) => x.id === targetId);
    if (to === -1) to = list.length; else if (after) to++;
    list.splice(to, 0, t);
    save();
    renderRight();
  }

  // ----- panel derecho: lista -----
  function refreshMusicList() { if (state.ui.rtab === 'music') renderRight(); }

  function renderMusic() {
    const yt = h('input.grow', { placeholder: 'Pega un link de YouTube y pulsa Enter', spellcheck: 'false' });
    const addYt = async () => { if (await addYoutube(yt.value)) yt.value = ''; };
    yt.addEventListener('keydown', (e) => { if (e.key === 'Enter') addYt(); });
    const head = section('Música',
      h('button.mini', { title: 'Agregar archivos de audio de tu equipo', onclick: pickMusicFiles }, '📁 Archivo'));
    const list = h('div.music-list');
    let dragId = null;
    const clearMarks = () => $$('.music-row', list).forEach((r) => r.classList.remove('drop-before', 'drop-after', 'dragging'));
    M().tracks.forEach((t, i) => {
      const cur = t.id === M().current;
      const row = h(`div.music-row${cur ? '.current' : ''}${cur && Player.playing ? '.playing' : ''}`, {
        draggable: 'true',
        dataset: { id: t.id },
        title: 'Clic: reproducir · arrastra para reordenar',
        onclick: () => (cur ? togglePlay() : playTrack(t.id)),
      },
      h('span.grip', '⋮⋮'),
      h('span.num', cur && Player.playing ? h('span.eq', h('i'), h('i'), h('i')) : String(i + 1)),
      h(`span.src.${t.type}`, { title: t.type === 'youtube' ? 'YouTube' : 'Archivo local' }, t.type === 'youtube' ? '▶' : '♫'),
      h('span.ttl', { title: t.author ? `${t.title} — ${t.author}` : t.title }, t.title),
      h('span.dur', fmtDur(t.duration)),
      h('button.icon.mini', { title: 'Quitar de la lista', onclick: (e) => { e.stopPropagation(); removeTrack(t.id); } }, '✕'));
      row.addEventListener('dragstart', (e) => {
        dragId = t.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
        requestAnimationFrame(() => row.classList.add('dragging'));
      });
      row.addEventListener('dragend', () => { dragId = null; clearMarks(); });
      row.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        const after = e.clientY > r.top + r.height / 2;
        $$('.music-row', list).forEach((x) => x !== row && x.classList.remove('drop-before', 'drop-after'));
        row.classList.toggle('drop-after', after);
        row.classList.toggle('drop-before', !after);
      });
      row.addEventListener('drop', (e) => {
        if (!dragId) return;
        e.preventDefault();
        e.stopPropagation();
        const after = row.classList.contains('drop-after');
        const id = dragId;
        dragId = null;
        clearMarks();
        moveTrack(id, t.id, after);
      });
      list.append(row);
    });
    // soltar archivos de audio desde el sistema
    list.addEventListener('dragover', (e) => { if (!dragId && e.dataTransfer.types.includes('Files')) { e.preventDefault(); list.classList.add('drop-files'); } });
    list.addEventListener('dragleave', () => list.classList.remove('drop-files'));
    list.addEventListener('drop', (e) => {
      list.classList.remove('drop-files');
      if (dragId || !e.dataTransfer.files.length) return;
      e.preventDefault();
      addMusicFiles(e.dataTransfer.files);
    });
    if (!M().tracks.length) list.append(h('p.muted', { style: 'padding:10px' }, 'Lista vacía. Agrega archivos (📁 o soltándolos aquí) o un link de YouTube.'));
    return [
      head,
      h('div.field-row', { style: 'margin-bottom:8px' }, yt, h('button.mini.primary', { onclick: addYt }, '+ YouTube')),
      h('p.muted', { style: 'margin:0 2px 8px;font-size:11px' },
        `${M().tracks.length} pista${M().tracks.length === 1 ? '' : 's'} · arrastra ⋮⋮ para reordenar · los archivos se guardan en este navegador · YouTube requiere el bridge`),
      list,
    ];
  }

  // ----- dock del reproductor (fijo al pie del panel derecho) -----
  let dock = null;
  function ensureDock() {
    if (dock) return dock;
    const root = $('#music-dock');
    const title = h('div.md-title');
    const seek = h('input.md-seek', { type: 'range', min: 0, max: 1000, value: 0, title: 'Posición' });
    let seeking = false;
    seek.addEventListener('input', () => { seeking = true; time.textContent = fmtDur((seek.value / 1000) * Player.duration) || '0:00'; });
    seek.addEventListener('change', () => { seeking = false; if (Player.duration) seekTo((seek.value / 1000) * Player.duration); });
    const time = h('span.md-time', '0:00');
    const total = h('span.md-time', '');
    const btn = (label, title, fn) => h('button.icon.md-btn', { title, onclick: fn }, label);
    const shuffle = btn('⇄', 'Aleatorio', toggleShuffle);
    const prev = btn('⏮', 'Anterior', prevTrack);
    const play = h('button.md-play', { title: 'Reproducir / pausa (Alt+Shift+M)', onclick: togglePlay }, '▶');
    const next = btn('⏭', 'Siguiente', () => nextTrack());
    const loop = btn('🔁', 'Repetir', cycleLoop);
    const vol = h('input.md-vol', { type: 'range', min: 0, max: 100, value: M().volume, title: 'Volumen' });
    vol.addEventListener('input', () => setVolume(Number(vol.value)));
    const ytBox = h('div#music-yt');
    root.append(
      ytBox,
      title,
      h('div.md-progress', time, seek, total),
      h('div.md-controls', shuffle, prev, play, next, loop, h('span.grow'), h('span.md-volicon', '🔊'), vol));
    dock = { root, title, seek, time, total, shuffle, play, loop, vol, ytBox, isSeeking: () => seeking };
    return dock;
  }

  function updateProgress() {
    if (!dock || dock.isSeeking()) return;
    const d = Player.duration || (currentTrack() || {}).duration || 0;
    dock.seek.value = d ? String(Math.round((Player.time / d) * 1000)) : '0';
    dock.time.textContent = fmtDur(Player.time) || '0:00';
    dock.total.textContent = fmtDur(d);
  }

  function updateDock() {
    const has = M().tracks.length > 0 && rtabOn('music');
    const root = $('#music-dock');
    root.classList.toggle('hidden', !has);
    renderStatusMusic();
    if (!has) return;
    const d = ensureDock();
    const t = currentTrack();
    d.title.textContent = t ? t.title : 'Nada sonando — elige una pista';
    d.title.title = t ? t.title : '';
    d.play.textContent = Player.playing ? '⏸' : '▶';
    d.shuffle.classList.toggle('on', !!M().shuffle);
    d.loop.classList.toggle('on', M().loop !== 'off');
    d.loop.textContent = M().loop === 'one' ? '🔂' : '🔁';
    d.loop.title = LOOP_LABEL[M().loop];
    d.vol.value = String(M().volume);
    // el video de YouTube se ve en la pestaña Música; en otras queda minimizado pero sigue sonando
    const showVideo = Player.kind === 'youtube' && t && t.type === 'youtube';
    d.ytBox.classList.toggle('hidden-video', !showVideo || state.ui.rtab !== 'music');
    d.ytBox.classList.toggle('gone', !showVideo);
    updateProgress();
  }

  function renderStatusMusic() {
    const el = $('#st-music');
    if (!el) return;
    const t = currentTrack();
    el.replaceChildren(...(t ? [h(`span.st-music${Player.playing ? '.on' : ''}`, {
      title: `${Player.playing ? 'Sonando' : 'En pausa'}: ${t.title} — clic para ver la lista`,
      onclick: () => { if (state.ui.hideRight) togglePanel('right'); setRtab('music'); },
    }, `${Player.playing ? '♪' : '⏸'} ${t.title.length > 32 ? t.title.slice(0, 31) + '…' : t.title}`)] : []));
  }

  // ---------- temporizador: recordatorios recurrentes o de una vez, con aviso simple o bloqueante ----------
  const TIMER_ICONS = ['⏰', '💧', '🧘', '👀', '🍅', '☕', '🚶', '🍎', '💊', '📞', '🧠', '🛌', '🏋️', '🌿', '📝', '🔔', '🎯', '🚀', '🧹', '🐶'];
  const TIMER_UNITS = { s: 1, min: 60, h: 3600 };
  const TIMER_PRESETS = [
    { icon: '💧', title: 'Toma agua', desc: 'Un vaso de agua. Tu cerebro te lo agradece.', kind: 'repeat', every: 3600, mode: 'toast' },
    { icon: '🧘', title: 'Estírate', desc: 'Levántate, estira espalda, cuello y muñecas.', kind: 'repeat', every: 50 * 60, mode: 'modal' },
    { icon: '👀', title: 'Descansa la vista', desc: 'Regla 20-20-20: mira algo a 6 metros durante 20 segundos.', kind: 'repeat', every: 20 * 60, mode: 'toast' },
    { icon: '🚶', title: 'Camina un poco', desc: 'Da una vuelta de 5 minutos.', kind: 'repeat', every: 2 * 3600, mode: 'modal' },
    { icon: '🍅', title: 'Pomodoro', desc: '25 minutos de foco terminados. Toma 5 de descanso.', kind: 'once', every: 25 * 60, mode: 'modal' },
    { icon: '☕', title: 'Pausa', desc: 'Fin del descanso: de vuelta al trabajo.', kind: 'once', every: 5 * 60, mode: 'toast' },
  ];
  const timerById = (id) => state.timers.find((t) => t.id === id) || null;

  function fmtCountdown(sec) {
    sec = Math.max(0, Math.ceil(sec));
    const hh = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const ss = String(sec % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
  }
  function fmtEvery(sec) {
    if (sec % 3600 === 0) return `${sec / 3600} h`;
    if (sec % 60 === 0) return `${sec / 60} min`;
    return `${sec} s`;
  }
  const timerLeft = (t) => (t.enabled && t.nextAt ? (t.nextAt - Date.now()) / 1000 : null);

  function startTimer(t) {
    t.enabled = true;
    t.startedAt = Date.now();
    t.nextAt = Date.now() + t.every * 1000;
    save();
  }
  function stopTimer(t) {
    t.enabled = false;
    t.nextAt = null;
    save();
  }

  // ----- disparo -----
  function fireTimer(t, late = false) {
    if (t.kind === 'repeat') {
      // se reprograma desde ahora (no se acumulan avisos atrasados)
      t.startedAt = Date.now();
      t.nextAt = Date.now() + t.every * 1000;
    } else {
      t.enabled = false;
      t.nextAt = null;
    }
    save();
    if (t.sound) chime(t.mode === 'modal');
    notifySystem(t);
    flashTitle(t);
    if (t.mode === 'modal') showAlarm(t, late);
    else timerToast(t, late);
    if (state.ui.rtab === 'timers') renderRight();
  }

  function timerToast(t, late) {
    const el = h('div.toast.timer-toast', { title: 'Clic para cerrar', onclick: () => el.remove() },
      h('span.tt-icon', t.icon || '⏰'),
      h('div', h('div.tt-title', t.title + (late ? ' (atrasado)' : '')), t.desc ? h('div.tt-desc', t.desc) : null));
    $('#toasts').append(el);
    setTimeout(() => el.remove(), 12000);
  }

  // Aviso bloqueante: overlay a pantalla completa por encima de todo; hay que atenderlo.
  const alarmQueue = [];
  function showAlarm(t, late) {
    alarmQueue.push({ t, late });
    if (alarmQueue.length === 1) renderAlarm();
  }
  function renderAlarm() {
    const root = $('#alarm');
    const item = alarmQueue[0];
    if (!item) { root.classList.add('hidden'); const at = activeTerm(); if (at) at.term.focus(); return; }
    const { t, late } = item;
    const done = (snoozeMin) => {
      if (snoozeMin) {
        const cur = timerById(t.id);
        if (cur) {
          cur.enabled = true;
          cur.startedAt = Date.now();
          cur.nextAt = Date.now() + snoozeMin * 60 * 1000;
          save();
          toast(`${t.icon || '⏰'} ${t.title}: pospuesto ${snoozeMin} min`);
        }
      }
      alarmQueue.shift();
      renderAlarm();
      if (state.ui.rtab === 'timers') renderRight();
    };
    const ok = h('button.primary.alarm-ok', { onclick: () => done(0) }, 'Listo');
    root.replaceChildren(h('div.alarm-card', { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'alarm-title' },
      h('div.alarm-icon', t.icon || '⏰'),
      h('h2#alarm-title', t.title),
      t.desc ? h('p.alarm-desc', t.desc) : null,
      h('p.muted.alarm-meta', `${t.kind === 'preview' ? 'Vista previa del aviso' : t.kind === 'repeat' ? `Se repite cada ${fmtEvery(t.every)}` : 'Temporizador terminado'}${late ? ' · llegó atrasado' : ''}${alarmQueue.length > 1 ? ` · ${alarmQueue.length - 1} más en cola` : ''}`),
      h('div.alarm-acts',
        t.kind === 'preview' ? null : h('button', { onclick: () => done(5) }, 'Posponer 5 min'),
        t.kind === 'preview' ? null : h('button', { onclick: () => done(15) }, '15 min'),
        ok)));
    root.classList.remove('hidden');
    // el foco sale de la terminal: las teclas no deben llegar a xterm mientras está el aviso
    if (document.activeElement) document.activeElement.blur();
    setTimeout(() => ok.focus(), 30);
  }
  // atrapa el foco dentro del aviso bloqueante
  document.addEventListener('keydown', (e) => {
    if ($('#alarm').classList.contains('hidden')) return;
    const btns = $$('#alarm button');
    if (e.key === 'Tab') {
      e.preventDefault();
      const i = btns.indexOf(document.activeElement);
      btns[(i + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
    } else if (!btns.includes(document.activeElement) || e.key !== 'Enter') {
      if (e.key !== 'Enter' && e.key !== ' ') { e.preventDefault(); e.stopPropagation(); }
    }
  }, true);

  // ----- sonido, notificación del sistema y título -----
  let audioCtx = null;
  function chime(strong) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = strong ? [880, 1175, 880, 1175] : [880, 1175];
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        const t0 = audioCtx.currentTime + i * 0.22;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0);
        o.stop(t0 + 0.21);
      });
    } catch (_) { /* sin audio */ }
  }
  const canNotify = () => typeof Notification !== 'undefined';
  function notifySystem(t) {
    if (!canNotify() || Notification.permission !== 'granted' || !document.hidden) return;
    try { new Notification(`${t.icon || '⏰'} ${t.title}`, { body: t.desc || '', tag: `frap-${t.id}`, requireInteraction: t.mode === 'modal' }); } catch (_) { /* nada */ }
  }
  let titleTimer = null;
  const baseTitle = document.title;
  function flashTitle(t) {
    if (!document.hidden) return;
    clearInterval(titleTimer);
    let on = false;
    titleTimer = setInterval(() => { on = !on; document.title = on ? `${t.icon || '⏰'} ${t.title}` : baseTitle; }, 1000);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { clearInterval(titleTimer); titleTimer = null; document.title = baseTitle; updateTitle(); }
  });

  // ----- reloj -----
  function tickTimers() {
    const now = Date.now();
    for (const t of state.timers) {
      if (t.enabled && t.nextAt && t.nextAt <= now && rtabOn('timers')) fireTimer(t, now - t.nextAt > 60 * 1000);
    }
    // actualiza contadores visibles sin re-renderizar
    for (const el of $$('[data-timer-left]')) {
      const t = timerById(el.dataset.timerLeft);
      if (!t) continue;
      const left = timerLeft(t);
      el.textContent = left == null ? (t.kind === 'once' && t.startedAt ? 'terminado' : 'apagado') : fmtCountdown(left);
    }
    for (const el of $$('[data-timer-bar]')) {
      const t = timerById(el.dataset.timerBar);
      const left = t && timerLeft(t);
      el.style.width = left == null ? '0%' : `${Math.min(100, Math.max(0, 100 - (left / t.every) * 100))}%`;
    }
    renderStatusTimer();
  }
  setInterval(tickTimers, 1000);

  function renderStatusTimer() {
    const el = $('#st-timer');
    if (!el) return;
    const next = state.timers.filter((t) => t.enabled && t.nextAt && rtabOn('timers')).sort((a, b) => a.nextAt - b.nextAt)[0];
    const label = next ? `${next.icon || '⏰'} ${fmtCountdown(timerLeft(next))} ${next.title.length > 18 ? next.title.slice(0, 17) + '…' : next.title}` : '';
    if (el.dataset.label === label) return;
    el.dataset.label = label;
    el.replaceChildren(...(next ? [h('span.st-timer', {
      title: `Próximo aviso: ${next.title} — clic para ver temporizadores`,
      onclick: () => { if (state.ui.hideRight) togglePanel('right'); setRtab('timers'); },
    }, label)] : []));
  }

  // ----- panel derecho -----
  function renderTimers() {
    const notifBtn = canNotify() && Notification.permission === 'default'
      ? h('button.mini', {
        title: 'Para recibir avisos aunque FRAP esté en segundo plano',
        onclick: async () => {
          try { await Notification.requestPermission(); } catch (_) { /* nada */ }
          toast(Notification.permission === 'granted' ? 'Notificaciones activadas' : 'El navegador no permitió notificaciones (en file:// suele bloquearlas)', Notification.permission === 'granted' ? 'ok' : 'err');
          renderRight();
        },
      }, '🔔')
      : null;
    const head = section('Temporizador',
      notifBtn,
      h('button.mini', { title: 'Agregar desde una plantilla', onclick: openTimerPresets }, '✨ Plantillas'),
      h('button.mini.primary', { onclick: () => editTimer() }, '+ Nuevo'));
    const hint = h('p.muted', { style: 'margin:0 2px 8px;font-size:11px' },
      '🔔 aviso simple: aparece en la esquina sin interrumpir · 🛑 bloquea la pantalla hasta que lo atiendas (puedes posponer).');
    if (!state.timers.length) {
      return [head, hint, h('p.muted', 'Aún no hay temporizadores. Crea uno o usa una plantilla como "💧 Toma agua cada 1 h".')];
    }
    return [head, hint, ...state.timers.map((t) => {
      const left = timerLeft(t);
      const finished = !t.enabled && t.kind === 'once' && t.startedAt;
      return h(`div.card.timer-card${t.enabled ? '.on' : ''}`,
        h('div.timer-top',
          h('span.timer-icon', t.icon || '⏰'),
          h('div.timer-main',
            h('div.title', h('span.name', { title: t.title }, t.title)),
            t.desc ? h('div.desc', t.desc) : null,
            h('div.timer-meta',
              h('span.badge', { title: t.mode === 'modal' ? 'Bloquea la pantalla' : 'Aviso simple' }, t.mode === 'modal' ? '🛑 bloquea' : '🔔 aviso'),
              h('span.badge', t.kind === 'repeat' ? `cada ${fmtEvery(t.every)}` : `una vez · ${fmtEvery(t.every)}`),
              t.sound ? h('span.badge', { title: 'Con sonido' }, '🔊') : null)),
          h('button.switch', {
            class: `switch ${t.enabled ? 'on' : 'off'}`,
            role: 'switch', 'aria-checked': String(!!t.enabled),
            title: t.enabled ? 'Apagar' : 'Encender (empieza a contar desde ahora)',
            onclick: () => { if (t.enabled) stopTimer(t); else startTimer(t); renderRight(); tickTimers(); },
          })),
        h('div.timer-bottom',
          h('span.timer-left', { dataset: { timerLeft: t.id } }, left == null ? (finished ? 'terminado' : 'apagado') : fmtCountdown(left)),
          h('div.timer-track', h('div.timer-bar', { dataset: { timerBar: t.id } })),
          h('button.icon.mini', { title: 'Reiniciar la cuenta', onclick: () => { startTimer(t); renderRight(); tickTimers(); } }, '↺'),
          h('button.icon.mini', { title: 'Probar el aviso ahora', onclick: () => previewTimer(t) }, '▶'),
          h('button.icon.mini', { title: 'Editar', onclick: () => editTimer(t) }, '✎'),
          h('button.icon.mini', { title: 'Eliminar', onclick: () => deleteTimer(t) }, '✕')));
    })];
  }

  function previewTimer(t) {
    if (t.sound) chime(t.mode === 'modal');
    if (t.mode === 'modal') showAlarm({ ...t, kind: 'preview' }, false);
    else timerToast(t, false);
  }

  function editTimer(t, preset) {
    const isNew = !t;
    const src = t || preset || {};
    let icon = src.icon || '⏰';
    const iconBtns = h('div.icon-grid', TIMER_ICONS.map((ic) => h('button.icon-pick', {
      class: `icon-pick${ic === icon ? ' sel' : ''}`,
      title: ic,
      onclick: (e) => {
        icon = ic;
        customIcon.value = '';
        $$('.icon-pick', iconBtns).forEach((b) => b.classList.toggle('sel', b === e.currentTarget));
      },
    }, ic)));
    const customIcon = h('input', { placeholder: 'u otro emoji', maxlength: '4', style: 'width:110px', value: TIMER_ICONS.includes(icon) ? '' : icon });
    customIcon.addEventListener('input', () => {
      if (customIcon.value.trim()) { icon = customIcon.value.trim(); $$('.icon-pick', iconBtns).forEach((b) => b.classList.remove('sel')); }
    });
    const title = h('input', { value: src.title || '', placeholder: 'Toma agua' });
    const desc = h('textarea.prompt-body', { placeholder: 'Descripción opcional que se muestra en el aviso', style: 'min-height:60px' });
    desc.value = src.desc || '';
    const every = src.every || 3600;
    const unit = every % 3600 === 0 ? 'h' : every % 60 === 0 ? 'min' : 's';
    const amount = h('input', { type: 'number', min: '1', value: String(every / TIMER_UNITS[unit]), style: 'width:90px' });
    const unitSel = h('select', h('option', { value: 's' }, 'segundos'), h('option', { value: 'min' }, 'minutos'), h('option', { value: 'h' }, 'horas'));
    unitSel.value = unit;
    const kind = h('select', h('option', { value: 'repeat' }, 'Repetir cada…'), h('option', { value: 'once' }, 'Una vez, dentro de…'));
    kind.value = src.kind || 'repeat';
    const mode = h('select', h('option', { value: 'toast' }, '🔔 Aviso simple (no bloquea)'), h('option', { value: 'modal' }, '🛑 Bloquear la pantalla con un aviso'));
    mode.value = src.mode || 'toast';
    const sound = h('input', { type: 'checkbox' });
    sound.checked = src.sound !== false;
    const doSave = () => {
      const secs = Math.round(Number(amount.value) * TIMER_UNITS[unitSel.value]);
      if (!title.value.trim()) { toast('El título es obligatorio', 'err'); return; }
      if (!(secs >= 1)) { toast('El intervalo debe ser mayor que 0', 'err'); return; }
      const changedTiming = !t || t.every !== secs || t.kind !== kind.value;
      if (isNew) { t = { id: uid() }; state.timers.push(t); }
      Object.assign(t, { icon, title: title.value.trim(), desc: desc.value.trim(), kind: kind.value, every: secs, mode: mode.value, sound: sound.checked });
      if (isNew || (changedTiming && t.enabled)) startTimer(t); else save();
      modalClose(true);
      if (state.ui.rtab !== 'timers') setRtab('timers'); else renderRight();
      tickTimers();
      if (isNew) toast(`${icon} ${t.title}: ${t.kind === 'repeat' ? `cada ${fmtEvery(secs)}` : `en ${fmtEvery(secs)}`}`, 'ok');
    };
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
    openModal({
      title: isNew ? 'Nuevo temporizador' : `Editar · ${t.title}`,
      body: [
        h('div.field', h('label', 'Ícono'), iconBtns, customIcon),
        h('div.field', h('label', 'Título'), title),
        h('div.field', h('label', 'Descripción'), desc),
        h('div.field', h('label', 'Cuándo'), h('div.field-row', kind, amount, unitSel)),
        h('div.field', h('label', 'Tipo de aviso'), mode),
        h('label.muted', sound, ' Sonar al avisar'),
      ],
      foot: [h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, isNew ? 'Crear y empezar' : 'Guardar')],
    });
  }

  function openTimerPresets() {
    openModal({
      title: 'Plantillas de temporizador',
      body: [
        h('p.muted', { style: 'margin:0' }, 'Elige una para crearla; puedes ajustarla antes de guardar.'),
        ...TIMER_PRESETS.map((p) => h('div.card.clickable', { onclick: () => { modalClose(true); editTimer(null, p); } },
          h('div.title', h('span', { style: 'font-size:18px' }, p.icon), h('span.name', p.title),
            h('span.badge', p.mode === 'modal' ? '🛑 bloquea' : '🔔 aviso'),
            h('span.badge', p.kind === 'repeat' ? `cada ${fmtEvery(p.every)}` : `una vez · ${fmtEvery(p.every)}`)),
          h('div.desc', p.desc))),
      ],
    });
  }

  async function deleteTimer(t) {
    if (!(await confirmBox(`¿Eliminar "${t.title}"?`))) return;
    state.timers = state.timers.filter((x) => x.id !== t.id);
    save();
    renderRight();
    tickTimers();
  }

  // ---------- configuración de agentes (agents/skills/commands/hooks/memory) ----------
  let config = null;
  let configKey = '';
  let configLoading = false;
  async function loadConfig(force = false) {
    if (!Bridge.ready) return;
    const p = project();
    const folders = p ? p.folders : [];
    const key = folders.join('|');
    if (!force && config && key === configKey) { renderRight(); return; }
    if (configLoading && !force) return;
    configLoading = true;
    try {
      config = await Bridge.call('config.scan', { folders });
      configKey = key;
    } catch (e) { toast(e.message, 'err'); }
    configLoading = false;
    if (state.ui.rtab !== 'procs') renderRight();
  }

  const KIND_LABEL = { agents: 'Agentes', skills: 'Skills', commands: 'Comandos (slash)' };
  const scopeBadge = (it) => it.scope === 'user' ? h('span.badge', 'usuario') : h('span.badge.project', basename(it.root));

  function renderConfigList(kind) {
    const head = section(KIND_LABEL[kind],
      h('button.mini', { title: 'Recargar', onclick: () => loadConfig(true) }, '↻'),
      h('button.mini.primary', { onclick: () => createConfigItem(kind) }, '+ Nuevo'));
    if (!Bridge.ready) return [head, h('p.muted', 'Bridge desconectado.')];
    if (!config) return [head, h('p.muted', 'Cargando…')];
    const items = config[kind];
    if (!items.length) return [head, h('p.muted', 'Nada encontrado en ~/.claude, ~/.codex, ~/.config/opencode ni en las carpetas del proyecto.')];
    return [head, ...items.map((it) => h('div.card.clickable', { onclick: () => openEditor(it.path, { title: `${it.tool} · ${it.name}` }) },
      h('div.title', h('span.name', it.name), scopeBadge(it), h(`span.badge.${it.tool}`, it.tool),
        (kind !== 'agents' && it.tool === 'claude') || it.tool === 'opencode' && kind === 'commands'
          ? h('button.icon.mini', { title: `Enviar /${it.name} a la terminal activa`, onclick: (e) => { e.stopPropagation(); sendToTerminal(`/${it.name} `, false); } }, '▶')
          : null),
      it.description ? h('div.desc', it.description) : null,
      h('div.path', tilde(it.path))))];
  }

  function configTargets() {
    const p = project();
    const home = Bridge.info.home;
    const t = [{ label: 'Usuario (~)', base: home, scope: 'user' }];
    if (p) for (const f of p.folders) t.push({ label: `Proyecto: ${basename(f)}`, base: f, scope: 'project' });
    return t;
  }

  function templateFor(kind, tool, name) {
    if (kind === 'agents' && tool === 'claude') return `---\nname: ${name}\ndescription: Describe cuándo debe usarse este agente.\ntools: Read, Grep, Glob, Bash\n---\n\nEres un agente especializado en …\n`;
    if (kind === 'agents') return `---\ndescription: Describe cuándo debe usarse este agente.\nmode: subagent\n---\n\nEres un agente especializado en …\n`;
    if (kind === 'skills') return `---\nname: ${name}\ndescription: Qué hace esta skill y cuándo usarla.\n---\n\n# ${name}\n\nInstrucciones paso a paso…\n`;
    return `---\ndescription: Qué hace este comando.\n---\n\nInstrucciones del comando. Usa $ARGUMENTS para los argumentos.\n`;
  }
  function pathFor(kind, tool, target, name) {
    const user = target.scope === 'user';
    const b = target.base;
    if (tool === 'claude') {
      if (kind === 'skills') return `${b}/.claude/skills/${name}/SKILL.md`;
      return `${b}/.claude/${kind}/${name}.md`;
    }
    if (tool === 'opencode') {
      const dir = user ? `${b}/.config/opencode` : `${b}/.opencode`;
      return `${dir}/${kind === 'agents' ? 'agent' : 'command'}/${name}.md`;
    }
    // codex
    if (kind === 'skills') return user ? `${b}/.codex/skills/${name}/SKILL.md` : `${b}/.agents/skills/${name}/SKILL.md`;
    return `${b}/.codex/prompts/${name}.md`;
  }
  function toolsFor(kind) {
    if (kind === 'agents') return ['claude', 'opencode'];
    if (kind === 'skills') return ['claude', 'codex'];
    return ['claude', 'opencode', 'codex'];
  }

  function createConfigItem(kind) {
    if (!Bridge.ready) { toast('Bridge desconectado', 'err'); return; }
    const targets = configTargets();
    const name = h('input', { placeholder: 'nombre-en-kebab-case' });
    const tool = h('select', toolsFor(kind).map((t) => h('option', { value: t }, t)));
    const target = h('select', targets.map((t, i) => h('option', { value: String(i) }, t.label)));
    const preview = h('div.muted.mono', { style: 'font-size:11px' });
    const upd = () => {
      const n = name.value.trim() || '<nombre>';
      preview.textContent = pathFor(kind, tool.value, targets[+target.value], n);
    };
    [name, tool, target].forEach((el) => el.addEventListener('input', upd));
    upd();
    const go = async () => {
      const n = name.value.trim();
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(n)) { toast('Nombre inválido (letras, números, . _ -)', 'err'); return; }
      const path = pathFor(kind, tool.value, targets[+target.value], n);
      if (await Bridge.call('fs.exists', { path })) { toast('Ya existe; se abre para editar', 'err'); modalClose(true); openEditor(path); return; }
      modalClose(true);
      openEditor(path, { create: true, template: templateFor(kind, tool.value, n), title: `Nuevo · ${n}` });
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    openModal({
      title: `Nuevo: ${KIND_LABEL[kind]}`,
      body: [
        h('div.field', h('label', 'Nombre'), name),
        h('div.field-row', h('div.field.grow', h('label', 'Herramienta'), tool), h('div.field.grow', h('label', 'Ámbito'), target)),
        preview,
      ],
      foot: [h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: go }, 'Crear')],
    });
  }

  // ---------- hooks ----------
  const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact'];
  function renderHooks() {
    const head = section('Hooks (Claude Code)',
      h('button.mini', { title: 'Recargar', onclick: () => loadConfig(true) }, '↻'),
      h('button.mini.primary', { onclick: createHook }, '+ Nuevo'));
    if (!Bridge.ready) return [head, h('p.muted', 'Bridge desconectado.')];
    if (!config) return [head, h('p.muted', 'Cargando…')];
    if (!config.hooks.length) return [head, h('p.muted', 'No hay hooks en ~/.claude/settings*.json ni en .claude/settings*.json del proyecto.')];
    return [head, ...config.hooks.map((it) => h('div.card.clickable', { title: 'Editar archivo de settings', onclick: () => openEditor(it.file) },
      h('div.title', h('span.name', it.event), h('span.badge', it.matcher), scopeBadge(it),
        h('button.icon.mini', { title: 'Eliminar hook', onclick: (e) => { e.stopPropagation(); deleteHook(it); } }, '✕')),
      h('div.desc.mono', it.command),
      h('div.path', tilde(it.file))))];
  }
  function createHook() {
    if (!Bridge.ready) return;
    const targets = configTargets();
    const event = h('select', HOOK_EVENTS.map((e) => h('option', { value: e }, e)));
    const matcher = h('input', { placeholder: 'Bash, Edit|Write, * … (solo eventos de herramientas)' });
    const command = h('textarea.prompt-body', { placeholder: 'comando a ejecutar, p. ej.: notify-send "Claude terminó"', spellcheck: 'false' });
    const target = h('select', targets.map((t, i) => h('option', { value: String(i) }, t.label)));
    const local = h('input', { type: 'checkbox' });
    const go = async () => {
      if (!command.value.trim()) { toast('El comando es obligatorio', 'err'); return; }
      const t = targets[+target.value];
      const file = `${t.base}/.claude/${local.checked ? 'settings.local.json' : 'settings.json'}`;
      try {
        let json = {};
        if (await Bridge.call('fs.exists', { path: file })) json = JSON.parse((await Bridge.call('fs.read', { path: file })).content || '{}');
        json.hooks = json.hooks || {};
        const groups = (json.hooks[event.value] = json.hooks[event.value] || []);
        const m = matcher.value.trim();
        let g = groups.find((x) => (x.matcher || '') === m);
        if (!g) { g = m ? { matcher: m, hooks: [] } : { hooks: [] }; groups.push(g); }
        g.hooks.push({ type: 'command', command: command.value.trim() });
        await Bridge.call('fs.write', { path: file, content: JSON.stringify(json, null, 2) + '\n' });
        modalClose(true);
        toast(`Hook agregado en ${file}`, 'ok');
        loadConfig(true);
      } catch (e) { toast(e.message, 'err'); }
    };
    openModal({
      title: 'Nuevo hook',
      body: [
        h('div.field-row', h('div.field.grow', h('label', 'Evento'), event), h('div.field.grow', h('label', 'Ámbito'), target)),
        h('div.field', h('label', 'Matcher'), matcher),
        h('div.field', h('label', 'Comando'), command),
        h('label.muted', local, ' guardar en settings.local.json (no se versiona)'),
      ],
      foot: [h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: go }, 'Agregar')],
    });
  }
  async function deleteHook(it) {
    if (!(await confirmBox(`¿Eliminar hook ${it.event}?`, it.command))) return;
    try {
      const json = JSON.parse((await Bridge.call('fs.read', { path: it.file })).content);
      const groups = (json.hooks || {})[it.event] || [];
      for (const g of groups) {
        if ((g.matcher || '*') !== it.matcher) continue;
        const i = (g.hooks || []).findIndex((x) => (x.command || x.type) === it.command);
        if (i !== -1) { g.hooks.splice(i, 1); break; }
      }
      json.hooks[it.event] = groups.filter((g) => (g.hooks || []).length);
      if (!json.hooks[it.event].length) delete json.hooks[it.event];
      await Bridge.call('fs.write', { path: it.file, content: JSON.stringify(json, null, 2) + '\n' });
      toast('Hook eliminado', 'ok');
      loadConfig(true);
    } catch (e) { toast(e.message, 'err'); }
  }

  // ---------- memoria / instrucciones ----------
  function renderMemory() {
    const head = section('Memoria e instrucciones', h('button.mini', { title: 'Recargar', onclick: () => loadConfig(true) }, '↻'));
    if (!Bridge.ready) return [head, h('p.muted', 'Bridge desconectado.')];
    if (!config) return [head, h('p.muted', 'Cargando…')];
    return [head, ...config.memory.map((it) => h(`div.card.clickable${it.exists ? '' : '.missing'}`, {
      onclick: () => openEditor(it.path, { create: !it.exists, title: `${it.tool} · ${it.name}`, template: it.path.endsWith('.json') ? '{\n}\n' : '' }),
    },
    h('div.title', h('span.name', it.name), scopeBadge(it), h(`span.badge.${it.tool}`, it.tool), it.exists ? null : h('span.badge', 'crear')),
    h('div.path', tilde(it.path))))];
  }

  // ======================================================================
  // Ajustes
  // ======================================================================
  function openSettings() {
    const s = state.settings;
    const font = h('input', { type: 'number', min: 9, max: 24, value: s.fontSize });
    const editor = h('input.mono', { value: s.editor || 'frap', placeholder: 'frap' });
    const extEditor = h('input.mono', { value: s.extEditor || 'code', placeholder: 'code' });
    const pmode = h('select', h('option', { value: 'tab' }, 'Pestaña del navegador'), h('option', { value: 'iframe' }, 'Pestaña interna (iframe)'));
    pmode.value = s.pageMode || 'tab';
    const port = h('input', { type: 'number', min: 1, max: 65535, value: conn.port });
    const token = h('input', { type: 'password', value: conn.token, autocomplete: 'off' });
    const launchers = AGENT_TOOLS.map((k) => {
      const l = s.launchers[k];
      return { k, cmd: h('input.mono', { value: l.cmd }), add: h('input.mono', { value: l.addDir, placeholder: '(sin soporte)' }) };
    });
    const doSave = () => {
      s.fontSize = Math.max(9, Math.min(24, Number(font.value) || 13));
      s.pageMode = pmode.value;
      s.editor = editor.value.trim() || 'frap';
      s.extEditor = extEditor.value.trim() || 'code';
      for (const l of launchers) s.launchers[l.k] = { cmd: l.cmd.value.trim() || l.k, addDir: l.add.value.trim() };
      for (const t of terms.values()) { t.term.options.fontSize = s.fontSize; fitTerm(t); }
      for (const p of viewPanes.values()) if (p && p.kind === 'code') for (const G of p.groups) if (G.cm) { G.cm.getWrapperElement().style.fontSize = `${s.fontSize}px`; G.cm.refresh(); }
      const reconnect = Number(port.value) !== conn.port || token.value !== conn.token;
      conn.port = Number(port.value) || 7681;
      conn.token = token.value.trim();
      storeSet('frap.conn', conn);
      save();
      modalClose(true);
      if (reconnect) Bridge.connect();
      toast('Ajustes guardados', 'ok');
    };
    openModal({
      title: 'Ajustes',
      body: [
        h('div.field-row', h('div.field.grow', h('label', 'Puerto del bridge'), port), h('div.field', h('label', 'Tamaño de fuente'), font)),
        h('div.field', h('label', 'Token del bridge'), token),
        h('div.field', h('label', 'Abrir páginas por defecto en'), pmode),
        h('div.field', h('label', 'Editor para rutas clicadas en la terminal'), editor,
          h('span.muted', { style: 'font-size:11px' }, 'frap = el editor de código de FRAP (pestaña "Código"). O un comando: code (VS Code), cursor, codium, windsurf…')),
        h('div.field', h('label', 'Editor externo ("Abrir en…" desde el editor de FRAP)'), extEditor),
        h('h4', { style: 'margin:8px 0 0' }, 'Módulos'),
        h('div.field-row', { style: 'align-items:center' },
          h('span.muted.grow', `Elige qué botones y pestañas se ven en cada panel: ${MODULE_LIST.filter((m) => modOn(m.key)).length} de ${MODULE_LIST.length} activados.`),
          h('button', { onclick: () => { modalClose(true); openModules(); } }, '🧩 Personalizar módulos…')),
        h('h4', { style: 'margin:8px 0 0' }, 'Lanzadores'),
        h('p.muted', { style: 'margin:0' }, 'Comando que se escribe en una shell nueva. La primera carpeta del proyecto es el cwd; las demás se pasan con el flag de "carpeta extra".'),
        ...launchers.map((l) => h('div.field-row',
          h('div.field', { style: 'width:90px' }, h('label', l.k)),
          h('div.field.grow', h('label', 'comando'), l.cmd),
          h('div.field', { style: 'width:150px' }, h('label', 'flag carpeta extra'), l.add))),
        h('h4', { style: 'margin:8px 0 0' }, 'Atajos'),
        h('p.muted.mono', { style: 'margin:0;font-size:11px;white-space:pre-line' },
          'Alt+1…9  ir a pestaña\nAlt+Shift+T  nueva shell   ·   Alt+Shift+C/X/O  claude/codex/opencode   ·   Alt+Shift+D  DB   ·   Alt+Shift+G  Git   ·   Alt+Shift+F  Archivos   ·   Alt+Shift+N  Notas   ·   Alt+Shift+V  hablar (voz)   ·   Alt+Shift+M  música ⏯\nAlt+Shift+W  cerrar pestaña   ·   Alt+Shift+B / P  ocultar paneles\nCtrl+Shift+C  copiar selección   ·   Ctrl+Shift+V  pegar'),
      ],
      foot: [h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
  }

  // ---------- módulo interno: gestión de issues (pestaña "Issues" del panel derecho) ----------
  // Las issues viven en local/issues/<ID>/ de FRAP (fuera de git). La skill frap-issues le explica a claude/codex
  // cómo bajarlas, llevar changelog/status y enviar al tracker solo al cerrar o al final de la jornada.
  let issuesInfo = null; // respuesta de issues.list
  let issuesError = null;
  let issuesOpen = null; // id de la issue desplegada
  let issuesSkillSynced = null; // último estado aplicado de la skill (true/false)
  async function loadIssues() {
    if (!Bridge.ready || !modOn('internal.issues')) return;
    try { issuesInfo = await Bridge.call('issues.list'); issuesError = null; } catch (e) { issuesError = e.message; }
    if (state.ui.rtab === 'issues') renderRight();
  }
  /** Instala/actualiza la skill frap-issues si el módulo está activo, o la quita si está apagado. */
  async function syncIssuesSkill(force) {
    if (!Bridge.ready) return;
    const on = modOn('internal.issues');
    if (!force && issuesSkillSynced === on) return;
    try {
      const r = await Bridge.call('issues.setSkill', { on });
      issuesSkillSynced = on;
      if (r.changed.length) toast(on ? 'Skill frap-issues lista en claude y codex: dile a la IA "toma la issue AVE-…"' : 'Skill frap-issues quitada de claude y codex', 'ok');
    } catch (e) { toast(`Skill frap-issues: ${e.message}`, 'err'); }
  }
  /** Servicio de origen de la issue según su URL (Linear por defecto si no hay URL pero no es local). */
  function issueTracker(i) {
    const u = (i && i.url) || '';
    if (/linear\.app/i.test(u)) return 'Linear';
    if (/atlassian\.net|jira/i.test(u)) return 'Jira';
    if (/github\.com/i.test(u)) return 'GitHub';
    if (/gitlab/i.test(u)) return 'GitLab';
    if (/dev\.azure\.com|visualstudio\.com/i.test(u)) return 'Azure DevOps';
    if (u) return 'el tracker de origen';
    return i && /^LOCAL-/i.test(i.id || '') ? null : 'Linear';
  }
  const ISSUE_PROMPTS = {
    take: (id) => `Toma la issue ${id} (skill frap-issues): tráela de Linear a local (con su prioridad tal cual) y arma el plan en su status.md.`,
    local: (id) => `Toma la issue local ${id} (skill frap-issues, sin tracker): ayúdame a redactar issue.md (qué, por qué, cuándo está lista), revisa que la prioridad sea la adecuada y arma el plan en su status.md.`,
    resume: (id, i) => {
      const t = issueTracker(i || { id });
      return t
        ? `Retoma la issue ${id} (skill frap-issues): lee su status.md y changelog.md, mira su estado en ${t} (comentarios, estado y cambios desde la última vez), actualiza local si es necesario y sigue con lo pendiente.`
        : `Retoma la issue ${id} (skill frap-issues): lee su status.md y changelog.md y sigue con lo pendiente.`;
    },
    close: (id) => `Cierra la issue ${id} (skill frap-issues): redacta el comentario final para Linear con lo pendiente de enviar y muéstramelo antes de enviarlo.`,
    day: () => 'Fin de jornada (skill frap-issues): revisa las issues activas en local, arma los comentarios y cambios de estado pendientes para Linear y muéstramelos antes de enviar nada.',
  };
  // Prioridad: misma escala y formato que Linear (la línea «- **Prioridad:** High» de issue.md), venga o no de Linear.
  const ISSUE_PRIORITIES = [
    { key: 'urgent', label: 'Urgente', en: 'Urgent', icon: '🔴' },
    { key: 'high', label: 'Alta', en: 'High', icon: '🟠' },
    { key: 'medium', label: 'Media', en: 'Medium', icon: '🟡' },
    { key: 'low', label: 'Baja', en: 'Low', icon: '🔵' },
    { key: 'none', label: 'Sin prioridad', en: 'No priority', icon: '⚪' },
  ];
  const issuePrio = (k) => ISSUE_PRIORITIES.find((p) => p.key === k) || ISSUE_PRIORITIES[4];
  async function setIssuePriority(i, key) {
    if (i.priority === key) return;
    try {
      await Bridge.call('issues.setPriority', { id: i.id, priority: key });
      toast(`${i.id}: prioridad ${issuePrio(key).label}`, 'ok');
      await loadIssues();
    } catch (e) { toast(e.message, 'err'); }
  }
  function issuePrioMenu(ev, i) {
    popMenu(ev, ISSUE_PRIORITIES.map((p) => ({ label: `${p.icon} ${p.label}`, hint: p.key === i.priority ? '✓' : p.en, action: () => setIssuePriority(i, p.key) })));
  }
  /** Escribe el pedido en la terminal de IA del proyecto (sin Enter, para revisarlo). Sin IA abierta: lo copia. */
  function issueAsk(text) {
    const t = codeAiTarget();
    if (!t) { copyText(text); toast('No hay claude/codex/opencode abierto en este proyecto: copié el pedido para que lo pegues', 'ok'); return; }
    activate(t.sid);
    Bridge.send('session.input', { sid: t.sid, data: text });
    toast(`Escrito en ${termTitle(t)} (revisa y pulsa Enter)`, 'ok');
  }
  function newIssue() {
    const id = h('input.mono', { placeholder: 'AVE-303', style: 'text-transform:uppercase' });
    const title = h('input', { placeholder: 'Título (opcional: la IA lo completa desde Linear)' });
    const prio = h('select', h('option', { value: '' }, 'La de Linear (la copia la IA)'), ISSUE_PRIORITIES.map((p) => h('option', { value: p.key }, `${p.icon} ${p.label} (${p.en})`)));
    const local = h('input', { type: 'checkbox' });
    const ask = h('input', { type: 'checkbox' });
    ask.checked = true;
    const askLabel = h('span', ' Pedirle a la IA del proyecto que la traiga de Linear y arme el plan');
    const idLabel = h('label', 'Identificador');
    const sync = () => {
      const l = local.checked;
      id.placeholder = l ? 'LOCAL (se numera solo: LOCAL-1, LOCAL-2…)' : 'AVE-303';
      title.placeholder = l ? 'Título' : 'Título (opcional: la IA lo completa desde Linear)';
      idLabel.textContent = l ? 'Prefijo o identificador (opcional)' : 'Identificador';
      prio.options[0].textContent = l ? '⚪ Sin prioridad' : 'La de Linear (la copia la IA)';
      askLabel.textContent = l ? ' Pedirle a la IA del proyecto que ayude a redactarla y arme el plan' : ' Pedirle a la IA del proyecto que la traiga de Linear y arme el plan';
    };
    local.addEventListener('change', sync);
    const doCreate = async () => {
      let v = id.value.trim().toUpperCase();
      if (local.checked && !v) v = 'LOCAL';
      const ok = /^[A-Z][A-Z0-9]*-\d+$/.test(v) || (local.checked && /^[A-Z][A-Z0-9]*$/.test(v));
      if (!ok) { toast(local.checked ? 'Identificador inválido (un prefijo como LOCAL o algo como LOCAL-7)' : 'Identificador inválido (algo como AVE-303)', 'err'); id.focus(); return; }
      if (local.checked && !title.value.trim()) { toast('Una issue local necesita título', 'err'); title.focus(); return; }
      try {
        const r = await Bridge.call('issues.create', { id: v, title: title.value.trim(), priority: prio.value || (local.checked ? 'none' : undefined), local: local.checked });
        modalClose(true);
        issuesOpen = r.id;
        toast(r.created ? `Issue ${r.id} creada en ${tilde(r.dir)}` : `${r.id} ya existía: se retoma`, 'ok');
        await loadIssues();
        if (ask.checked) issueAsk(!r.created ? ISSUE_PROMPTS.resume(r.id, (issuesInfo && issuesInfo.issues.find((x) => x.id === r.id)) || r) : local.checked ? ISSUE_PROMPTS.local(r.id) : ISSUE_PROMPTS.take(r.id));
      } catch (e) { toast(e.message, 'err'); }
    };
    [id, title].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); }));
    openModal({
      title: 'Nueva issue',
      body: [
        h('label.muted', local, ' Issue local (no viene de Linear ni de otro tracker)'),
        h('div.field', idLabel, id),
        h('div.field', h('label', 'Título'), title),
        h('div.field', h('label', 'Prioridad'), prio),
        h('label.muted', ask, askLabel),
        h('p.muted', { style: 'margin:4px 0 0;font-size:11px' }, `Se crea en ${issuesInfo ? tilde(issuesInfo.dir) : 'local/issues'}/<ID> con issue.md, changelog.md y status.md.`),
      ],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doCreate }, 'Crear')],
    });
    requestAnimationFrame(() => id.focus());
  }
  async function importIssuesFolder() {
    const dir = await pickFolder();
    if (!dir) return;
    try {
      const r = await Bridge.call('issues.importDir', { path: dir });
      toast(`Importadas ${r.copied.length} issue(s) de ${tilde(r.from)}${r.skipped.length ? ` · ${r.skipped.length} ya existían (no se tocaron)` : ''}`, 'ok');
      loadIssues();
    } catch (e) { toast(e.message, 'err'); }
  }
  function issueFile(i, f) { return `${i.dir}/${f}`; }
  function renderIssues() {
    if (!Bridge.ready) return [section('Issues'), h('div.empty-list', 'Bridge desconectado.')];
    if (issuesError) return [section('Issues'), h('div.empty-list', issuesError)];
    if (!issuesInfo) { loadIssues(); return [section('Issues'), h('div.empty-list', 'Cargando…')]; }
    const f = state.ui.issuesFilter || 'open';
    const q = (state.ui.issuesQuery || '').toLowerCase();
    const all = issuesInfo.issues;
    const counts = { open: all.filter((i) => !i.closed).length, closed: all.filter((i) => i.closed).length, all: all.length };
    const list = all.filter((i) => (f === 'all' || (f === 'open' ? !i.closed : i.closed)) && (!q || `${i.id} ${i.title} ${i.estado} ${issuePrio(i.priority).label} ${issuePrio(i.priority).en}`.toLowerCase().includes(q)));
    const pending = all.filter((i) => !i.closed && i.pending).reduce((n, i) => n + i.pending, 0);
    const search = h('input.filter', { placeholder: 'Buscar por ID, título, estado o prioridad…', value: state.ui.issuesQuery || '' });
    search.addEventListener('input', debounce(() => { state.ui.issuesQuery = search.value; save(); renderRight(); requestAnimationFrame(() => { const s = $('#rbody .filter'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 200));
    const seg = (k, label) => h(`button.mini${f === k ? '.primary' : ''}`, { onclick: () => { state.ui.issuesFilter = k; save(); renderRight(); } }, `${label} ${counts[k]}`);
    return [
      section('Issues locales',
        h('button.icon', { title: 'Recargar', onclick: () => loadIssues() }, '⟳'),
        h('button.icon', { title: 'Importar issues de otra carpeta (p. ej. un harness viejo con carpetas AVE-123/)', onclick: importIssuesFolder }, '⇩'),
        h('button.primary.mini', { onclick: newIssue }, '+ Nueva')),
      h('div.iss-bar', seg('open', 'Activas'), seg('closed', 'Cerradas'), seg('all', 'Todas'), h('span.grow'),
        h('button.mini', { title: ISSUE_PROMPTS.day(), onclick: () => issueAsk(ISSUE_PROMPTS.day()) }, `📤 Fin de jornada${pending ? ` (${pending})` : ''}`)),
      search,
      h('p.muted.iss-hint', `En ${tilde(issuesInfo.dir)} (fuera de git). La IA las gestiona con la skill frap-issues: dile "toma la issue AVE-…".`),
      list.length ? h('div.iss-list', ISSUE_PRIORITIES.map((p) => {
        const items = list.filter((i) => (i.priority || 'none') === p.key);
        if (!items.length) return null;
        const collapsed = (state.ui.issuesCollapsed || []).includes(p.key);
        const toggle = () => {
          const set = new Set(state.ui.issuesCollapsed || []);
          if (set.has(p.key)) set.delete(p.key); else set.add(p.key);
          state.ui.issuesCollapsed = [...set];
          save();
          renderRight();
        };
        return h(`div.iss-group.prio-${p.key}${collapsed ? '.collapsed' : ''}`,
          h('div.iss-ghead', { onclick: toggle, title: collapsed ? 'Desplegar' : 'Plegar' },
            h('span.iss-caret', collapsed ? '▸' : '▾'), h('span', p.icon), h('span.iss-gname', p.label), h('span.iss-count', String(items.length)),
            h('span.grow'), h('span.muted.iss-gen', p.en)),
          collapsed ? null : h('div.iss-gitems', items.map((i) => issueCard(i))));
      })) : h('div.empty-list', all.length ? 'Nada con ese filtro.' : 'Sin issues todavía. Crea una con "+ Nueva" o dile a la IA "toma la issue AVE-…".'),
    ];
  }
  function issueCard(i) {
    const open = issuesOpen === i.id;
    const pr = issuePrio(i.priority);
    const toggle = () => { issuesOpen = open ? null : i.id; renderRight(); }; // cabecera, título y estado abren/cierran las opciones
    return h(`div.iss-card${open ? '.open' : ''}${i.closed ? '.closed' : ''}`,
      h('div.iss-head', { onclick: toggle },
        h('button.iss-prio', { title: `Prioridad: ${pr.label} (${pr.en}) · clic para cambiarla`, onclick: (e) => issuePrioMenu(e, i) }, pr.icon),
        h('span.iss-id', i.id),
        i.pending && !i.closed ? h('span.iss-pend', { title: `${i.pending} comentario(s)/cambio(s) por enviar a Linear` }, `📤 ${i.pending}`) : null,
        i.review ? h('span.iss-review', { title: 'In Review en Linear: entregada, falta la aprobación. En local cuenta como cerrada.' }, '👀 In Review') : null,
        h('span.grow'),
        h('span.muted.iss-date', i.updated ? new Date(i.updated).toLocaleDateString([], { day: '2-digit', month: 'short' }) : '')),
      h('div.iss-title', { onclick: toggle, title: open ? 'Clic: ocultar opciones' : 'Clic: ver opciones' }, i.title || h('span.muted', '(sin título)')),
      i.estado ? h('div.iss-estado.muted', { onclick: toggle }, i.estado) : null,
      open ? h('div.iss-acts',
        h('div.iss-files', ['status.md', 'issue.md', 'changelog.md', 'final.md'].filter((x) => i.files.includes(x)).map((x) => h('button.mini', { title: tilde(issueFile(i, x)), onclick: () => openInFrap(issueFile(i, x)) }, x))),
        h('div.iss-files',
          i.closed ? null : h('button.mini', { title: ISSUE_PROMPTS.resume(i.id, i), onclick: () => issueAsk(ISSUE_PROMPTS.resume(i.id, i)) }, '🤖 Retomar con la IA'),
          i.closed ? null : h('button.mini', { onclick: () => issueAsk(ISSUE_PROMPTS.close(i.id)) }, '✅ Cerrar'),
          i.url ? h('button.mini', { title: i.url, onclick: () => openPageTab({ url: i.url }) }, '↗ Linear') : null,
          h('button.mini', { title: 'Copiar la carpeta de la issue', onclick: () => { copyText(i.dir); toast(`Copiado: ${tilde(i.dir)}`, 'ok'); } }, '⧉ Ruta'))) : null);
  }

  // ---------- integraciones (panel izquierdo): WordPress con el plugin frap-wordpress ----------
  // Cada sitio es URL + token (temporal; sus permisos se configuran en el WordPress). Los tokens viven en
  // FRAP_HOME/wordpress.env y nunca llegan a la UI. Las IA los usan con la skill frap-wordpress (frap-wp.js),
  // solo si la conexión está Activa y con IA, como las bases de datos.
  let wpInfo = null; // respuesta de wp.list
  let wpError = null;
  const wpChecks = new Map(); // id → {ok, info?, error?, at}
  let wpSkillSynced = null;
  async function loadWp(checkAll) {
    if (!Bridge.ready || !modOn('left.integrations')) { renderIntegrations(); return; }
    try { wpInfo = await Bridge.call('wp.list'); wpError = null; } catch (e) { wpError = e.message; }
    renderIntegrations();
    if (checkAll && wpInfo) for (const s of wpInfo.sites) if (s.enabled && !wpChecks.has(s.id)) checkWp(s, true);
  }
  async function syncWpSkill(force) {
    if (!Bridge.ready) return;
    const on = modOn('left.integrations');
    if (!force && wpSkillSynced === on) return;
    try {
      const r = await Bridge.call('wp.setSkill', { on });
      wpSkillSynced = on;
      if (r.changed.length) toast(on ? 'Skill frap-wordpress lista en claude y codex' : 'Skill frap-wordpress quitada de claude y codex', 'ok');
    } catch (e) { toast(`Skill frap-wordpress: ${e.message}`, 'err'); }
  }
  async function checkWp(s, quiet) {
    wpChecks.set(s.id, { ...(wpChecks.get(s.id) || {}), loading: true });
    renderIntegrations();
    try {
      const info = await Bridge.call('wp.check', { id: s.id });
      wpChecks.set(s.id, { ok: true, info, at: Date.now() });
      if (!quiet) toast(`${s.name}: conectado (${info.ms} ms) · token vence ${wpLeft(info)}`, 'ok');
    } catch (e) {
      wpChecks.set(s.id, { ok: false, error: e.message, at: Date.now() });
      if (!quiet) toast(`${s.name}: ${e.message}`, 'err');
    }
    renderIntegrations();
  }
  /** "en 23 h 5 min" según el reloj del sitio cuando se probó. */
  function wpLeft(info, at = Date.now()) {
    const s = Math.max(0, info.token.expires - info.now - Math.round((Date.now() - at) / 1000));
    if (!s) return 'vencido';
    const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
    return `en ${d ? `${d} d ` : ''}${d || hh ? `${hh} h ` : ''}${mm} min`;
  }
  const WP_PLUGIN_ZIP = 'https://github.com/franciscoblancojn/frap-wordpress/archive/refs/heads/master.zip';
  const WP_ACT = { read: 'ver', create: 'crear', update: 'editar', delete: 'eliminar' };
  /** Resumen de permisos: "Entradas: ver, editar · Páginas: ver…". */
  function wpPermSummary(info) {
    const rows = Object.values(info.resources || {}).filter((r) => r.allowed.length);
    return rows.length ? rows.map((r) => `${r.label}: ${r.allowed.map((a) => WP_ACT[a] || a).join(', ')}`).join(' · ') : 'sin permisos';
  }
  async function toggleWp(s, key) {
    try {
      await Bridge.call('wp.toggle', { id: s.id, [key]: !s[key] });
      await loadWp();
      if (key === 'enabled' && !s.enabled) checkWp(s, true);
    } catch (e) { toast(e.message, 'err'); }
  }
  function editWpSite(s) {
    const name = h('input', { placeholder: 'Mi tienda', value: s ? s.name : '' });
    const url = h('input.mono', { placeholder: 'https://misitio.com', value: s ? s.url : '' });
    const token = h('input.mono', { type: 'password', autocomplete: 'off', placeholder: s && s.hasToken ? `•••• ${s.tokenHint} (vacío = conservar el actual)` : 'frapwp_…' });
    const result = h('div.wp-test.muted');
    const read = () => ({ id: s ? s.id : undefined, name: name.value.trim() || (url.value.trim() ? url.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : ''), url: url.value.trim(), token: token.value.trim() || null });
    const test = async () => {
      result.className = 'wp-test muted';
      result.textContent = 'Probando…';
      try {
        const i = await Bridge.call('wp.check', { site: read() });
        result.className = 'wp-test ok';
        result.replaceChildren(h('div', `✓ ${i.name} · WordPress ${i.wordpress}${i.woocommerce ? ` · WooCommerce ${i.woocommerce}` : ''} · plugin ${i.plugin}`),
          h('div', `Token «${i.token.name}», vence ${wpLeft(i)}`), h('div.muted', wpPermSummary(i)));
      } catch (e) { result.className = 'wp-test err'; result.textContent = `✗ ${e.message}`; }
    };
    const doSave = async () => {
      try {
        const r = await Bridge.call('wp.save', { site: read() });
        modalClose(true);
        toast(`Conexión ${r.name} guardada`, 'ok');
        await loadWp();
        checkWp(r, true);
      } catch (e) { toast(e.message, 'err'); }
    };
    openModal({
      title: s ? `WordPress · ${s.name}` : 'Nueva conexión WordPress',
      body: [
        h('p.muted', { style: 'margin:0 0 8px' }, h('a', { href: WP_PLUGIN_ZIP, target: '_blank' }, '⬇ Descargar el plugin frap-wordpress'), ' · Instálalo en el sitio y crea un token en WordPress → FRAP → Tokens (24 h por defecto, solo lectura salvo que le des más permisos).'),
        h('div.field', h('label', 'Nombre'), name),
        h('div.field', h('label', 'URL del sitio'), url),
        h('div.field', h('label', 'Token'), token),
        result,
      ],
      foot: [h('button', { onclick: test }, 'Probar'), h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
    requestAnimationFrame(() => (s ? token : url).focus());
  }
  async function deleteWp(s) {
    if (!window.confirm(`¿Eliminar la conexión «${s.name}»? El token se borra de FRAP (en el sitio sigue existiendo hasta que venza o lo revoques).`)) return;
    try { await Bridge.call('wp.delete', { id: s.id }); wpChecks.delete(s.id); toast('Conexión eliminada', 'ok'); loadWp(); } catch (e) { toast(e.message, 'err'); }
  }
  function wpMenu(ev, s) {
    popMenu(ev, [
      { label: '⟳ Probar conexión', action: () => checkWp(s) },
      { label: '✎ Editar / cambiar token', action: () => editWpSite(s) },
      { label: '↗ Tokens en WordPress', hint: 'renovar, permisos', action: () => openPageTab({ url: `${s.url}/wp-admin/admin.php?page=FRAPWP` }) },
      { label: '↗ Abrir el sitio', action: () => openPageTab({ url: s.url }) },
      { label: '⧉ Copiar comando para la IA', hint: 'frap-wp', action: () => { const c = `node ${wpInfo.cli} ${s.id} info`; copyText(c); toast(`Copiado: ${c}`, 'ok'); } },
      '-',
      { label: '🗑 Eliminar conexión', danger: true, action: () => deleteWp(s) },
    ]);
  }
  function wpSwitch(s, key) {
    const on = !!s[key];
    return h('label.wp-sw', { title: key === 'ai' ? 'Las IA la pueden usar (skill frap-wordpress), con los permisos del token' : 'Conexión activa' },
      h('button', { class: `switch ${on ? 'on' : 'off'}`, role: 'switch', 'aria-checked': String(on), onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleWp(s, key); } }),
      key === 'ai' ? 'IA' : 'Activa');
  }
  // ----- Aveonline: tiendas con el plugin de envíos Aveonline y su «Revisión por token» (solo lectura) -----
  // Un token por tienda, de corta vida (10 min por defecto): «Pegar token» acepta el texto tal como se comparte
  // ("pedido 16322 token … tienda http://…") y lo procesa el bridge. Los tokens viven en FRAP_HOME/aveonline.env.
  let aveInfo = null; // respuesta de ave.list
  let aveError = null;
  const aveChecks = new Map(); // id → {ok, info?, error?, at, loading?}
  let aveSkillSynced = null;
  async function loadAve(checkAll) {
    if (!Bridge.ready || !modOn('left.integrations')) { renderIntegrations(); return; }
    try { aveInfo = await Bridge.call('ave.list'); aveError = null; } catch (e) { aveError = e.message; }
    renderIntegrations();
    if (checkAll && aveInfo) for (const s of aveInfo.sites) if (s.enabled && s.hasToken && !aveChecks.has(s.id)) checkAve(s, true);
  }
  async function syncAveSkill(force) {
    if (!Bridge.ready) return;
    const on = modOn('left.integrations');
    if (!force && aveSkillSynced === on) return;
    try {
      const r = await Bridge.call('ave.setSkill', { on });
      aveSkillSynced = on;
      if (r.changed.length) toast(on ? 'Skill frap-aveonline lista en claude y codex' : 'Skill frap-aveonline quitada de claude y codex', 'ok');
    } catch (e) { toast(`Skill frap-aveonline: ${e.message}`, 'err'); }
  }
  /** Segundos que le quedan al token según el reloj de la tienda cuando se probó. */
  const aveSecs = (info, at) => Math.max(0, (info.expires || 0) - (info.now || 0) - Math.round((Date.now() - at) / 1000));
  function aveLeft(info, at = Date.now()) {
    const s = aveSecs(info, at);
    if (!s) return 'vencido';
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60);
    return hh ? `en ${hh} h ${mm} min` : mm ? `en ${mm} min` : `en ${s} s`;
  }
  async function checkAve(s, quiet) {
    aveChecks.set(s.id, { ...(aveChecks.get(s.id) || {}), loading: true });
    renderIntegrations();
    try {
      const info = await Bridge.call('ave.check', { id: s.id });
      aveChecks.set(s.id, { ok: true, info, at: Date.now() });
      if (!quiet) toast(`${s.name}: conectado (${info.ms} ms) · plugin ${info.version} · token vence ${aveLeft(info)}`, 'ok');
    } catch (e) {
      aveChecks.set(s.id, { ok: false, error: e.message, at: Date.now() });
      if (!quiet) toast(`${s.name}: ${e.message}`, 'err');
    }
    renderIntegrations();
  }
  async function toggleAve(s, key) {
    try {
      await Bridge.call('ave.toggle', { id: s.id, [key]: !s[key] });
      await loadAve();
      if (key === 'enabled' && !s.enabled && s.hasToken) checkAve(s, true);
    } catch (e) { toast(e.message, 'err'); }
  }
  /** «Pegar token»: el texto que comparte la tienda o soporte. Con `s`, el token va a esa tienda. */
  function pasteAveToken(s) {
    const text = h('textarea.mono', { rows: '4', spellcheck: 'false', autocomplete: 'off', placeholder: 'pedido 16322 token 6dbc0f96… tienda https://www.mitienda.com/\n(Shopify: pedido 1021 token … tienda mitienda.myshopify.com)' });
    const go = async () => {
      if (!text.value.trim()) return;
      try {
        const r = await Bridge.call('ave.paste', { text: text.value, id: s ? s.id : undefined });
        text.value = '';
        modalClose(true);
        aveChecks.delete(r.site.id);
        await loadAve();
        await checkAve(r.site, true);
        const c = aveChecks.get(r.site.id);
        const st = c && c.ok ? `token vence ${aveLeft(c.info, c.at)}` : c ? c.error : '';
        toast(`${r.created ? 'Tienda agregada' : 'Token actualizado'}: ${r.site.name}${st ? ` · ${st}` : ''}${r.order ? ` · pedido ${r.order}` : ''}`, c && c.ok ? 'ok' : 'err');
        if (r.order && c && c.ok) {
          const cmd = `revisa el pedido ${r.order} de la tienda ${r.site.id} (Aveonline)`;
          copyText(cmd);
          toast(`Copiado para la IA: «${cmd}»`, 'ok');
        }
      } catch (e) { toast(e.message, 'err'); }
    };
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    openModal({
      title: s ? `Pegar token · ${s.name}` : 'Pegar token de Aveonline',
      body: [
        h('p.muted', { style: 'margin:0 0 8px' }, 'Pega el texto con la tienda, el token y (opcional) el pedido, tal como lo compartes hoy. ',
          s ? 'El token se guarda en esta tienda.' : 'Si la tienda ya está en FRAP se le cambia el token; si no, se agrega.',
          ' El token se guarda en aveonline.env (0600) y no se muestra en la UI ni a la IA. En WordPress: Aveonline → Revisión por token. En Shopify: app Aveonline Connect → Revisión por token (si el texto trae xxx.myshopify.com, la tienda es de Shopify).'),
        text,
      ],
      foot: [h('span.muted', { style: 'font-size:11px' }, 'Ctrl+Enter'), h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: go }, 'Guardar token')],
    });
    requestAnimationFrame(() => text.focus());
  }
  function editAveSite(s) {
    const appDefault = (aveInfo && aveInfo.shopifyAppUrl) || 'https://connect-crm-s.aveonline.co';
    const type = h('select', h('option', { value: 'wordpress' }, 'WordPress (WooCommerce + plugin Aveonline)'), h('option', { value: 'shopify' }, 'Shopify (app Aveonline Connect)'));
    type.value = s && s.type === 'shopify' ? 'shopify' : 'wordpress';
    const name = h('input', { placeholder: 'Mi tienda', value: s ? s.name : '' });
    const url = h('input.mono', { placeholder: 'https://www.mitienda.com', value: s && s.type !== 'shopify' ? s.url : '' });
    const shop = h('input.mono', { placeholder: 'mitienda.myshopify.com o https://mitienda.com', value: s && s.shop ? s.shop : '' });
    const appUrl = h('input.mono', { placeholder: appDefault, value: s && s.type === 'shopify' && s.url !== appDefault ? s.url : '' });
    const token = h('input.mono', { type: 'password', autocomplete: 'off', placeholder: s && s.hasToken ? `•••• ${s.tokenHint} (vacío = conservar el actual)` : 'Token de la «Revisión por token»' });
    const result = h('div.wp-test.muted');
    const help = h('p.muted', { style: 'margin:0 0 8px' });
    const wpFields = h('div', h('div.field', h('label', 'URL de la tienda'), url));
    const shFields = h('div',
      h('div.field', h('label', 'Tienda de Shopify'), shop),
      h('div.field', h('label', 'URL de la app ', h('span.muted', '(vacío = la de producción)')), appUrl));
    const syncType = () => {
      const sh = type.value === 'shopify';
      wpFields.classList.toggle('hidden', sh);
      shFields.classList.toggle('hidden', !sh);
      help.textContent = sh
        ? 'En Shopify: app Aveonline Connect → Revisión por token → «Generar token» y guardar (10 min por defecto, máximo 24 h). Es solo lectura. La tienda es su dominio xxx.myshopify.com; si escribes el dominio propio (https://mitienda.com), FRAP averigua el .myshopify.com. También sirve pegar el endpoint que muestra la app.'
        : 'En la tienda: WordPress → Aveonline → Revisión por token → «Generar token» y «Guardar y activar» (10 min por defecto, máximo 24 h). Es solo lectura. Lo más rápido es «Pegar token» en la lista.';
      result.textContent = '';
    };
    type.addEventListener('change', syncType);
    syncType();
    const read = () => {
      const sh = type.value === 'shopify';
      const guess = sh ? shop.value.trim().replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*$/, '') : url.value.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      return { id: s ? s.id : undefined, type: type.value, name: name.value.trim() || guess, url: sh ? appUrl.value.trim() : url.value.trim(), shop: sh ? shop.value.trim() : '', token: token.value.trim() || null };
    };
    const test = async () => {
      result.className = 'wp-test muted';
      result.textContent = 'Probando…';
      try {
        const i = await Bridge.call('ave.check', { site: read() });
        result.className = 'wp-test ok';
        result.replaceChildren(
          h('div', i.platform === 'shopify' ? `✓ ${i.shop}${shop.value.trim() && !/myshopify/i.test(shop.value) ? ` (de ${shop.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')})` : ''} · app Aveonline Connect ${i.version}` : `✓ ${i.name || i.site} · plugin Aveonline ${i.version}${i.woocommerce ? ` · WooCommerce ${i.woocommerce}` : ''}`),
          h('div', `Token: vence ${aveLeft(i)}`), i.legacy ? h('div.muted', 'Plugin anterior a 4.11.4: solo el log (sin pedidos ni tramas por pedido).') : null);
      } catch (e) { result.className = 'wp-test err'; result.textContent = `✗ ${e.message}`; }
    };
    const doSave = async () => {
      try {
        const r = await Bridge.call('ave.save', { site: read() });
        modalClose(true);
        toast(`Tienda ${r.name} guardada`, 'ok');
        aveChecks.delete(r.id);
        await loadAve();
        if (r.hasToken) checkAve(r, true);
      } catch (e) { toast(e.message, 'err'); }
    };
    openModal({
      title: s ? `Aveonline · ${s.name}` : 'Nueva tienda Aveonline',
      body: [
        help,
        h('div.field', h('label', 'Tipo'), type),
        h('div.field', h('label', 'Nombre'), name),
        wpFields, shFields,
        h('div.field', h('label', 'Token'), token),
        result,
      ],
      foot: [h('button', { onclick: test }, 'Probar'), h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
    requestAnimationFrame(() => (s ? token : type.value === 'shopify' ? shop : url).focus());
  }
  async function deleteAve(s) {
    if (!(await confirmBox(`¿Eliminar la tienda «${s.name}»?`, 'El token se borra de FRAP (en la tienda sigue activo hasta que venza o lo revoquen).'))) return;
    try { await Bridge.call('ave.delete', { id: s.id }); aveChecks.delete(s.id); toast('Tienda eliminada', 'ok'); loadAve(); } catch (e) { toast(e.message, 'err'); }
  }
  /** Últimos pedidos con Aveonline de la tienda: guía y si tienen tramas, con el comando para la IA. */
  async function aveOrders(s) {
    const list = h('div.ave-orders', h('p.muted', 'Cargando…'));
    openModal({ title: `Pedidos · ${s.name}`, wide: true, body: [list], foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cerrar')] });
    try {
      const d = await Bridge.call('ave.orders', { id: s.id, query: { per_page: 30 } });
      if (!d.orders.length) { list.replaceChildren(h('p.muted', 'Sin pedidos enviados con Aveonline.')); return; }
      list.replaceChildren(
        h('p.muted', { style: 'margin:0 0 6px' }, `${d.orders.length} pedido(s) · token vence ${aveLeft(d)} · «IA» copia la petición para pegarla en claude/codex (usa la skill frap-aveonline).`),
        h('div.ave-orow.ave-ohead', h('span', 'Pedido'), h('span', 'Fecha'), h('span', 'Estado'), h('span', 'Envío'), h('span', 'Guía'), h('span', 'Tramas'), h('span')),
        ...d.orders.map((o) => h('div.ave-orow',
          h('span.mono', `#${o.number}`),
          h('span.muted', o.created.slice(0, 16)),
          h('span', o.status),
          h('span', { title: o.city ? `${o.city}${o.state ? `, ${o.state}` : ''}` : '' }, o.shipping ? o.shipping.name : '—'),
          h('span.mono', o.guia && o.guia.numguia ? String(o.guia.numguia) : '—'),
          h('span', [o.tramas.cotizacion ? 'cotización' : '', o.tramas.guia ? 'guía' : ''].filter(Boolean).join(' + ') || '—'),
          h('button.mini', { title: 'Copiar la petición para la IA', onclick: () => { const c = `revisa el pedido ${o.number} de la tienda ${s.id} (Aveonline)`; copyText(c); toast(`Copiado: ${c}`, 'ok'); } }, '⧉ IA'))));
    } catch (e) { list.replaceChildren(h('pre.db-error', e.message)); }
  }
  function aveMenu(ev, s) {
    popMenu(ev, [
      { label: '📋 Pegar token nuevo', action: () => pasteAveToken(s) },
      { label: '⟳ Probar conexión', action: () => checkAve(s) },
      s.hasToken && s.type !== 'shopify' && { label: '☰ Últimos pedidos', action: () => aveOrders(s) },
      { label: '✎ Editar', action: () => editAveSite(s) },
      s.type === 'shopify'
        ? { label: '↗ Apps de la tienda en Shopify', hint: 'activar token', action: () => openPageTab({ url: `https://admin.shopify.com/store/${s.shop.replace(/\.myshopify\.com$/, '')}/apps` }) }
        : { label: '↗ Revisión por token en la tienda', hint: 'activar token', action: () => openPageTab({ url: `${s.url}/wp-admin/admin.php?page=revision_token` }) },
      { label: '↗ Abrir la tienda', action: () => openPageTab({ url: s.type === 'shopify' ? `https://${s.domain || s.shop}` : s.url }) },
      { label: '⧉ Copiar comando para la IA', hint: 'frap-ave', action: () => { const c = `node ${aveInfo.cli} ${s.id} info`; copyText(c); toast(`Copiado: ${c}`, 'ok'); } },
      '-',
      { label: '🗑 Eliminar tienda', danger: true, action: () => deleteAve(s) },
    ]);
  }
  function aveSwitch(s, key) {
    const on = !!s[key];
    return h('label.wp-sw', { title: key === 'ai' ? 'Las IA la pueden consultar (skill frap-aveonline, solo lectura)' : 'Tienda activa' },
      h('button', { class: `switch ${on ? 'on' : 'off'}`, role: 'switch', 'aria-checked': String(on), onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleAve(s, key); } }),
      key === 'ai' ? 'IA' : 'Activa');
  }
  function aveGroup() {
    const col = integCollapsed('aveonline');
    const head = h('div.integ-ghead', { onclick: () => integToggle('aveonline') },
      h('span.integ-caret', col ? '▸' : '▾'), h('span.integ-logo.ave', 'A'), h('span.grow', 'Aveonline'),
      h('span.integ-count', aveInfo ? String(aveInfo.sites.length) : '…'),
      h('button.icon.mini', { title: 'Pegar token (texto con tienda, token y pedido)', onclick: (e) => { e.stopPropagation(); pasteAveToken(null); } }, '📋'),
      h('button.icon.mini', { title: 'Nueva tienda Aveonline', onclick: (e) => { e.stopPropagation(); editAveSite(null); } }, '＋'));
    if (col) return h('div.integ-group', head);
    if (aveError) return h('div.integ-group', head, h('div.integ-empty', aveError));
    if (!aveInfo) { loadAve(true); return h('div.integ-group', head, h('div.integ-empty', 'Cargando…')); }
    const sites = aveInfo.sites;
    return h('div.integ-group', head, sites.length ? h('div.integ-items', sites.map((s) => {
      const c = aveChecks.get(s.id);
      const expired = c && c.ok && !aveSecs(c.info, c.at);
      const st = !s.enabled || !s.hasToken ? 'off' : !c || c.loading ? 'wait' : c.ok && !expired ? 'ok' : 'err';
      const title = !s.enabled ? 'Apagada' : !s.hasToken ? 'Sin token: «Pegar token nuevo»' : !c ? 'Sin probar' : c.loading ? 'Probando…'
        : c.ok ? `${s.type === 'shopify' ? 'App Aveonline Connect' : 'Plugin Aveonline'} ${c.info.version} · token vence ${aveLeft(c.info, c.at)}${c.info.legacy ? '\nPlugin anterior a 4.11.4: solo log' : ''}` : c.error;
      let host = s.type === 'shopify' ? (s.domain ? `${s.domain} · ${s.shop}` : s.shop) : s.url;
      if (s.type !== 'shopify') try { host = new URL(s.url).host; } catch (_) { /* se deja la URL */ }
      const sub = !s.hasToken ? ' · sin token' : c && c.ok && s.enabled ? ` · ${expired ? 'token vencido' : `vence ${aveLeft(c.info, c.at)}`}` : c && !c.ok && s.enabled && !c.loading ? ' · token vencido o inválido' : '';
      return h(`div.integ-site${s.enabled ? '' : '.off'}`, { title, oncontextmenu: (e) => aveMenu(e, s) },
        h('div.integ-row',
          h(`span.integ-dot.${st}`),
          h('span.integ-name', s.name),
          h(`span.ave-kind.${s.type === 'shopify' ? 'shopify' : 'wp'}`, { title: s.type === 'shopify' ? 'Shopify (app Aveonline Connect)' : 'WordPress (plugin Aveonline)' }, s.type === 'shopify' ? 'Shopify' : 'WP'),
          h('span.grow'),
          h('button.icon.mini', { title: 'Pegar token nuevo', onclick: (e) => { e.stopPropagation(); pasteAveToken(s); } }, '📋'),
          h('button.icon.mini', { title: 'Opciones', onclick: (e) => aveMenu(e, s) }, '⋯')),
        h('div.integ-sub.muted', host, sub),
        h('div.integ-sws', aveSwitch(s, 'enabled'), aveSwitch(s, 'ai')));
    })) : h('div.integ-empty', 'Sin tiendas. Pulsa 📋 y pega el texto con la tienda y el token de la «Revisión por token».'));
  }
  // los tokens de Aveonline duran minutos: el «vence en…» se refresca solo
  setInterval(() => { if ([...aveChecks.values()].some((c) => c.ok) && !integCollapsed('all') && !integCollapsed('aveonline')) renderIntegrations(); }, 30000);

  function integCollapsed(k) { return (state.ui.integCollapsed || []).includes(k); }
  function integToggle(k) {
    const set = new Set(state.ui.integCollapsed || []);
    if (set.has(k)) set.delete(k); else set.add(k);
    state.ui.integCollapsed = [...set];
    save();
    renderIntegrations();
  }
  function renderIntegrations() {
    const root = $('#integrations');
    if (!root) return;
    const on = modOn('left.integrations');
    root.classList.toggle('hidden', !on);
    if (!on) return;
    const all = integCollapsed('all');
    const head = h('div.integ-head', { onclick: () => integToggle('all'), title: all ? 'Desplegar' : 'Plegar' },
      h('span.integ-caret', all ? '▸' : '▾'), h('span.integ-title', 'Integraciones'));
    if (all) { root.replaceChildren(head); return; }
    let body;
    if (!Bridge.ready) body = h('div.integ-empty', 'Bridge desconectado.');
    else if (wpError) body = h('div', h('div.integ-empty', wpError), aveGroup());
    else if (!wpInfo) { body = h('div.integ-empty', 'Cargando…'); loadWp(true); }
    else {
      const sites = wpInfo.sites;
      const col = integCollapsed('wordpress');
      body = h('div.integ-group',
        h('div.integ-ghead', { onclick: () => integToggle('wordpress') },
          h('span.integ-caret', col ? '▸' : '▾'), h('span.integ-logo', 'W'), h('span.grow', 'WordPress'),
          h('span.integ-count', String(sites.length)),
          h('button.icon.mini', { title: 'Descargar el plugin frap-wordpress (.zip para subir en WordPress → Plugins → Añadir nuevo → Subir plugin)', onclick: (e) => { e.stopPropagation(); window.open(WP_PLUGIN_ZIP, '_blank'); } }, '⬇'),
          h('button.icon.mini', { title: 'Nueva conexión WordPress', onclick: (e) => { e.stopPropagation(); editWpSite(null); } }, '＋')),
        col ? null : sites.length ? h('div.integ-items', sites.map((s) => {
          const c = wpChecks.get(s.id);
          const st = !s.enabled ? 'off' : !c || c.loading ? 'wait' : c.ok ? 'ok' : 'err';
          const title = !s.enabled ? 'Apagada' : !c ? 'Sin probar' : c.loading ? 'Probando…' : c.ok ? `Conectado · token vence ${wpLeft(c.info, c.at)}\n${wpPermSummary(c.info)}` : c.error;
          let host = s.url;
          try { host = new URL(s.url).host; } catch (_) { /* se deja la URL */ }
          return h(`div.integ-site${s.enabled ? '' : '.off'}`, { title, oncontextmenu: (e) => wpMenu(e, s) },
            h('div.integ-row',
              h(`span.integ-dot.${st}`),
              h('span.integ-name', s.name),
              h('span.grow'),
              h('button.icon.mini', { title: 'Opciones', onclick: (e) => wpMenu(e, s) }, '⋯')),
            h('div.integ-sub.muted', host, c && c.ok && s.enabled ? ` · vence ${wpLeft(c.info, c.at)}` : c && !c.ok && s.enabled && !c.loading ? ` · ${c.error}` : ''),
            h('div.integ-sws', wpSwitch(s, 'enabled'), wpSwitch(s, 'ai')));
        })) : h('div.integ-empty', 'Sin sitios. Pulsa ＋ y pega la URL y el token que crea el plugin frap-wordpress.'));
      body = h('div', body, aveGroup());
    }
    root.replaceChildren(head, body);
  }

  // ----- carpeta local/ como .zip (exportar / importar) -----
  function b64FromBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function exportLocalZip() {
    try {
      const r = await Bridge.call('local.export');
      const bin = atob(r.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })), download: `frap-local-${new Date().toISOString().slice(0, 10)}.zip` });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast(`Exportada la carpeta local: ${r.files} archivo(s), ${(r.bytes / 1024).toFixed(0)} KB`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }
  function importLocalZip() {
    const input = h('input', { type: 'file', accept: '.zip,application/zip' });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const data = b64FromBytes(new Uint8Array(await file.arrayBuffer()));
      const over = h('input', { type: 'checkbox' });
      const doImport = async () => {
        try {
          const r = await Bridge.call('local.import', { data, overwrite: over.checked });
          modalClose(true);
          toast(`Carpeta local restaurada de ${file.name}: ${r.written} escrito(s)${r.skipped ? `, ${r.skipped} ya existían (sin tocar)` : ''}${r.rejected.length ? `, ${r.rejected.length} rechazado(s)` : ''}`, r.rejected.length ? 'err' : 'ok');
          issuesInfo = null;
          loadIssues();
        } catch (e) { toast(e.message, 'err'); }
      };
      openModal({
        title: `Importar carpeta local · ${file.name}`,
        body: [
          h('p', 'Los archivos del zip se copian a la carpeta local de FRAP (issues y demás).'),
          h('label.muted', over, ' Reemplazar los archivos que ya existen (si no, se dejan como están)'),
        ],
        foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doImport }, 'Importar')],
      });
    });
    input.click();
  }

  // ---------- módulo interno: scripts (pestaña "Scripts" del panel derecho) ----------
  // local/scripts/<carpeta>/<script>, con interruptores «Usuario» (ejecutar desde FRAP) e «IA» (frap-scripts run).
  let scrInfo = null; // respuesta de scripts.list
  let scrError = null;
  let scrSynced = null; // último estado aplicado de la skill/módulo
  async function loadScripts() {
    if (!Bridge.ready || !modOn('internal.scripts')) return;
    try { scrInfo = await Bridge.call('scripts.list'); scrError = null; } catch (e) { scrError = e.message; }
    if (state.ui.rtab === 'scripts') renderRight();
  }
  /** Skill frap-scripts + `frap-scripts run`: activos con el módulo, quitados/bloqueados sin él. */
  async function syncScriptsModule(force) {
    if (!Bridge.ready) return;
    const on = modOn('internal.scripts');
    if (!force && scrSynced === on) return;
    try {
      const r = await Bridge.call('scripts.setModule', { on });
      scrSynced = on;
      if (r.changed.length) toast(on ? 'Skill frap-scripts lista en claude y codex: los scripts que pidas se crean en local/scripts' : 'Skill frap-scripts quitada; la IA ya no puede ejecutar scripts', 'ok');
    } catch (e) { toast(`Skill frap-scripts: ${e.message}`, 'err'); }
  }
  async function setScriptFlag(sc, key) {
    try {
      const r = await Bridge.call('scripts.set', { path: sc.path, [key]: !sc[key] });
      Object.assign(sc, r);
      toast(`${sc.name}: ${key === 'ai' ? (r.ai ? 'la IA lo puede ejecutar' : 'la IA ya no lo puede ejecutar') : (r.user ? 'habilitado para ejecutarlo desde FRAP' : 'deshabilitado para ejecutarlo desde FRAP')}`, 'ok');
      renderRight();
    } catch (e) { toast(e.message, 'err'); }
  }
  /** Lo ejecuta en una terminal nueva del proyecto activo (desde local/scripts), para ver la salida en vivo. */
  async function runScript(sc, args = '') {
    try {
      const c = await Bridge.call('scripts.command', { path: sc.path });
      await launch('shell', { cwd: c.cwd, title: `▶ ${sc.name}`, init: `${c.line}${args ? ` ${args}` : ''}` });
    } catch (e) { toast(e.message, 'err'); }
  }
  function runScriptWithArgs(sc) {
    const args = h('input.mono', { placeholder: 'argumentos (como en la terminal)', value: (state.ui.scriptArgs || {})[sc.path] || '' });
    const go = () => {
      state.ui.scriptArgs = { ...(state.ui.scriptArgs || {}), [sc.path]: args.value };
      save();
      modalClose(true);
      runScript(sc, args.value.trim());
    };
    args.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    openModal({
      title: `Ejecutar · ${sc.name}`,
      body: [h('p.muted', { style: 'margin-top:0' }, sc.desc || sc.path), h('div.field', h('label', 'Argumentos'), args)],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: go }, '▶ Ejecutar')],
    });
    requestAnimationFrame(() => args.focus());
  }
  async function trashScript(sc) {
    if (!(await confirmBox(`¿Mandar "${sc.path}" a la papelera?`, 'Se puede recuperar desde la papelera del sistema.'))) return;
    try { await Bridge.call('fs.trash', { path: sc.abs }); toast(`${sc.name} en la papelera`, 'ok'); loadScripts(); } catch (e) { toast(e.message, 'err'); }
  }
  function scriptMenu(ev, sc) {
    popMenu(ev, [
      sc.runnable && { label: 'Ejecutar con argumentos…', disabled: !sc.user, action: () => runScriptWithArgs(sc) },
      { label: 'Abrir en el editor', action: () => openInFrap(sc.abs) },
      '-',
      { label: 'Copiar ruta', action: () => { copyText(sc.abs); toast('Ruta copiada', 'ok'); } },
      sc.runnable && { label: 'Copiar comando para la IA', action: () => { const t = `frap-scripts run ${sc.path}`; copyText(t); toast(`Copiado: ${t}`, 'ok'); } },
      { label: 'Mostrar en el explorador de archivos', action: () => openInFileManager(sc.abs) },
      '-',
      { label: 'Mover a la papelera', danger: true, action: () => trashScript(sc) },
    ]);
  }
  function newScript(folder) {
    const folders = (scrInfo ? scrInfo.folders.map((f) => f.name) : []);
    const ids = issuesInfo ? issuesInfo.issues.filter((i) => !i.closed).map((i) => i.id) : [];
    const list = h('datalist', { id: 'scr-folders' }, [...new Set([...ids, ...folders])].map((f) => h('option', { value: f })));
    const dir = h('input.mono', { list: 'scr-folders', value: folder || '', placeholder: 'AVE-1630 o un-tema-corto' });
    const name = h('input.mono', { placeholder: '1-leads-con-telefono' });
    const ext = h('select', ...['ts', 'js', 'py', 'sh', 'php', 'sql'].map((x) => h('option', { value: x }, `.${x}`)));
    ext.value = state.ui.scriptExt || 'ts';
    const desc = h('input', { placeholder: 'Qué hace (va en la cabecera del archivo)' });
    const doCreate = async () => {
      const d = dir.value.trim().replace(/^\/+|\/+$/g, '');
      const n = name.value.trim().replace(/\.(ts|js|py|sh|php|sql)$/i, '');
      if (!d || !/^[\w][\w.-]*$/.test(d)) { toast('Carpeta inválida (letras, números y guiones)', 'err'); dir.focus(); return; }
      if (!n || !/^[\w][\w.-]*$/.test(n)) { toast('Nombre inválido (letras, números y guiones)', 'err'); name.focus(); return; }
      state.ui.scriptExt = ext.value;
      try {
        const r = await Bridge.call('scripts.create', { path: `${d}/${n}.${ext.value}`, desc: desc.value.trim() });
        modalClose(true);
        state.ui.scriptsOpen = [...new Set([...(state.ui.scriptsOpen || []), d])];
        save();
        toast(`Creado ${r.path}`, 'ok');
        await loadScripts();
        openInFrap(r.abs);
      } catch (e) { toast(e.message, 'err'); }
    };
    [dir, name, desc].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); }));
    openModal({
      title: 'Nuevo script',
      body: [
        list,
        h('div.field', h('label', 'Carpeta (ID de la issue o un tema)'), dir),
        h('div.field-row', h('div.field.grow', h('label', 'Nombre'), name), h('div.field', h('label', 'Tipo'), ext)),
        h('div.field', h('label', 'Descripción'), desc),
        h('p.muted', { style: 'margin:0;font-size:11px' }, `Se crea en ${scrInfo ? tilde(scrInfo.dir) : 'local/scripts'}/<carpeta>/ con Usuario e IA habilitados. Para pedírselo a la IA basta con decirle "hazme un script que…".`),
      ],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doCreate }, 'Crear y abrir')],
    });
    requestAnimationFrame(() => (folder ? name : dir).focus());
  }
  function scriptSwitch(sc, key) {
    const on = !!sc[key];
    return h('label.scr-sw', { title: key === 'ai' ? 'La IA lo puede ejecutar (frap-scripts run)' : 'Lo puedes ejecutar desde FRAP (▶)' },
      h('button', { class: `switch ${on ? 'on' : 'off'}`, role: 'switch', 'aria-checked': String(on), onclick: (e) => { e.preventDefault(); setScriptFlag(sc, key); } }),
      key === 'ai' ? 'IA' : 'Usuario');
  }
  function renderScripts() {
    if (!Bridge.ready) return [section('Scripts'), h('div.empty-list', 'Bridge desconectado.')];
    if (scrError) return [section('Scripts'), h('div.empty-list', scrError)];
    if (!scrInfo) { loadScripts(); return [section('Scripts'), h('div.empty-list', 'Cargando…')]; }
    const q = (state.ui.scriptsQuery || '').toLowerCase();
    const open = new Set(state.ui.scriptsOpen || []);
    const list = scrInfo.scripts.filter((s) => !q || `${s.path} ${s.desc}`.toLowerCase().includes(q));
    const groups = new Map();
    for (const s of list) { const g = s.folder.split('/')[0] || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
    const order = ['', ...scrInfo.folders.map((f) => f.name).filter((f) => groups.has(f))]; // compartidos primero, luego lo más reciente
    const search = h('input.filter', { placeholder: 'Buscar script…', value: state.ui.scriptsQuery || '' });
    search.addEventListener('input', debounce(() => { state.ui.scriptsQuery = search.value; save(); renderRight(); requestAnimationFrame(() => { const s = $('#rbody .filter'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }); }, 200));
    const toggle = (g) => { const s = new Set(state.ui.scriptsOpen || []); if (s.has(g)) s.delete(g); else s.add(g); state.ui.scriptsOpen = [...s]; save(); renderRight(); };
    const row = (sc) => h(`div.scr-row${sc.user ? '' : '.off'}`,
      h('div.scr-main',
        h('a.scr-name.mono', { href: '#', title: `${sc.path} · clic: abrir en el editor`, onclick: (e) => { e.preventDefault(); openInFrap(sc.abs); } }, sc.folder ? sc.path.slice(sc.folder.split('/')[0].length + 1) : sc.name),
        sc.desc ? h('div.scr-desc.muted', sc.desc) : null),
      h('div.scr-ctrl',
        scriptSwitch(sc, 'user'),
        scriptSwitch(sc, 'ai'),
        sc.runnable ? h('button.mini', { title: sc.user ? `Ejecutar (${sc.runner}) en una terminal` : 'Deshabilitado (interruptor Usuario)', disabled: !sc.user, onclick: () => runScript(sc) }, '▶') : h('span.muted.scr-noexec', { title: 'Este tipo de archivo no se ejecuta: revísalo y córrelo a mano' }, 'ver'),
        h('button.icon', { title: 'Más', onclick: (e) => scriptMenu(e, sc) }, '⋯')));
    return [
      section('Scripts',
        h('button.icon', { title: 'Recargar', onclick: () => loadScripts() }, '⟳'),
        h('button.primary.mini', { onclick: () => newScript() }, '+ Nuevo')),
      h('p.muted.scr-hint', `En ${tilde(scrInfo.dir)} (fuera de git). Pídele a la IA "hazme un script que…" y lo crea aquí. «Usuario»: ejecutarlo desde FRAP · «IA»: que la IA lo ejecute.`),
      !scrInfo.bun && scrInfo.scripts.some((s) => s.runner === 'bun') ? h('p.scr-warn', '⚠ No encuentro bun: los .ts no se podrán ejecutar (curl -fsSL https://bun.sh/install | bash).') : null,
      search,
      list.length ? h('div.scr-groups', order.map((g) => {
        const items = groups.get(g) || [];
        const f = scrInfo.folders.find((x) => x.name === g);
        const isOpen = q || open.has(g);
        const isIssue = issuesInfo && issuesInfo.issues.some((i) => i.id === g);
        return h('div.scr-group',
          h('div.scr-ghead', { onclick: () => toggle(g) },
            h('span.scr-caret', isOpen ? '▾' : '▸'),
            h('span.scr-gname', g || 'Compartidos'),
            isIssue ? h('span.badge', { title: 'Carpeta de una issue' }, '🎫') : null,
            h('span.muted.scr-count', String(items.length)),
            h('span.grow'),
            f && f.salida ? h('button.mini', { title: `Abrir ${g}/salida en el explorador de archivos`, onclick: (e) => { e.stopPropagation(); openInFileManager(`${scrInfo.dir}/${g}/salida`); } }, `📂 salida ${f.salida}`) : null,
            g ? h('button.icon', { title: `Nuevo script en ${g}`, onclick: (e) => { e.stopPropagation(); newScript(g); } }, '＋') : null),
          isOpen ? h('div.scr-items', items.map(row)) : null);
      })) : h('div.empty-list', scrInfo.scripts.length ? 'Nada con esa búsqueda.' : 'Sin scripts todavía. Crea uno o pídeselo a la IA.'),
    ];
  }

  // ---------- túneles (pestaña del panel derecho): compartir por URL pública lo que corre en local ----------
  // state.tunnels = [{id, name, kind: 'port'|'url'|'path', port, url, path, provider, password, hostRewrite, rewriteUrls}]
  // El bridge los corre (tunnel.start) y avisa con el evento `tunnel`; no sobreviven a reiniciar el bridge.
  let tunInfo = null; // {providers, binDir, install}
  const tunLive = new Map(); // id -> info del bridge
  let tunPorts = null; // servidores detectados
  let tunError = null;
  async function loadTunnels(withPorts) {
    if (!Bridge.ready) return;
    try {
      const st = await Bridge.call('tunnel.status');
      tunInfo = st;
      tunLive.clear();
      for (const t of st.tunnels) tunLive.set(t.id, t);
      tunError = null;
      if (withPorts) tunPorts = await Bridge.call('tunnel.ports');
    } catch (e) { tunError = e.message; }
    if (state.ui.rtab === 'tunnels') renderRight();
  }
  Bridge.on('tunnel', ({ tunnel: t }) => {
    const prev = tunLive.get(t.id);
    if (t.status === 'stopped') tunLive.delete(t.id); else tunLive.set(t.id, t);
    if (t.status === 'online' && (!prev || prev.status !== 'online')) {
      toast(`🚇 ${t.name}: ${t.url}`, 'ok');
    } else if (t.status === 'error' && (!prev || prev.status !== 'error')) toast(`Túnel ${t.name}: ${t.error}`, 'err');
    if (t.warning && (!prev || prev.warning !== t.warning)) toast(`Túnel ${t.name}: ${t.warning}`, 'err');
    if (state.ui.rtab === 'tunnels') renderRight();
    renderStatusTunnels();
  });
  const tunTarget = (c) => (c.kind === 'path' ? { type: 'path', path: c.path } : { type: 'url', url: c.kind === 'port' ? String(c.port) : c.url });
  const tunTargetLabel = (c) => (c.kind === 'path' ? tilde(c.path || '') : c.kind === 'port' ? `localhost:${c.port}` : c.url);
  const tunShareUrl = (c, live) => (live && live.url ? (c.password ? `${live.url}/?frap_key=${encodeURIComponent(c.password)}` : live.url) : '');
  async function startTunnel(c) {
    try {
      const t = await Bridge.call('tunnel.start', { id: c.id, name: c.name, target: tunTarget(c), provider: c.provider || 'auto', password: c.password || '', hostRewrite: c.hostRewrite !== false, rewriteUrls: !!c.rewriteUrls });
      tunLive.set(t.id, t);
      renderRight();
    } catch (e) { toast(e.message, 'err'); }
  }
  async function stopTunnel(c) {
    try { await Bridge.call('tunnel.stop', { id: c.id }); } catch (e) { toast(e.message, 'err'); }
    tunLive.delete(c.id);
    renderRight();
    renderStatusTunnels();
  }
  async function deleteTunnel(c) {
    if (!(await confirmBox(`¿Eliminar el túnel "${c.name}"?`, tunLive.has(c.id) ? 'Se detiene y la URL deja de funcionar.' : ''))) return;
    if (tunLive.has(c.id)) await stopTunnel(c);
    state.tunnels = state.tunnels.filter((x) => x.id !== c.id);
    save();
    renderRight();
  }
  function tunInstallHelp() {
    const cmd = (tunInfo && tunInfo.install) || 'bash scripts/install-cloudflared.sh';
    openModal({
      title: 'Instalar cloudflared (recomendado)',
      body: [
        h('p', { style: 'margin-top:0' }, 'Con cloudflared los túneles usan Cloudflare: URL https://….trycloudflare.com, sin cuenta, sin límite de tiempo y más estables que localhost.run. Es un solo binario oficial (~40 MB). Corre en una terminal:'),
        h('pre.mono', { style: 'white-space:pre-wrap;user-select:all;background:var(--bg);padding:8px;border-radius:4px' }, cmd),
        h('p.muted', `Queda en ${tilde((tunInfo && tunInfo.binDir) || '~/.config/frap/bin')}. Sin cloudflared se usa localhost.run por ssh (no hay que instalar nada).`),
      ],
      foot: [h('span.grow'), h('button', { onclick: () => { copyText(cmd); toast('Comando copiado', 'ok'); } }, 'Copiar comando'), h('button.primary', { onclick: () => { modalClose(true); loadTunnels(); } }, 'Listo')],
    });
  }
  /** Crear/editar un túnel. preset: {kind, port, url, path, name} (desde "detectados" o el árbol del editor). */
  function editTunnel(c, preset) {
    const isNew = !c;
    const src = c || { id: uid(), kind: 'port', port: '', url: '', path: '', provider: 'auto', password: '', hostRewrite: true, rewriteUrls: false, ...(preset || {}) };
    const name = h('input', { value: src.name || '', placeholder: 'Mi app (opcional)' });
    const kind = h('select',
      h('option', { value: 'port' }, 'Un puerto de este equipo (npm, bun, pnpm, php -S, WordPress…)'),
      h('option', { value: 'url' }, 'Una URL o IP de la red (192.168.1.20:8080, https://localhost:8443…)'),
      h('option', { value: 'path' }, 'Un archivo o carpeta (HTML estático)'));
    kind.value = src.kind;
    const port = h('input.mono', { type: 'number', min: 1, max: 65535, value: src.port || '', placeholder: '3000' });
    const url = h('input.mono', { value: src.url || '', placeholder: 'http://192.168.1.20:8080' });
    const pth = h('input.mono', { value: src.path || '', placeholder: '/ruta/a/index.html o /ruta/a/carpeta' });
    const pick = h('button', { onclick: async () => { const d = await pickFolderInline(pth.value || (project() && project().folders[0])); if (d) pth.value = d; } }, 'Elegir carpeta…');
    const fPort = h('div.field', h('label', 'Puerto'), port);
    const fUrl = h('div.field', h('label', 'URL o IP:puerto'), url);
    const fPath = h('div.field', h('label', 'Archivo o carpeta'), h('div.field-row', h('span.grow', pth), pick),
      h('span.muted', { style: 'font-size:11px' }, 'Una carpeta muestra su index.html (o la lista de archivos); un archivo abre ese archivo. Los archivos ocultos (.env, .git) no se sirven.'));
    const syncKind = () => { fPort.classList.toggle('hidden', kind.value !== 'port'); fUrl.classList.toggle('hidden', kind.value !== 'url'); fPath.classList.toggle('hidden', kind.value !== 'path'); };
    kind.addEventListener('change', syncKind);
    syncKind();
    const av = (tunInfo && tunInfo.providers) || {};
    const prov = h('select',
      h('option', { value: 'auto' }, `Automático${av.cloudflared && av.cloudflared.path ? ' (Cloudflare)' : ' (localhost.run)'}`),
      ...Object.entries(av).map(([k, p]) => h('option', { value: k, disabled: !p.path }, `${p.name}${p.path ? '' : ' — no instalado'}`)));
    prov.value = src.provider || 'auto';
    const pass = h('input', { value: src.password || '', placeholder: 'sin contraseña: cualquiera con la URL entra', autocomplete: 'off' });
    const hostRw = h('input', { type: 'checkbox' });
    hostRw.checked = src.hostRewrite !== false;
    const urlRw = h('input', { type: 'checkbox' });
    urlRw.checked = !!src.rewriteUrls;
    const doSave = (andStart) => {
      const d = { name: name.value.trim(), kind: kind.value, port: Number(port.value) || '', url: url.value.trim(), path: pth.value.trim(), provider: prov.value, password: pass.value, hostRewrite: hostRw.checked, rewriteUrls: urlRw.checked };
      if (d.kind === 'port' && !(d.port > 0 && d.port < 65536)) { toast('Puerto inválido', 'err'); return; }
      if (d.kind === 'url' && !d.url) { toast('Escribe la URL o IP:puerto', 'err'); return; }
      if (d.kind === 'path' && !d.path.startsWith('/')) { toast('Escribe una ruta absoluta', 'err'); return; }
      d.name = d.name || (d.kind === 'path' ? basename(d.path) : tunTargetLabel(d));
      if (isNew) { c = { id: src.id, ...d }; state.tunnels.push(c); } else Object.assign(c, d);
      save();
      modalClose(true);
      if (andStart || tunLive.has(c.id)) startTunnel(c); else renderRight();
    };
    openModal({
      title: isNew ? 'Nuevo túnel' : `Editar túnel · ${c.name}`,
      body: [
        h('div.field', h('label', 'Qué compartir'), kind),
        fPort, fUrl, fPath,
        h('div.field', h('label', 'Nombre'), name),
        h('div.field-row',
          h('div.field.grow', h('label', 'Proveedor'), prov),
          h('div.field.grow', h('label', 'Contraseña (opcional)'), pass)),
        av.cloudflared && !av.cloudflared.path ? h('p.muted', { style: 'margin:0;font-size:11px' }, 'Recomendado: ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); tunInstallHelp(); } }, 'instalar cloudflared'), ' (más estable y sin límite de tiempo).') : null,
        h('label.muted', hostRw, ' Reescribir el Host a localhost (Vite, Next, Angular… rechazan hosts desconocidos)'),
        h('label.muted', urlRw, ' Reemplazar las URLs localhost del contenido por la pública (WordPress y apps que generan enlaces absolutos)'),
        h('p.muted', { style: 'margin:4px 0 0;font-size:11px' }, 'La URL es pública: quien la tenga puede entrar (salvo que pongas contraseña). Detén el túnel cuando termines.'),
      ],
      foot: [
        h('span.grow'),
        h('button', { onclick: () => modalClose(true) }, 'Cancelar'),
        h('button', { onclick: () => doSave(false) }, 'Guardar'),
        h('button.primary', { onclick: () => doSave(true) }, tunLive.has(src.id) ? 'Guardar y reiniciar' : 'Guardar y compartir'),
      ],
    });
  }
  /** Proceso de un puerto detectado → ¿de qué proyecto es? (por su carpeta de trabajo). */
  function tunPortProject(p) {
    if (!p.cwd) return null;
    return state.projects.find((pr) => pr.folders.some((f) => p.cwd === f.replace(/\/+$/, '') || p.cwd.startsWith(`${f.replace(/\/+$/, '')}/`))) || null;
  }
  function renderTunnels() {
    if (!Bridge.ready) return [section('Túneles'), h('div.empty-list', 'Bridge desconectado.')];
    if (tunError) return [section('Túneles'), h('div.empty-list', tunError)];
    if (!tunInfo) { loadTunnels(true); return [section('Túneles'), h('div.empty-list', 'Cargando…')]; }
    const av = tunInfo.providers;
    const cards = state.tunnels.map((c) => {
      const live = tunLive.get(c.id);
      const st = live ? live.status : 'off';
      const share = tunShareUrl(c, live);
      return h(`div.tun-card.${st}`,
        h('div.tun-head',
          h(`span.tun-dot.${st}`, { title: { off: 'Detenido', starting: 'Conectando…', online: 'En línea', error: 'Error' }[st] }),
          h('span.tun-name', c.name),
          c.password ? h('span.badge', { title: 'Con contraseña' }, '🔒') : null,
          h('span.grow'),
          live && live.status === 'online' ? h('span.muted.tun-hits', { title: `${live.hits} peticiones · ${live.visitors} visitante(s)${live.lastHit ? ` · última ${new Date(live.lastHit).toLocaleTimeString()}` : ''}` }, `👁 ${live.visitors}`) : null,
          h('button.icon', { title: 'Editar', onclick: () => editTunnel(c) }, '✎'),
          h('button.icon', { title: 'Eliminar', onclick: () => deleteTunnel(c) }, '✕')),
        h('div.tun-target.muted.mono', `${c.kind === 'path' ? '📄' : '🔌'} ${tunTargetLabel(c)}${live ? ` · ${live.providerName}` : ''}`),
        live && live.status === 'online' ? h('div.tun-url',
          h('a.mono', { href: live.url, target: '_blank', rel: 'noopener', title: 'Abrir en otra pestaña' }, live.url.replace(/^https:\/\//, '')),
          h('button.mini', { title: c.password ? 'Copiar la URL con la clave incluida (entra sin pedirla)' : 'Copiar la URL', onclick: () => { copyText(share); toast(`Copiado: ${share}`, 'ok'); } }, '⧉ Copiar'),
          c.password ? h('button.mini', { title: 'Copiar solo la URL (pedirá la contraseña)', onclick: () => { copyText(live.url); toast('URL copiada (sin clave)', 'ok'); } }, 'sin clave') : null) : null,
        live && live.status === 'starting' ? h('div.tun-url.muted', 'Conectando con el proveedor…') : null,
        live && live.status === 'error' ? h('div.tun-err', live.error) : null,
        live && live.status === 'online' && live.warning ? h('div.tun-warn', '⚠ ', live.warning, av.cloudflared && !av.cloudflared.path ? [' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); tunInstallHelp(); } }, 'Instalar cloudflared')] : null) : null,
        h('div.tun-acts',
          !live || live.status === 'error' ? h('button.primary.mini', { onclick: () => startTunnel(c) }, '▶ Compartir') : h('button.mini', { onclick: () => stopTunnel(c) }, '■ Detener'),
          live && live.log && live.log.length ? h('button.mini', { title: 'Últimas líneas del proveedor', onclick: () => openModal({ title: `Registro · ${c.name}`, body: h('pre.mono', { style: 'white-space:pre-wrap;font-size:11px;max-height:60vh;overflow:auto' }, live.log.join('\n')), foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cerrar')] }) }, 'Registro') : null));
    });
    const ports = (tunPorts || []).filter((p) => !state.tunnels.some((c) => c.kind === 'port' && Number(c.port) === p.port && tunLive.has(c.id)));
    return [
      section('Túneles',
        h('button.icon', { title: 'Recargar (y buscar servidores)', onclick: () => loadTunnels(true) }, '⟳'),
        h('button.primary.mini', { onclick: () => editTunnel(null) }, '+ Nuevo')),
      h('p.muted.tun-hint', 'Comparte por una URL pública lo que corre en local: un puerto (npm, bun, pnpm, php, WordPress), una IP de la red o un archivo HTML.'),
      h('div.tun-prov.muted',
        'Proveedor: ', av.cloudflared.path ? h('b', 'Cloudflare ✓') : h('span', 'localhost.run (ssh)', ' · ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); tunInstallHelp(); } }, 'instalar cloudflared'))),
      cards.length ? h('div.tun-list', cards) : h('div.empty-list', 'Sin túneles. Crea uno o comparte un servidor detectado.'),
      h('div.section-head', h('h4.grow', 'Servidores detectados'), h('button.icon', { title: 'Buscar otra vez', onclick: () => loadTunnels(true) }, '⟳')),
      tunPorts == null ? h('div.empty-list', 'Buscando…')
        : ports.length ? h('div.tun-ports', ports.map((p) => {
          const pr = tunPortProject(p);
          return h('div.tun-port',
            h('span.mono.tun-pnum', `:${p.port}`),
            h('span.tun-pdesc', { title: [p.cmd, p.cwd && `en ${p.cwd}`].filter(Boolean).join('\n') }, p.name || '—', pr ? h('span.badge.project', pr.name) : null),
            h('span.grow'),
            h('button.mini', { onclick: () => editTunnel(null, { kind: 'port', port: p.port, name: pr ? `${pr.name} :${p.port}` : `${p.name || 'localhost'} :${p.port}` }) }, 'Compartir'));
        })) : h('div.empty-list', 'No se ve ningún servidor web escuchando. Arranca tu app (npm run dev, php -S…) y pulsa ⟳.'),
    ];
  }
  /** Barra de estado: cuántos túneles están en línea (clic: ir a la pestaña). */
  function renderStatusTunnels() {
    const el = $('#st-tunnels');
    if (!el) return;
    const n = [...tunLive.values()].filter((t) => t.status === 'online').length;
    el.replaceChildren(...(n && rtabOn('tunnels') ? [h('span.st-tun', { title: 'Túneles en línea (clic: ver)', onclick: () => setRtab('tunnels') }, `🚇 ${n}`)] : []));
  }

  // ======================================================================
  // Módulos: qué partes de la UI se muestran (Ajustes → Módulos)
  // ======================================================================
  // state.modules.off = claves desactivadas (todo lo nuevo sale activado). Desactivar un módulo oculta su botón,
  // pestaña o barra y su atajo; lo que ya está abierto (una vista de Git, una terminal) sigue hasta cerrarlo.
  const MODULES = {
    left: [
      { key: 'left.sections', icon: '🗂️', name: 'Secciones de carpetas', desc: 'Barra de secciones arriba de las carpetas (Todas, Trabajo…)' },
      { key: 'left.integrations', icon: '🔌', name: 'Integraciones', desc: 'Sitios WordPress (plugin frap-wordpress) con interruptores Activa / IA y skill frap-wordpress' },
    ],
    center: [
      { key: 'center.shell', launch: 'shell', icon: '＞_', name: 'Shell', desc: 'Nueva terminal (Alt+Shift+T)' },
      { key: 'center.claude', launch: 'claude', img: 'claude', name: 'Claude Code', desc: 'Alt+Shift+C' },
      { key: 'center.codex', launch: 'codex', img: 'codex', name: 'Codex', desc: 'Alt+Shift+X' },
      { key: 'center.opencode', launch: 'opencode', img: 'opencode', name: 'opencode', desc: 'Alt+Shift+O' },
      { key: 'center.git', launch: 'git', img: 'git', name: 'Git', desc: 'Vista de git guiada (Alt+Shift+G)' },
      { key: 'center.ssh', launch: 'ssh', img: 'ssh', name: 'SSH', desc: 'Conectar a un servidor' },
      { key: 'center.sftp', launch: 'sftp', icon: '⇅', name: 'Archivos (SFTP)', desc: 'Subir y descargar (Alt+Shift+F)' },
      { key: 'center.db', launch: 'db', img: 'db', name: 'Bases de datos', desc: 'Consultas SQL (Alt+Shift+D)' },
      { key: 'center.notes', launch: 'notes', img: 'notes', name: 'Notas', desc: 'NOTES.md de la carpeta (Alt+Shift+N)' },
      { key: 'center.code', launch: 'code', img: 'code', name: 'Editor de código', desc: 'Alt+Shift+E · si se apaga, las rutas clicadas van al editor externo' },
      { key: 'center.team', icon: '👥', name: 'Equipo', desc: 'Asignar cada sesión de IA a una persona (jefe, PM, cliente…) con su rol y descripción; la IA escribe para ella (skill frap-equipo)' },
      { key: 'center.api', launch: 'api', img: 'api', name: 'API', desc: 'Alt+Shift+R · peticiones HTTP guardadas en local/api (como Postman) y la skill frap-api para las IA' },
      { key: 'center.split', icon: '⊞', name: 'Pantalla dividida', desc: 'Botón para ver hasta 4 terminales a la vez' },
    ],
    right: [
      { key: 'right.procs', rtab: 'procs', icon: '⚙️', name: 'Procesos', desc: 'Procesos de las terminales del proyecto' },
      { key: 'right.prompts', rtab: 'prompts', icon: '💬', name: 'Prompts', desc: 'Prompts guardados para enviar a la IA' },
      { key: 'right.actions', rtab: 'actions', icon: '▶️', name: 'Acciones', desc: 'Comandos con nombre que se encienden y apagan' },
      { key: 'right.pages', rtab: 'pages', icon: '🌐', name: 'Páginas', desc: 'Accesos a páginas web' },
      { key: 'right.dbs', rtab: 'dbs', icon: '🛢️', name: 'Bases de datos', desc: 'Conexiones de BD' },
      { key: 'right.ssh', rtab: 'ssh', icon: '🔐', name: 'SSH', desc: 'Servidores SSH' },
      { key: 'right.music', rtab: 'music', icon: '🎵', name: 'Música', desc: 'Reproductor (y su barra abajo)' },
      { key: 'right.timers', rtab: 'timers', icon: '⏰', name: 'Temporizador', desc: 'Recordatorios (apagado: no avisan)' },
      { key: 'right.agents', rtab: 'agents', icon: '🤖', name: 'Agentes', desc: 'Subagentes de claude/codex' },
      { key: 'right.skills', rtab: 'skills', icon: '🧩', name: 'Skills', desc: 'Skills instaladas' },
      { key: 'right.commands', rtab: 'commands', icon: '⌘', name: 'Comandos', desc: 'Comandos / de las IA' },
      { key: 'right.hooks', rtab: 'hooks', icon: '🪝', name: 'Hooks', desc: 'Hooks de claude' },
      { key: 'right.memory', rtab: 'memory', icon: '🧠', name: 'Memoria', desc: 'CLAUDE.md / AGENTS.md' },
      { key: 'right.msgs', rtab: 'msgs', icon: '✉️', name: 'Mensajes', desc: 'Mensajes que la IA redacta para personas y de pull requests: filtrar, editar, copiar (WhatsApp) y marcar enviados (skill frap-mensajes)' },
      { key: 'right.todos', rtab: 'todos', icon: '📌', name: 'Pendientes', desc: 'Cosas por hacer con prioridad, estado y dependencias, vinculadas a su sesión de IA (skill frap-pendientes)' },
      { key: 'right.tunnels', rtab: 'tunnels', icon: '🚇', name: 'Túneles', desc: 'Compartir por URL pública un puerto, una IP o un archivo' },
      { key: 'right.voice', icon: '🎤', name: 'Voz (Hablar)', desc: 'Dictado a la IA, abajo del panel (Alt+Shift+V)' },
    ],
    // funciones propias de FRAP que agregan comportamiento (no solo un botón)
    internal: [
      { key: 'internal.issues', icon: '🎫', name: 'Gestión de issues', desc: 'Issues en local/issues (fuera de git), pestaña Issues y skill frap-issues para las IA' },
      { key: 'internal.scripts', icon: '📜', name: 'Scripts', desc: 'Scripts en local/scripts con interruptores Usuario / IA, pestaña Scripts y skill frap-scripts' },
    ],
  };
  const MODULE_LIST = [...MODULES.left, ...MODULES.center, ...MODULES.right, ...MODULES.internal];
  const MODULE_PANELS = [['left', 'Panel izquierdo'], ['center', 'Panel central'], ['right', 'Panel derecho'], ['internal', 'Módulos internos']];
  const modOn = (key) => !((state.modules && state.modules.off) || []).includes(key);
  const launchOn = (kind) => modOn(`center.${kind}`);
  const RTAB_MODULE = { issues: 'internal.issues', scripts: 'internal.scripts' }; // pestañas que pertenecen a un módulo interno
  const rtabOn = (tab) => modOn(RTAB_MODULE[tab] || `right.${tab}`);
  const visibleRtabs = () => $$('#rtabs button').map((b) => b.dataset.rtab).filter(rtabOn);
  /** Atajo Alt+Shift+… → módulo que lo da (si está apagado, el atajo no hace nada). */
  const SHORTCUT_MODULE = { KeyT: 'center.shell', KeyC: 'center.claude', KeyX: 'center.codex', KeyO: 'center.opencode', KeyD: 'center.db', KeyG: 'center.git', KeyF: 'center.sftp', KeyN: 'center.notes', KeyE: 'center.code', KeyR: 'center.api', KeyV: 'right.voice', KeyM: 'right.music' };

  function setModule(key, on) {
    const off = new Set((state.modules && state.modules.off) || []);
    if (on) off.delete(key); else off.add(key);
    state.modules = { off: [...off] };
    save();
    applyModules();
  }
  /** Muestra/oculta botones, pestañas y barras según state.modules. */
  function applyModules() {
    for (const m of MODULES.center) {
      if (m.launch) { const b = $(`#launchers [data-launch="${m.launch}"]`); if (b) b.classList.toggle('hidden', !modOn(m.key)); }
    }
    $('#btn-split').classList.toggle('hidden', !modOn('center.split'));
    for (const b of $$('#rtabs button')) b.classList.toggle('hidden', !rtabOn(b.dataset.rtab));
    const tabs = visibleRtabs();
    $('#rtabs').classList.toggle('hidden', !tabs.length);
    $('#voice-dock').classList.toggle('hidden', !modOn('right.voice'));
    if (tabs.length && !tabs.includes(state.ui.rtab)) setRtab(tabs[0]); // la pestaña elegida se apagó
    else { renderRight(); updateDock(); }
    renderAll();
    syncIssuesSkill();
    syncScriptsModule();
    syncWpSkill();
    syncAveSkill();
    syncApiSkill();
    syncTeamSkill();
    loadTeam();
    syncTodosSkill();
    loadTodos();
    syncMsgsSkill();
    loadMsgs();
    renderTeamChips();
  }

  /** Modal de Módulos: tres columnas (izquierdo, central, derecho) con un switch por módulo. */
  function openModules() {
    const sw = (m) => {
      const b = h('button', { role: 'switch', class: `switch ${modOn(m.key) ? 'on' : 'off'}`, 'aria-checked': String(modOn(m.key)), 'aria-label': m.name });
      b.onclick = () => { setModule(m.key, !modOn(m.key)); refresh(); };
      return b;
    };
    const cols = h('div.mod-cols');
    const refresh = () => {
      cols.replaceChildren(...MODULE_PANELS.map(([panel, title]) => {
        const list = MODULES[panel];
        const on = list.filter((m) => modOn(m.key)).length;
        return h('div.mod-col',
          h('div.mod-head', h('h4', title), h('span.muted', `${on}/${list.length}`), h('span.grow'),
            list.length > 1 ? h('button.mini', { onclick: () => { for (const m of list) setModule(m.key, on < list.length); refresh(); } }, on < list.length ? 'Activar todo' : 'Apagar todo') : null),
          panel === 'internal' ? h('p.muted.mod-note', 'Funciones de FRAP que también cambian lo que hacen las IA (instalan o quitan su skill).') : null,
          list.map((m) => h(`label.mod-row${modOn(m.key) ? '' : '.off'}`,
            h('span.mod-ico', m.img ? h('img', { src: `vendor/icons/${m.img}.svg`, alt: '' }) : m.icon),
            h('span.mod-txt', h('span.mod-name', m.name), h('span.mod-desc.muted', m.desc)),
            sw(m))));
      }));
    };
    refresh();
    openModal({
      title: 'Módulos',
      wide: true,
      body: [
        h('p.muted', { style: 'margin:0 0 4px' }, 'Elige qué se muestra en cada panel. Todo viene activado; apagar un módulo oculta su botón o pestaña y su atajo (lo que ya está abierto sigue hasta que lo cierres). Se exporta e importa con la configuración.'),
        cols,
      ],
      foot: [
        h('button', { onclick: () => { state.modules = { off: [] }; save(); applyModules(); refresh(); } }, 'Restablecer (todo activado)'),
        h('span.grow'),
        h('button.primary', { onclick: () => modalClose(true) }, 'Listo'),
      ],
    });
  }

  // ======================================================================
  // Atajos de teclado
  // ======================================================================
  function isAppShortcut(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return false;
    if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) return true;
    return e.shiftKey && ['KeyT', 'KeyW', 'KeyB', 'KeyP', 'KeyC', 'KeyX', 'KeyO', 'KeyD', 'KeyM', 'KeyG', 'KeyF', 'KeyN', 'KeyV', 'KeyE', 'KeyR'].includes(e.code);
  }
  document.addEventListener('keydown', (e) => {
    if (!$('#alarm').classList.contains('hidden')) return; // el aviso bloqueante tiene prioridad
    if (e.key === 'Escape' && modalClose) { modalClose(); return; }
    if (!isAppShortcut(e) || modalClose) return;
    e.preventDefault();
    if (SHORTCUT_MODULE[e.code] && e.shiftKey && !modOn(SHORTCUT_MODULE[e.code])) return; // módulo apagado
    if (/^Digit/.test(e.code)) {
      const t = tabSessions()[Number(e.code.slice(5)) - 1];
      if (t) activate(t.sid);
      return;
    }
    switch (e.code) {
      case 'KeyT': launch('shell'); break;
      case 'KeyC': launch('claude'); break;
      case 'KeyX': launch('codex'); break;
      case 'KeyO': launch('opencode'); break;
      case 'KeyD': openDbView(); break;
      case 'KeyG': openGitView(); break;
      case 'KeyF': openSftpView(); break;
      case 'KeyN': openNotesView(); break;
      case 'KeyE': openCodeView(); break;
      case 'KeyR': openApiView(); break;
      case 'KeyV': voiceToggle(); break;
      case 'KeyM': togglePlay(); break;
      case 'KeyW':
        if (activeView()) closeView(activeView());
        else if (isPageView(state.activeSid)) closePageView(state.activeSid.slice(PAGE_PREFIX.length));
        else if (state.activeSid) closeTerm(state.activeSid);
        break;
      case 'KeyB': togglePanel('left'); break;
      case 'KeyP': togglePanel('right'); break;
      default: break;
    }
  }, true);

  function togglePanel(which) {
    const key = which === 'left' ? 'hideLeft' : 'hideRight';
    state.ui[key] = !state.ui[key];
    applyPanels();
    save();
    if (which === 'right' && !state.ui.hideRight) pollProcs();
  }
  function applyPanels() {
    $('#app').classList.toggle('no-left', !!state.ui.hideLeft);
    $('#app').classList.toggle('no-right', !!state.ui.hideRight);
    $('#toggle-left').textContent = state.ui.hideLeft ? '⟩' : '⟨';
    $('#toggle-right').textContent = state.ui.hideRight ? '⟨' : '⟩';
    fitAll();
  }

  // ======================================================================
  // Arranque
  // ======================================================================
  // (el ＋ para abrir carpeta está en la barra de secciones)
  // ======================================================================
  // Exportar / importar (botón ⇅ del panel izquierdo)
  // ======================================================================
  const EXPORT_FORMAT = 'frap-export';
  const RESUME = { claude: ' --continue', opencode: ' --continue' }; // codex: `codex resume --last`

  /**
   * Grupo de casillas con una casilla padre (todas/ninguna, con estado intermedio).
   * items: [{ value, label, sub?, children?: [{value, label, sub?}] }]
   * Devuelve { el, selected(): [{value, children: [values]}] }.
   */
  function checkGroup(title, items, { note } = {}) {
    const rows = [];
    const all = h('input', { type: 'checkbox' });
    all.checked = true;
    const sync = () => {
      const boxes = rows.flatMap((r) => [r.box, ...r.kids.map((k) => k.box)]);
      const n = boxes.filter((b) => b.checked).length;
      all.checked = n === boxes.length && n > 0;
      all.indeterminate = n > 0 && n < boxes.length;
    };
    const list = h('div.xp-items');
    for (const it of items) {
      const box = h('input', { type: 'checkbox' });
      box.checked = true;
      const kids = (it.children || []).map((c) => {
        const kb = h('input', { type: 'checkbox' });
        kb.checked = c.checked !== false;
        kb.addEventListener('change', () => {
          if (kb.checked) box.checked = true;
          box.indeterminate = kids.some((k) => !k.box.checked) && kids.some((k) => k.box.checked);
          sync();
        });
        return { value: c.value, box: kb, el: h('label.xp-item.xp-kid', kb, h('span', c.label), c.sub ? h('span.muted', c.sub) : null) };
      });
      box.addEventListener('change', () => { box.indeterminate = false; for (const k of kids) k.box.checked = box.checked; sync(); });
      if (kids.length && kids.some((k) => !k.box.checked)) box.indeterminate = kids.some((k) => k.box.checked);
      rows.push({ value: it.value, box, kids });
      list.append(h('label.xp-item', box, h('span', it.label), it.sub ? h('span.muted', it.sub) : null), ...kids.map((k) => k.el));
    }
    all.addEventListener('change', () => {
      for (const r of rows) { r.box.checked = all.checked; r.box.indeterminate = false; for (const k of r.kids) k.box.checked = all.checked; }
      all.indeterminate = false;
    });
    const el = h('div.xp-group',
      h('label.xp-head', all, h('span', title), h('span.muted', `(${items.length})`)),
      note ? h('div.muted.xp-note', note) : null,
      items.length ? list : h('div.muted.xp-note', 'Nada que mostrar.'));
    if (!items.length) { all.checked = false; all.disabled = true; } else sync();
    return {
      el,
      selected: () => rows.filter((r) => r.box.checked || r.box.indeterminate || r.kids.some((k) => k.box.checked))
        .map((r) => ({ value: r.value, children: r.kids.filter((k) => k.box.checked).map((k) => k.value) })),
    };
  }

  const CONFIG_PARTS = [
    { key: 'prompts', label: 'Prompts', count: (c) => (c.prompts || []).length },
    { key: 'promptCats', label: 'Categorías de prompts', count: (c) => (c.promptCats || []).length },
    { key: 'actions', label: 'Acciones', count: (c) => (c.actions || []).length },
    { key: 'pages', label: 'Páginas', count: (c) => (c.pages || []).length },
    { key: 'timers', label: 'Temporizadores', count: (c) => (c.timers || []).length },
    { key: 'tunnels', label: 'Túneles', count: (c) => (c.tunnels || []).length, sub: 'incluye sus contraseñas' },
    { key: 'modules', label: 'Módulos', count: (c) => MODULE_LIST.length - (((c.modules || {}).off) || []).length, sub: 'qué se muestra en cada panel' },
    { key: 'sections', label: 'Secciones del panel izquierdo', count: (c) => (c.sections || []).filter((s) => s.id !== 'all').length },
    { key: 'rtabs', label: 'Pestañas del panel derecho', count: (c) => Object.keys((c.rtabs || {}).custom || {}).length, sub: 'orden, íconos, títulos y descripciones' },
    { key: 'music', label: 'Música', count: (c) => ((c.music || {}).tracks || []).filter((t) => t.type === 'youtube').length, sub: 'solo enlaces de YouTube' },
    { key: 'settings', label: 'Ajustes', sub: 'fuente, editor, lanzadores de claude/codex/opencode' },
  ];

  function pickConfig(src, key) {
    if (key === 'timers') return (src.timers || []).map(({ nextAt, startedAt, ...t }) => t);
    if (key === 'music') {
      const m = src.music || {};
      return { tracks: (m.tracks || []).filter((t) => t.type === 'youtube'), loop: m.loop, shuffle: m.shuffle, volume: m.volume };
    }
    return JSON.parse(JSON.stringify(src[key]));
  }

  function openTransfer() {
    openModal({
      title: 'Exportar / importar',
      body: [
        h('p.muted', { style: 'margin:0' }, 'Lleva tus proyectos, terminales y configuración a otro equipo, o guarda una copia.'),
        h('div.xp-choice',
          h('button.xp-big', { onclick: openExport }, h('b', '⇩ Exportar'), h('span.muted', 'Elige qué llevar y descarga un archivo .json')),
          h('button.xp-big', { onclick: pickImportFile }, h('b', '⇧ Importar'), h('span.muted', 'Abre un archivo exportado y elige qué traer'))),
        h('h4', { style: 'margin:14px 0 0' }, 'Carpeta local (.zip)'),
        h('p.muted', { style: 'margin:0' }, 'La carpeta local de FRAP (issues y demás datos locales, fuera de git) en un .zip aparte.'),
        h('div.xp-choice',
          h('button.xp-big', { onclick: exportLocalZip }, h('b', '🗜 Exportar .zip'), h('span.muted', 'Descarga toda la carpeta local')),
          h('button.xp-big', { onclick: importLocalZip }, h('b', '📂 Importar .zip'), h('span.muted', 'Restaura un .zip exportado (sin pisar lo existente, salvo que lo elijas)'))),
      ],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cerrar')],
    });
  }

  async function openExport() {
    if (Bridge.ready) await Promise.all([dbInfo ? null : loadDbs(), sshInfo ? null : loadSsh(), wpInfo ? null : loadWp(), aveInfo ? null : loadAve(), teamInfo ? null : loadTeam()]);
    const projects = checkGroup('Proyectos y terminales', state.projects.map((p) => ({
      value: p.id, label: p.name, sub: p.folders.map(tilde).join(', '),
      children: sessionsOf(p.id).filter((t) => termKind(t) !== 'action').map((t) => ({ value: t.sid, label: termTitle(t), sub: termKind(t) })),
    })), { note: 'Al importar se pueden reabrir las terminales y retomar la última conversación de cada IA en esa carpeta.' });
    const config = checkGroup('Configuración', CONFIG_PARTS.map((c) => ({
      value: c.key, label: c.count ? `${c.label} (${c.count(state)})` : c.label, sub: c.sub,
    })));
    const dbs = checkGroup('Bases de datos', ((dbInfo && dbInfo.conns) || []).map((c) => ({ value: c.id, label: c.name, sub: dbTarget(c) })));
    const sshs = checkGroup('SSH', ((sshInfo && sshInfo.hosts) || []).map((c) => ({ value: c.id, label: c.name, sub: sshTarget(c) })));
    const wps = checkGroup('Integraciones · WordPress', ((wpInfo && wpInfo.sites) || []).map((c) => ({ value: c.id, label: c.name, sub: c.url })),
      { note: 'URL, interruptores Activa / IA y, con la clave de abajo, el token cifrado.' });
    const aves = checkGroup('Integraciones · Aveonline', ((aveInfo && aveInfo.sites) || []).map((c) => ({ value: c.id, label: c.name, sub: c.url })),
      { note: 'URL e interruptores; el token (dura minutos) solo cifrado con la clave. Lo normal es pegar uno nuevo al importar.' });
    const teamGroup = checkGroup('Equipo', ((teamInfo && teamInfo.people) || []).map((x) => ({ value: x.id, label: `${x.icon || '👤'} ${x.name}`, sub: x.role })),
      { note: 'Personas con su rol, ícono, color y descripción. Cada terminal exportada lleva además a quién está asignada.' });
    const withPw = h('input', { type: 'checkbox' });
    withPw.checked = true;
    const pass1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'clave para cifrar (mín. 6)' });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'repite la clave' });
    const passRow = h('div.field-row', h('span.grow', pass1), h('span.grow', pass2));
    withPw.addEventListener('change', () => passRow.classList.toggle('hidden', !withPw.checked));
    const credsBox = h('div.xp-group',
      h('label.xp-head', withPw, h('span', 'Incluir contraseñas de BD y SSH y tokens de WordPress y Aveonline, cifrados')),
      h('div.muted.xp-note', 'Se cifran con esta clave (AES-256-GCM); te la pedirá al importar. Sin ellos, tendrás que escribirlos de nuevo.'),
      passRow);

    const doExport = async () => {
      const selDb = dbs.selected().map((x) => x.value);
      const selSsh = sshs.selected().map((x) => x.value);
      const selWp = wps.selected().map((x) => x.value);
      const selAve = aves.selected().map((x) => x.value);
      const out = { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), from: (Bridge.info && Bridge.info.hostname) || '' };
      out.projects = projects.selected().map(({ value, children }) => {
        const p = project(value);
        return {
          id: p.id, name: p.name, folders: p.folders.slice(),
          terminals: children.map((sid) => terms.get(sid)).filter(Boolean).map((t) => {
            const m = t.info.meta || {};
            return { kind: termKind(t), title: termTitle(t), cwd: m.cwd || p.folders[0], ...(m.named ? { named: true } : {}), ...(m.sshId ? { sshId: m.sshId } : {}), ...(m.agent && m.agent.session ? { agent: m.agent } : {}), ...(m.person ? { person: m.person } : {}), ...(m.icon ? { icon: m.icon } : {}) };
          }),
        };
      });
      out.config = {};
      for (const { value } of config.selected()) out.config[value] = pickConfig(state, value);
      const selTeam = new Set(teamGroup.selected().map((x) => x.value));
      if (selTeam.size) out.team = ((teamInfo && teamInfo.people) || []).filter((x) => selTeam.has(x.id)).map(({ id, name, icon, role, descripcion, color }) => ({ id, name, icon, role, descripcion, color }));
      if (selDb.length || selSsh.length || selWp.length || selAve.length) {
        if (!Bridge.ready) { toast('Bridge desconectado: no se pueden exportar BD, SSH ni integraciones', 'err'); return; }
        let passphrase = '';
        if (withPw.checked) {
          if (pass1.value.length < 6) { toast('La clave de cifrado debe tener al menos 6 caracteres', 'err'); pass1.focus(); return; }
          if (pass1.value !== pass2.value) { toast('Las claves no coinciden', 'err'); pass2.focus(); return; }
          passphrase = pass1.value;
        }
        try { Object.assign(out, await Bridge.call('export.creds', { db: selDb, ssh: selSsh, wp: selWp, ave: selAve, passphrase })); } catch (e) { toast(e.message, 'err'); return; }
      }
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `frap-export-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      modalClose(true);
      const nTerms = out.projects.reduce((n, p) => n + p.terminals.length, 0);
      toast(`Exportado: ${out.projects.length} proyecto(s), ${nTerms} terminal(es), ${(out.team || []).length} persona(s) del equipo, ${Object.keys(out.config).length} sección(es) de configuración, ${(out.db || []).length} BD, ${(out.ssh || []).length} SSH, ${((out.integrations || {}).wordpress || []).length} WordPress, ${((out.integrations || {}).aveonline || []).length} Aveonline${out.secrets ? ' (contraseñas y tokens cifrados)' : ''}`, 'ok');
    };
    openModal({
      title: 'Exportar',
      wide: true,
      body: h('div.xp-cols',
        h('div.xp-col', h('h4', 'Panel izquierdo'), projects.el, teamGroup.el, wps.el, aves.el),
        h('div.xp-col', h('h4', 'Panel derecho'), config.el, dbs.el, sshs.el, credsBox)),
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doExport }, '⇩ Exportar')],
    });
  }

  function pickImportFile() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch (_) { toast('El archivo no es un JSON válido', 'err'); return; }
      if (!data || data.format !== EXPORT_FORMAT) { toast('Este archivo no es una exportación de FRAP', 'err'); return; }
      openImport(data, f.name);
    });
    input.click();
  }

  function openImport(data, fileName) {
    const projs = Array.isArray(data.projects) ? data.projects.filter((p) => p && p.id && Array.isArray(p.folders)) : [];
    const cfg = data.config && typeof data.config === 'object' ? data.config : {};
    const projects = checkGroup('Proyectos y terminales', projs.map((p) => ({
      value: p.id, label: `${p.name}${project(p.id) ? ' (reemplaza)' : ''}`, sub: p.folders.map(tilde).join(', '),
      children: (() => {
        const used = new Set();
        return (p.terminals || []).map((t, i) => {
          const open = termOpenMatch(t, used);
          return { value: i, label: `${t.title || t.kind}${open ? ' · ya abierta' : ''}`, sub: t.kind, checked: !open };
        });
      })(),
    })));
    const config = checkGroup('Configuración', CONFIG_PARTS.filter((c) => cfg[c.key] != null).map((c) => ({
      value: c.key, label: c.count ? `${c.label} (${c.count(cfg)})` : c.label, sub: c.key === 'settings' ? 'reemplaza tus ajustes' : 'se agrega; mismo id se reemplaza',
    })));
    const dbs = checkGroup('Bases de datos', (data.db || []).map((c) => ({ value: c.id, label: c.name, sub: c.engine === 'sqlite' ? c.database : `${c.user}@${c.host}` })));
    const sshs = checkGroup('SSH', (data.ssh || []).map((c) => ({ value: c.id, label: c.name, sub: `${c.user}@${c.host}` })));
    const inWp = ((data.integrations || {}).wordpress || []).filter((c) => c && c.id);
    const wps = checkGroup('Integraciones · WordPress', inWp.map((c) => ({ value: c.id, label: c.name, sub: c.url })),
      { note: data.secrets ? 'El token viene cifrado: escribe la clave abajo.' : 'Sin token en el archivo: se conserva el que ya tengas o lo agregas en Editar.' });
    const inTeam = (Array.isArray(data.team) ? data.team : []).filter((x) => x && x.id && x.name);
    const teamGroup = checkGroup('Equipo', inTeam.map((x) => ({ value: x.id, label: `${x.icon || '👤'} ${x.name}`, sub: x.role })),
      { note: 'Mismo id = se reemplaza. Las terminales que se reabran vuelven asignadas a su persona.' });
    const inAve = ((data.integrations || {}).aveonline || []).filter((c) => c && c.id);
    const aves = checkGroup('Integraciones · Aveonline', inAve.map((c) => ({ value: c.id, label: c.name, sub: c.url })),
      { note: 'Los tokens de Aveonline duran minutos: lo normal es pegar uno nuevo (📋) después de importar.' });
    const openTerms = h('input', { type: 'checkbox' });
    openTerms.checked = true;
    const resume = h('input', { type: 'checkbox' });
    resume.checked = true;
    const pass = h('input', { type: 'password', autocomplete: 'off', placeholder: 'clave con la que se exportó' });
    const termOpts = h('div.xp-group',
      h('label.xp-head', openTerms, h('span', 'Abrir las terminales al importar')),
      h('label.xp-item', resume, h('span', 'Retomar la conversación de cada terminal'), h('span.muted', 'claude --resume <la de esa terminal> · codex resume --last · opencode --continue')),
      h('div.muted.xp-note', 'Las conversaciones viven en cada equipo (~/.claude, ~/.codex…): en otro equipo, la IA empieza de cero si no tiene historial en esa carpeta.'));
    const secretsBox = data.secrets ? h('div.xp-group',
      h('div.xp-head', h('span', '🔒 Contraseñas y tokens cifrados')),
      h('div.muted.xp-note', 'Escribe la clave de la exportación. Si la dejas vacía, se importan sin contraseña.'),
      pass) : null;

    const doImport = async () => {
      const selDb = new Set(dbs.selected().map((x) => x.value));
      const selSsh = new Set(sshs.selected().map((x) => x.value));
      const selWp = new Set(wps.selected().map((x) => x.value));
      const selAve = new Set(aves.selected().map((x) => x.value));
      const report = [];
      // equipo primero: así las terminales que se reabren encuentran a su persona
      const selTeam = new Set(teamGroup.selected().map((x) => x.value));
      if (selTeam.size) {
        if (!Bridge.ready) { toast('Bridge desconectado: no se puede importar el equipo', 'err'); return; }
        try {
          const r = await Bridge.call('team.import', { people: inTeam.filter((x) => selTeam.has(x.id)) });
          report.push(`${r.added + r.replaced} persona(s) del equipo`);
          await loadTeam();
        } catch (e) { toast(e.message, 'err'); return; }
      }
      if (selDb.size || selSsh.size || selWp.size || selAve.size) {
        if (!Bridge.ready) { toast('Bridge desconectado: no se pueden importar BD, SSH ni integraciones', 'err'); return; }
        try {
          const r = await Bridge.call('import.creds', {
            db: (data.db || []).filter((c) => selDb.has(c.id)),
            ssh: (data.ssh || []).filter((c) => selSsh.has(c.id)),
            wp: inWp.filter((c) => selWp.has(c.id)),
            ave: inAve.filter((c) => selAve.has(c.id)),
            secrets: data.secrets, passphrase: pass.value,
          });
          if (r.db) report.push(`${r.db} BD`);
          if (r.ssh) report.push(`${r.ssh} SSH`);
          if (r.wp) { report.push(`${r.wp} WordPress`); wpChecks.clear(); }
          if (r.ave) { report.push(`${r.ave} Aveonline`); aveChecks.clear(); }
          if (r.errors.length) toast(r.errors.join('\n'), 'err');
        } catch (e) { toast(e.message, 'err'); pass.focus(); return; }
      }
      // configuración: se agrega por id (mismo id = se reemplaza)
      const mergeById = (cur, inc) => {
        const byId = new Map(cur.map((x) => [x.id, x]));
        for (const x of inc || []) if (x && x.id) byId.set(x.id, x);
        return [...byId.values()];
      };
      for (const { value: key } of config.selected()) {
        const v = cfg[key];
        if (key === 'settings') {
          state.settings = { ...state.settings, ...v, launchers: { ...state.settings.launchers, ...(v.launchers || {}) } };
        } else if (key === 'music') {
          const have = new Set(state.music.tracks.filter((t) => t.type === 'youtube').map((t) => t.videoId));
          for (const t of v.tracks || []) if (t.videoId && !have.has(t.videoId)) state.music.tracks.push({ ...t, id: uid() });
          for (const k of ['loop', 'shuffle', 'volume']) if (v[k] != null) state.music[k] = v[k];
        } else if (key === 'timers') {
          state.timers = mergeById(state.timers, v);
          for (const t of state.timers) if (t.enabled && !t.nextAt) startTimer(t);
        } else if (key === 'modules') {
          state.modules = { off: Array.isArray((v || {}).off) ? v.off.filter((k) => typeof k === 'string') : [] };
          applyModules();
        } else if (key === 'rtabs') {
          const custom = {};
          for (const [t, c] of Object.entries((v && v.custom) || {})) if (c && typeof c === 'object') custom[t] = { ...(typeof c.icon === 'string' ? { icon: c.icon.slice(0, 8) } : {}), ...(typeof c.title === 'string' ? { title: c.title.slice(0, 40) } : {}), ...(typeof c.desc === 'string' ? { desc: c.desc.slice(0, 300) } : {}) };
          state.rtabs = { order: Array.isArray((v || {}).order) ? v.order.filter((t) => typeof t === 'string') : [], custom };
          renderRtabs();
        } else if (Array.isArray(v)) {
          state[key] = mergeById(state[key], v);
        }
        report.push(CONFIG_PARTS.find((c) => c.key === key).label.toLowerCase());
      }
      // proyectos
      const chosen = projects.selected().map(({ value, children }) => {
        const p = projs.find((x) => x.id === value);
        return { p, terminals: children.map((i) => (p.terminals || [])[i]).filter(Boolean) };
      });
      for (const { p } of chosen) {
        const cur = project(p.id);
        if (cur) { cur.name = p.name; cur.folders = p.folders.slice(); } else state.projects.push({ id: p.id, name: p.name, folders: p.folders.slice() });
      }
      if (chosen.length) report.unshift(`${chosen.length} proyecto(s)`);
      if (chosen.length && !project()) state.activeProject = chosen[0].p.id;
      save();
      modalClose(true);
      renderAll();
      renderRight();
      loadDbs();
      loadWp(true);
      loadAve(true);
      await loadSsh();
      toast(`Importado de ${fileName}: ${report.join(', ') || 'nada'}`, 'ok');
      if (openTerms.checked) await reopenTerminals(chosen, resume.checked);
    };
    openModal({
      title: `Importar · ${fileName}`,
      wide: true,
      body: [
        h('p.muted', { style: 'margin:0' }, `Exportado ${data.exportedAt ? new Date(data.exportedAt).toLocaleString() : ''}${data.from ? ' desde ' + data.from : ''}. Lo que ya existe con el mismo id se reemplaza.`),
        h('div.xp-cols',
          h('div.xp-col', h('h4', 'Panel izquierdo'), projects.el, termOpts, teamGroup.el, wps.el, aves.el),
          h('div.xp-col', h('h4', 'Panel derecho'), config.el, dbs.el, sshs.el, secretsBox)),
      ],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doImport }, '⇧ Importar')],
    });
  }

  /**
   * Terminal abierta que corresponde a una exportada o de la foto: la misma conversación de claude (agent.session) o,
   * sin conversación, el mismo tipo, carpeta y nombre (y servidor si es ssh). `used`: las ya emparejadas (no se repiten).
   */
  function termOpenMatch(t, used = new Set()) {
    const live = [...terms.values()].filter((x) => x.info.alive !== false && !used.has(x.sid) && termKind(x) !== 'action');
    const conv = t.agent && t.agent.session;
    let hit = conv ? live.find((x) => ((x.info.meta || {}).agent || {}).session === conv) : null;
    if (!hit && !conv) {
      hit = live.find((x) => {
        const m = x.info.meta || {};
        return termKind(x) === t.kind && (m.cwd || '') === (t.cwd || '') && (t.kind !== 'ssh' || m.sshId === t.sshId)
          && (!t.named || (m.named && m.title === t.title));
      });
    }
    if (hit) used.add(hit.sid);
    return hit || null;
  }
  /** Reabre las terminales importadas; las IA pueden retomar su última conversación. */
  async function reopenTerminals(chosen, resume) {
    if (!Bridge.ready) return;
    const prev = state.activeProject;
    let skipped = 0;
    for (const { p, terminals } of chosen) {
      state.activeProject = p.id;
      for (const t of terminals) {
        // la misma conversación de IA ya abierta: no se duplica (dos claude sobre la misma conversación se pisan)
        if (t.agent && t.agent.session && termOpenMatch(t)) { skipped++; continue; }
        if (t.kind === 'ssh') {
          if (t.sshId && sshInfo && sshInfo.hosts.some((x) => x.id === t.sshId && x.enabled)) await connectSsh(t.sshId);
          continue;
        }
        const proj = project(p.id);
        let init;
        const claudeId = t.agent && t.agent.tool === 'claude' && /^[0-9a-f-]{36}$/i.test(t.agent.session || '') ? t.agent.session : null;
        // cada terminal retoma SU conversación de claude (con --continue todas abrían la última de la carpeta)
        if (resume && claudeId) init = `${t.kind === 'claude' ? buildLaunch('claude', proj) : (state.settings.launchers.claude || { cmd: 'claude' }).cmd} --resume ${claudeId}`;
        else if (resume && t.kind === 'codex') init = `${(state.settings.launchers.codex || { cmd: 'codex' }).cmd} resume --last`;
        else if (resume && RESUME[t.kind]) init = buildLaunch(t.kind, proj) + RESUME[t.kind];
        await launch(['shell', 'claude', 'codex', 'opencode'].includes(t.kind) ? t.kind : 'shell', { title: t.title, cwd: t.cwd, init, named: t.named, person: t.person, icon: t.icon });
      }
    }
    if (prev && project(prev)) state.activeProject = prev;
    save();
    renderAll();
    if (skipped) toast(`${skipped} terminal(es) ya estaban abiertas con su conversación: no se duplicaron`, 'ok');
  }

  $('#btn-settings').onclick = openSettings;
  $('#btn-transfer').onclick = openTransfer;
  $('#btn-split').onclick = cycleSplit;
  $('#toggle-left').onclick = () => togglePanel('left');
  $('#toggle-right').onclick = () => togglePanel('right');
  for (const b of $$('#launchers button')) b.onclick = () => (b.dataset.launch === 'db' ? openDbView() : b.dataset.launch === 'git' ? openGitView() : b.dataset.launch === 'ssh' ? pickSsh() : b.dataset.launch === 'sftp' ? openSftpView() : b.dataset.launch === 'notes' ? openNotesView() : b.dataset.launch === 'code' ? openCodeView() : b.dataset.launch === 'api' ? openApiView() : launch(b.dataset.launch));
  // ----- pestañas del panel derecho: ícono, título y descripción editables (doble clic) y orden arrastrando -----
  const RTAB_EXTRA = { issues: { icon: '🎫', desc: 'Issues locales (Linear u otro tracker)' }, scripts: { icon: '📜', desc: 'Scripts locales con interruptores Usuario / IA' } };
  for (const [i, b] of $$('#rtabs button').entries()) { b.dataset.label = b.textContent.trim(); b.dataset.idx = String(i); }
  /** Ícono, título y descripción de una pestaña: los propios del usuario o los de su módulo. */
  function rtabInfo(tab) {
    const b = $(`#rtabs button[data-rtab="${tab}"]`);
    const mod = MODULE_LIST.find((m) => m.rtab === tab) || {};
    const def = { icon: mod.icon || (RTAB_EXTRA[tab] || {}).icon || '•', title: (b && b.dataset.label) || tab, desc: mod.desc || (RTAB_EXTRA[tab] || {}).desc || '' };
    const c = (state.rtabs.custom || {})[tab] || {};
    return { icon: c.icon != null && c.icon !== '' ? c.icon : def.icon, title: c.title || def.title, desc: c.desc != null ? c.desc : def.desc, def, custom: !!state.rtabs.custom[tab] };
  }
  function renderRtabs() {
    const nav = $('#rtabs');
    const btns = [...nav.querySelectorAll('button')];
    const order = state.rtabs.order || [];
    const rank = (b) => { const i = order.indexOf(b.dataset.rtab); return i < 0 ? 1000 + Number(b.dataset.idx) : i; };
    nav.append(...btns.sort((a, b) => rank(a) - rank(b)));
    for (const b of btns) {
      const d = rtabInfo(b.dataset.rtab);
      b.replaceChildren(h('span.rt-ico', d.icon), h('span.rt-label', d.title));
      b.title = `${d.desc ? `${d.desc}\n` : ''}Doble clic: editar ícono, título y descripción · arrastra para ordenar`;
    }
  }
  let rtabDrag = null;
  for (const b of $$('#rtabs button')) {
    b.onclick = () => setRtab(b.dataset.rtab);
    b.draggable = true;
    b.addEventListener('dblclick', () => rtabEditModal(b.dataset.rtab));
    b.addEventListener('dragstart', (e) => { rtabDrag = b.dataset.rtab; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-frap-rtab', rtabDrag); b.classList.add('dragging'); });
    b.addEventListener('dragend', () => { rtabDrag = null; for (const x of $$('#rtabs button')) x.classList.remove('dragging', 'drop-before', 'drop-after'); });
    b.addEventListener('dragover', (e) => {
      if (!rtabDrag || rtabDrag === b.dataset.rtab) return;
      e.preventDefault();
      const r = b.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      for (const x of $$('#rtabs button')) x.classList.remove('drop-before', 'drop-after');
      b.classList.add(after ? 'drop-after' : 'drop-before');
    });
    b.addEventListener('dragleave', () => b.classList.remove('drop-before', 'drop-after'));
    b.addEventListener('drop', (e) => {
      if (!rtabDrag || rtabDrag === b.dataset.rtab) return;
      e.preventDefault();
      const after = b.classList.contains('drop-after');
      const cur = [...$$('#rtabs button')].map((x) => x.dataset.rtab).filter((t) => t !== rtabDrag);
      cur.splice(cur.indexOf(b.dataset.rtab) + (after ? 1 : 0), 0, rtabDrag);
      state.rtabs.order = cur;
      save();
      renderRtabs();
    });
  }
  function rtabEditModal(tab) {
    const d = rtabInfo(tab);
    const icon = h('input.team-icon-in', { value: d.icon, maxlength: '8' });
    const title = h('input', { value: d.title, placeholder: d.def.title });
    const desc = h('textarea.team-desc', { rows: '3', placeholder: d.def.desc || 'Para qué la usas (se ve al pasar el ratón)' });
    desc.value = d.desc;
    const picks = h('div.icon-grid', [...new Set([d.def.icon, ...SECTION_ICONS, '⚙️', '💬', '▶️', '🛢️', '🔐', '🎵', '⏰', '🧩', '⌘', '🪝', '🧠', '🚇', '🎫', '📜', '📌', '📊', '📝', '✅'])].map((ic) => h('button.icon-pick', { type: 'button', onclick: () => { icon.value = ic; } }, ic)));
    const doSave = () => {
      const c = {};
      if (icon.value.trim() && icon.value.trim() !== d.def.icon) c.icon = icon.value.trim();
      if (title.value.trim() && title.value.trim() !== d.def.title) c.title = title.value.trim().slice(0, 40);
      if (desc.value !== d.def.desc) c.desc = desc.value.slice(0, 300);
      if (Object.keys(c).length) state.rtabs.custom[tab] = c; else delete state.rtabs.custom[tab];
      save();
      renderRtabs();
      modalClose(true);
    };
    openModal({
      title: `Pestaña · ${d.title}`,
      body: [
        h('div.field-row', h('div.field', { style: 'width:80px' }, h('label', 'Ícono'), icon), h('div.field.grow', h('label', 'Título'), title)),
        picks,
        h('div.field', h('label', 'Descripción'), desc),
        h('p.muted', { style: 'font-size:11px;margin:4px 0 0' }, 'Arrastra las pestañas para cambiar el orden. Todo se guarda y viaja en el export .json (Configuración → Pestañas del panel derecho).'),
      ],
      foot: [d.custom ? h('button', { onclick: () => { delete state.rtabs.custom[tab]; save(); renderRtabs(); modalClose(true); } }, 'Restablecer') : null, h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
    requestAnimationFrame(() => title.select());
  }
  renderRtabs();
  $('#token-input').value = conn.token;
  $('#port-input').value = conn.port;
  const bridgePath = decodeURIComponent(location.pathname).replace(/\/src\/index\.html$/, '/bridge/frap-bridge.js');
  if (location.protocol === 'file:') $('#bridge-cmd').textContent = `node ${bridgePath}`;
  $('#token-save').onclick = () => {
    conn.token = $('#token-input').value.trim();
    conn.port = Number($('#port-input').value) || 7681;
    storeSet('frap.conn', conn);
    Bridge.connect();
  };
  $('#token-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#token-save').click(); });

  Bridge.on('open', async () => {
    // El estado del bridge (~/.config/frap/state.json) gana si es más reciente que el local.
    try {
      const remote = await Bridge.call('state.get');
      if (remote && (remote.savedAt || 0) > (state.savedAt || 0)) {
        state = mergeState(DEFAULT_STATE(), remote);
        bound = { git: null, db: null, sftp: null, notes: null, code: null }; // las vistas se vuelven a enlazar con los datos nuevos
        storeSet('frap.state', state);
        applyPanels();
        for (const b of $$('#rtabs button')) b.classList.toggle('active', b.dataset.rtab === state.ui.rtab);
        applyModules();
      } else if (!remote || (remote.savedAt || 0) < (state.savedAt || 0)) {
        save();
      }
    } catch (_) { /* sin estado remoto */ }
    await syncSessions(true);
    restoreChecked = false; // en cada (re)conexión: ¿se perdieron terminales? (equipo apagado/reiniciado)
    checkRestore();
    tickTimers();
    loadConfig(true);
    loadDbs();
    loadSsh().then(() => { if (sftpPane && !sftpPane.local.path) sftpInitial(); }); // vista Archivos restaurada al recargar: aún sin cargar
    pollProcs();
    syncIssuesSkill(true);
    syncScriptsModule(true);
    syncWpSkill(true);
    loadWp(true);
    syncAveSkill(true);
    loadAve(true);
    syncApiSkill(true);
    syncTeamSkill(true);
    loadTeam();
    syncTodosSkill(true);
    loadTodos();
    syncMsgsSkill(true);
    msgsInfo = null;
    loadMsgs();
    apiInfo = null;
    if (apiPane) { // al (re)conectar: lo que no pudo cargarse sin bridge
      for (const [k, d] of [...apiPane.docs]) if (d.error || d.loading) apiPane.docs.delete(k);
      apiLoadTree();
      apiRenderEditor();
    }
    loadIssues();
    loadScripts();
    loadTunnels(state.ui.rtab === 'tunnels');
    renderRight();
  });
  Bridge.on('close', () => { tunLive.clear(); renderStatusTunnels(); renderAll(); }); // sin bridge no hay túneles
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollProcs(); });

  applyPanels();
  for (const b of $$('#rtabs button')) b.classList.toggle('active', b.dataset.rtab === state.ui.rtab);
  applyModules();
  updateDock();
  renderAll();
  renderRight();
  Bridge.connect();
})();
