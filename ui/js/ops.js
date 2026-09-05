// Editing operations on the project. Used by the timeline, menus and shortcuts.

import { state, bus, edit, select, clearSelection, selectedClips, setPlayhead } from './state.js';
import { newClip, newTrack, newTitle, clipDuration, clipEnd, findClip, overlaps, freePosition, isVisual, hasAudio, projectDuration, prevClip, nextClip, sortedClips } from './model.js';
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

export function insertGenerated(kind, { at = null, trackId = null } = {}) {
  const duration = state.settings.defaultTitleDuration;
  let track = trackId ? state.project.tracks.find(t => t.id === trackId && t.kind === 'video') : null;
  if (!track) track = state.project.tracks.find(t => t.kind === 'video' && !t.locked);
  const start = at ?? state.playhead;
  const clip = newClip({
    kind, start, in: 0, out: duration,
    name: kind === 'title' ? 'Title' : 'Color',
    title: kind === 'title' ? newTitle('Your title') : null,
    color: kind === 'color' ? '#1f6feb' : null,
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
