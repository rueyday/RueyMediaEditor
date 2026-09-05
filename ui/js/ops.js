// Editing operations on the project. Used by the timeline, menus and shortcuts.

import { state, bus, edit, select, clearSelection, selectedClips, setPlayhead } from './state.js';
import { newClip, newTrack, newTitle, newShape, newTimecode, clipDuration, clipEnd, findClip, overlaps, freePosition, isVisual, hasAudio, projectDuration, prevClip, nextClip, sortedClips, isGenerated } from './model.js';
import { invoke, dialog, isTauri } from './bridge.js';
import { modal, numberInput, promptDialog, h } from './ui.js';
import { uid, toast, clamp } from './ui.js';

const frame = () => 1 / (state.project.settings.fps || 30);

export function trackFor(kind) {
  // First unlocked track of the right kind; audio clips go to audio tracks.
  const want = kind === 'audio' ? 'audio' : 'video';
  return state.project.tracks.filter(t => t.kind === want && !t.locked).reverse()[0] || null;
}

/** Add a media item to the timeline. Returns the clip. */
export function insertMedia(mediaId, { trackId = null, at = null } = {}) {
  const m = state.project.media[mediaId];
  if (!m) return null;
  const kind = m.kind;
  let track = trackId ? state.project.tracks.find(t => t.id === trackId) : null;
  if (!track || (kind === 'audio' && track.kind !== 'audio') || (kind !== 'audio' && track.kind !== 'video')) track = trackFor(kind);
  let created = null;
  if (!track) { created = newTrack(kind === 'audio' ? 'audio' : 'video'); }
  const duration = kind === 'image' ? state.settings.defaultImageDuration : m.duration;
  const start = at ?? state.playhead;
  const clip = newClip({ kind, media_id: mediaId, start, in: 0, out: duration, name: m.name });
  edit('Add clip', () => {
    if (created) { state.project.tracks.push(created); track = created; }
    clip.start = freePosition(track, clip, start, duration) ?? clipEndOfTrack(track);
    track.clips.push(clip);
    // Audio of a video file also lands as the video's own audio; nothing extra needed.
  });
  select([clip.id]);
  return clip;
}

