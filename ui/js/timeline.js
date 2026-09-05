// Multi-track timeline: rendering, selection, dragging, trimming, snapping.

import { state, bus, edit, beginEdit, endEdit, select, clearSelection, selectedClips, setPlayhead } from './state.js';
import { clipDuration, clipEnd, overlaps, freePosition, isVisual, hasAudio, projectDuration, prevClip, nextClip, TRANSITIONS } from './model.js';
import { selectCaption } from './captions.js';
import * as ops from './ops.js';
import { h, btn, icon, fmtTimecode, clamp, contextMenu, promptDialog, confirmDialog, toast, $ } from './ui.js';
import { fileSrc } from './bridge.js';
import { pause } from './preview.js';

let root, viewport, content, ruler, lanesEl, headersScroll, playheadEl, snapLine, marquee, emptyHint, zoomSlider, toolBtns = {};
let capDrag = null;
let drag = null;
const LEFT_PAD = 12;
const FRAME_PX_LIMIT = 4000;

const fps = () => state.project.settings.fps || 30;
const frame = () => 1 / fps();
const x2t = x => (x - LEFT_PAD) / state.zoom;
const t2x = t => LEFT_PAD + t * state.zoom;

export function initTimeline(rootEl) {
  root = rootEl;
  buildTools();
  const grid = h('div', { class: 'timeline' });
  headersScroll = h('div', { class: 'track-headers-scroll' });
  const headers = h('div', { class: 'track-headers' },
    h('div', { class: 'ruler-corner' },
      btn('', { icon: 'plus', class: 'ghost sm', title: 'Add video track', onClick: () => ops.addTrack('video') }),
      btn('', { icon: 'music', class: 'ghost sm', title: 'Add audio track', onClick: () => ops.addTrack('audio') }),
    ),
    headersScroll,
  );
  ruler = h('div', { class: 'ruler' });
  lanesEl = h('div', { class: 'lanes' });
  playheadEl = h('div', { class: 'playhead' });
  snapLine = h('div', { class: 'snap-line', hidden: true });
  marquee = h('div', { class: 'marquee', hidden: true });
  emptyHint = h('div', { class: 'timeline-empty' }, h('div', {}, 'Drag media here, or double-click a file in the media bin'), h('div', { class: 'hint' }, 'Space plays · S splits · Delete removes · N toggles snapping'));
  content = h('div', { class: 'tracks-content' }, ruler, lanesEl, playheadEl, snapLine, marquee, emptyHint);
  viewport = h('div', { class: 'tracks-viewport' }, content);
  grid.append(headers, viewport);
  root.append(grid);

  viewport.addEventListener('scroll', () => { headersScroll.scrollTop = viewport.scrollTop; });
  viewport.addEventListener('wheel', onWheel, { passive: false });
  viewport.addEventListener('pointerdown', onPointerDown);
  viewport.addEventListener('pointermove', onPointerMove);
  viewport.addEventListener('pointerup', onPointerUp);
  viewport.addEventListener('pointercancel', onPointerUp);
  viewport.addEventListener('contextmenu', onContextMenu);
  viewport.addEventListener('dblclick', onDblClick);

  bus.on('project', renderAll);
  bus.on('assets', renderAll);
  bus.on('selection', updateSelection);
  bus.on('playhead', updatePlayhead);
  bus.on('view', renderAll);
  bus.on('transform-live', () => {});
  new ResizeObserver(() => renderAll()).observe(viewport);
  renderAll();
}

