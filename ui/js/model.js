// Project data model and pure helpers. Mirrors src-tauri/src/project.rs.
// The front end is the source of truth; the whole project is sent to Rust for export.

import { uid, clamp } from './ui.js';

export const PROJECT_VERSION = 1;

export const RESOLUTIONS = [
  { label: '1080p · 1920×1080', w: 1920, h: 1080 },
  { label: '4K UHD · 3840×2160', w: 3840, h: 2160 },
  { label: '720p · 1280×720', w: 1280, h: 720 },
  { label: 'Vertical 1080×1920', w: 1080, h: 1920 },
  { label: 'Square 1080×1080', w: 1080, h: 1080 },
  { label: '2K DCI · 2048×1080', w: 2048, h: 1080 },
  { label: '4K DCI · 4096×2160', w: 4096, h: 2160 },
];
export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

export function newProject(name = 'Untitled') {
  return {
    version: PROJECT_VERSION,
    name,
    settings: { width: 1920, height: 1080, fps: 30, sample_rate: 48000 },
    media: {},
    tracks: [
      newTrack('video', 'V2'),
      newTrack('video', 'V1'),
      newTrack('audio', 'A1'),
    ],
    markers: [],
  };
}

export function newTrack(kind, name) {
  return { id: uid(), kind, name: name || (kind === 'video' ? 'Video' : 'Audio'), muted: false, solo: false, hidden: false, locked: false, clips: [] };
}

export function defaultTransform() {
  return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
}

export function newClip(props) {
  return {
    id: uid(),
    kind: 'video',
    media_id: null,
    start: 0,
    in: 0,
    out: 0,
    speed: 1,
    volume: 1,
    muted: false,
    audio_detached: false,
    fade_in: 0,
    fade_out: 0,
    transform: defaultTransform(),
    keyframes: {},
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    effects: [],
    transition_in: null,
    transition_out: null,
    title: null,
    color: null,
    name: '',
    ...props,
  };
}

export function newTitle(text = 'Title') {
  return { text, font_size: 96, color: '#ffffff', weight: 'bold', align: 'center', background: null, padding: 24, shadow: true, line_height: 1.2 };
}

export const clipDuration = c => Math.max(0, (c.out - c.in) / (c.speed > 0 ? c.speed : 1));
export const clipEnd = c => c.start + clipDuration(c);
export const isVisual = c => c.kind !== 'audio';
export const hasAudio = (c, project) => {
  if (c.kind === 'audio') return true;
  if (c.kind !== 'video' || c.audio_detached) return false;
  const m = project.media[c.media_id];
  return !!(m && m.has_audio);
};

