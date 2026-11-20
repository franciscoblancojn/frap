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
  const DEFAULT_PROMPTS = [
    { title: 'Explicar proyecto', body: 'Explícame la estructura de este proyecto, sus partes principales y cómo se ejecuta.' },
    { title: 'Revisar cambios', body: 'Revisa los cambios sin commitear (git diff) y señala bugs, riesgos y mejoras concretas.' },
    { title: 'Escribir tests', body: 'Escribe tests para el código modificado recientemente y ejecútalos.' },
    { title: 'Commit', body: 'Crea un commit con un mensaje claro que describa los cambios actuales.' },
  ];
  const DEFAULT_STATE = () => ({
    v: 1,
    savedAt: 0,
    projects: [],
    activeProject: null,
    activeSid: null,
    prompts: DEFAULT_PROMPTS.map((p) => ({ id: uid(), ...p })),
    actions: [], // {id, name, cmd, cwd, ready} comandos con nombre que se encienden/apagan
    pages: [], // {id, name, url, mode: 'default'|'tab'|'iframe'} accesos a páginas web
    openPages: [], // ids de páginas abiertas como pestaña interna (iframe)
    db: { open: false, connId: null, sql: '', limit: 500, history: [] }, // pestaña DB del panel central
    // música: tracks = [{id, type: 'file'|'youtube', title, videoId?, duration?}]; los archivos viven en IndexedDB
    music: { tracks: [], current: null, loop: 'all', shuffle: false, volume: 80 },
    git: { open: false, repo: null, tab: 'diff' }, // pestaña Git del panel central
    // temporizadores: [{id, icon, title, desc, kind: 'repeat'|'once', every (seg), mode: 'toast'|'modal', sound, enabled, nextAt, startedAt}]
    timers: [],
    settings: {
      fontSize: 13,
      editor: 'code', // comando para abrir archivos clicados en la terminal (VS Code)
      pageMode: 'tab', // cómo se abren las páginas por defecto: 'tab' (navegador) | 'iframe' (pestaña interna)
      launchers: {
        claude: { cmd: 'claude', addDir: '--add-dir' },
        codex: { cmd: 'codex', addDir: '--add-dir' },
        opencode: { cmd: 'opencode', addDir: '' },
      },
    },
    ui: { rtab: 'procs', hideLeft: false, hideRight: false, procsAll: false, split: 1 }, // split: 1-4 terminales a la vez
  });

  function mergeState(base, saved) {
    if (!saved || typeof saved !== 'object') return base;
    return {
      ...base,
      ...saved,
      settings: {
        ...base.settings,
        ...(saved.settings || {}),
        launchers: { ...base.settings.launchers, ...((saved.settings || {}).launchers || {}) },
      },
      ui: { ...base.ui, ...(saved.ui || {}) },
      db: { ...base.db, ...(saved.db || {}) },
      music: { ...base.music, ...(saved.music || {}) },
      git: { ...base.git, ...(saved.git || {}) },
    };
  }

  let state = mergeState(DEFAULT_STATE(), storeGet('frap.state', null));

  // localStorage se escribe al instante (recargar justo después de un cambio no lo pierde);
  // la copia en el bridge (~/.config/frap/state.json) va con debounce.
  const persistRemote = debounce(() => {
    if (Bridge.ready) Bridge.call('state.set', { state }).catch(() => {});
  }, 300);
  function save() {
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
  const REQUIRED_OPS = ['session.create', 'session.seen', 'config.scan', 'db.list', 'db.save', 'db.toggle', 'db.query', 'ssh.list', 'ssh.save', 'ssh.toggle', 'ssh.connect', 'export.creds', 'import.creds', 'git.run', 'music.ytInfo', 'paths.check', 'open.editor'];
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
    return t;
  }

  async function attach(t) {
    t.attaching = true;
    try {
      const res = await Bridge.call('session.attach', { sid: t.sid });
      t.term.reset();
      if (res.buffer) t.term.write(res.buffer);
      t.info = { ...t.info, ...res };
      if (res.buffer) actionScan(t, res.buffer, true);
      if (!res.alive) t.term.write('\r\n\x1b[2m[proceso terminado]\x1b[0m\r\n');
    } catch (e) {
      t.term.write(`\r\n\x1b[31m[frap] ${e.message}\x1b[0m\r\n`);
    }
    t.attaching = false;
    sendResize(t);
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
  new ResizeObserver(fitAll).observe($('#term-host'));

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
      t.term.write(d); // durante attach el buffer ya trae esta salida
      actionScan(t, d, false);
    }
  });
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
    if (state.activeSid && !isViewSid(state.activeSid) && !terms.has(state.activeSid)) state.activeSid = null;
    if (!state.activeSid) {
      const first = sessionsOf(state.activeProject)[0];
      if (first) state.activeSid = first.sid;
    }
    renderAll();
  }

  function sessionsOf(projectId) {
    return [...terms.values()]
      .filter((t) => (t.info.meta || {}).projectId === projectId)
      .sort((a, b) => a.info.created - b.info.created);
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
  const termTitle = (t) => t.liveTitle || (t.info.meta || {}).title || t.sid;
  const termKind = (t) => (t.info.meta || {}).kind || 'shell';

  function activeTerm() { return terms.get(state.activeSid) || null; }

  function activate(sid) {
    const t = terms.get(sid);
    if (!t) return;
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
        meta: { projectId: p.id, kind, title: opts.title || (n > 1 ? `${kind} ${n}` : kind) },
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
    await launch(meta.kind || 'shell', { title: meta.title, cwd: meta.cwd });
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

  async function renameTerm(sid) {
    const t = terms.get(sid);
    if (!t) return;
    const name = await askText('Renombrar terminal', 'Nombre', (t.info.meta || {}).title || '');
    if (!name) return;
    t.liveTitle = '';
    try {
      const info = await Bridge.call('session.meta', { sid, meta: { title: name } });
      t.info.meta = info.meta;
    } catch (e) { toast(e.message, 'err'); }
    renderAll();
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
  // Rutas clicables en la terminal: clic = abrir en el editor (VS Code)
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
                openInEditor(f.path, c.line, c.col);
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
  if (storeGet('frap.debug', false)) window.__frap = { terms, logicalLine, pathCandidates, resolvePaths };

  const editorName = () => {
    const e = basename((state.settings.editor || 'code').split(/\s+/)[0]);
    return { code: 'VS Code', 'code-insiders': 'VS Code Insiders', codium: 'VSCodium', cursor: 'Cursor', windsurf: 'Windsurf' }[e] || e;
  };
  async function openInEditor(p, line, col) {
    try {
      await Bridge.call('open.editor', { path: p, line, col, editor: state.settings.editor || 'code' });
      toast(`Abriendo ${basename(p)}${line ? ':' + line : ''} en ${editorName()}`, 'ok');
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
  async function renameProject(p) {
    const name = await askText('Renombrar proyecto', 'Nombre', p.name);
    if (!name) return;
    p.name = name;
    save();
    renderAll();
  }
  async function deleteProject(p) {
    const live = sessionsOf(p.id);
    const ok = await confirmBox(
      `¿Eliminar el proyecto "${p.name}"?`,
      live.length ? `Se cerrarán ${live.length} terminal(es). Las carpetas no se tocan.` : 'Las carpetas no se tocan.'
    );
    if (!ok) return;
    for (const t of live) await closeTerm(t.sid);
    state.projects = state.projects.filter((x) => x.id !== p.id);
    if (state.activeProject === p.id) {
      state.activeProject = state.projects[0] ? state.projects[0].id : null;
      state.activeSid = null;
    }
    save();
    renderAll();
    loadConfig(true);
  }
  function selectProject(id) {
    if (state.activeProject === id) return;
    state.activeProject = id;
    const list = sessionsOf(id);
    const group = splitGroup();
    state.activeSid = group.length ? group[0].sid : list.length ? list[list.length - 1].sid : null;
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

  /** slot = posición (0-3) en la pantalla dividida, o undefined si no está agrupada. */
  function termItem(t, slot) {
    const grouped = slot != null;
    return h('div.term-item', {
      class: `term-item${t.sid === state.activeSid ? ' active' : ''}${grouped ? ' grouped' : ''}`,
      dataset: { sid: t.sid },
      title: (t.info.meta || {}).cwd || '',
      onclick: () => activate(t.sid),
      ondblclick: () => renameTerm(t.sid),
    },
    h('span', { class: dotClass(t) }),
    grouped ? h('span.slot', { title: `Pantalla dividida: panel ${slot + 1}` }, String(slot + 1)) : null,
    h('span.tname', termTitle(t)),
    noticeBadge(t),
    kindIcon(termKind(t)) || h(`span.kind.${termKind(t)}`, termKind(t)));
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

  function renderProjects() {
    const root = $('#projects');
    root.replaceChildren();
    if (!state.projects.length) {
      root.append(h('div.empty-list', 'Sin proyectos. Pulsa ＋ para agregar una carpeta.'));
    }
    const slots = splitSlots();
    for (const p of state.projects) {
      const active = p.id === state.activeProject;
      const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
      root.append(h(`div.project${active ? '.active' : ''}`,
        h('div.project-head', { onclick: () => selectProject(p.id), ondblclick: () => renameProject(p) },
          h('span.pname.grow', { title: p.folders.join('\n') }, p.name),
          h('span.acts',
            h('button.icon', { title: 'Agregar carpeta', onclick: stop(() => addFolder(p)) }, '⊕'),
            h('button.icon', { title: 'Renombrar', onclick: stop(() => renameProject(p)) }, '✎'),
            h('button.icon', { title: 'Eliminar proyecto', onclick: stop(() => deleteProject(p)) }, '✕'))),
        active && h('div.folders', p.folders.map((f, i) =>
          h('div.folder', { title: f },
            h('span', (i === 0 ? '▸ ' : '+ ') + tilde(f)),
            h('button.icon.mini', { title: 'Quitar carpeta', onclick: () => removeFolder(p, f) }, '✕')))),
        h('div.terms', sessionsOf(p.id).map((t) => termItem(t, slots.get(t.sid))))));
    }
    const orphans = orphanSessions();
    if (orphans.length) {
      root.append(h('div.project',
        h('div.project-head', h('span.pname.muted', 'Sin proyecto')),
        h('div.terms', orphans.map((t) => termItem(t)))));
    }
  }

  function renderTabs() {
    const tabs = $('#tabs');
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
    for (const t of tabSessions()) {
      const slot = slots.get(t.sid);
      tabs.append(h(`div.tab${t.sid === state.activeSid ? '.active' : ''}${slot != null ? '.grouped' : ''}`, {
        dataset: { sid: t.sid },
        title: `${(t.info.meta || {}).cwd || ''}\nDoble clic: renombrar`,
        onclick: () => activate(t.sid),
        ondblclick: () => renameTerm(t.sid),
        onauxclick: (e) => { if (e.button === 1) closeTerm(t.sid); },
      },
      h('span', { class: dotClass(t) }),
      slot != null ? h('span.slot', String(slot + 1)) : null,
      kindIcon(termKind(t)),
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
    if (state.db.open) {
      tabs.append(h(`div.tab.db-tab${state.activeSid === DB_VIEW ? '.active' : ''}`, {
        dataset: { sid: DB_VIEW }, title: 'Consultas SQL (Alt+Shift+D)',
        onclick: () => openDbView(),
        onauxclick: (e) => { if (e.button === 1) closeDbView(); },
      },
      kindIcon('db'),
      h('span.tname', 'DB'),
      h('span.x', { title: 'Cerrar', onclick: (e) => { e.stopPropagation(); closeDbView(); } }, '✕')));
    }
    if (state.git.open) {
      tabs.append(h(`div.tab.git-tab${state.activeSid === GIT_VIEW ? '.active' : ''}`, {
        dataset: { sid: GIT_VIEW }, title: 'Git (Alt+Shift+G)',
        onclick: () => openGitView(),
        onauxclick: (e) => { if (e.button === 1) closeGitView(); },
      },
      kindIcon('git'),
      h('span.tname', 'Git'),
      h('span.x', { title: 'Cerrar', onclick: (e) => { e.stopPropagation(); closeGitView(); } }, '✕')));
    }
  }

  // ---------- pantalla dividida ----------
  // Muestra a la vez las primeras N terminales (shell/agentes/ssh) del proyecto activo.
  // Ciclo del botón: 1 → 2 (1 arriba, 1 abajo) → 3 (2 arriba, 1 abajo) → 4 (2×2) → 1.
  const SPLIT_KINDS = ['shell', 'claude', 'codex', 'opencode', 'ssh'];
  const SPLIT_MAX = 4;
  const SPLIT_RECTS = { // [left, top, width, height] en %
    2: [[0, 0, 100, 50], [0, 50, 100, 50]],
    3: [[0, 0, 50, 50], [50, 0, 50, 50], [0, 50, 100, 50]],
    4: [[0, 0, 50, 50], [50, 0, 50, 50], [0, 50, 50, 50], [50, 50, 50, 50]],
  };
  const splitN = () => Math.min(SPLIT_MAX, Math.max(1, Number(state.ui.split) || 1));
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
    const rects = SPLIT_RECTS[group.length];
    const refit = [];
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
      t.pane.style.visibility = r || t.sid === state.activeSid ? 'visible' : 'hidden';
    }
    if (refit.length) requestAnimationFrame(() => refit.forEach(fitTerm));
    renderSplitBtn();
    const pg = isPageView(state.activeSid) ? pageById(state.activeSid.slice(PAGE_PREFIX.length)) : null;
    if (pg) ensurePagePane(pg);
    for (const [id, pane] of pagePanes) pane.classList.toggle('hidden', !pg || pg.id !== id);
    const dbActive = state.activeSid === DB_VIEW;
    if (dbActive) ensureDbPane();
    if (dbPane) dbPane.root.classList.toggle('hidden', !dbActive);
    const gitActive = state.activeSid === GIT_VIEW;
    if (gitActive) { ensureGitPane(); gitSyncProject(); }
    if (gitPane) gitPane.root.classList.toggle('hidden', !gitActive);
    const p = project();
    $('#empty').classList.toggle('hidden', !!activeTerm() || !!pg || dbActive || gitActive);
    $('#st-project').textContent = p ? p.name : '—';
    const t = activeTerm();
    $('#st-cwd').textContent = gitActive ? (state.git.repo ? tilde(state.git.repo) : 'Git') : dbActive ? dbStatusLine() : pg ? pg.url : t ? tilde((t.info.meta || {}).cwd || '') : p ? p.folders.map(tilde).join('  +  ') : '';
    renderStatusActions();
  }

  function renderAll() {
    renderProjects();
    renderTabs();
    renderPanes();
    updateTitle();
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
    $('#modal-body').replaceChildren(...[].concat(body));
    $('#modal-foot').replaceChildren(...foot);
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
        } catch (e) { toast(e.message, 'err'); }
      }
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(input.value.trim()); });
      hidden.addEventListener('change', () => go(current));
      const done = (v) => { close(true); resolve(v); };
      const close = openModal({
        title: 'Elegir carpeta',
        body: [
          h('div.picker-path', input, h('button', { onclick: () => go(input.value.trim()) }, 'Ir')),
          h('label.muted', hidden, ' mostrar ocultas'),
          list,
        ],
        foot: [
          h('button', { onclick: () => done(null) }, 'Cancelar'),
          h('button.primary', { onclick: () => done(current) }, 'Usar esta carpeta'),
        ],
        onClose: () => { resolve(null); },
      });
      go(current);
    });
  }

  /** Editor de archivos (agentes, skills, hooks, memoria…). */
  async function openEditor(path, { create = false, template = '', title } = {}) {
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
  };
  function setRtab(name) {
    state.ui.rtab = name;
    save();
    for (const b of $$('#rtabs button')) b.classList.toggle('active', b.dataset.rtab === name);
    renderRight();
    if (name === 'procs') pollProcs();
    else if (name !== 'prompts' && name !== 'actions' && name !== 'pages' && name !== 'dbs' && name !== 'ssh' && name !== 'music' && name !== 'timers') loadConfig();
    if (name === 'dbs') loadDbs();
    if (name === 'ssh') loadSsh();
    updateDock();
  }
  function renderRight() {
    const fn = RTABS[state.ui.rtab] || renderProcs;
    const body = $('#rbody');
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
  function renderPrompts() {
    const filter = h('input.filter', { placeholder: 'Filtrar prompts…', value: promptFilter });
    filter.addEventListener('input', () => {
      promptFilter = filter.value;
      const q = promptFilter.toLowerCase();
      for (const el of $$('.prompt-card')) el.classList.toggle('hidden', !el.dataset.q.includes(q));
    });
    const q = promptFilter.toLowerCase();
    return [
      section('Prompts estándar',
        h('button.mini', { title: 'Exportar JSON', onclick: exportPrompts }, '⇩'),
        h('button.mini', { title: 'Importar JSON', onclick: importPrompts }, '⇧'),
        h('button.mini.primary', { onclick: () => editPrompt() }, '+ Nuevo')),
      filter,
      h('p.muted', { style: 'margin:0 2px 8px;font-size:11px' }, 'Clic = ejecutar en la terminal activa · ⇥ = insertar sin Enter · variables: {{project}} {{folder}} {{folders}}'),
      ...state.prompts.map((pr) => {
        const key = `${pr.title}\n${pr.body}`.toLowerCase();
        return h(`div.card.clickable.prompt-card${key.includes(q) ? '' : '.hidden'}`, {
          dataset: { q: key },
          title: 'Ejecutar en la terminal activa',
          onclick: () => runPrompt(pr, true),
        },
        h('div.title', h('span.name', '▶ ' + pr.title),
          h('button.icon.mini', { title: 'Insertar sin Enter', onclick: (e) => { e.stopPropagation(); runPrompt(pr, false); } }, '⇥'),
          h('button.icon.mini', { title: 'Editar', onclick: (e) => { e.stopPropagation(); editPrompt(pr); } }, '✎'),
          h('button.icon.mini', { title: 'Eliminar', onclick: (e) => { e.stopPropagation(); deletePrompt(pr); } }, '✕')),
        h('div.body', pr.body));
      }),
    ];
  }
  function editPrompt(pr) {
    const isNew = !pr;
    const title = h('input', { value: pr ? pr.title : '', placeholder: 'Título' });
    const body = h('textarea.prompt-body', { spellcheck: 'false', placeholder: 'Texto del prompt…' });
    body.value = pr ? pr.body : '';
    const doSave = (run) => {
      if (!title.value.trim() || !body.value.trim()) { toast('Título y texto son obligatorios', 'err'); return; }
      if (isNew) { pr = { id: uid() }; state.prompts.push(pr); }
      pr.title = title.value.trim();
      pr.body = body.value;
      save();
      modalClose(true);
      renderRight();
      if (run) runPrompt(pr, true);
    };
    body.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') doSave(true); });
    openModal({
      title: isNew ? 'Nuevo prompt' : 'Editar prompt',
      body: [h('div.field', h('label', 'Título'), title), h('div.field', h('label', 'Prompt'), body)],
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
    const blob = new Blob([JSON.stringify(state.prompts.map(({ title, body }) => ({ title, body })), null, 2)], { type: 'application/json' });
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
            state.prompts.push({ id: uid(), title: it.title, body: it.body });
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
  const GIT_VIEW = 'git:main';
  let gitPane = null;
  const Git = {
    repos: [], // repos detectados en las carpetas del proyecto
    projectId: null,
    status: null, // { branch, upstream, ahead, behind, staged, unstaged, untracked, noCommits, detached }
    branches: [],
    remotes: [],
    log: [],
    out: [], // salida de comandos ejecutados (la "guía")
    busy: false,
    selected: null, // { path, area } del diff mostrado
  };
  const gitArgsLabel = (args) => 'git ' + args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');

  /** Ejecuta git en el repo actual. log=true lo registra en "Salida" (comandos que hace el usuario). */
  async function git(args, { log = true, repo = state.git.repo, quiet = false } = {}) {
    if (!Bridge.ready) throw new Error('Bridge desconectado');
    if (!repo) throw new Error('No hay repositorio seleccionado');
    const r = await Bridge.call('git.run', { cwd: repo, args });
    if (log) {
      Git.out.push({ cmd: gitArgsLabel(args), code: r.code, text: (r.stdout + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '')).trimEnd(), at: Date.now() });
      if (Git.out.length > 100) Git.out.shift();
      if (state.git.tab === 'out') renderGitRight();
      if (r.code !== 0 && !quiet) {
        const msg = (r.stderr || r.stdout).trim().split('\n').filter(Boolean).slice(-2).join(' · ');
        toast(`${gitArgsLabel(args)} → ${msg || 'código ' + r.code}`, 'err');
      }
    }
    return r;
  }

  function openGitView() {
    state.git.open = true;
    state.activeSid = GIT_VIEW;
    save();
    renderAll();
    gitRefresh();
  }
  function closeGitView() {
    state.git.open = false;
    if (state.activeSid === GIT_VIEW) {
      const list = sessionsOf(state.activeProject);
      state.activeSid = list.length ? list[list.length - 1].sid : null;
    }
    save();
    renderAll();
  }

  /** Detecta los repos de las carpetas del proyecto activo (cuando cambia el proyecto). */
  async function gitSyncProject(force = false) {
    const p = project();
    if (!p || !Bridge.ready) return;
    if (!force && Git.projectId === p.id) return;
    Git.projectId = p.id;
    const repos = [];
    for (const f of p.folders) {
      try {
        const r = await git(['rev-parse', '--show-toplevel'], { log: false, repo: f });
        const top = r.stdout.trim();
        if (r.code === 0 && top && !repos.includes(top)) repos.push(top);
      } catch (_) { /* sin acceso */ }
    }
    Git.repos = repos;
    if (!repos.includes(state.git.repo)) state.git.repo = repos[0] || null;
    save();
    gitRefresh();
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
    if (!gitPane || state.activeSid !== GIT_VIEW) return;
    if (!state.git.repo) { Git.status = null; renderGit(); return; }
    try {
      const [st, br, rbr, rem, lg] = await Promise.all([
        git(['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all'], { log: false }),
        git(['branch', '--format=%(HEAD)%09%(refname:short)%09%(upstream:short)%09%(upstream:track)'], { log: false }),
        git(['branch', '-r', '--format=%(refname:short)'], { log: false }),
        git(['remote'], { log: false }),
        git(['log', '-n', '60', '--pretty=format:%h%x1f%an%x1f%ar%x1f%D%x1f%s'], { log: false }),
      ]);
      if (st.code !== 0) { Git.status = { error: st.stderr.trim() }; renderGit(); return; }
      Git.status = parseGitStatus(st.stdout);
      Git.branches = br.stdout.split('\n').filter(Boolean).map((l) => {
        const [head, name, upstream, track] = l.split('\t');
        return { name, current: head === '*', upstream, track };
      });
      Git.remoteBranches = rbr.stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD') && s.includes('/'));
      Git.remotes = rem.stdout.split('\n').filter(Boolean);
      Git.log = lg.code === 0 ? lg.stdout.split('\n').filter(Boolean).map((l) => {
        const [hash, author, when, refs, subject] = l.split('\x1f');
        return { hash, author, when, refs, subject };
      }) : [];
    } catch (e) { Git.status = { error: e.message }; }
    renderGit();
  }

  /** Ejecuta una acción guiada: bloquea botones, refresca al terminar. */
  async function gitAction(label, fn) {
    if (Git.busy) return;
    Git.busy = true;
    gitPane.root.classList.add('busy');
    gitPane.busy.textContent = `${label}…`;
    try { await fn(); } catch (e) { toast(e.message, 'err'); }
    Git.busy = false;
    gitPane.root.classList.remove('busy');
    gitPane.busy.textContent = '';
    await gitRefresh();
  }
  const okToast = (r, msg) => { if (r.code === 0) toast(msg, 'ok'); return r.code === 0; };

  // ----- acciones -----
  const gitAdd = (paths) => gitAction('git add', async () => okToast(await git(['add', '--', ...paths]), paths.length > 1 ? `${paths.length} archivos agregados` : `Agregado: ${paths[0]}`));
  const gitAddAll = () => gitAction('git add -A', async () => okToast(await git(['add', '-A']), 'Todos los cambios agregados'));
  const gitUnstage = (paths) => gitAction('git restore --staged', async () => {
    const r = Git.status && Git.status.noCommits ? await git(['rm', '--cached', '-r', '-q', '--', ...paths]) : await git(['restore', '--staged', '--', ...paths]);
    okToast(r, paths.length > 1 ? `${paths.length} archivos quitados del stage` : `Quitado del stage: ${paths[0]}`);
  });
  async function gitDiscard(f) {
    const untracked = f.code === '?';
    if (!(await confirmBox(`¿Descartar los cambios de "${f.path}"?`, untracked ? 'El archivo sin seguimiento se BORRARÁ del disco (git clean -f). No se puede deshacer.' : 'Se perderán los cambios sin preparar (git restore). No se puede deshacer.'))) return;
    gitAction('descartar', async () => okToast(untracked ? await git(['clean', '-f', '--', f.path]) : await git(['restore', '--', f.path]), `Descartado: ${f.path}`));
  }
  async function gitCommit(andPush) {
    const msg = gitPane.msg.value.trim();
    if (!msg) { toast('Escribe un mensaje de commit', 'err'); gitPane.msg.focus(); return; }
    const st = Git.status || {};
    let addAll = false;
    if (!(st.staged || []).length) {
      if (!(st.unstaged || []).length && !(st.untracked || []).length) { toast('No hay cambios para commitear'); return; }
      if (!(await confirmBox('No hay archivos preparados', '¿Agregar TODOS los cambios (git add -A) y hacer commit?'))) return;
      addAll = true;
    }
    gitAction('git commit', async () => {
      if (addAll && (await git(['add', '-A'])).code !== 0) return;
      const r = await git(['commit', '-m', msg]);
      if (r.code !== 0) return;
      gitPane.msg.value = '';
      toast(`Commit creado: ${msg.split('\n')[0]}`, 'ok');
      if (andPush) await doPush();
    });
  }
  async function doPush() {
    const st = Git.status || {};
    if (!Git.remotes.length) { toast('El repositorio no tiene remotos (git remote add origin <url>)', 'err'); return; }
    // sin upstream: publica la rama en el primer remoto y la enlaza
    const args = st.upstream ? ['push'] : ['push', '-u', Git.remotes.includes('origin') ? 'origin' : Git.remotes[0], 'HEAD'];
    okToast(await git(args), 'Push completado');
  }
  const gitPush = () => gitAction('git push', doPush);
  const gitPull = () => gitAction('git pull', async () => okToast(await git(['pull', '--no-edit']), 'Pull completado'));
  const gitFetch = () => gitAction('git fetch', async () => okToast(await git(['fetch', '--all', '--prune']), 'Fetch completado'));
  const gitStash = () => gitAction('git stash', async () => okToast(await git(['stash', 'push', '-u', '-m', `FRAP ${new Date().toLocaleString()}`]), 'Cambios guardados en el stash'));
  const gitStashPop = () => gitAction('git stash pop', async () => okToast(await git(['stash', 'pop']), 'Stash aplicado'));
  const gitInit = () => gitAction('git init', async () => {
    const p = project();
    if (!p) return;
    if ((await git(['init'], { repo: p.folders[0] })).code === 0) { toast('Repositorio creado', 'ok'); await gitSyncProject(true); }
  });

  async function gitCheckout(name, isRemote) {
    const st = Git.status || {};
    if ((st.staged || []).length || (st.unstaged || []).length) {
      if (!(await confirmBox(`¿Cambiar a "${name}" con cambios sin commitear?`, 'Git los llevará a la otra rama si no hay conflicto; si lo hay, el cambio fallará y nada se pierde. También puedes usar Stash antes.'))) return;
    }
    // rama remota (origin/x) -> rama local que la sigue
    const args = isRemote ? ['checkout', '--track', name] : ['checkout', name];
    gitAction(gitArgsLabel(args), async () => okToast(await git(args), `Ahora en ${isRemote ? name.split('/').slice(1).join('/') : name}`));
  }
  function gitNewBranch() {
    const name = gitPane.newBranch.value.trim();
    if (!name) { toast('Escribe el nombre de la nueva rama', 'err'); gitPane.newBranch.focus(); return; }
    if (!/^(?!-)(?!.*\.\.)(?!.*\/\/)[\w./-]+(?<![./])$/.test(name)) { toast('Nombre de rama inválido', 'err'); return; }
    gitAction('git checkout -b', async () => {
      if (okToast(await git(['checkout', '-b', name]), `Rama "${name}" creada`)) gitPane.newBranch.value = '';
    });
  }
  async function gitDeleteBranch(b) {
    if (!(await confirmBox(`¿Eliminar la rama "${b.name}"?`, 'Usa git branch -d: si tiene commits sin fusionar, git se negará y no se pierde nada.'))) return;
    gitAction('git branch -d', async () => okToast(await git(['branch', '-d', b.name]), `Rama "${b.name}" eliminada`));
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
    gitAction(gitArgsLabel(args), async () => {
      const r = await git(args, { quiet: true });
      if (r.code === 0) gitPane.free.value = '';
      renderGitRight();
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
    const r = await git(args, { log: false });
    Git.diff = { title: `${f.path} · ${area === 'staged' ? 'preparado' : area === 'untracked' ? 'nuevo' : 'sin preparar'}`, cmd: gitArgsLabel(args), text: r.stdout || r.stderr || '(sin diferencias)' };
    renderGit();
  }
  async function gitShowCommit(c) {
    state.git.tab = 'diff';
    Git.selected = null;
    const args = ['show', '--stat', '--patch', '--format=commit %H%nAutor: %an <%ae>%nFecha: %ad%n%n    %s%n%n%b', c.hash];
    const r = await git(args, { log: false });
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
    repo.addEventListener('change', () => { state.git.repo = repo.value; Git.diff = null; save(); gitRefresh(); renderPanes(); });
    const btn = (label, title, fn, cls = '') => h(`button${cls}`, { title, onclick: fn }, label);
    const branch = h('span.git-branch');
    const busy = h('span.git-busy.muted');
    const msg = h('textarea.git-msg', { placeholder: 'Mensaje del commit (Ctrl+Enter = commit)', spellcheck: 'true' });
    msg.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); gitCommit(false); } });
    const newBranch = h('input.mono', { placeholder: 'nueva-rama', spellcheck: 'false' });
    newBranch.addEventListener('keydown', (e) => { if (e.key === 'Enter') gitNewBranch(); });
    const free = h('input.mono.grow', { placeholder: 'status · log --oneline -10 · diff HEAD~1 · branch -a …', spellcheck: 'false' });
    free.addEventListener('keydown', (e) => { if (e.key === 'Enter') gitFree(); });
    const left = h('div.git-left');
    const rtabs = h('div.git-rtabs');
    const right = h('div.git-right-body');
    const root = h('div.git-pane.hidden',
      h('div.git-bar',
        repo, branch,
        h('span.grow'), busy,
        btn('⟳', 'Actualizar (git status)', () => gitRefresh(), '.icon'),
        btn('⤓ Fetch', 'git fetch --all --prune', gitFetch),
        btn('⬇ Pull', 'git pull --no-edit', gitPull),
        btn('⬆ Push', 'git push (o push -u origin HEAD si la rama no tiene upstream)', gitPush),
        btn('📦 Stash', 'git stash push -u (guarda los cambios y limpia el directorio)', gitStash),
        btn('📤 Pop', 'git stash pop (recupera lo último guardado)', gitStashPop)),
      h('div.git-main',
        left,
        h('div.git-right', rtabs, right,
          h('div.git-free', h('span.mono.muted', '$ git'), free, h('button', { onclick: gitFree, title: 'Ejecutar el comando (Enter)' }, 'Ejecutar')))));
    $('#term-host').append(root);
    gitPane = { root, repo, branch, busy, msg, newBranch, free, left, rtabs, right };
    // refresco automático mientras la pestaña está visible
    setInterval(() => { if (state.activeSid === GIT_VIEW && !document.hidden && !Git.busy && !modalClose) gitRefresh(); }, 5000);
    window.addEventListener('focus', () => { if (state.activeSid === GIT_VIEW) gitRefresh(); });
    return gitPane;
  }

  function fileRow(f, area) {
    const sel = Git.selected && Git.selected.path === f.path && Git.selected.area === area;
    const acts = [];
    if (area === 'staged') acts.push(h('button.icon.mini', { title: `git restore --staged -- ${f.path}`, onclick: (e) => { e.stopPropagation(); gitUnstage([f.path]); } }, '−'));
    else {
      acts.push(h('button.icon.mini.danger', { title: area === 'untracked' ? `git clean -f -- ${f.path} (borra el archivo)` : `git restore -- ${f.path} (descarta cambios)`, onclick: (e) => { e.stopPropagation(); gitDiscard(f); } }, '↶'));
      acts.push(h('button.icon.mini', { title: `git add -- ${f.path}`, onclick: (e) => { e.stopPropagation(); gitAdd([f.path]); } }, '+'));
    }
    const slash = f.path.lastIndexOf('/');
    return h(`div.git-file${sel ? '.sel' : ''}${f.conflict ? '.conflict' : ''}`, { title: `${f.path}\nClic: ver diff`, onclick: () => gitShowDiff(f, area) },
      h(`span.git-code.c-${f.code === '?' ? 'U2' : f.code}`, f.code === '?' ? 'U' : f.code),
      h('span.git-fname', slash === -1 ? f.path : f.path.slice(slash + 1)),
      slash === -1 ? null : h('span.git-fdir', f.path.slice(0, slash)),
      h('span.grow'),
      ...acts);
  }
  function fileSection(title, files, area, bulk) {
    if (!files.length) return null;
    return h('div.git-sec',
      h('div.git-sec-head', h('span.grow', `${title} (${files.length})`), bulk),
      files.map((f) => fileRow(f, area)));
  }

  function renderGit() {
    if (!gitPane) return;
    const p = gitPane;
    const st = Git.status;
    p.repo.replaceChildren(...(Git.repos.length ? Git.repos.map((r) => h('option', { value: r, title: tilde(r) }, `📁 ${basename(r)}`)) : [h('option', { value: '' }, 'Sin repositorio')]));
    p.repo.value = state.git.repo || '';
    p.repo.title = state.git.repo ? tilde(state.git.repo) : '';
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
        Git.branches.map((b) => h(`div.git-branch-row${b.current ? '.current' : ''}`, {
          title: b.current ? 'Rama actual' : `git checkout ${b.name}`,
          onclick: () => { if (!b.current) gitCheckout(b.name, false); },
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
              .map((r) => h('div.git-branch-row', { title: `git checkout --track ${r}`, onclick: () => gitCheckout(r, true) }, h('span', '☁'), h('span.grow.mono', r))))
          : null),
    ].filter(Boolean));
    renderGitRight();
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
          h('div.mono', h(`span.${o.code === 0 ? 'ok' : 'err'}`, o.code === 0 ? '✓' : '✗'), ` $ ${o.cmd}`),
          o.text ? h('pre', o.text) : null)))]
        : [h('p.muted.git-hint', 'Aquí aparece cada comando git que ejecutes desde esta vista, con su salida. Así ves exactamente qué hace cada botón.')];
    }
    p.right.replaceChildren(...body);
  }

  // ---------- bases de datos: conexiones (.env del bridge) + pestaña DB en el centro ----------
  const DB_VIEW = 'db:main';
  const isViewSid = (sid) => isPageView(sid) || sid === DB_VIEW || sid === GIT_VIEW;
  const DB_ENGINES = { mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite' };
  const DB_PORTS = { mysql: '3306', postgres: '5432' };
  /** Respuesta de db.list: { envFile, cli, clients, skills, conns } (sin contraseñas). */
  let dbInfo = null;
  let dbError = null; // error de la última carga (p. ej. bridge desactualizado)
  let dbPane = null;
  let dbLast = null; // último resultado { columns, rows, … } para exportar
  const dbConnById = (id) => (dbInfo ? dbInfo.conns.find((c) => c.id === id) : null) || null;
  const dbTarget = (c) => (c.engine === 'sqlite' ? tilde(c.database) : `${c.user}@${c.host || 'localhost'}:${c.port || DB_PORTS[c.engine]}${c.database ? '/' + c.database : ''}`);

  async function loadDbs() {
    if (!Bridge.ready) return;
    try { dbInfo = await Bridge.call('db.list'); dbError = null; } catch (e) {
      dbError = e.message;
      if (state.ui.rtab === 'dbs') renderRight(); else toast(e.message, 'err');
      return;
    }
    const cur = dbConnById(state.db.connId);
    if (state.db.connId && !(cur && cur.enabled)) state.db.connId = null;
    const first = dbInfo.conns.find((c) => c.enabled);
    if (!state.db.connId && first) state.db.connId = first.id;
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
          c.uiWrite ? h('span.badge.st-starting', { title: 'La pestaña DB puede escribir (los agentes no)' }, 'escritura UI') : h('span.badge', '🔒 lectura'),
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
            h('span', c.enabled && c.ai ? '🤖 Uso por IA' : '🤖 Sin IA'))),
        missing ? h('div.desc', { style: 'color:var(--err)' }, `Falta el cliente ${c.engine === 'postgres' ? 'psql' : c.engine === 'sqlite' ? 'sqlite3' : 'mysql'} en el sistema`) : null);
    })];
  }

  function dbSwitch(c, key, title, disabled) {
    const on = key === 'ai' ? c.enabled && c.ai : c.enabled;
    return h('button', {
      class: `switch ${on ? 'on' : 'off'}`,
      role: 'switch', 'aria-checked': String(!!on), title, disabled: !!disabled || !Bridge.ready,
      onclick: (e) => { e.stopPropagation(); toggleDb(c, key); },
    });
  }

  async function toggleDb(c, key) {
    try {
      const saved = await Bridge.call('db.toggle', { id: c.id, [key]: !c[key] });
      toast(key === 'enabled'
        ? `${c.name}: ${saved.enabled ? 'activada' : 'desactivada'}`
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
    const uiWrite = h('input', { type: 'checkbox' });
    uiWrite.checked = !!(c && c.uiWrite);
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
      database: database.value.trim(), uiWrite: uiWrite.checked, enabled: enabled.checked, ai: ai.checked,
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
        h('label.muted', uiWrite, ' Permitir escritura desde la pestaña DB (pide confirmación). Los agentes siempre son solo lectura.'),
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
      if (state.db.connId === c.id) state.db.connId = null;
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
        h('button.icon.mini', { title: 'Probar conexión', onclick: (e) => { e.stopPropagation(); testSsh({ id: c.id }, c.name); } }, '⚡'),
        h('button.icon.mini', { title: 'Editar', onclick: (e) => { e.stopPropagation(); editSsh(c); } }, '✎'),
        h('button.icon.mini', { title: 'Eliminar', onclick: (e) => { e.stopPropagation(); deleteSsh(c); } }, '✕')),
      h('div.path', { title: c.id }, `${sshTarget(c)} · id: ${c.id}`),
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
    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = !c || c.enabled !== false;
    const ai = h('input', { type: 'checkbox' });
    ai.checked = !!(c && c.ai);
    const collect = () => ({
      id: c ? c.id : undefined,
      name: name.value.trim(), host: host.value.trim(), port: port.value.trim(), user: user.value.trim(),
      password: c && !pass.value ? null : pass.value,
      key: key.value.trim().replace(/^~(?=\/|$)/, (Bridge.info && Bridge.info.home) || '~'),
      enabled: enabled.checked, ai: ai.checked,
    });
    const doSave = async () => {
      try {
        await Bridge.call('ssh.save', { host: collect() });
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

  // ----- pestaña DB (panel central) -----
  function openDbView(connId) {
    state.db.open = true;
    if (connId) state.db.connId = connId;
    state.activeSid = DB_VIEW;
    save();
    renderAll();
    if (!dbInfo) loadDbs();
    else { renderDbBar(); loadDbTables(); }
    requestAnimationFrame(() => dbPane && dbPane.sql.focus());
  }
  function closeDbView() {
    state.db.open = false;
    if (state.activeSid === DB_VIEW) {
      const list = sessionsOf(state.activeProject);
      state.activeSid = list.length ? list[list.length - 1].sid : null;
    }
    save();
    renderAll();
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
    conn.addEventListener('change', () => { state.db.connId = conn.value; save(); renderDbBar(); loadDbTables(); renderPanes(); });
    const write = h('input', { type: 'checkbox' });
    const writeLabel = h('label.db-write', { title: 'Permitido en esta conexión. Cada ejecución pide confirmación.' }, write, ' escritura');
    write.addEventListener('change', () => renderDbBar());
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
      h('div.db-bar', conn, mode, writeLabel, limit, history, h('span.grow'), status, csv, run),
      h('div.db-main',
        h('div.db-side', filter, tableList),
        h('div.db-work', sql, result)));
    $('#term-host').append(root);
    dbPane = { root, conn, write, writeLabel, mode, limit, history, run, sql, tableList, filter, result, status };
    renderDbBar();
    loadDbTables();
    return dbPane;
  }

  function renderDbBar() {
    if (!dbPane) return;
    const { conn, write, writeLabel, mode, history } = dbPane;
    const conns = dbInfo ? dbInfo.conns.filter((c) => c.enabled) : [];
    conn.replaceChildren(...(conns.length
      ? conns.map((c) => h('option', { value: c.id }, `${c.name} (${c.engine})`))
      : [h('option', { value: '' }, dbInfo && dbInfo.conns.length ? 'Todas las conexiones están desactivadas' : 'Sin conexiones — agrégalas en el panel derecho')]));
    conn.value = state.db.connId || '';
    const cc = dbConnById(state.db.connId);
    const c = cc && cc.enabled ? cc : null;
    writeLabel.classList.toggle('hidden', !(c && c.uiWrite));
    if (!(c && c.uiWrite)) write.checked = false;
    mode.className = `badge ${write.checked ? 'st-error' : 'st-on'}`;
    mode.textContent = write.checked ? '✎ ESCRITURA' : '🔒 solo lectura';
    history.replaceChildren(h('option', { value: '' }, `🕘 Historial (${state.db.history.length})`),
      ...state.db.history.map((q, i) => h('option', { value: String(i) }, q.replace(/\s+/g, ' ').slice(0, 80))));
    dbPane.run.disabled = !c;
  }

  async function loadDbTables() {
    if (!dbPane) return;
    const list = dbPane.tableList;
    const cc = dbConnById(state.db.connId);
    const c = cc && cc.enabled ? cc : null;
    if (!c || !Bridge.ready) { list.replaceChildren(h('p.muted', c ? 'Bridge desconectado.' : 'Elige una conexión activa.')); return; }
    list.replaceChildren(h('p.muted', 'Cargando tablas…'));
    try {
      const tables = await Bridge.call('db.tables', { id: c.id });
      if (state.db.connId !== c.id) return;
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
      dbPane.filter.dispatchEvent(new Event('input'));
    } catch (e) { list.replaceChildren(h('p.muted', { style: 'color:var(--err)' }, e.message)); }
  }

  async function runDbQuery() {
    const p = ensureDbPane();
    const c = dbConnById(state.db.connId);
    if (!c) { toast('Elige una conexión', 'err'); return; }
    const { selectionStart: a, selectionEnd: b } = p.sql;
    const sql = (a !== b ? p.sql.value.slice(a, b) : p.sql.value).trim();
    if (!sql) { toast('Escribe una consulta', 'err'); return; }
    const write = p.write.checked;
    if (write && !(await confirmBox(`¿Ejecutar en modo ESCRITURA en "${c.name}"?`, sql.length > 400 ? sql.slice(0, 400) + '…' : sql))) return;
    p.run.disabled = true;
    p.status.textContent = 'Ejecutando…';
    p.result.classList.add('running');
    try {
      const r = await Bridge.call('db.query', { id: c.id, sql, write, limit: state.db.limit || 500 });
      dbLast = r;
      renderDbResult(r);
      p.status.textContent = `${r.rowCount} fila${r.rowCount === 1 ? '' : 's'}${r.truncated ? ' (truncado)' : ''} · ${r.ms} ms`;
      state.db.history = [sql, ...state.db.history.filter((q) => q !== sql)].slice(0, 30);
      save();
      renderDbBar();
    } catch (e) {
      dbLast = null;
      p.result.replaceChildren(h('pre.db-error', e.message));
      p.status.textContent = 'Error';
    }
    p.result.classList.remove('running');
    p.run.disabled = false;
  }

  function renderDbResult(r) {
    const p = dbPane;
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
    const has = M().tracks.length > 0;
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
      if (t.enabled && t.nextAt && t.nextAt <= now) fireTimer(t, now - t.nextAt > 60 * 1000);
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
    const next = state.timers.filter((t) => t.enabled && t.nextAt).sort((a, b) => a.nextAt - b.nextAt)[0];
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
    const editor = h('input.mono', { value: s.editor || 'code', placeholder: 'code' });
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
      s.editor = editor.value.trim() || 'code';
      for (const l of launchers) s.launchers[l.k] = { cmd: l.cmd.value.trim() || l.k, addDir: l.add.value.trim() };
      for (const t of terms.values()) { t.term.options.fontSize = s.fontSize; fitTerm(t); }
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
          h('span.muted', { style: 'font-size:11px' }, 'code (VS Code), cursor, codium, windsurf… o cualquier comando que reciba la ruta.')),
        h('h4', { style: 'margin:8px 0 0' }, 'Lanzadores'),
        h('p.muted', { style: 'margin:0' }, 'Comando que se escribe en una shell nueva. La primera carpeta del proyecto es el cwd; las demás se pasan con el flag de "carpeta extra".'),
        ...launchers.map((l) => h('div.field-row',
          h('div.field', { style: 'width:90px' }, h('label', l.k)),
          h('div.field.grow', h('label', 'comando'), l.cmd),
          h('div.field', { style: 'width:150px' }, h('label', 'flag carpeta extra'), l.add))),
        h('h4', { style: 'margin:8px 0 0' }, 'Atajos'),
        h('p.muted.mono', { style: 'margin:0;font-size:11px;white-space:pre-line' },
          'Alt+1…9  ir a pestaña\nAlt+Shift+T  nueva shell   ·   Alt+Shift+C/X/O  claude/codex/opencode   ·   Alt+Shift+D  DB   ·   Alt+Shift+G  Git   ·   Alt+Shift+M  música ⏯\nAlt+Shift+W  cerrar pestaña   ·   Alt+Shift+B / P  ocultar paneles\nCtrl+Shift+C  copiar selección   ·   Ctrl+Shift+V  pegar'),
      ],
      foot: [h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doSave }, 'Guardar')],
    });
  }

  // ======================================================================
  // Atajos de teclado
  // ======================================================================
  function isAppShortcut(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return false;
    if (!e.shiftKey && /^Digit[1-9]$/.test(e.code)) return true;
    return e.shiftKey && ['KeyT', 'KeyW', 'KeyB', 'KeyP', 'KeyC', 'KeyX', 'KeyO', 'KeyD', 'KeyM', 'KeyG'].includes(e.code);
  }
  document.addEventListener('keydown', (e) => {
    if (!$('#alarm').classList.contains('hidden')) return; // el aviso bloqueante tiene prioridad
    if (e.key === 'Escape' && modalClose) { modalClose(); return; }
    if (!isAppShortcut(e) || modalClose) return;
    e.preventDefault();
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
      case 'KeyM': togglePlay(); break;
      case 'KeyW':
        if (state.activeSid === DB_VIEW) closeDbView();
        else if (state.activeSid === GIT_VIEW) closeGitView();
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
  $('#btn-new-project').onclick = newProject;
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
        kb.checked = true;
        kb.addEventListener('change', () => {
          if (kb.checked) box.checked = true;
          box.indeterminate = kids.some((k) => !k.box.checked) && kids.some((k) => k.box.checked);
          sync();
        });
        return { value: c.value, box: kb, el: h('label.xp-item.xp-kid', kb, h('span', c.label), c.sub ? h('span.muted', c.sub) : null) };
      });
      box.addEventListener('change', () => { box.indeterminate = false; for (const k of kids) k.box.checked = box.checked; sync(); });
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
    if (!items.length) { all.checked = false; all.disabled = true; }
    return {
      el,
      selected: () => rows.filter((r) => r.box.checked || r.box.indeterminate || r.kids.some((k) => k.box.checked))
        .map((r) => ({ value: r.value, children: r.kids.filter((k) => k.box.checked).map((k) => k.value) })),
    };
  }

  const CONFIG_PARTS = [
    { key: 'prompts', label: 'Prompts', count: (c) => (c.prompts || []).length },
    { key: 'actions', label: 'Acciones', count: (c) => (c.actions || []).length },
    { key: 'pages', label: 'Páginas', count: (c) => (c.pages || []).length },
    { key: 'timers', label: 'Temporizadores', count: (c) => (c.timers || []).length },
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
      ],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cerrar')],
    });
  }

  async function openExport() {
    if (Bridge.ready) await Promise.all([dbInfo ? null : loadDbs(), sshInfo ? null : loadSsh()]);
    const projects = checkGroup('Proyectos y terminales', state.projects.map((p) => ({
      value: p.id, label: p.name, sub: p.folders.map(tilde).join(', '),
      children: sessionsOf(p.id).filter((t) => termKind(t) !== 'action').map((t) => ({ value: t.sid, label: termTitle(t), sub: termKind(t) })),
    })), { note: 'Al importar se pueden reabrir las terminales y retomar la última conversación de cada IA en esa carpeta.' });
    const config = checkGroup('Configuración', CONFIG_PARTS.map((c) => ({
      value: c.key, label: c.count ? `${c.label} (${c.count(state)})` : c.label, sub: c.sub,
    })));
    const dbs = checkGroup('Bases de datos', ((dbInfo && dbInfo.conns) || []).map((c) => ({ value: c.id, label: c.name, sub: dbTarget(c) })));
    const sshs = checkGroup('SSH', ((sshInfo && sshInfo.hosts) || []).map((c) => ({ value: c.id, label: c.name, sub: sshTarget(c) })));
    const withPw = h('input', { type: 'checkbox' });
    withPw.checked = true;
    const pass1 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'clave para cifrar (mín. 6)' });
    const pass2 = h('input', { type: 'password', autocomplete: 'new-password', placeholder: 'repite la clave' });
    const passRow = h('div.field-row', h('span.grow', pass1), h('span.grow', pass2));
    withPw.addEventListener('change', () => passRow.classList.toggle('hidden', !withPw.checked));
    const credsBox = h('div.xp-group',
      h('label.xp-head', withPw, h('span', 'Incluir contraseñas de BD y SSH, cifradas')),
      h('div.muted.xp-note', 'Se cifran con esta clave (AES-256-GCM); te la pedirá al importar. Sin contraseñas, tendrás que escribirlas de nuevo.'),
      passRow);

    const doExport = async () => {
      const selDb = dbs.selected().map((x) => x.value);
      const selSsh = sshs.selected().map((x) => x.value);
      const out = { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), from: (Bridge.info && Bridge.info.hostname) || '' };
      out.projects = projects.selected().map(({ value, children }) => {
        const p = project(value);
        return {
          id: p.id, name: p.name, folders: p.folders.slice(),
          terminals: children.map((sid) => terms.get(sid)).filter(Boolean).map((t) => {
            const m = t.info.meta || {};
            return { kind: termKind(t), title: termTitle(t), cwd: m.cwd || p.folders[0], ...(m.sshId ? { sshId: m.sshId } : {}) };
          }),
        };
      });
      out.config = {};
      for (const { value } of config.selected()) out.config[value] = pickConfig(state, value);
      if (selDb.length || selSsh.length) {
        if (!Bridge.ready) { toast('Bridge desconectado: no se pueden exportar BD ni SSH', 'err'); return; }
        let passphrase = '';
        if (withPw.checked) {
          if (pass1.value.length < 6) { toast('La clave de cifrado debe tener al menos 6 caracteres', 'err'); pass1.focus(); return; }
          if (pass1.value !== pass2.value) { toast('Las claves no coinciden', 'err'); pass2.focus(); return; }
          passphrase = pass1.value;
        }
        try { Object.assign(out, await Bridge.call('export.creds', { db: selDb, ssh: selSsh, passphrase })); } catch (e) { toast(e.message, 'err'); return; }
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
      toast(`Exportado: ${out.projects.length} proyecto(s), ${nTerms} terminal(es), ${Object.keys(out.config).length} sección(es) de configuración, ${(out.db || []).length} BD, ${(out.ssh || []).length} SSH${out.secrets ? ' (contraseñas cifradas)' : ''}`, 'ok');
    };
    openModal({
      title: 'Exportar',
      wide: true,
      body: h('div.xp-cols',
        h('div.xp-col', h('h4', 'Panel izquierdo'), projects.el),
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
      children: (p.terminals || []).map((t, i) => ({ value: i, label: t.title || t.kind, sub: t.kind })),
    })));
    const config = checkGroup('Configuración', CONFIG_PARTS.filter((c) => cfg[c.key] != null).map((c) => ({
      value: c.key, label: c.count ? `${c.label} (${c.count(cfg)})` : c.label, sub: c.key === 'settings' ? 'reemplaza tus ajustes' : 'se agrega; mismo id se reemplaza',
    })));
    const dbs = checkGroup('Bases de datos', (data.db || []).map((c) => ({ value: c.id, label: c.name, sub: c.engine === 'sqlite' ? c.database : `${c.user}@${c.host}` })));
    const sshs = checkGroup('SSH', (data.ssh || []).map((c) => ({ value: c.id, label: c.name, sub: `${c.user}@${c.host}` })));
    const openTerms = h('input', { type: 'checkbox' });
    openTerms.checked = true;
    const resume = h('input', { type: 'checkbox' });
    resume.checked = true;
    const pass = h('input', { type: 'password', autocomplete: 'off', placeholder: 'clave con la que se exportó' });
    const termOpts = h('div.xp-group',
      h('label.xp-head', openTerms, h('span', 'Abrir las terminales al importar')),
      h('label.xp-item', resume, h('span', 'Retomar la última conversación'), h('span.muted', 'claude --continue · codex resume --last · opencode --continue')),
      h('div.muted.xp-note', 'Las conversaciones viven en cada equipo (~/.claude, ~/.codex…): en otro equipo, la IA empieza de cero si no tiene historial en esa carpeta.'));
    const secretsBox = data.secrets ? h('div.xp-group',
      h('div.xp-head', h('span', '🔒 Contraseñas cifradas')),
      h('div.muted.xp-note', 'Escribe la clave de la exportación. Si la dejas vacía, se importan sin contraseña.'),
      pass) : null;

    const doImport = async () => {
      const selDb = new Set(dbs.selected().map((x) => x.value));
      const selSsh = new Set(sshs.selected().map((x) => x.value));
      const report = [];
      if (selDb.size || selSsh.size) {
        if (!Bridge.ready) { toast('Bridge desconectado: no se pueden importar BD ni SSH', 'err'); return; }
        try {
          const r = await Bridge.call('import.creds', {
            db: (data.db || []).filter((c) => selDb.has(c.id)),
            ssh: (data.ssh || []).filter((c) => selSsh.has(c.id)),
            secrets: data.secrets, passphrase: pass.value,
          });
          if (r.db) report.push(`${r.db} BD`);
          if (r.ssh) report.push(`${r.ssh} SSH`);
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
          h('div.xp-col', h('h4', 'Panel izquierdo'), projects.el, termOpts),
          h('div.xp-col', h('h4', 'Panel derecho'), config.el, dbs.el, sshs.el, secretsBox)),
      ],
      foot: [h('span.grow'), h('button', { onclick: () => modalClose(true) }, 'Cancelar'), h('button.primary', { onclick: doImport }, '⇧ Importar')],
    });
  }

  /** Reabre las terminales importadas; las IA pueden retomar su última conversación. */
  async function reopenTerminals(chosen, resume) {
    if (!Bridge.ready) return;
    const prev = state.activeProject;
    for (const { p, terminals } of chosen) {
      state.activeProject = p.id;
      for (const t of terminals) {
        if (t.kind === 'ssh') {
          if (t.sshId && sshInfo && sshInfo.hosts.some((x) => x.id === t.sshId && x.enabled)) await connectSsh(t.sshId);
          continue;
        }
        const proj = project(p.id);
        let init;
        if (resume && t.kind === 'codex') init = `${(state.settings.launchers.codex || { cmd: 'codex' }).cmd} resume --last`;
        else if (resume && RESUME[t.kind]) init = buildLaunch(t.kind, proj) + RESUME[t.kind];
        await launch(['shell', 'claude', 'codex', 'opencode'].includes(t.kind) ? t.kind : 'shell', { title: t.title, cwd: t.cwd, init });
      }
    }
    if (prev && project(prev)) state.activeProject = prev;
    save();
    renderAll();
  }

  $('#btn-settings').onclick = openSettings;
  $('#btn-transfer').onclick = openTransfer;
  $('#btn-split').onclick = cycleSplit;
  $('#toggle-left').onclick = () => togglePanel('left');
  $('#toggle-right').onclick = () => togglePanel('right');
  for (const b of $$('#launchers button')) b.onclick = () => (b.dataset.launch === 'db' ? openDbView() : b.dataset.launch === 'git' ? openGitView() : b.dataset.launch === 'ssh' ? pickSsh() : launch(b.dataset.launch));
  for (const b of $$('#rtabs button')) b.onclick = () => setRtab(b.dataset.rtab);
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
        storeSet('frap.state', state);
        applyPanels();
        for (const b of $$('#rtabs button')) b.classList.toggle('active', b.dataset.rtab === state.ui.rtab);
      } else if (!remote || (remote.savedAt || 0) < (state.savedAt || 0)) {
        save();
      }
    } catch (_) { /* sin estado remoto */ }
    await syncSessions(true);
    tickTimers();
    loadConfig(true);
    loadDbs();
    loadSsh();
    pollProcs();
    renderRight();
  });
  Bridge.on('close', () => renderAll());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollProcs(); });

  applyPanels();
  for (const b of $$('#rtabs button')) b.classList.toggle('active', b.dataset.rtab === state.ui.rtab);
  updateDock();
  renderAll();
  renderRight();
  Bridge.connect();
})();