// ---------- toolbar ----------
function buildTools() {
  const tools = h('div', { class: 'timeline-tools' });
  toolBtns.select = btn('', { icon: 'cursor', title: 'Select tool (V)', onClick: () => setTool('select') });
  toolBtns.razor = btn('', { icon: 'scissors', title: 'Razor tool (C): click a clip to split it', onClick: () => setTool('razor') });
  toolBtns.snap = btn('', { icon: 'magnet', title: 'Snapping (N)', onClick: toggleSnap });
  zoomSlider = h('input', { class: 'range zoom', type: 'range', min: 0, max: 100, step: 1, value: zoomToSlider(state.zoom), title: 'Zoom' });
  zoomSlider.addEventListener('input', () => setZoom(sliderToZoom(parseFloat(zoomSlider.value))));
  tools.append(
    h('div', { class: 'btn-group' }, toolBtns.select, toolBtns.razor),
    toolBtns.snap,
    h('span', { class: 'sep', style: { width: '1px', height: '20px', background: 'var(--border)', margin: '0 4px' } }),
    btn('', { icon: 'scissors', title: 'Split at playhead (S)', onClick: ops.splitAtPlayhead }),
    btn('', { icon: 'trash', title: 'Delete selected (Delete)', onClick: () => ops.deleteSelected() }),
    btn('', { icon: 'marker', title: 'Add / remove marker at playhead (M)', onClick: () => ops.addMarker() }),
    btn('Transition', { icon: 'wand', title: 'Add a cross dissolve at the start of the selected clips', onClick: () => ops.addTransition('crossfade') }),
    h('span', { class: 'spacer' }),
    btn('', { icon: 'zoomout', title: 'Zoom out (-)', onClick: () => zoomBy(1 / 1.4) }),
    zoomSlider,
    btn('', { icon: 'zoomin', title: 'Zoom in (+)', onClick: () => zoomBy(1.4) }),
    btn('', { icon: 'fit', title: 'Zoom to fit (Shift+Z)', onClick: zoomToFit }),
  );
  root.append(tools);
  updateTools();
}
function updateTools() {
  toolBtns.select.classList.toggle('active', state.tool === 'select');
  toolBtns.razor.classList.toggle('active', state.tool === 'razor');
  toolBtns.snap.classList.toggle('active', state.snapping);
  viewport && (viewport.style.cursor = state.tool === 'razor' ? 'crosshair' : '');
}
export function setTool(t) { state.tool = t; updateTools(); }
export function toggleSnap() { state.snapping = !state.snapping; updateTools(); }
const zoomToSlider = z => clamp(Math.log(z / 2) / Math.log(600) * 100, 0, 100);
const sliderToZoom = s => 2 * Math.pow(600, s / 100);
export function setZoom(z, anchorT = null) {
  const old = state.zoom;
  state.zoom = clamp(z, 2, 1200);
  zoomSlider.value = zoomToSlider(state.zoom);
  if (anchorT != null) {
    const px = t2x(anchorT) - viewport.scrollLeft;
    renderAll();
    viewport.scrollLeft = Math.max(0, t2x(anchorT) - px);
  } else renderAll();
  void old;
}
export function zoomBy(f) {
  const center = x2t(viewport.scrollLeft + viewport.clientWidth / 2);
  setZoom(state.zoom * f, center);
}
export function zoomToFit() {
  const d = Math.max(1, projectDuration(state.project));
  setZoom((viewport.clientWidth - 60) / d);
  viewport.scrollLeft = 0;
}

// ---------- rendering ----------
function contentWidth() {
  const d = projectDuration(state.project);
  return Math.max(viewport.clientWidth, t2x(d + 20) + 100);
}

export function renderAll() {
  if (!viewport) return;
  const p = state.project;
  content.style.width = `${contentWidth()}px`;
  renderRuler();
  headersScroll.replaceChildren(captionHeader(), ...p.tracks.map(trackHeader));
  lanesEl.replaceChildren(captionLane(), ...p.tracks.map(trackLane));
  emptyHint.hidden = p.tracks.some(t => t.clips.length > 0);
  updatePlayhead();
  updateSelection();
}