export function projectDuration(p) {
  let d = 0;
  for (const t of p.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
  return d;
}

export function findClip(p, id) {
  for (const track of p.tracks) {
    const clip = track.clips.find(c => c.id === id);
    if (clip) return { clip, track };
  }
  return null;
}

export function clipsAt(p, t) {
  const out = [];
  for (const track of p.tracks) for (const c of track.clips) if (c.start <= t && t < clipEnd(c)) out.push({ clip: c, track });
  return out;
}

export function sortedClips(track) {
  return [...track.clips].sort((a, b) => a.start - b.start);
}

export function prevClip(track, clip) {
  let best = null;
  for (const c of track.clips) if (c !== clip && clipEnd(c) <= clip.start + 1e-6 && (!best || c.start > best.start)) best = c;
  return best;
}
export function nextClip(track, clip) {
  let best = null;
  for (const c of track.clips) if (c !== clip && c.start >= clipEnd(clip) - 1e-6 && (!best || c.start < best.start)) best = c;
  return best;
}

/** True when `clip` (with proposed start/duration) overlaps another clip on the track. */
export function overlaps(track, clip, start = clip.start, duration = clipDuration(clip)) {
  const end = start + duration;
  return track.clips.some(c => c !== clip && c.start < end - 1e-6 && clipEnd(c) > start + 1e-6);
}

/** Nearest free start position on `track` for a clip of `duration` near `start`. */
export function freePosition(track, clip, start, duration) {
  if (!overlaps(track, clip, start, duration)) return start;
  const others = track.clips.filter(c => c !== clip).sort((a, b) => a.start - b.start);
  const candidates = [0];
  for (const c of others) { candidates.push(clipEnd(c)); candidates.push(c.start - duration); }
  let best = null;
  for (const s of candidates) {
    if (s < 0) continue;
    if (!overlaps(track, clip, s, duration) && (best === null || Math.abs(s - start) < Math.abs(best - start))) best = s;
  }
  return best;
}

// ---------- keyframes ----------
export const KEYFRAMABLE = ['x', 'y', 'scale', 'rotation', 'opacity'];

export function kfValue(clip, key, tLocal) {
  const kfs = clip.keyframes?.[key];
  const base = clip.transform[key];
  if (!kfs || !kfs.length) return base;
  const k = [...kfs].sort((a, b) => a.t - b.t);
  if (tLocal <= k[0].t) return k[0].v;
  if (tLocal >= k[k.length - 1].t) return k[k.length - 1].v;
  for (let i = 0; i < k.length - 1; i++) {
    const a = k[i], b = k[i + 1];
    if (tLocal < b.t) {
      let p = (tLocal - a.t) / Math.max(1e-6, b.t - a.t);
      if (a.ease === 'ease') p = p * p * (3 - 2 * p);
      return a.v + (b.v - a.v) * p;
    }
  }
  return base;
}

export function transformAt(clip, tLocal) {
  const out = { ...clip.transform };
  for (const k of KEYFRAMABLE) out[k] = kfValue(clip, k, tLocal);
  return out;
}

export function setKeyframe(clip, key, tLocal, value) {
  if (!clip.keyframes) clip.keyframes = {};
  const list = clip.keyframes[key] || (clip.keyframes[key] = []);
  const existing = list.find(k => Math.abs(k.t - tLocal) < 1e-3);
  if (existing) existing.v = value;
  else list.push({ t: tLocal, v: value, ease: 'linear' });
  list.sort((a, b) => a.t - b.t);
}
export function removeKeyframe(clip, key, tLocal) {
  const list = clip.keyframes?.[key];
  if (!list) return;
  const i = list.findIndex(k => Math.abs(k.t - tLocal) < 1e-3);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) delete clip.keyframes[key];
}
export function keyframeAt(clip, key, tLocal) {
  return clip.keyframes?.[key]?.find(k => Math.abs(k.t - tLocal) < 1e-3) || null;
}

/** Audio gain multiplier from fades at local time. */
export function fadeGain(clip, tLocal) {
  const d = clipDuration(clip);
  let g = 1;
  if (clip.fade_in > 0 && tLocal < clip.fade_in) g *= clamp(tLocal / clip.fade_in, 0, 1);
  if (clip.fade_out > 0 && tLocal > d - clip.fade_out) g *= clamp((d - tLocal) / clip.fade_out, 0, 1);
  return g;
}

// ---------- transitions ----------
// Names are ffmpeg xfade transitions; "crossfade" maps to xfade "fade".
export const TRANSITIONS = [
  { id: 'crossfade', name: 'Cross dissolve', preview: 'crossfade' },
  { id: 'fade', name: 'Fade through black', preview: 'fadeblack' },
  { id: 'fadewhite', name: 'Fade through white', preview: 'fadewhite' },
  { id: 'wipeleft', name: 'Wipe left', preview: 'wipe' },
  { id: 'wiperight', name: 'Wipe right', preview: 'wipe' },
  { id: 'wipeup', name: 'Wipe up', preview: 'wipe' },
  { id: 'wipedown', name: 'Wipe down', preview: 'wipe' },
  { id: 'slideleft', name: 'Slide left', preview: 'slide' },
  { id: 'slideright', name: 'Slide right', preview: 'slide' },
  { id: 'slideup', name: 'Slide up', preview: 'slide' },
  { id: 'slidedown', name: 'Slide down', preview: 'slide' },
  { id: 'circleopen', name: 'Circle open', preview: 'circle' },
  { id: 'circleclose', name: 'Circle close', preview: 'circle' },
  { id: 'smoothleft', name: 'Smooth left', preview: 'crossfade' },
  { id: 'smoothright', name: 'Smooth right', preview: 'crossfade' },
  { id: 'radial', name: 'Radial', preview: 'crossfade' },
  { id: 'zoomin', name: 'Zoom in', preview: 'crossfade' },
  { id: 'pixelize', name: 'Pixelize', preview: 'crossfade' },
  { id: 'hblur', name: 'Blur', preview: 'crossfade' },
  { id: 'dissolve', name: 'Noise dissolve', preview: 'crossfade' },
  { id: 'squeezeh', name: 'Squeeze horizontal', preview: 'crossfade' },
  { id: 'squeezev', name: 'Squeeze vertical', preview: 'crossfade' },
  { id: 'diagtl', name: 'Diagonal', preview: 'crossfade' },
];

