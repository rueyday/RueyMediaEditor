// Small DOM helpers, icons, modals, toasts and context menus.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

/** h('div', {class:'x', onClick}, children...) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'textContent' || k === 'innerHTML') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  play: '<path d="M7 5v14l11-7z"/>',
  pause: '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>',
  start: '<path d="M6 5v14M18 5l-10 7 10 7z"/>',
  end: '<path d="M18 5v14M6 5l10 7-10 7z"/>',
  prev: '<path d="M14 6l-6 6 6 6"/>',
  next: '<path d="M10 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  scissors: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5L20 19M8 16.5L20 5"/>',
  cursor: '<path d="M5 3l14 8-6 2-3 6z"/>',
  magnet: '<path d="M6 4v8a6 6 0 0012 0V4M6 4h4v8a2 2 0 004 0V4h4"/>',
  zoomin: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5M8 11h6M11 8v6"/>',
  zoomout: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5M8 11h6"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  undo: '<path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3"/>',
  save: '<path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  type: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 01-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 01-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 01-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 010-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 012.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 014 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 012.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 010 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  download: '<path d="M12 4v12M6 10l6 6 6-6M4 20h16"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 10.6A3 3 0 0013.4 13.4M9.9 5.1A10.4 10.4 0 0112 5c6 0 10 7 10 7a17 17 0 01-3.2 3.9M6.6 6.6A17 17 0 002 12s4 7 10 7a10 10 0 004.4-1"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.5-2"/>',
  volume: '<path d="M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  marker: '<path d="M6 21V4h11l-3 4 3 4H6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>',
  diamond: '<path d="M12 3l8 9-8 9-8-9z"/>',
  export: '<path d="M12 16V4M6 10l6-6 6 6M4 16v4h16v-4"/>',
  loop: '<path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3"/>',
  in: '<path d="M4 4v16M4 12h12M11 7l5 5-5 5"/>',
  out: '<path d="M20 4v16M20 12H8M13 7l-5 5 5 5"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1.5 1.5M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1.5-1.5"/>',
  camera: '<path d="M4 8h4l2-3h4l2 3h4v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  refresh: '<path d="M20 12a8 8 0 01-14 5.3M4 12a8 8 0 0114-5.3M18 3v4h-4M6 21v-4h4"/>',
  wand: '<path d="M4 20l11-11M15 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z"/>',
};
export function icon(name) {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return wrap.firstChild;
}
export function btn(label, opts = {}) {
  const { icon: ic, onClick, class: cls = '', title, primary, disabled, id } = opts;
  const b = h('button', { class: `btn ${cls} ${primary ? 'primary' : ''} ${!label ? 'icon' : ''}`.trim(), title: title || (label ? null : undefined), disabled, id, onClick });
  if (ic) b.append(icon(ic));
  if (label) b.append(document.createTextNode(label));
  return b;
}

export function fmtTimecode(t, fps = 30) {
  t = Math.max(0, t || 0);
  const totalFrames = Math.round(t * fps);
  const f = totalFrames % Math.round(fps);
  const s = Math.floor(totalFrames / fps);
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = n => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(f)}`;
}
export function fmtDuration(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = t - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(2)}s`;
}
export function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function baseName(path) {
  return String(path || '').split(/[\\/]/).pop();
}

// ---------- overlays ----------
export function toast(message, kind = 'info', ms = 3200) {
  const root = $('#toast-root');
  const el = h('div', { class: `toast ${kind}` }, message);
  root.append(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, ms);
  return el;
}

/** modal({title, body, buttons:[{label, primary, onClick(close)}], wide}) */
export function modal({ title, body, buttons = [], wide = false, onClose, closable = true }) {
  const root = $('#overlay-root');
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = e => { if (e.key === 'Escape' && closable) { e.stopPropagation(); close(); } };
  const foot = h('div', { class: 'modal-foot' });
  const left = h('div', { class: 'left' });
  foot.append(left);
  for (const b of buttons) {
    const el = btn(b.label, { primary: b.primary, class: b.class, icon: b.icon, onClick: () => b.onClick ? b.onClick(close) : close() });
    (b.left ? left : foot).append(el);
  }
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}` },
    h('div', { class: 'modal-head' }, title, closable ? btn('', { icon: 'x', class: 'ghost', onClick: close }) : null),
    h('div', { class: 'modal-body' }, body),
    buttons.length ? foot : null,
  );
  const backdrop = h('div', { class: 'modal-backdrop', onMousedown: e => { if (e.target === backdrop && closable) close(); } }, box);
  root.append(backdrop);
  document.addEventListener('keydown', onKey);
  return { close, el: box };
}

export function confirmDialog(title, message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    modal({
      title, body: h('div', {}, message),
      buttons: [
        { label: 'Cancel', onClick: c => { c(); resolve(false); } },
        { label: okLabel, primary: !danger, class: danger ? 'danger' : '', onClick: c => { c(); resolve(true); } },
      ],
      onClose: () => resolve(false),
    });
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise(resolve => {
    const input = h('input', { class: 'input', value });
    let done = false;
    const finish = (c, v) => { if (done) return; done = true; c(); resolve(v); };
    const m = modal({
      title, body: h('div', { class: 'form' }, h('label', {}, label), input),
      buttons: [
        { label: 'Cancel', onClick: c => finish(c, null) },
        { label: 'OK', primary: true, onClick: c => finish(c, input.value) },
      ],
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(m.close, input.value); });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

let openMenu = null;
/** items: [{label, shortcut, onClick, disabled, sep, children:[...]}] */
export function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = h('div', { class: 'context-menu' });
  const build = (list, into) => {
    for (const it of list) {
      if (it.sep) { into.append(h('div', { class: 'sep' })); continue; }
      const row = h('div', { class: `item ${it.disabled ? 'disabled' : ''} ${it.children ? 'sub' : ''}` }, it.label, it.shortcut ? h('span', { class: 'k' }, it.shortcut) : null);
      if (it.children) {
        row.addEventListener('mouseenter', () => {
          menu.querySelectorAll('.submenu').forEach(s => s.remove());
          const sub = h('div', { class: 'context-menu submenu' });
          build(it.children, sub);
          const r = row.getBoundingClientRect();
          sub.style.left = `${r.right + 2}px`;
          sub.style.top = `${r.top - 4}px`;
          menu.append(sub);
          fit(sub);
        });
      } else {
        row.addEventListener('click', () => { closeContextMenu(); it.onClick && it.onClick(); });
        row.addEventListener('mouseenter', () => menu.querySelectorAll('.submenu').forEach(s => s.remove()));
      }
      into.append(row);
    }
  };
  build(items, menu);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.append(menu);
  const fit = el => {
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth) el.style.left = `${Math.max(0, innerWidth - r.width - 4)}px`;
    if (r.bottom > innerHeight) el.style.top = `${Math.max(0, innerHeight - r.height - 4)}px`;
  };
  fit(menu);
  openMenu = menu;
  setTimeout(() => {
    document.addEventListener('mousedown', onDoc, { once: true });
    document.addEventListener('keydown', onEsc, { once: true });
  }, 0);
  function onDoc(e) { if (!menu.contains(e.target)) closeContextMenu(); else document.addEventListener('mousedown', onDoc, { once: true }); }
  function onEsc(e) { if (e.key === 'Escape') closeContextMenu(); }
}
export function closeContextMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
}

/** Labelled property row used by the inspector. */
export function propRow(label, control, extra, opts = {}) {
  return h('div', { class: `prop ${opts.class || ''}` }, h('label', { title: label }, label), control, extra);
}
export function numberInput(value, { min, max, step = 1, onChange, width } = {}) {
  const el = h('input', { class: 'input num', type: 'number', value: fmtNum(value), min, max, step });
  el.addEventListener('change', () => { const v = parseFloat(el.value); if (!isNaN(v)) onChange(clamp(v, min ?? -Infinity, max ?? Infinity)); });
  el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); e.stopPropagation(); });
  if (width) el.style.width = width;
  return el;
}
export function rangeInput(value, { min = 0, max = 1, step = 0.01, onInput, onChange } = {}) {
  const el = h('input', { class: 'range', type: 'range', value, min, max, step });
  el.addEventListener('input', () => onInput && onInput(parseFloat(el.value)));
  el.addEventListener('change', () => onChange && onChange(parseFloat(el.value)));
  return el;
}
export function selectInput(value, options, onChange) {
  const el = h('select', { class: 'select' }, options.map(o => h('option', { value: o.value ?? o.id, selected: (o.value ?? o.id) === value }, o.label ?? o.name)));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}
export function fmtNum(v, digits = 2) {
  if (typeof v !== 'number' || !isFinite(v)) return '0';
  return String(parseFloat(v.toFixed(digits)));
}
