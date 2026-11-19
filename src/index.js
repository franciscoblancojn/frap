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
    settings: {
      fontSize: 13,
      launchers: {
        claude: { cmd: 'claude', addDir: '--add-dir' },
        codex: { cmd: 'codex', addDir: '--add-dir' },
        opencode: { cmd: 'opencode', addDir: '' },
      },
    },
    ui: { rtab: 'procs', hideLeft: false, hideRight: false, procsAll: false },
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
    };
  }

  let state = mergeState(DEFAULT_STATE(), storeGet('frap.state', null));

  const persist = debounce(() => {
    state.savedAt = Date.now();
    storeSet('frap.state', state);
    if (Bridge.ready) Bridge.call('state.set', { state }).catch(() => {});
  }, 300);
  function save() { persist(); }

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
          msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
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

  function setConn(kind, detail) {
    const el = $('#conn');
    el.className = `conn ${kind}`;
    el.title = detail || '';
    $('#offline').classList.toggle('hidden', kind === 'on');
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
    t = { sid: info.sid, info, term, fit, pane, attaching: true, lastOut: info.lastOutput || 0, liveTitle: '' };
    terms.set(info.sid, t);

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
    t.term.write(`\r\n\x1b[2m[proceso terminado · código ${code}] — cierra la pestaña o pulsa Enter para reiniciar\x1b[0m\r\n`);
    t.exitHandler = t.term.onData((d) => {
      if (d === '\r') restartTerm(sid);
    });
    renderAll();
  });
  Bridge.on('sessions', () => syncSessions());

  async function syncSessions() {
    if (!Bridge.ready) return;
    let list;
    try { list = await Bridge.call('sessions.list'); } catch (_) { return; }
    const seen = new Set();
    for (const info of list) {
      seen.add(info.sid);
      ensureTerm(info);
    }
    for (const sid of [...terms.keys()]) if (!seen.has(sid) && terms.get(sid).info.alive !== false) disposeTerm(sid);
    if (state.activeSid && !terms.has(state.activeSid)) state.activeSid = null;
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
  const termTitle = (t) => t.liveTitle || (t.info.meta || {}).title || t.sid;
  const termKind = (t) => (t.info.meta || {}).kind || 'shell';

  function activeTerm() { return terms.get(state.activeSid) || null; }

  function activate(sid) {
    const t = terms.get(sid);
    if (!t) return;
    const pid = (t.info.meta || {}).projectId;
    if (pid && project(pid)) state.activeProject = pid;
    state.activeSid = sid;
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
    const list = sessionsOf(state.activeProject);
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
    state.activeSid = list.length ? list[list.length - 1].sid : null;
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

  function termItem(t) {
    return h('div.term-item', {
      class: `term-item${t.sid === state.activeSid ? ' active' : ''}`,
      dataset: { sid: t.sid },
      title: (t.info.meta || {}).cwd || '',
      onclick: () => activate(t.sid),
      ondblclick: () => renameTerm(t.sid),
    },
    h('span', { class: dotClass(t) }),
    h('span.tname', termTitle(t)),
    h(`span.kind.${termKind(t)}`, termKind(t)));
  }

  function renderProjects() {
    const root = $('#projects');
    root.replaceChildren();
    if (!state.projects.length) {
      root.append(h('div.empty-list', 'Sin proyectos. Pulsa ＋ para agregar una carpeta.'));
    }
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
        h('div.terms', sessionsOf(p.id).map(termItem))));
    }
    const orphans = orphanSessions();
    if (orphans.length) {
      root.append(h('div.project',
        h('div.project-head', h('span.pname.muted', 'Sin proyecto')),
        h('div.terms', orphans.map(termItem))));
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
    for (const t of sessionsOf(state.activeProject)) {
      tabs.append(h(`div.tab${t.sid === state.activeSid ? '.active' : ''}`, {
        dataset: { sid: t.sid },
        title: `${(t.info.meta || {}).cwd || ''}\nDoble clic: renombrar`,
        onclick: () => activate(t.sid),
        ondblclick: () => renameTerm(t.sid),
        onauxclick: (e) => { if (e.button === 1) closeTerm(t.sid); },
      },
      h('span', { class: dotClass(t) }),
      h('span.tname', termTitle(t)),
      h('span.x', { title: 'Cerrar', onclick: (e) => { e.stopPropagation(); closeTerm(t.sid); } }, '✕')));
    }
  }

  function renderPanes() {
    for (const t of terms.values()) t.pane.style.visibility = t.sid === state.activeSid ? 'visible' : 'hidden';
    const p = project();
    $('#empty').classList.toggle('hidden', !!activeTerm());
    $('#st-project').textContent = p ? p.name : '—';
    const t = activeTerm();
    $('#st-cwd').textContent = t ? tilde((t.info.meta || {}).cwd || '') : p ? p.folders.map(tilde).join('  +  ') : '';
    renderStatusActions();
  }

  function renderAll() {
    renderProjects();
    renderTabs();
    renderPanes();
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
          list.replaceChildren(
            res.parent ? h('div.picker-item.up', { onclick: () => go(res.parent) }, '↑ ..') : null,
            ...res.entries.map((e) => h('div.picker-item', {
              onclick: () => go(`${current}/${e.name}`.replace(/\/\//g, '/')),
            }, `📁 ${e.name}`)));
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
    else if (name !== 'prompts' && name !== 'actions') loadConfig();
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
    const port = h('input', { type: 'number', min: 1, max: 65535, value: conn.port });
    const token = h('input', { type: 'password', value: conn.token, autocomplete: 'off' });
    const launchers = AGENT_TOOLS.map((k) => {
      const l = s.launchers[k];
      return { k, cmd: h('input.mono', { value: l.cmd }), add: h('input.mono', { value: l.addDir, placeholder: '(sin soporte)' }) };
    });
    const doSave = () => {
      s.fontSize = Math.max(9, Math.min(24, Number(font.value) || 13));
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
        h('h4', { style: 'margin:8px 0 0' }, 'Lanzadores'),
        h('p.muted', { style: 'margin:0' }, 'Comando que se escribe en una shell nueva. La primera carpeta del proyecto es el cwd; las demás se pasan con el flag de "carpeta extra".'),
        ...launchers.map((l) => h('div.field-row',
          h('div.field', { style: 'width:90px' }, h('label', l.k)),
          h('div.field.grow', h('label', 'comando'), l.cmd),
          h('div.field', { style: 'width:150px' }, h('label', 'flag carpeta extra'), l.add))),
        h('h4', { style: 'margin:8px 0 0' }, 'Atajos'),
        h('p.muted.mono', { style: 'margin:0;font-size:11px;white-space:pre-line' },
          'Alt+1…9  ir a pestaña\nAlt+Shift+T  nueva shell   ·   Alt+Shift+C/X/O  claude/codex/opencode\nAlt+Shift+W  cerrar pestaña   ·   Alt+Shift+B / P  ocultar paneles\nCtrl+Shift+C  copiar selección   ·   Ctrl+Shift+V  pegar'),
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
    return e.shiftKey && ['KeyT', 'KeyW', 'KeyB', 'KeyP', 'KeyC', 'KeyX', 'KeyO'].includes(e.code);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalClose) { modalClose(); return; }
    if (!isAppShortcut(e) || modalClose) return;
    e.preventDefault();
    if (/^Digit/.test(e.code)) {
      const t = sessionsOf(state.activeProject)[Number(e.code.slice(5)) - 1];
      if (t) activate(t.sid);
      return;
    }
    switch (e.code) {
      case 'KeyT': launch('shell'); break;
      case 'KeyC': launch('claude'); break;
      case 'KeyX': launch('codex'); break;
      case 'KeyO': launch('opencode'); break;
      case 'KeyW': if (state.activeSid) closeTerm(state.activeSid); break;
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
  $('#btn-settings').onclick = openSettings;
  $('#toggle-left').onclick = () => togglePanel('left');
  $('#toggle-right').onclick = () => togglePanel('right');
  for (const b of $$('#launchers button')) b.onclick = () => launch(b.dataset.launch);
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
    await syncSessions();
    loadConfig(true);
    pollProcs();
    renderRight();
  });
  Bridge.on('close', () => renderAll());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollProcs(); });

  applyPanels();
  for (const b of $$('#rtabs button')) b.classList.toggle('active', b.dataset.rtab === state.ui.rtab);
  renderAll();
  renderRight();
  Bridge.connect();
})();