// ---------- effects ----------
// `preview` says whether the canvas can approximate it; otherwise the badge
// "export only" is shown and "Accurate frame" renders it through ffmpeg.
export const EFFECTS = {
  color: { name: 'Color correction', preview: true, params: [
    { key: 'brightness', name: 'Brightness', min: -1, max: 1, step: 0.01, def: 0 },
    { key: 'contrast', name: 'Contrast', min: 0, max: 3, step: 0.01, def: 1 },
    { key: 'saturation', name: 'Saturation', min: 0, max: 3, step: 0.01, def: 1 },
    { key: 'gamma', name: 'Gamma', min: 0.1, max: 3, step: 0.01, def: 1 },
    { key: 'hue', name: 'Hue', min: -180, max: 180, step: 1, def: 0 },
  ] },
  blur: { name: 'Blur', preview: true, params: [{ key: 'radius', name: 'Radius', min: 0, max: 50, step: 0.5, def: 4 }] },
  sharpen: { name: 'Sharpen', preview: false, params: [{ key: 'amount', name: 'Amount', min: 0, max: 3, step: 0.05, def: 1 }] },
  flip: { name: 'Flip', preview: true, params: [
    { key: 'horizontal', name: 'Horizontal', type: 'bool', def: true },
    { key: 'vertical', name: 'Vertical', type: 'bool', def: false },
  ] },
  grayscale: { name: 'Black & white', preview: true, params: [] },
  sepia: { name: 'Sepia', preview: true, params: [] },
  invert: { name: 'Invert', preview: true, params: [] },
  vignette: { name: 'Vignette', preview: true, params: [{ key: 'angle', name: 'Strength', min: 0, max: 1.5, step: 0.01, def: 0.6 }] },
  chromakey: { name: 'Chroma key', preview: false, params: [
    { key: 'color', name: 'Key color', type: 'color', def: '#00ff00' },
    { key: 'similarity', name: 'Similarity', min: 0.01, max: 1, step: 0.01, def: 0.3 },
    { key: 'blend', name: 'Blend', min: 0, max: 1, step: 0.01, def: 0.1 },
  ] },
  lut: { name: 'LUT (.cube)', preview: false, params: [{ key: 'path', name: 'File', type: 'file', def: '' }] },
  noise: { name: 'Film grain', preview: false, params: [{ key: 'strength', name: 'Strength', min: 0, max: 100, step: 1, def: 20 }] },
};

export function newEffect(type) {
  const def = EFFECTS[type];
  const params = {};
  for (const p of def.params) params[p.key] = p.def;
  return { type, params, enabled: true };
}

/** CSS filter string approximating the effect stack for canvas preview. */
export function cssFilter(effects, pxScale = 1) {
  const parts = [];
  for (const e of effects || []) {
    if (!e.enabled) continue;
    const p = e.params || {};
    switch (e.type) {
      case 'color':
        parts.push(`brightness(${1 + (p.brightness ?? 0)}) contrast(${p.contrast ?? 1}) saturate(${p.saturation ?? 1})`);
        if (p.hue) parts.push(`hue-rotate(${p.hue}deg)`);
        break;
      case 'blur': parts.push(`blur(${(p.radius ?? 4) * pxScale}px)`); break;
      case 'grayscale': parts.push('grayscale(1)'); break;
      case 'sepia': parts.push('sepia(1)'); break;
      case 'invert': parts.push('invert(1)'); break;
      default: break;
    }
  }
  return parts.join(' ') || 'none';
}
export function hasExportOnlyEffect(clip) {
  return (clip.effects || []).some(e => e.enabled && EFFECTS[e.type] && !EFFECTS[e.type].preview);
}