function clipEndOfTrack(track) {
  return track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function insertGenerated(kind, { at = null, trackId = null, shapeKind = 'rect' } = {}) {
  const duration = state.settings.defaultTitleDuration;
  let track = trackId ? state.project.tracks.find(t => t.id === trackId && t.kind === 'video') : null;
  if (!track) track = state.project.tracks.find(t => t.kind === 'video' && !t.locked);
  const start = at ?? state.playhead;
  const clip = newClip({
    kind, start, in: 0, out: duration,
    name: { title: 'Title', color: 'Color', shape: 'Shape', timecode: 'Timecode' }[kind] || kind,
    title: kind === 'title' ? newTitle('Your title') : null,
    color: kind === 'color' ? '#1f6feb' : null,
    shape: kind === 'shape' ? newShape(shapeKind) : null,
    timecode: kind === 'timecode' ? newTimecode() : null,
  });
  edit(`Add ${kind}`, () => {
    if (!track) { track = newTrack('video', 'V' + (state.project.tracks.filter(t => t.kind === 'video').length + 1)); state.project.tracks.unshift(track); }
    clip.start = freePosition(track, clip, start, duration) ?? clipEndOfTrack(track);
    track.clips.push(clip);
  });
  select([clip.id]);
  return clip;
}

export function splitClip(track, clip, t) {
  const d = clipDuration(clip);
  if (t <= clip.start + frame() / 2 || t >= clipEnd(clip) - frame() / 2) return null;
  const offset = t - clip.start;
  const right = JSON.parse(JSON.stringify(clip));
  right.id = uid();
  right.start = t;
  right.in = clip.in + offset * clip.speed;
  right.transition_in = null;
  right.fade_in = 0;
  clip.out = clip.in + offset * clip.speed;
  clip.transition_out = null;
  clip.fade_out = 0;
  // keyframes: split lists and shift the right side
  for (const key of Object.keys(right.keyframes || {})) {
    const list = right.keyframes[key];
    right.keyframes[key] = list.filter(k => k.t >= offset).map(k => ({ ...k, t: k.t - offset }));
    clip.keyframes[key] = list.filter(k => k.t < offset);
    if (!right.keyframes[key].length) delete right.keyframes[key];
    if (!clip.keyframes[key].length) delete clip.keyframes[key];
  }
  track.clips.push(right);
  void d;
  return right;
}

export function splitAtPlayhead() {
  const t = state.playhead;
  const targets = state.selection.size ? selectedClips() : allClipsAt(t);
  let count = 0;
  edit('Split', () => {
    for (const { clip, track } of targets) {
      if (track.locked) continue;
      if (splitClip(track, clip, t)) count++;
    }
  });
  if (!count) toast('Nothing to split at the playhead');
}

function allClipsAt(t) {
  const out = [];
  for (const track of state.project.tracks) for (const clip of track.clips) if (clip.start < t && t < clipEnd(clip)) out.push({ clip, track });
  return out;
}

export function deleteSelected({ ripple = false } = {}) {
  const items = selectedClips().filter(x => !x.track.locked);
  if (!items.length) return;
  edit(ripple ? 'Ripple delete' : 'Delete', () => {
    for (const { clip, track } of items) {
      const start = clip.start, d = clipDuration(clip);
      track.clips = track.clips.filter(c => c.id !== clip.id);
      if (ripple) {
        for (const c of track.clips) if (c.start >= clipEnd({ start, in: 0, out: d, speed: 1 }) - 1e-6) c.start -= d;
      }
    }
  });
  clearSelection();
}

export function duplicateSelected() {
  const items = selectedClips();
  if (!items.length) return;
  const ids = [];
  edit('Duplicate', () => {
    for (const { clip, track } of items) {
      const copy = JSON.parse(JSON.stringify(clip));
      copy.id = uid();
      const d = clipDuration(clip);
      copy.start = freePosition(track, copy, clipEnd(clip), d) ?? clipEndOfTrack(track);
      track.clips.push(copy);
      ids.push(copy.id);
    }
  });
  select(ids);
}

export function copySelected() {
  const items = selectedClips();
  if (!items.length) return;
  const min = Math.min(...items.map(x => x.clip.start));
  state.clipboard = items.map(({ clip, track }) => ({ clip: JSON.parse(JSON.stringify(clip)), trackId: track.id, offset: clip.start - min }));
  toast(`Copied ${items.length} clip${items.length > 1 ? 's' : ''}`);
}
export function cutSelected() {
  copySelected();
  deleteSelected();
}
export function paste() {
  if (!state.clipboard.length) return;
  const ids = [];
  edit('Paste', () => {
    for (const item of state.clipboard) {
      const copy = JSON.parse(JSON.stringify(item.clip));
      copy.id = uid();
      let track = state.project.tracks.find(t => t.id === item.trackId) || trackFor(copy.kind);
      if (!track) continue;
      const d = clipDuration(copy);
      const want = state.playhead + item.offset;
      copy.start = freePosition(track, copy, want, d) ?? clipEndOfTrack(track);
      track.clips.push(copy);
      ids.push(copy.id);
    }
  });
  select(ids);
}

export function selectAll() {
  select(state.project.tracks.flatMap(t => t.clips.map(c => c.id)));
}

export function nudgeSelected(dt) {
  const items = selectedClips().filter(x => !x.track.locked);
  if (!items.length) return;
  edit('Nudge', () => {
    for (const { clip, track } of items) {
      const ns = Math.max(0, clip.start + dt);
      if (!overlaps(track, clip, ns)) clip.start = ns;
    }
  });
}

export function detachAudio() {
  const items = selectedClips().filter(({ clip }) => clip.kind === 'video' && hasAudio(clip, state.project));
  if (!items.length) { toast('Select a video clip with audio'); return; }
  const ids = [];
  edit('Detach audio', () => {
    for (const { clip } of items) {
      clip.audio_detached = true;
      let track = state.project.tracks.filter(t => t.kind === 'audio' && !t.locked).find(t => !overlaps(t, null, clip.start, clipDuration(clip)));
      if (!track) { track = newTrack('audio', 'A' + (state.project.tracks.filter(t => t.kind === 'audio').length + 1)); state.project.tracks.push(track); }
      const a = newClip({ kind: 'audio', media_id: clip.media_id, start: clip.start, in: clip.in, out: clip.out, speed: clip.speed, volume: clip.volume, fade_in: clip.fade_in, fade_out: clip.fade_out, name: clip.name });
      track.clips.push(a);
      ids.push(a.id);
    }
  });
  select(ids);
}

export function addTransition(type = 'crossfade', duration = null) {
  const dur = duration ?? state.settings.defaultTransition;
  const items = selectedClips().filter(({ clip }) => isVisual(clip));
  if (!items.length) { toast('Select a video clip first'); return; }
  edit('Add transition', () => {
    for (const { clip, track } of items) {
      const prev = prevClip(track, clip);
      if (prev && Math.abs(clipEnd(prev) - clip.start) < 0.002) clip.transition_in = { type, duration: Math.min(dur, clipDuration(clip), clipDuration(prev)) };
      else clip.transition_in = { type, duration: Math.min(dur, clipDuration(clip)) };
    }
  });
}

export function setSpeedSelected(speed) {
  const items = selectedClips().filter(({ clip }) => clip.kind === 'video' || clip.kind === 'audio');
  edit('Speed', () => {
    for (const { clip, track } of items) {
      clip.speed = clamp(speed, 0.1, 16);
      // keep the clip from overlapping the next one
      const nx = nextClip(track, clip);
      if (nx && clipEnd(clip) > nx.start) clip.out = clip.in + (nx.start - clip.start) * clip.speed;
    }
  });
}

export function addMarker(t = state.playhead, label = '') {
  edit('Add marker', () => {
    const existing = state.project.markers.find(m => Math.abs(m.t - t) < frame() / 2);
    if (existing) state.project.markers = state.project.markers.filter(m => m !== existing);
    else state.project.markers.push({ t, label, color: '#f5a524' });
  });
}

export function addTrack(kind, index = null) {
  const n = state.project.tracks.filter(t => t.kind === kind).length + 1;
  const track = newTrack(kind, (kind === 'video' ? 'V' : 'A') + n);
  edit('Add track', () => {
    if (index === null) {
      if (kind === 'video') state.project.tracks.unshift(track);
      else state.project.tracks.push(track);
    } else state.project.tracks.splice(index, 0, track);
  });
  return track;
}
export function removeTrack(trackId) {
  const track = state.project.tracks.find(t => t.id === trackId);
  if (!track) return;
  edit('Remove track', () => { state.project.tracks = state.project.tracks.filter(t => t !== track); });
  clearSelection();
}
export function moveTrack(trackId, dir) {
  const tracks = state.project.tracks;
  const i = tracks.findIndex(t => t.id === trackId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= tracks.length || tracks[j].kind !== tracks[i].kind) return;
  edit('Move track', () => { [tracks[i], tracks[j]] = [tracks[j], tracks[i]]; });
}

export function goToPrevEdit() {
  const t = state.playhead;
  const points = editPoints().filter(p => p < t - 1e-3);
  setPlayhead(points.length ? Math.max(...points) : 0);
}
export function goToNextEdit() {
  const t = state.playhead;
  const points = editPoints().filter(p => p > t + 1e-3);
  setPlayhead(points.length ? Math.min(...points) : projectDuration(state.project));
}
function editPoints() {
  const pts = [0, projectDuration(state.project), ...state.project.markers.map(m => m.t)];
  for (const track of state.project.tracks) for (const c of track.clips) pts.push(c.start, clipEnd(c));
  return pts;
}

/** Remove all references to a media item. */
export function removeMedia(mediaId) {
  edit('Remove media', () => {
    for (const track of state.project.tracks) track.clips = track.clips.filter(c => c.media_id !== mediaId);
    delete state.project.media[mediaId];
  });
  delete state.assets[mediaId];
  clearSelection();
  bus.emit('assets');
}

export function setInPoint() { state.inPoint = state.playhead; if (state.outPoint != null && state.outPoint <= state.inPoint) state.outPoint = null; bus.emit('view'); }
export function setOutPoint() { state.outPoint = state.playhead; if (state.inPoint != null && state.inPoint >= state.outPoint) state.inPoint = null; bus.emit('view'); }
export function clearInOut() { state.inPoint = state.outPoint = null; bus.emit('view'); }


// ---------- researcher tools: freeze frame, watermark, layouts, silence, sync ----------

const settingsDir = () => state.settings.ffmpegDir || null;

/** Turns the frame under the playhead of the selected video clip into a still image clip. */
export async function freezeFrame() {
  const t = state.playhead;
  let target = selectedClips().find(({ clip }) => clip.kind === 'video' && clip.start <= t && t < clipEnd(clip));
  if (!target) target = allClipsAt(t).find(({ clip }) => clip.kind === 'video');
  if (!target) { toast('Put the playhead on a video clip'); return; }
  const { clip, track } = target;
  const m = state.project.media[clip.media_id];
  const src = clip.reverse ? clip.out - (t - clip.start) * clip.speed : clip.in + (t - clip.start) * clip.speed;
  let png;
  try { png = await invoke('extract_frame', { path: m.path, time: src, customDir: settingsDir() }); }
  catch (e) { toast(`Could not extract the frame: ${e}`, 'error', 6000); return; }
  const dur = state.settings.defaultImageDuration;
  const mediaId = uid();
  edit('Freeze frame', () => {
    state.project.media[mediaId] = { path: png, name: `Freeze ${m.name} @${src.toFixed(2)}s`, kind: 'image', duration: 0, width: m.width, height: m.height, fps: 0, has_video: true, has_audio: false, proxy: null };
    if (t > clip.start + 0.02 && t < clipEnd(clip) - 0.02) splitClip(track, clip, t);
    for (const c of track.clips) if (c.start >= t - 1e-6 && c !== clip) c.start += dur;
    const still = newClip({ kind: 'image', media_id: mediaId, start: t, in: 0, out: dur, name: 'Freeze frame', transform: JSON.parse(JSON.stringify(clip.transform)), crop: { ...clip.crop }, effects: JSON.parse(JSON.stringify(clip.effects)) });
    track.clips.push(still);
    select([still.id]);
  });
  bus.emit('assets');
  bus.emit('need-assets', mediaId);
}

/** Places an image as a logo in the corner, on its own top track, for the whole timeline. */
export function addWatermark(mediaId, { corner = 'bottom-right', size = 0.15, opacity = 0.85 } = {}) {
  const m = state.project.media[mediaId];
  if (!m || m.kind !== 'image') { toast('Watermarks must be images'); return; }
  const { width: PW, height: PH } = state.project.settings;
  const total = Math.max(projectDuration(state.project), state.settings.defaultImageDuration);
  const fit = Math.min(PW / (m.width || PW), PH / (m.height || PH));
  const fw = (m.width || PW) * fit * size, fh = (m.height || PH) * fit * size;
  const mx = PW * 0.03, my = PH * 0.04;
  const x = corner.endsWith('right') ? PW / 2 - fw / 2 - mx : -PW / 2 + fw / 2 + mx;
  const y = corner.startsWith('bottom') ? PH / 2 - fh / 2 - my : -PH / 2 + fh / 2 + my;
  edit('Add watermark', () => {
    let track = state.project.tracks.find(t => t.kind === 'video' && t.name === 'Logo');
    if (!track) { track = newTrack('video', 'Logo'); state.project.tracks.unshift(track); }
    const clip = newClip({ kind: 'image', media_id: mediaId, start: 0, in: 0, out: total, name: `Logo · ${m.name}`, transform: { x, y, scale: size, rotation: 0, opacity } });
    clip.start = freePosition(track, clip, 0, total) ?? clipEndOfTrack(track);
    track.clips.push(clip);
    select([clip.id]);
  });
}

export const LAYOUTS = [
  { id: 'side-by-side', name: 'Side by side (2)', cells: 2 },
  { id: 'triple', name: 'Three across', cells: 3 },
  { id: 'top-bottom', name: 'Top / bottom', cells: 2 },
  { id: 'grid', name: '2 × 2 grid', cells: 4 },
  { id: 'pip', name: 'Picture in picture', cells: 2 },
];

function layoutCells(id, n, PW, PH) {
  const cells = [];
  const cols = id === 'grid' ? 2 : id === 'triple' ? 3 : id === 'side-by-side' ? 2 : 1;
  const rows = id === 'grid' ? 2 : id === 'top-bottom' ? 2 : 1;
  if (id === 'pip') {
    cells.push({ x: 0, y: 0, w: PW, h: PH });
    for (let i = 1; i < n; i++) cells.push({ x: PW / 2 - PW * 0.3 / 2 - PW * 0.03, y: PH / 2 - PH * 0.3 / 2 - PH * 0.04 - (i - 1) * PH * 0.33, w: PW * 0.3, h: PH * 0.3 });
    return cells;
  }
  const gap = Math.round(PW * 0.008);
  const cw = (PW - gap * (cols - 1)) / cols, ch = (PH - gap * (rows - 1)) / rows;
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    if (r >= rows) break;
    cells.push({ x: -PW / 2 + cw / 2 + c * (cw + gap), y: -PH / 2 + ch / 2 + r * (ch + gap), w: cw, h: ch });
  }
  return cells;
}