function renderRuler() {
  const w = contentWidth();
  const z = state.zoom;
  const steps = [frame(), 5 * frame(), 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const step = steps.find(s => s * z >= 90) || 3600;
  const minor = step / (step >= 1 ? 5 : 1);
  const frag = document.createDocumentFragment();
  const end = x2t(w);
  for (let t = 0; t <= end; t += minor) {
    const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    const tick = h('div', { class: `tick ${isMajor ? '' : 'minor'}`, style: { left: `${t2x(t)}px` } });
    if (isMajor) tick.append(h('span', {}, rulerLabel(t, step)));
    frag.append(tick);
  }
  if (state.inPoint != null || state.outPoint != null) {
    const a = state.inPoint ?? 0, b = state.outPoint ?? projectDuration(state.project);
    frag.append(h('div', { class: 'inout', style: { left: `${t2x(a)}px`, width: `${Math.max(2, (b - a) * z)}px` } }));
  }
  for (const m of state.project.markers) {
    frag.append(h('div', { class: 'marker', dataset: { t: m.t }, title: m.label || fmtTimecode(m.t, fps()), style: { left: `${t2x(m.t)}px`, borderTopColor: m.color || undefined } }));
  }
  ruler.replaceChildren(frag);
}
function rulerLabel(t, step) {
  if (step < 1) return fmtTimecode(t, fps()).slice(3);
  const m = Math.floor(t / 60), s = Math.round(t % 60);
  const hh = Math.floor(m / 60);
  return hh ? `${hh}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function trackHeader(track) {
  const tog = (label, key, cls, title, iconOn, iconOff) => {
    const b = h('button', { class: `tog ${cls} ${track[key] ? 'on' : ''}`, title, onClick: e => { e.stopPropagation(); edit(title, () => { track[key] = !track[key]; }); } });
    if (iconOn) b.append(icon(track[key] ? iconOn : iconOff));
    else b.textContent = label;
    return b;
  };
  const head = h('div', { class: `track-head ${track.kind} ${state.selectedTrack === track.id ? 'selected' : ''}`, dataset: { track: track.id } },
    h('span', { class: 'tname', title: 'Double-click to rename' }, track.name),
    track.kind === 'video' ? tog('', 'hidden', 'eye', 'Hide track', 'eyeoff', 'eye') : null,
    tog('M', 'muted', 'mute', 'Mute'),
    tog('S', 'solo', 'solo', 'Solo'),
    tog('', 'locked', 'lock', 'Lock track', 'lock', 'unlock'),
  );
  head.addEventListener('click', () => { state.selectedTrack = track.id; state.selection.clear(); bus.emit('selection'); });
  head.addEventListener('dblclick', async () => { const name = await promptDialog('Rename track', 'Name', track.name); if (name) edit('Rename track', () => { track.name = name; }); });
  head.addEventListener('contextmenu', e => { e.preventDefault(); trackMenu(e, track); });
  return head;
}

function trackLane(track) {
  const lane = h('div', { class: `track-lane ${track.kind} ${track.locked ? 'locked' : ''}`, dataset: { track: track.id } });
  for (const clip of track.clips) lane.append(clipEl(clip, track));
  return lane;
}

function clipEl(clip, track) {
  const p = state.project;
  const media = p.media[clip.media_id];
  const asset = state.assets[clip.media_id];
  const d = clipDuration(clip);
  const w = Math.max(2, d * state.zoom);
  const el = h('div', {
    class: `clip ${clip.kind} ${state.selection.has(clip.id) ? 'selected' : ''} ${clip.muted ? 'muted' : ''}`,
    dataset: { id: clip.id },
    style: { left: `${t2x(clip.start)}px`, width: `${w}px` },
    title: `${clip.name || media?.name || clip.kind}\n${fmtTimecode(clip.start, fps())} → ${fmtTimecode(clipEnd(clip), fps())}`,
  });
  const label = h('div', { class: 'clip-label' }, clip.name || media?.name || clip.kind);
  if (clip.speed !== 1) label.append(h('span', { class: 'tag' }, `${parseFloat(clip.speed.toFixed(2))}×`));
  if (clip.kind === 'title' && clip.title) label.textContent = `T  ${clip.title.text.split('\n')[0]}`;
  if (clip.reverse) label.append(h('span', { class: 'tag' }, '⟲'));
  el.append(label);

  if (asset?.filmstrip && (clip.kind === 'video' || clip.kind === 'image') && w > 24) {
    const strip = h('div', { class: 'clip-strip' });
    strip.style.backgroundImage = `url("${fileSrc(asset.filmstrip)}")`;
    if (media && media.duration > 0) {
      const stripH = Math.max(1, 64 - 8 - 18);
      const frameW = stripH * 160 / 90;
      const natural = 40 * frameW;
      strip.style.backgroundPositionX = `${-(clip.in / media.duration) * natural}px`;
    }
    el.append(strip);
  }
  if (asset?.waveform && hasAudio(clip, p) && w > 12) {
    el.append(waveformEl(clip, asset.waveform, media, w, clip.kind === 'audio'));
  }
  if (clip.transition_in) el.append(h('div', { class: 'transition-in', style: { width: `${clip.transition_in.duration * state.zoom}px` }, title: `Transition: ${clip.transition_in.type}` }));
  if (clip.transition_out) el.append(h('div', { class: 'transition-out', style: { width: `${clip.transition_out.duration * state.zoom}px` } }));
  if (hasAudio(clip, p)) {
    if (clip.fade_in > 0) el.append(h('div', { class: 'fade-shade in', style: { left: 0, width: `${clip.fade_in * state.zoom}px` } }));
    if (clip.fade_out > 0) el.append(h('div', { class: 'fade-shade out', style: { right: 0, width: `${clip.fade_out * state.zoom}px` } }));
    el.append(h('div', { class: 'fade-handle in', dataset: { fade: 'in' }, style: { left: `${Math.max(2, clip.fade_in * state.zoom - 5)}px` }, title: 'Drag to fade audio in' }));
    el.append(h('div', { class: 'fade-handle out', dataset: { fade: 'out' }, style: { right: `${Math.max(2, clip.fade_out * state.zoom - 5)}px` }, title: 'Drag to fade audio out' }));
  }
  if ((clip.effects || []).some(e => e.enabled)) el.append(h('div', { class: 'fx-badge' }, 'fx'));
  if (state.selection.has(clip.id)) {
    const times = new Set();
    for (const list of Object.values(clip.keyframes || {})) for (const k of list) times.add(Math.round(k.t * 1000) / 1000);
    for (const t of times) el.append(h('div', { class: 'kf-dot', style: { left: `${t * state.zoom}px` } }));
  }
  el.append(h('div', { class: 'clip-handle left', dataset: { handle: 'left' } }), h('div', { class: 'clip-handle right', dataset: { handle: 'right' } }));
  return el;
}

function waveformEl(clip, peaks, media, w, full) {
  const wrap = h('div', { class: 'clip-wave', style: full ? {} : { top: '60%' } });
  const c = document.createElement('canvas');
  const cw = Math.min(FRAME_PX_LIMIT, Math.ceil(w));
  c.width = cw; c.height = full ? 36 : 22;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.55)';
  const pps = 25;
  const secPerPx = 1 / state.zoom;
  for (let x = 0; x < cw; x++) {
    const src = clip.in + x * secPerPx * clip.speed;
    const i = Math.floor(src * pps);
    let v = 0;
    const span = Math.max(1, Math.round(secPerPx * clip.speed * pps));
    for (let k = 0; k < span; k++) v = Math.max(v, peaks[i + k] || 0);
    const hgt = Math.max(1, v * c.height);
    g.fillRect(x, (c.height - hgt) / 2, 1, hgt);
  }
  wrap.append(c);
  return wrap;
}

function updatePlayhead() {
  if (!playheadEl) return;
  const x = t2x(state.playhead);
  playheadEl.style.left = `${x}px`;
  if (state.playing) {
    const vis = viewport.scrollLeft;
    if (x > vis + viewport.clientWidth - 40 || x < vis) viewport.scrollLeft = Math.max(0, x - 80);
  }
}
function updateSelection() {
  for (const el of lanesEl.querySelectorAll('.clip')) el.classList.toggle('selected', state.selection.has(el.dataset.id));
  for (const el of headersScroll.querySelectorAll('.track-head')) el.classList.toggle('selected', el.dataset.track === state.selectedTrack);
  // keyframe dots depend on selection
  const anyKf = state.project.tracks.some(t => t.clips.some(c => Object.keys(c.keyframes || {}).length));
  if (anyKf) renderLanesOnly();
}
function renderLanesOnly() {
  lanesEl.replaceChildren(captionLane(), ...state.project.tracks.map(trackLane));
}
/** Cheap position update for a clip element during drags (full render happens on release). */
function positionClipEl(clip) {
  const el = lanesEl.querySelector(`.clip[data-id="${clip.id}"]`);
  if (!el) return false;
  el.style.left = `${t2x(clip.start)}px`;
  el.style.width = `${Math.max(2, clipDuration(clip) * state.zoom)}px`;
  return true;
}

function captionHeader() {
  const head = h('div', { class: 'track-head caption', title: 'Captions (edit them in the Captions tab)' }, h('span', { class: 'tname' }, 'CC'),
    btn('', { icon: 'plus', class: 'ghost sm', title: 'Add caption at playhead (⇧C)', onClick: () => bus.emit('cmd', 'add-caption') }));
  return head;
}
function captionLane() {
  const lane = h('div', { class: 'track-lane caption', dataset: { caption: '1' } });
  for (const cap of state.project.captions || []) {
    const w = Math.max(3, (cap.end - cap.start) * state.zoom);
    lane.append(h('div', { class: `cap-block ${state.selectedCaption === cap.id ? 'selected' : ''}`, dataset: { cap: cap.id }, style: { left: `${t2x(cap.start)}px`, width: `${w}px` }, title: cap.text }, h('span', { class: 'clip-name' }, cap.text || '…')));
  }
  return lane;
}

// ---------- geometry helpers ----------
function laneAt(clientY) {
  for (const lane of lanesEl.children) {
    const r = lane.getBoundingClientRect();
    if (clientY >= r.top && clientY < r.bottom) return lane;
  }
  return null;
}
function trackOf(lane) { return lane ? state.project.tracks.find(t => t.id === lane.dataset.track) : null; }
function timeAt(clientX) {
  const r = content.getBoundingClientRect();
  return Math.max(0, x2t(clientX - r.left));
}
function snapCandidates(excludeIds = new Set()) {
  const c = [0, state.playhead];
  if (state.inPoint != null) c.push(state.inPoint);
  if (state.outPoint != null) c.push(state.outPoint);
  for (const m of state.project.markers) c.push(m.t);
  for (const cap of state.project.captions || []) c.push(cap.start, cap.end);
  for (const t of state.project.tracks) for (const clip of t.clips) if (!excludeIds.has(clip.id)) c.push(clip.start, clipEnd(clip));
  return c;
}
function snap(t, excludeIds, extraOffsets = [0]) {
  if (!state.snapping) return { t, snapped: null };
  const threshold = 8 / state.zoom;
  let best = null;
  for (const cand of snapCandidates(excludeIds)) {
    for (const off of extraOffsets) {
      const d = Math.abs(t + off - cand);
      if (d <= threshold && (!best || d < best.d)) best = { d, t: cand - off, at: cand };
    }
  }
  return best ? { t: best.t, snapped: best.at } : { t, snapped: null };
}
function showSnap(at) {
  if (at == null) { snapLine.hidden = true; return; }
  snapLine.hidden = false;
  snapLine.style.left = `${t2x(at)}px`;
}

/** Used by the media bin during drags: which track and time is under the pointer. */
export function hitTest(clientX, clientY) {
  const lane = laneAt(clientY);
  const r = viewport.getBoundingClientRect();
  const inside = clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  for (const l of lanesEl.children) l.classList.toggle('drop-target', l === lane && inside);
  if (!inside) return null;
  return { track: trackOf(lane), t: snap(timeAt(clientX), new Set()).t, lane };
}
export function clearDropTarget() {
  for (const l of lanesEl.children) l.classList.remove('drop-target');
  showSnap(null);
}

// ---------- pointer interaction ----------
function onPointerDown(ev) {
  if (ev.button !== 0) return;
  const target = ev.target;
  if (target.closest('.marker')) { setPlayhead(parseFloat(target.closest('.marker').dataset.t)); return; }
  if (target.closest('.ruler')) {
    pause();
    drag = { mode: 'scrub' };
    viewport.setPointerCapture(ev.pointerId);
    setPlayhead(timeAt(ev.clientX));
    return;
  }
  const capNode = target.closest('.cap-block');
  if (capNode) {
    const cap = (state.project.captions || []).find(c => c.id === capNode.dataset.cap);
    if (!cap) return;
    selectCaption(cap.id);
    clearSelection();
    capDrag = { cap, startX: ev.clientX, orig: { start: cap.start, end: cap.end }, token: null };
    viewport.setPointerCapture(ev.pointerId);
    drag = { mode: 'caption' };
    return;
  }
  const clipNode = target.closest('.clip');
  if (clipNode) {
    const id = clipNode.dataset.id;
    const found = findClipEl(id);
    if (!found) return;
    const { clip, track } = found;
    if (state.tool === 'razor') {
      if (track.locked) return;
      const t = snap(timeAt(ev.clientX), new Set([id])).t;
      edit('Split', () => ops.splitClip(track, clip, t));
      return;
    }
    if (target.dataset.handle) {
      if (track.locked) return;
      if (!state.selection.has(id)) select([id]);
      drag = { mode: 'trim', side: target.dataset.handle, clip, track, token: beginEdit('Trim'), orig: JSON.parse(JSON.stringify(clip)), startX: ev.clientX };
      viewport.setPointerCapture(ev.pointerId);
      return;
    }
    if (target.dataset.fade) {
      if (track.locked) return;
      drag = { mode: 'fade', side: target.dataset.fade, clip, token: beginEdit('Fade'), orig: { in: clip.fade_in, out: clip.fade_out }, startX: ev.clientX };
      viewport.setPointerCapture(ev.pointerId);
      return;
    }
    if (ev.shiftKey || ev.metaKey || ev.ctrlKey) select([id], { toggle: true });
    else if (!state.selection.has(id)) select([id]);
    state.selectedTrack = null;
    if (track.locked) return;
    const items = selectedClips().filter(x => !x.track.locked);
    drag = {
      mode: 'move-pending', startX: ev.clientX, startY: ev.clientY, primary: clip, primaryTrack: track,
      items: items.map(x => ({ clip: x.clip, track: x.track, start: x.clip.start })),
      offset: timeAt(ev.clientX) - clip.start,
    };
    viewport.setPointerCapture(ev.pointerId);
    return;
  }
  // empty area: deselect, move playhead, start marquee
  const lane = laneAt(ev.clientY);
  clearSelection();
  if (lane) state.selectedTrack = lane.dataset.track;
  bus.emit('selection');
  pause();
  setPlayhead(snap(timeAt(ev.clientX), new Set()).t);
  drag = { mode: 'marquee-pending', startX: ev.clientX, startY: ev.clientY };
  viewport.setPointerCapture(ev.pointerId);
}

function findClipEl(id) {
  for (const track of state.project.tracks) { const clip = track.clips.find(c => c.id === id); if (clip) return { clip, track }; }
  return null;
}

function onPointerMove(ev) {
  if (!drag) return;
  if (drag.mode === 'scrub') { setPlayhead(Math.max(0, timeAt(ev.clientX))); return; }
  if (drag.mode === 'caption' && capDrag) {
    const dx = (ev.clientX - capDrag.startX) / state.zoom;
    if (Math.abs(dx * state.zoom) < 3 && !capDrag.token) return;
    if (!capDrag.token) capDrag.token = beginEdit('Move caption');
    const d = capDrag.orig.end - capDrag.orig.start;
    const sn = snap(capDrag.orig.start + dx, new Set(), [0, d]);
    capDrag.cap.start = Math.max(0, sn.t);
    capDrag.cap.end = capDrag.cap.start + d;
    showSnap(sn.snapped);
    renderLanesOnly();
    return;
  }
  if (drag.mode === 'move-pending') {
    if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 4) return;
    drag.mode = 'move';
    drag.token = beginEdit('Move');
    for (const it of drag.items) { const el = lanesEl.querySelector(`.clip[data-id="${it.clip.id}"]`); el && el.classList.add('dragging'); }
  }
  if (drag.mode === 'move') { moveDrag(ev); return; }
  if (drag.mode === 'trim') { trimDrag(ev); return; }
  if (drag.mode === 'fade') { fadeDrag(ev); return; }
  if (drag.mode === 'marquee-pending') {
    if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 6) return;
    drag.mode = 'marquee';
    marquee.hidden = false;
  }
  if (drag.mode === 'marquee') { marqueeDrag(ev); }
}

function moveDrag(ev) {
  const ids = new Set(drag.items.map(i => i.clip.id));
  const raw = timeAt(ev.clientX) - drag.offset;
  const primaryDur = clipDuration(drag.primary);
  const sn = snap(raw, ids, [0, primaryDur]);
  const dt = sn.t - drag.items.find(i => i.clip === drag.primary).start;
  showSnap(sn.snapped);
  // Track change for single clip drags
  let targetTrack = null;
  if (drag.items.length === 1) {
    const lane = laneAt(ev.clientY);
    const tr = trackOf(lane);
    const clip = drag.primary;
    const okKind = tr && !tr.locked && ((clip.kind === 'audio' && tr.kind === 'audio') || (clip.kind !== 'audio' && tr.kind === 'video'));
    if (okKind && tr !== drag.primaryTrack) targetTrack = tr;
  }
  const p = state.project;
  for (const it of drag.items) {
    const ns = Math.max(0, it.start + dt);
    const curTrack = p.tracks.find(t => t.clips.includes(it.clip));
    let track = curTrack;
    if (targetTrack && it.clip === drag.primary && curTrack !== targetTrack) {
      curTrack.clips = curTrack.clips.filter(c => c !== it.clip);
      targetTrack.clips.push(it.clip);
      track = targetTrack;
    } else if (!targetTrack && it.clip === drag.primary && curTrack !== drag.primaryTrack) {
      curTrack.clips = curTrack.clips.filter(c => c !== it.clip);
      drag.primaryTrack.clips.push(it.clip);
      track = drag.primaryTrack;
    }
    it.clip.start = ns;
    if (it.track !== track) drag.trackChanged = true;
    it.track = track;
  }
  if (drag.trackChanged) {
    drag.trackChanged = false;
    renderLanesOnly();
    for (const it of drag.items) { const el = lanesEl.querySelector(`.clip[data-id="${it.clip.id}"]`); el && el.classList.add('dragging'); }
  } else {
    for (const it of drag.items) positionClipEl(it.clip);
  }
}

function trimDrag(ev) {
  const { clip, track, orig, side } = drag;
  const dx = (ev.clientX - drag.startX) / state.zoom;
  const media = state.project.media[clip.media_id];
  const minDur = frame();
  const generated = !media;
  if (side === 'left') {
    let newStart = snap(orig.start + dx, new Set([clip.id])).t;
    const prev = prevClip(track, orig);
    const lo = prev ? clipEnd(prev) : 0;
    const maxStart = clipEnd(orig) - minDur;
    const minStartBySource = generated ? -Infinity : orig.start - orig.in / orig.speed;
    newStart = clamp(newStart, Math.max(lo, minStartBySource, 0), maxStart);
    const delta = newStart - orig.start;
    clip.start = newStart;
    if (generated) clip.out = orig.out - delta * orig.speed;
    else clip.in = orig.in + delta * orig.speed;
    for (const key of Object.keys(clip.keyframes || {})) clip.keyframes[key] = orig.keyframes[key].map(k => ({ ...k, t: k.t - delta })).filter(k => k.t >= -1e-6);
    showSnap(snap(orig.start + dx, new Set([clip.id])).snapped);
  } else {
    const nx = nextClip(track, orig);
    let newEnd = snap(clipEnd(orig) + dx, new Set([clip.id])).t;
    const hi = nx ? nx.start : Infinity;
    const maxBySource = generated ? Infinity : orig.start + (media.duration - orig.in) / orig.speed;
    newEnd = clamp(newEnd, orig.start + minDur, Math.min(hi, maxBySource));
    clip.out = orig.in + (newEnd - orig.start) * orig.speed;
    showSnap(snap(clipEnd(orig) + dx, new Set([clip.id])).snapped);
  }
  positionClipEl(clip);
}

function fadeDrag(ev) {
  const { clip, side, orig } = drag;
  const dx = (ev.clientX - drag.startX) / state.zoom;
  const d = clipDuration(clip);
  if (side === 'in') clip.fade_in = clamp(orig.in + dx, 0, d - clip.fade_out);
  else clip.fade_out = clamp(orig.out - dx, 0, d - clip.fade_in);
  const el = lanesEl.querySelector(`.clip[data-id="${clip.id}"]`);
  if (el) {
    const hIn = el.querySelector('.fade-handle.in'), hOut = el.querySelector('.fade-handle.out');
    const sIn = el.querySelector('.fade-shade.in'), sOut = el.querySelector('.fade-shade.out');
    if (hIn) hIn.style.left = `${Math.max(2, clip.fade_in * state.zoom - 5)}px`;
    if (hOut) hOut.style.right = `${Math.max(2, clip.fade_out * state.zoom - 5)}px`;
    if (sIn) sIn.style.width = `${clip.fade_in * state.zoom}px`;
    if (sOut) sOut.style.width = `${clip.fade_out * state.zoom}px`;
  }
}

function marqueeDrag(ev) {
  const r = content.getBoundingClientRect();
  const x0 = Math.min(drag.startX, ev.clientX) - r.left, x1 = Math.max(drag.startX, ev.clientX) - r.left;
  const y0 = Math.min(drag.startY, ev.clientY) - r.top, y1 = Math.max(drag.startY, ev.clientY) - r.top;
  Object.assign(marquee.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
  const ids = [];
  for (const el of lanesEl.querySelectorAll('.clip')) {
    const b = el.getBoundingClientRect();
    const bx0 = b.left - r.left, bx1 = b.right - r.left, by0 = b.top - r.top, by1 = b.bottom - r.top;
    if (bx0 < x1 && bx1 > x0 && by0 < y1 && by1 > y0) ids.push(el.dataset.id);
  }
  state.selection = new Set(ids);
  updateSelection();
}

function onPointerUp(ev) {
  if (!drag) return;
  const d = drag;
  drag = null;
  showSnap(null);
  try { viewport.releasePointerCapture(ev.pointerId); } catch {}
  if (d.mode === 'move') {
    // resolve overlaps: push to nearest free spot, or revert
    let reverted = false;
    for (const it of d.items) {
      const track = state.project.tracks.find(t => t.clips.includes(it.clip));
      if (overlaps(track, it.clip)) {
        const free = freePosition(track, it.clip, it.clip.start, clipDuration(it.clip));
        if (free == null || Math.abs(free - it.clip.start) > 2) { reverted = true; break; }
        it.clip.start = free;
      }
    }
    if (reverted) {
      const before = JSON.parse(d.token.before);
      state.project = before;
      toast("Clips can't overlap on a track");
    }
    endEdit(d.token);
    return;
  }
  if (d.mode === 'trim' || d.mode === 'fade') { endEdit(d.token); return; }
  if (d.mode === 'caption') { if (capDrag?.token) endEdit(capDrag.token); else if (capDrag) setPlayhead(capDrag.cap.start); capDrag = null; return; }
  if (d.mode === 'marquee') { marquee.hidden = true; bus.emit('selection'); return; }
}

function onDblClick(ev) {
  const clipNode = ev.target.closest('.clip');
  if (clipNode) bus.emit('focus-inspector');
}

function onWheel(ev) {
  if (ev.ctrlKey || ev.metaKey) {
    ev.preventDefault();
    const t = timeAt(ev.clientX);
    setZoom(state.zoom * (ev.deltaY < 0 ? 1.15 : 1 / 1.15), t);
  } else if (ev.shiftKey && Math.abs(ev.deltaX) < 1) {
    ev.preventDefault();
    viewport.scrollLeft += ev.deltaY;
  }
}

// ---------- context menus ----------
function onContextMenu(ev) {
  ev.preventDefault();
  const clipNode = ev.target.closest('.clip');
  if (clipNode) {
    const id = clipNode.dataset.id;
    if (!state.selection.has(id)) select([id]);
    clipMenu(ev.clientX, ev.clientY);
    return;
  }
  if (ev.target.closest('.marker')) {
    const t = parseFloat(ev.target.closest('.marker').dataset.t);
    const m = state.project.markers.find(x => Math.abs(x.t - t) < 1e-6);
    contextMenu(ev.clientX, ev.clientY, [
      { label: 'Rename marker', onClick: async () => { const l = await promptDialog('Marker', 'Label', m.label); if (l != null) edit('Rename marker', () => { m.label = l; }); } },
      { label: 'Delete marker', onClick: () => edit('Delete marker', () => { state.project.markers = state.project.markers.filter(x => x !== m); }) },
    ]);
    return;
  }
  const t = timeAt(ev.clientX);
  const lane = laneAt(ev.clientY);
  contextMenu(ev.clientX, ev.clientY, [
    { label: 'Paste', shortcut: '⌘V', disabled: !state.clipboard.length, onClick: () => { setPlayhead(t); ops.paste(); } },
    { label: 'Add title here', onClick: () => ops.insertGenerated('title', { at: t, trackId: lane?.dataset.track }) },
    { label: 'Add color clip here', onClick: () => ops.insertGenerated('color', { at: t, trackId: lane?.dataset.track }) },
    { label: 'Add annotation here', children: [{ label: 'Rectangle', onClick: () => ops.insertGenerated('shape', { at: t, trackId: lane?.dataset.track, shapeKind: 'rect' }) }, { label: 'Ellipse', onClick: () => ops.insertGenerated('shape', { at: t, trackId: lane?.dataset.track, shapeKind: 'ellipse' }) }, { label: 'Arrow', onClick: () => ops.insertGenerated('shape', { at: t, trackId: lane?.dataset.track, shapeKind: 'arrow' }) }, { label: 'Line', onClick: () => ops.insertGenerated('shape', { at: t, trackId: lane?.dataset.track, shapeKind: 'line' }) }] },
    { label: 'Add timecode overlay here', onClick: () => ops.insertGenerated('timecode', { at: t, trackId: lane?.dataset.track }) },
    { label: 'Add caption here', onClick: () => { setPlayhead(t); bus.emit('cmd', 'add-caption'); } },
    { label: 'Add marker here', shortcut: 'M', onClick: () => ops.addMarker(t) },
    { sep: true },
    { label: 'Add video track', onClick: () => ops.addTrack('video') },
    { label: 'Add audio track', onClick: () => ops.addTrack('audio') },
    { sep: true },
    { label: 'Zoom to fit', shortcut: '⇧Z', onClick: zoomToFit },
  ]);
}

export function clipMenu(x, y) {
  const items = selectedClips();
  const one = items.length === 1 ? items[0] : null;
  const visual = items.some(i => isVisual(i.clip));
  const transitions = TRANSITIONS.slice(0, 12).map(tr => ({ label: tr.name, onClick: () => ops.addTransition(tr.id) }));
  contextMenu(x, y, [
    { label: 'Cut', shortcut: '⌘X', onClick: ops.cutSelected },
    { label: 'Copy', shortcut: '⌘C', onClick: ops.copySelected },
    { label: 'Duplicate', shortcut: '⌘D', onClick: ops.duplicateSelected },
    { sep: true },
    { label: 'Split at playhead', shortcut: 'S', onClick: ops.splitAtPlayhead },
    { label: 'Speed…', disabled: !items.some(i => i.clip.kind === 'video' || i.clip.kind === 'audio'), onClick: async () => { const v = await promptDialog('Speed', 'Multiplier (0.1 – 16)', String(one?.clip.speed ?? 1)); const n = parseFloat(v); if (n > 0) ops.setSpeedSelected(n); } },
    { label: one && one.clip.reverse ? 'Play forwards' : 'Reverse', disabled: !items.some(i => i.clip.kind === 'video' || i.clip.kind === 'audio'), onClick: ops.toggleReverse },
    { label: one && one.clip.muted ? 'Unmute audio' : 'Mute audio', onClick: () => edit('Mute', () => { for (const { clip } of items) clip.muted = !clip.muted; }) },
    { label: 'Detach audio', disabled: !items.some(i => i.clip.kind === 'video' && hasAudio(i.clip, state.project)), onClick: ops.detachAudio },
    { label: 'Add transition', disabled: !visual, children: transitions },
    { label: 'Remove transitions', disabled: !visual, onClick: () => edit('Remove transitions', () => { for (const { clip } of items) { clip.transition_in = null; clip.transition_out = null; } }) },
    { label: 'Reset transform', disabled: !visual, onClick: () => edit('Reset transform', () => { for (const { clip } of items) { clip.transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }; clip.keyframes = {}; } }) },
    { sep: true },
    { label: 'Freeze frame here', disabled: !items.some(i => i.clip.kind === 'video'), onClick: ops.freezeFrame },
    { label: 'Remove silence…', disabled: !items.some(i => hasAudio(i.clip, state.project)), onClick: ops.removeSilence },
    { label: 'Layout', disabled: items.length < 2, children: [...ops.LAYOUTS.map(l => ({ label: l.name, onClick: () => ops.applyLayout(l.id) })), { label: 'Compare with labels…', onClick: ops.compareLayout }] },
    { label: 'Sync by audio', disabled: items.length !== 2, onClick: ops.syncSelected },
    { label: 'Rename…', disabled: !one, onClick: async () => { const n = await promptDialog('Rename clip', 'Name', one.clip.name); if (n != null) edit('Rename', () => { one.clip.name = n; }); } },
    { sep: true },
    { label: 'Delete', shortcut: '⌫', onClick: () => ops.deleteSelected() },
    { label: 'Ripple delete', shortcut: '⇧⌫', onClick: () => ops.deleteSelected({ ripple: true }) },
  ]);
}

function trackMenu(ev, track) {
  const i = state.project.tracks.indexOf(track);
  contextMenu(ev.clientX, ev.clientY, [
    { label: 'Rename…', onClick: async () => { const name = await promptDialog('Rename track', 'Name', track.name); if (name) edit('Rename track', () => { track.name = name; }); } },
    { label: track.kind === 'video' ? 'Add video track above' : 'Add audio track above', onClick: () => ops.addTrack(track.kind, i) },
    { label: track.kind === 'video' ? 'Add video track below' : 'Add audio track below', onClick: () => ops.addTrack(track.kind, i + 1) },
    { label: 'Move up', onClick: () => ops.moveTrack(track.id, -1) },
    { label: 'Move down', onClick: () => ops.moveTrack(track.id, 1) },
    { sep: true },
    { label: 'Delete track', onClick: async () => { if (!track.clips.length || await confirmDialog('Delete track', `Delete "${track.name}" and its ${track.clips.length} clips?`, { okLabel: 'Delete', danger: true })) ops.removeTrack(track.id); } },
  ]);
}

