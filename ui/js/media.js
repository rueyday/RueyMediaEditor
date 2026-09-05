// Media bin: importing, probing, thumbnails, waveforms, proxies, drag to timeline.

import { state, bus, edit } from './state.js';
import * as ops from './ops.js';
import { invoke, listen, dialog, fileSrc, isTauri, kindFromPath } from './bridge.js';
import { h, btn, icon, fmtDuration, contextMenu, confirmDialog, toast, baseName, uid, $ } from './ui.js';
import * as timeline from './timeline.js';
import { releaseMedia } from './preview.js';

let listEl, searchEl, root;
let proxyWarned = false;

export function initMedia(el) {
  root = el;
  searchEl = h('input', { class: 'input', placeholder: 'Search media', type: 'search' });
  searchEl.addEventListener('input', render);
  searchEl.addEventListener('keydown', e => e.stopPropagation());
  listEl = h('div', { class: 'media-list' });
  root.append(
    h('div', { class: 'panel-head' }, 'Media', h('span', { class: 'spacer' }),
      btn('', { icon: 'type', class: 'ghost sm', title: 'Add a title clip at the playhead', onClick: () => ops.insertGenerated('title') }),
      btn('', { icon: 'square', class: 'ghost sm', title: 'Add a solid color clip at the playhead', onClick: () => ops.insertGenerated('color') }),
    ),
    h('div', { class: 'media-tools' }, btn('Import', { icon: 'plus', primary: true, onClick: importDialog }), searchEl),
    h('div', { class: 'panel-body' }, listEl),
  );
  bus.on('project', render);
  bus.on('assets', render);
  bus.on('need-proxy', requestProxy);
  listen('proxy-progress', p => { const a = state.assets[p.media_id]; if (a) { a.progress = p.ratio; updateProgress(p.media_id); } });
  render();
}

export async function importDialog() {
  const paths = await dialog.openFiles();
  if (paths.length) importPaths(paths);
}

export async function importPaths(paths) {
  const added = [];
  const failures = [];
  for (const path of paths) {
    if (Object.values(state.project.media).some(m => m.path === path)) continue;
    try {
      const info = await invoke('probe_media', { path, customDir: state.settings.ffmpegDir || null });
      const id = uid();
      added.push({ id, media: { path, name: info.name || baseName(path), kind: info.kind, duration: info.duration, width: info.width, height: info.height, fps: info.fps, has_video: info.has_video, has_audio: info.has_audio, proxy: null } });
    } catch (e) {
      failures.push(`${baseName(path)}: ${e}`);
    }
  }
  if (added.length) {
    edit('Import media', () => { for (const { id, media } of added) state.project.media[id] = media; });
    for (const { id } of added) loadAssets(id);
    // Empty project: put the first import on the timeline right away.
    if (!state.project.tracks.some(t => t.clips.length)) {
      let at = 0;
      for (const { id, media } of added) { const c = ops.insertMedia(id, { at }); if (c) at += (media.kind === 'image' ? state.settings.defaultImageDuration : media.duration); }
      timeline.zoomToFit();
    }
  }
  if (failures.length) toast(`Could not import:\n${failures.join('\n')}`, 'error', 7000);
  return added.map(a => a.id);
}

export async function loadAssets(mediaId) {
  const m = state.project.media[mediaId];
  if (!m) return;
  state.assets[mediaId] = { ...(state.assets[mediaId] || {}), status: 'Analyzing…' };
  render();
  try {
    const a = await invoke('generate_assets', { path: m.path, kind: m.kind, duration: m.duration, hasAudio: m.has_audio, customDir: state.settings.ffmpegDir || null });
    state.assets[mediaId] = { ...state.assets[mediaId], filmstrip: a.filmstrip, waveform: a.waveform, proxy: a.proxy, key: a.key, status: null, missing: false };
  } catch (e) {
    state.assets[mediaId] = { ...state.assets[mediaId], status: null, missing: true, error: String(e) };
  }
  bus.emit('assets');
  const s = state.settings;
  if (m.kind === 'video' && isTauri && !state.assets[mediaId].proxy && (s.autoProxy === 'always' || (s.autoProxy === 'above1080' && Math.max(m.width, m.height) > 1920))) requestProxy(mediaId);
}

export async function requestProxy(mediaId) {
  const m = state.project.media[mediaId];
  const a = state.assets[mediaId] || (state.assets[mediaId] = {});
  if (!m || a.proxy || a.proxyBusy || m.kind !== 'video') return;
  if (!isTauri) { if (!proxyWarned) { proxyWarned = true; toast('This browser cannot play that file. Proxies are made by the desktop app.', 'error', 6000); } return; }
  a.proxyBusy = true; a.status = 'Making proxy…'; a.progress = 0;
  render();
  try {
    const path = await invoke('make_proxy', { mediaId, path: m.path, duration: m.duration, maxWidth: state.settings.proxyWidth || 1280, customDir: state.settings.ffmpegDir || null });
    a.proxy = path;
    releaseMedia(mediaId);
  } catch (e) {
    toast(`Proxy failed for ${m.name}: ${e}`, 'error', 6000);
  }
  a.proxyBusy = false; a.status = null;
  bus.emit('assets');
}