/** Arranges the selected visual clips (top track first) into a split-screen layout. */
export function applyLayout(id, { labels = null } = {}) {
  const items = selectedClips().filter(({ clip }) => isVisual(clip) && clip.kind !== 'title' && clip.kind !== 'timecode');
  if (items.length < 2) { toast('Select two or more video clips on different tracks'); return; }
  const order = new Map(state.project.tracks.map((t, i) => [t.id, i]));
  items.sort((a, b) => order.get(a.track.id) - order.get(b.track.id));
  const { width: PW, height: PH } = state.project.settings;
  const cells = layoutCells(id, items.length, PW, PH);
  const labelIds = [];
  edit('Layout', () => {
    items.forEach(({ clip }, i) => {
      const cell = cells[i];
      if (!cell) return;
      const m = state.project.media[clip.media_id];
      const sw = (m?.width || PW) * (1 - clip.crop.left - clip.crop.right), sh = (m?.height || PH) * (1 - clip.crop.top - clip.crop.bottom);
      const fit = Math.min(PW / sw, PH / sh);
      const fw = sw * fit, fh = sh * fit;
      const scale = Math.min(cell.w / fw, cell.h / fh);
      clip.transform = { ...clip.transform, x: Math.round(cell.x), y: Math.round(cell.y), scale: Math.round(scale * 1000) / 1000, rotation: 0 };
      delete clip.keyframes.x; delete clip.keyframes.y; delete clip.keyframes.scale; delete clip.keyframes.rotation;
      if (labels && labels[i]) {
        let track = state.project.tracks.find(t => t.kind === 'video' && t.name === 'Labels');
        if (!track) { track = newTrack('video', 'Labels'); state.project.tracks.unshift(track); }
        const fs = Math.round(Math.min(cell.w, cell.h) * 0.11);
        const title = newClip({ kind: 'title', start: clip.start, in: 0, out: clipDuration(clip), name: labels[i], title: { ...newTitle(labels[i]), font_size: fs, background: '#000000a0', padding: Math.round(fs * 0.3), shadow: false }, transform: { x: Math.round(cell.x), y: Math.round(cell.y - cell.h / 2 + fs), scale: 1, rotation: 0, opacity: 1 } });
        title.start = freePosition(track, title, clip.start, clipDuration(clip)) ?? clipEndOfTrack(track);
        track.clips.push(title);
        labelIds.push(title.id);
      }
    });
  });
}

/** Side by side / grid with a label above each video (Baseline · Ours · Ground truth). */
export async function compareLayout() {
  const items = selectedClips().filter(({ clip }) => isVisual(clip) && !isGenerated(clip));
  if (items.length < 2) { toast('Select two or more video clips on different tracks'); return; }
  const defaults = ['Baseline', 'Ours', 'Ground truth', 'Input'].slice(0, items.length).join(', ');
  const text = await promptDialog('Compare videos', 'Labels, left to right (comma separated)', defaults);
  if (text == null) return;
  const labels = text.split(',').map(x => x.trim());
  applyLayout(items.length === 4 ? 'grid' : items.length === 3 ? 'triple' : 'side-by-side', { labels });
}

/** Cuts silent parts out of the selected clip (ripple on its track). */
export async function removeSilence() {
  const target = selectedClips().find(({ clip }) => clip.media_id && hasAudio(clip, state.project));
  if (!target) { toast('Select a clip with audio'); return; }
  const { clip, track } = target;
  const m = state.project.media[clip.media_id];
  const opts = { threshold: -35, min: 0.6, keep: 0.15 };
  const form = h('div', { class: 'form' },
    h('label', {}, 'Silence threshold (dB)'), numberInput(opts.threshold, { min: -90, max: 0, step: 1, onChange: v => { opts.threshold = v; } }),
    h('label', {}, 'Minimum silence (s)'), numberInput(opts.min, { min: 0.1, max: 30, step: 0.1, onChange: v => { opts.min = v; } }),
    h('label', {}, 'Padding to keep (s)'), numberInput(opts.keep, { min: 0, max: 5, step: 0.05, onChange: v => { opts.keep = v; } }),
  );
  const ok = await new Promise(res => modal({ title: 'Remove silence', body: form, buttons: [{ label: 'Cancel', onClick: c => { c(); res(false); } }, { label: 'Analyze & cut', primary: true, onClick: c => { c(); res(true); } }], onClose: () => res(false) }));
  if (!ok) return;
  let ranges;
  try { ranges = await invoke('detect_silence', { path: m.path, in: clip.in, out: clip.out, thresholdDb: opts.threshold, minDuration: opts.min, customDir: settingsDir() }); }
  catch (e) { toast(`Silence detection failed: ${e}`, 'error', 6000); return; }
  // keep padding at both ends of each silence, drop ranges that become too small
  const cuts = ranges.map(([a, b]) => [a + opts.keep, b - opts.keep]).filter(([a, b]) => b - a > 0.1 && a > clip.in + 0.05 && b < clip.out - 0.05);
  if (!cuts.length) { toast('No silence found with these settings'); return; }
  edit('Remove silence', () => {
    const local = src => clip.start + (src - clip.in) / clip.speed;
    for (const [a, b] of [...cuts].sort((x, y) => y[0] - x[0])) {
      const ta = local(a), tb = local(b);
      const pieces = track.clips.filter(c => c.media_id === clip.media_id && c.start <= ta && tb <= clipEnd(c));
      const piece = pieces[0];
      if (!piece) continue;
      const right = splitClip(track, piece, tb);
      const mid = splitClip(track, piece, ta) || (right ? null : null);
      const middle = mid || track.clips.find(c => Math.abs(c.start - ta) < 1e-6 && c !== piece);
      if (!middle) continue;
      track.clips = track.clips.filter(c => c !== middle);
      const d = tb - ta;
      for (const c of track.clips) if (c.start >= tb - 1e-6) c.start -= d;
    }
  });
  toast(`Removed ${cuts.length} silent part${cuts.length > 1 ? 's' : ''}`, 'success');
}