function updateProgress(mediaId) {
  const bar = listEl.querySelector(`.media-item[data-id="${mediaId}"] .media-progress > div`);
  if (bar) bar.style.width = `${Math.round((state.assets[mediaId]?.progress || 0) * 100)}%`;
}

function render() {
  const q = (searchEl.value || '').toLowerCase();
  const entries = Object.entries(state.project.media).filter(([, m]) => !q || m.name.toLowerCase().includes(q));
  if (!entries.length) {
    listEl.replaceChildren(h('div', { class: 'media-empty' }, h('div', { class: 'big' }, '🎬'), h('div', {}, q ? 'No matches' : 'Import video, audio or images'), h('div', { class: 'hint' }, q ? '' : 'or drop files anywhere in the window')));
    return;
  }
  listEl.replaceChildren(...entries.map(([id, m]) => item(id, m)));
}

function item(id, m) {
  const a = state.assets[id] || {};
  const thumb = h('div', { class: `media-thumb ${m.kind === 'audio' ? 'audio' : ''}` });
  if (a.filmstrip) thumb.style.backgroundImage = `url("${fileSrc(a.filmstrip)}")`;
  else thumb.append(icon(m.kind === 'audio' ? 'music' : m.kind === 'image' ? 'image' : 'film'));
  if (a.proxy) thumb.append(h('span', { class: 'badge', title: 'Preview uses a proxy file' }, 'PROXY'));
  if (a.missing) thumb.append(h('span', { class: 'badge', style: { background: 'var(--danger)' } }, 'MISSING'));
  const meta = m.kind === 'image' ? `${m.width}×${m.height}` : m.kind === 'audio' ? fmtDuration(m.duration) : `${fmtDuration(m.duration)} · ${m.width}×${m.height}`;
  const el = h('div', { class: `media-item ${state.selectedMedia === id ? 'selected' : ''} ${a.status ? 'busy' : ''}`, dataset: { id }, title: m.path },
    thumb,
    h('div', {}, h('div', { class: 'media-name' }, m.name), h('div', { class: 'media-meta' }, a.status || meta),
      a.proxyBusy ? h('div', { class: 'media-progress' }, h('div', { style: { width: `${Math.round((a.progress || 0) * 100)}%` } })) : null));
  el.addEventListener('pointerdown', ev => startDrag(ev, id, el));
  el.addEventListener('dblclick', () => { ops.insertMedia(id); });
  el.addEventListener('contextmenu', ev => { ev.preventDefault(); menu(ev, id, m); });
  return el;
}

function menu(ev, id, m) {
  contextMenu(ev.clientX, ev.clientY, [
    { label: 'Add to timeline at playhead', onClick: () => ops.insertMedia(id) },
    { label: 'Generate proxy', disabled: m.kind !== 'video' || !!state.assets[id]?.proxy, onClick: () => requestProxy(id) },
    { label: 'Re-analyze', onClick: () => loadAssets(id) },
    { label: 'Show in folder', disabled: !isTauri, onClick: () => invoke('reveal_path', { path: m.path }) },
    { sep: true },
    { label: 'Remove from project', onClick: async () => {
      const used = state.project.tracks.reduce((n, t) => n + t.clips.filter(c => c.media_id === id).length, 0);
      if (!used || await confirmDialog('Remove media', `"${m.name}" is used by ${used} clip${used > 1 ? 's' : ''}. Remove it and those clips?`, { okLabel: 'Remove', danger: true })) { releaseMedia(id); ops.removeMedia(id); }
    } },
  ]);
}

// ---------- drag to timeline ----------
function startDrag(ev, id, el) {
  if (ev.button !== 0) return;
  state.selectedMedia = id;
  for (const x of listEl.children) x.classList.toggle('selected', x === el);
  const startX = ev.clientX, startY = ev.clientY;
  let ghost = null;
  const move = e => {
    if (!ghost) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
      ghost = h('div', { class: 'drag-ghost' }, state.project.media[id].name);
      document.body.append(ghost);
    }
    ghost.style.left = `${e.clientX}px`;
    ghost.style.top = `${e.clientY}px`;
    timeline.hitTest(e.clientX, e.clientY);
  };
  const up = e => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    if (!ghost) return;
    ghost.remove();
    const hit = timeline.hitTest(e.clientX, e.clientY);
    timeline.clearDropTarget();
    if (hit) ops.insertMedia(id, { trackId: hit.track?.id, at: hit.t });
    else if (document.elementFromPoint(e.clientX, e.clientY)?.closest('.preview-panel')) ops.insertMedia(id);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}