/** Aligns the second selected clip to the first by matching their audio. */
export async function syncSelected() {
  const items = selectedClips().filter(({ clip }) => clip.media_id && hasAudio(clip, state.project));
  if (items.length !== 2) { toast('Select exactly two clips that have audio'); return; }
  const order = new Map(state.project.tracks.map((t, i) => [t.id, i]));
  items.sort((a, b) => order.get(a.track.id) - order.get(b.track.id));
  const [A, B] = items;
  const ma = state.project.media[A.clip.media_id], mb = state.project.media[B.clip.media_id];
  let lag;
  try { lag = await invoke('sync_offset', { pathA: ma.path, inA: A.clip.in, pathB: mb.path, inB: B.clip.in, maxLag: 60, customDir: settingsDir() }); }
  catch (e) { toast(`Sync failed: ${e}`, 'error', 6000); return; }
  edit('Sync clips', () => {
    let newStart = A.clip.start - lag / (B.clip.speed || 1);
    if (newStart < 0) { const shift = -newStart; for (const t of state.project.tracks) for (const c of t.clips) if (c !== B.clip) c.start += shift; newStart = 0; }
    const free = freePosition(B.track, B.clip, newStart, clipDuration(B.clip));
    if (free == null || Math.abs(free - newStart) > 0.01) toast('Aligned position is blocked by another clip on that track', 'error');
    B.clip.start = free ?? newStart;
  });
  toast(`Synced: offset ${lag.toFixed(3)} s`, 'success');
}

export function toggleReverse() {
  const items = selectedClips().filter(({ clip }) => clip.kind === 'video' || clip.kind === 'audio');
  if (!items.length) return;
  edit('Reverse', () => { for (const { clip } of items) clip.reverse = !clip.reverse; });
}
