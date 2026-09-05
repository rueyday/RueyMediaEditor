// Canvas compositor, playback engine and audio mixer for the preview.
// It approximates the ffmpeg export; "Accurate frame" renders through ffmpeg.

import { state, bus, beginEdit, endEdit, setPlayhead, primaryClip, select } from './state.js';
import { clipDuration, clipEnd, transformAt, cssFilter, gainAt, hasAudio, projectDuration, TRANSITIONS, prevClip, setKeyframe, isVisual, hasExportOnlyEffect, captionsAt, isGenerated } from './model.js';
import { fileSrc, invoke, isTauri } from './bridge.js';
import { h, btn, icon, fmtTimecode, clamp, toast, uid } from './ui.js';

let canvas, ctx, stage, badge, transportEl, timeEl, totalEl, playBtn, loopBtn;
let scaleFactor = 0.5;
const pool = new Map();          // clipId -> { el, src, kind, gain, failed, seekTarget }
let audioCtx = null, master = null;
let clock = null;
let accurate = null;             // { t, img }
let gizmo = null;                // drag state
let hoverCursor = '';
let fontsReady = false;
const customFonts = new Map();   // font file path -> family name (loaded via FontFace)

/** Family name for a custom font file; loads it on first use. */
export function fontFamilyFor(path) {
  if (!path) return 'Inter';
  if (customFonts.has(path)) return customFonts.get(path);
  const family = 'rvefont-' + uid();
  customFonts.set(path, family);
  try {
    const face = new FontFace(family, `url("${fileSrc(path)}")`);
    face.load().then(f => document.fonts.add(f)).catch(() => customFonts.set(path, 'Inter'));
  } catch { customFonts.set(path, 'Inter'); }
  return family;
}
const sourceTime = (clip, t) => clip.reverse ? clip.out - (t - clip.start) * clip.speed : clip.in + (t - clip.start) * clip.speed;

const now = () => performance.now() / 1000; // wall clock; the audio context only mixes
const PW = () => state.project.settings.width;
const PH = () => state.project.settings.height;

export function initPreview(root) {
  canvas = h('canvas', { width: 960, height: 540 });
  ctx = canvas.getContext('2d');
  badge = h('div', { class: 'preview-badge' });
  stage = h('div', { class: 'preview-stage' }, canvas, badge);

  timeEl = h('span', { class: 'timecode' }, '00:00:00:00');
  totalEl = h('span', { class: 'timecode total' }, '00:00:00:00');
  playBtn = btn('', { icon: 'play', class: 'play', title: 'Play / Pause (Space)', onClick: togglePlay });
  loopBtn = btn('', { icon: 'loop', title: 'Loop playback between in/out (or whole timeline)', onClick: () => { state.loop = !state.loop; loopBtn.classList.toggle('active', state.loop); } });
  const volume = h('input', { class: 'range', type: 'range', min: 0, max: 1, step: 0.01, value: 1, title: 'Preview volume', style: { width: '80px' } });
  volume.addEventListener('input', () => { if (master) master.gain.value = parseFloat(volume.value); state.masterVolume = parseFloat(volume.value); });
  transportEl = h('div', { class: 'transport' },
    btn('', { icon: 'start', title: 'Go to start (Home)', onClick: () => seekTo(0) }),
    btn('', { icon: 'prev', title: 'Previous frame (←)', onClick: () => stepFrame(-1) }),
    playBtn,
    btn('', { icon: 'next', title: 'Next frame (→)', onClick: () => stepFrame(1) }),
    btn('', { icon: 'end', title: 'Go to end (End)', onClick: () => seekTo(projectDuration(state.project)) }),
    timeEl, h('span', { class: 'hint' }, '/'), totalEl,
    h('span', { class: 'spacer' }),
    btn('', { icon: 'in', title: 'Mark in point (I)', onClick: () => bus.emit('cmd', 'in') }),
    btn('', { icon: 'out', title: 'Mark out point (O)', onClick: () => bus.emit('cmd', 'out') }),
    loopBtn,
    btn('', { icon: 'camera', title: 'Accurate frame: render this frame with ffmpeg (exact effects and transitions)', onClick: renderAccurate }),
    btn('', { icon: 'download', title: 'Export this frame as an image (PNG/JPEG)', onClick: () => bus.emit('cmd', 'export-frame') }),
    icon('volume'), volume,
  );
  root.append(stage, transportEl);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('dblclick', () => { const p = primaryClip(); if (p) bus.emit('focus-inspector'); });

  bus.on('project', () => { applyQuality(); accurate = null; });
  bus.on('settings', applyQuality);
  bus.on('assets', () => { for (const [id, e] of pool) { const c = clipById(id); if (!c || fileSrc(pathFor(c)) !== e.src) release(id); } });
  bus.on('playhead', () => { if (accurate && Math.abs(accurate.t - state.playhead) > 1e-6) accurate = null; });
  document.fonts?.load('700 20px Inter').then(() => { fontsReady = true; });
  applyQuality();
  requestAnimationFrame(frame);
}

function applyQuality() {
  const q = state.settings.previewQuality;
  scaleFactor = q === 'full' ? 1 : q === 'quarter' ? 0.25 : 0.5;
  const w = Math.round(PW() * scaleFactor), hgt = Math.round(PH() * scaleFactor);
  if (canvas.width !== w || canvas.height !== hgt) { canvas.width = w; canvas.height = hgt; }
}

// ---------- media element pool ----------
function clipById(id) {
  for (const t of state.project.tracks) for (const c of t.clips) if (c.id === id) return c;
  return null;
}
function pathFor(clip) {
  const m = state.project.media[clip.media_id];
  const a = state.assets[clip.media_id];
  return a?.proxy || m?.proxy || m?.path || '';
}
function acquire(clip) {
  const path = pathFor(clip);
  if (!path) return null;
  const src = fileSrc(path);
  let e = pool.get(clip.id);
  if (e && e.src === src) return e;
  if (e) release(clip.id);
  let el;
  if (clip.kind === 'image') {
    el = new Image();
    el.src = src;
  } else {
    el = document.createElement(clip.kind === 'audio' ? 'audio' : 'video');
    el.preload = 'auto';
    el.playsInline = true;
    el.muted = !audioCtx; // silent until routed through the mixer
    el.src = src;
  }
  e = { el, src, kind: clip.kind, gain: null, failed: false, seekTarget: -1, mediaId: clip.media_id };
  el.addEventListener('error', () => onMediaError(clip, e));
  if (audioCtx && clip.kind !== 'image') attachGain(e);
  pool.set(clip.id, e);
  return e;
}
function release(id) {
  const e = pool.get(id);
  if (!e) return;
  try { e.el.pause?.(); e.el.removeAttribute('src'); e.el.load?.(); } catch {}
  if (e.gain) e.gain.disconnect();
  pool.delete(id);
}
function onMediaError(clip, e) {
  if (e.failed) return;
  e.failed = true;
  const a = state.assets[clip.media_id];
  if (!(a && a.proxy) && !e.src.startsWith('data:')) bus.emit('need-proxy', clip.media_id);
}
function attachGain(e) {
  try {
    const src = audioCtx.createMediaElementSource(e.el);
    e.gain = audioCtx.createGain();
    src.connect(e.gain).connect(master);
    e.el.muted = false;
  } catch (err) { console.warn('audio routing failed', err); }
}
function ensureAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  master = audioCtx.createGain();
  master.gain.value = state.masterVolume ?? 1;
  master.connect(audioCtx.destination);
  for (const e of pool.values()) if (e.kind !== 'image' && !e.gain) attachGain(e);
}
export function releaseMedia(mediaId) {
  for (const [id, e] of [...pool]) if (e.mediaId === mediaId) release(id);
}

// ---------- playback ----------
export function play() {
  const dur = projectDuration(state.project);
  if (dur <= 0) return;
  ensureAudio();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  let start = state.playhead;
  const loopEnd = state.loop && state.outPoint != null ? state.outPoint : dur;
  if (start >= loopEnd - 1e-3) start = state.loop && state.inPoint != null ? state.inPoint : 0;
  setPlayhead(start);
  state.playing = true;
  clock = { ph: start, at: now() };
  playBtn.replaceChildren(icon('pause'));
  bus.emit('playing');
}
export function pause() {
  if (!state.playing) return;
  state.playing = false;
  clock = null;
  for (const e of pool.values()) if (e.kind !== 'image' && !e.el.paused) e.el.pause();
  playBtn.replaceChildren(icon('play'));
  bus.emit('playing');
}
export function togglePlay() { state.playing ? pause() : play(); }
export function seekTo(t) {
  const wasPlaying = state.playing;
  if (wasPlaying) pause();
  setPlayhead(clamp(t, 0, Math.max(0, projectDuration(state.project))));
  if (wasPlaying) play();
}
export function stepFrame(n) {
  if (state.playing) pause();
  const f = 1 / (state.project.settings.fps || 30);
  setPlayhead(Math.max(0, Math.round((state.playhead + n * f) * 1e4) / 1e4));
}

function frame() {
  if (state.playing && clock) {
    const dur = projectDuration(state.project);
    const end = state.loop && state.outPoint != null ? state.outPoint : dur;
    const begin = state.loop && state.inPoint != null ? state.inPoint : 0;
    let t = clock.ph + (now() - clock.at);
    if (t >= end) {
      if (state.loop && end > begin) { t = begin; clock = { ph: begin, at: now() }; }
      else { setPlayhead(end); pause(); }
    }
    if (state.playing) setPlayhead(t);
  }
  syncMedia();
  draw();
  timeEl.textContent = fmtTimecode(state.playhead, state.project.settings.fps);
  totalEl.textContent = fmtTimecode(projectDuration(state.project), state.project.settings.fps);
  requestAnimationFrame(frame);
}

function trackAudible(track) {
  const anySolo = state.project.tracks.some(t => t.solo);
  return !track.muted && (!anySolo || track.solo);
}

/** Which clips are "on screen" at t, including a previous clip during a transition. */
function activeAt(t) {
  const out = [];
  for (const track of state.project.tracks) {
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      if (c.start <= t && t < clipEnd(c)) out.push({ clip: c, track, local: sourceTime(c, t) });
      const nx = sorted[i + 1];
      if (nx && nx.transition_in && Math.abs(nx.start - clipEnd(c)) < 0.002 && t >= nx.start && t < nx.start + nx.transition_in.duration) {
        out.push({ clip: c, track, local: Math.max(0, sourceTime(c, t)), extended: true });
      }
    }
  }
  return out;
}

function syncMedia() {
  const t = state.playhead;
  const active = activeAt(t);
  const keep = new Set();
  // Preload clips shortly ahead.
  for (const track of state.project.tracks) for (const c of track.clips) {
    if (c.media_id && c.start - 4 <= t && t < clipEnd(c) + 1) { keep.add(c.id); acquire(c); }
  }
  const playingIds = new Set();
  for (const { clip, track, local } of active) {
    if (!clip.media_id) continue;
    const e = acquire(clip);
    if (!e || e.kind === 'image') continue;
    const el = e.el;
    playingIds.add(clip.id);
    const visual = isVisual(clip) && !track.hidden;
    const audible = hasAudio(clip, state.project) && !clip.muted && trackAudible(track);
    if (!visual && !audible) { if (!el.paused) el.pause(); continue; }
    const g = audible && !clip.reverse ? gainAt(clip, t - clip.start) : 0;
    if (e.gain) e.gain.gain.value = g;
    if (state.playing && clip.reverse) {
      // Media elements cannot play backwards: step by seeking a few times a second.
      if (!el.paused) el.pause();
      const nowMs = performance.now();
      if (!e.lastSeek || nowMs - e.lastSeek > 120) { e.lastSeek = nowMs; e.seekTarget = local; el.currentTime = local; }
    } else if (state.playing) {
      el.playbackRate = clamp(clip.speed, 0.0625, 16);
      if (el.paused) {
        el.currentTime = local;
        el.play().catch(() => {});
      } else if (!el.seeking && Math.abs(el.currentTime - local) > 0.2) {
        el.currentTime = local;
      }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(e.seekTarget - local) > 1e-3 && !el.seeking) { e.seekTarget = local; el.currentTime = local; }
      else if (Math.abs(e.seekTarget - local) > 1e-3) { e.seekTarget = local; el.currentTime = local; }
    }
  }
  for (const [id, e] of pool) {
    if (!keep.has(id)) { release(id); continue; }
    if (!playingIds.has(id) && e.kind !== 'image' && !e.el.paused) e.el.pause();
  }
}

// ---------- drawing ----------
function draw() {
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (accurate && !state.playing && accurate.img.complete) {
    ctx.drawImage(accurate.img, 0, 0, W, H);
    drawGizmo();
    return;
  }
  const t = state.playhead;
  const videoTracks = state.project.tracks.filter(tr => tr.kind === 'video');
  for (let i = videoTracks.length - 1; i >= 0; i--) {
    const track = videoTracks[i];
    if (track.hidden) continue;
    const sorted = [...track.clips].sort((a, b) => a.start - b.start);
    for (let j = 0; j < sorted.length; j++) {
      const clip = sorted[j];
      if (!(clip.start <= t && t < clipEnd(clip))) continue;
      const tr = clip.transition_in;
      const prev = j > 0 ? sorted[j - 1] : null;
      if (tr && tr.duration > 0 && t < clip.start + tr.duration) {
        const adjacent = prev && Math.abs(clipEnd(prev) - clip.start) < 0.002;
        const p = clamp((t - clip.start) / tr.duration, 0, 1);
        if (adjacent) drawTransition(prev, clip, t, p, tr.type);
        else drawClip(clip, t, p); // fade in from transparent
      } else if (clip.transition_out && clip.transition_out.duration > 0 && t > clipEnd(clip) - clip.transition_out.duration) {
        const nx = sorted[j + 1];
        const adjacent = nx && Math.abs(nx.start - clipEnd(clip)) < 0.002 && nx.transition_in;
        if (adjacent) drawClip(clip, t, 1);
        else drawClip(clip, t, clamp((clipEnd(clip) - t) / clip.transition_out.duration, 0, 1));
      } else {
        drawClip(clip, t, 1);
      }
      break;
    }
  }
  drawCaptions(t);
  drawGizmo();
  updateBadge();
}

function sourceSize(clip, e) {
  const m = state.project.media[clip.media_id];
  if (e && e.kind === 'image' && e.el.naturalWidth) return [e.el.naturalWidth, e.el.naturalHeight];
  if (e && e.el.videoWidth) return [e.el.videoWidth, e.el.videoHeight];
  if (m && m.width) return [m.width, m.height];
  return [PW(), PH()];
}

/** Rectangle (project px, before rotation) the clip occupies at time t. */
export function clipRect(clip, t) {
  const tf = transformAt(clip, t - clip.start);
  let w, hgt;
  if (isGenerated(clip)) { w = PW(); hgt = PH(); }
  else {
    const [sw, sh] = sourceSize(clip, pool.get(clip.id));
    const c = clip.crop;
    const fit = Math.min(PW() / sw, PH() / sh);
    w = sw * (1 - c.left - c.right) * fit;
    hgt = sh * (1 - c.top - c.bottom) * fit;
  }
  return { cx: PW() / 2 + tf.x, cy: PH() / 2 + tf.y, w: w * tf.scale, h: hgt * tf.scale, rotation: tf.rotation, tf };
}

function drawClip(clip, t, alpha) {
  const s = scaleFactor;
  const r = clipRect(clip, t);
  if (r.tf.opacity * alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha *= clamp(r.tf.opacity * alpha, 0, 1);
  ctx.translate(r.cx * s, r.cy * s);
  ctx.rotate(r.rotation * Math.PI / 180);
  ctx.filter = cssFilter(clip.effects, s);
  const flip = (clip.effects || []).find(e => e.type === 'flip' && e.enabled);
  if (flip) ctx.scale(flip.params.horizontal ? -1 : 1, flip.params.vertical ? -1 : 1);
  const dw = r.w * s, dh = r.h * s;
  if (clip.kind === 'color') {
    ctx.fillStyle = clip.color || '#000';
    ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
  } else if (clip.kind === 'title') {
    drawTitle(clip, r.tf.scale * s);
  } else if (clip.kind === 'shape') {
    drawShape(clip.shape, r.tf.scale * s, ctx);
  } else if (clip.kind === 'timecode') {
    drawTimecode(clip, t, r.tf.scale * s);
  } else {
    const e = pool.get(clip.id);
    const ready = e && (e.kind === 'image' ? e.el.complete && e.el.naturalWidth : e.el.readyState >= 2);
    if (ready) {
      const [sw, sh] = sourceSize(clip, e);
      const c = clip.crop;
      ctx.drawImage(e.el, sw * c.left, sh * c.top, sw * (1 - c.left - c.right), sh * (1 - c.top - c.bottom), -dw / 2, -dh / 2, dw, dh);
    } else {
      ctx.fillStyle = e && e.failed ? '#3a1f1f' : '#1b1e26';
      ctx.fillRect(-dw / 2, -dh / 2, dw, dh);
      ctx.fillStyle = '#8a93a6';
      ctx.font = `${Math.max(10, 14 * s * 2)}px Inter, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(e && e.failed ? 'Cannot decode, making proxy…' : 'Loading…', 0, 0);
    }
  }
  ctx.restore();
}

function drawTitle(clip, k) {
  const tt = clip.title || {};
  const size = (tt.font_size || 72) * k;
  const weight = tt.weight === 'bold' ? 700 : 400;
  ctx.font = `${weight} ${size}px "${fontFamilyFor(tt.font_file)}", Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  const lines = String(tt.text || '').split('\n');
  const lh = size * (tt.line_height || 1.2);
  const widths = lines.map(l => ctx.measureText(l).width);
  const blockW = Math.max(0, ...widths);
  const blockH = lh * lines.length;
  const frameW = PW() * k;
  const align = tt.align || 'center';
  const x0 = align === 'left' ? -frameW / 2 + frameW * 0.05 : align === 'right' ? frameW / 2 - frameW * 0.05 - blockW : -blockW / 2;
  const y0 = -blockH / 2;
  if (tt.background) {
    const pad = (tt.padding || 0) * k;
    ctx.fillStyle = tt.background;
    ctx.fillRect(x0 - pad, y0 - pad, blockW + pad * 2, blockH + pad * 2);
  }
  if (tt.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowOffsetX = size * 0.04; ctx.shadowOffsetY = size * 0.04; }
  ctx.fillStyle = tt.color || '#fff';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    const lx = align === 'center' ? x0 + (blockW - widths[i]) / 2 : align === 'right' ? x0 + blockW - widths[i] : x0;
    ctx.fillText(line, lx, y0 + i * lh + (lh - size) / 2);
  });
  ctx.shadowColor = 'transparent';
}

/** Draws a shape centred at the origin in a frame of PW*k by PH*k. Also used to rasterise shapes for export. */
export function drawShape(shape, k, g) {
  const sh = shape || {};
  const w = PW() * (sh.w ?? 0.3) * k, hgt = PH() * (sh.h ?? 0.2) * k;
  const lw = Math.max(1, (sh.stroke_width ?? 8) * k);
  g.lineWidth = lw;
  g.strokeStyle = sh.stroke || '#ff3b30';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  switch (sh.kind) {
    case 'ellipse':
      g.beginPath(); g.ellipse(0, 0, Math.max(1, w / 2), Math.max(1, hgt / 2), 0, 0, Math.PI * 2);
      if (sh.fill) { g.fillStyle = sh.fill; g.fill(); }
      g.stroke();
      break;
    case 'line':
      g.beginPath(); g.moveTo(-w / 2, 0); g.lineTo(w / 2, 0); g.stroke();
      break;
    case 'arrow': {
      const head = Math.max(lw * 3, w * 0.12);
      g.beginPath(); g.moveTo(-w / 2, 0); g.lineTo(w / 2 - head * 0.6, 0); g.stroke();
      g.beginPath(); g.moveTo(w / 2, 0); g.lineTo(w / 2 - head, -head * 0.55); g.lineTo(w / 2 - head, head * 0.55); g.closePath();
      g.fillStyle = sh.stroke || '#ff3b30'; g.fill();
      break;
    }
    default:
      if (sh.fill) { g.fillStyle = sh.fill; g.fillRect(-w / 2, -hgt / 2, w, hgt); }
      g.strokeRect(-w / 2, -hgt / 2, w, hgt);
  }
}

export function timecodeText(clip, t) {
  const tc = clip.timecode || {};
  const base = tc.source === 'clip' ? t - clip.start : t;
  const v = Math.max(0, base + (tc.offset || 0));
  let text;
  if (tc.format === 'frames') text = String(Math.round(v * (state.project.settings.fps || 30)));
  else {
    const hh = Math.floor(v / 3600), mm = Math.floor(v / 60) % 60, ss = Math.floor(v % 60), ms = Math.floor((v - Math.floor(v)) * 1000);
    text = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }
  return (tc.label ? tc.label + ' ' : '') + text;
}

function drawTimecode(clip, t, k) {
  const tc = clip.timecode || {};
  const size = (tc.font_size || 40) * k;
  const m = size * 0.5;
  ctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const text = timecodeText(clip, t);
  const tw = ctx.measureText(text).width;
  const fw = PW() * k, fh = PH() * k;
  const pos = tc.position || 'top-left';
  const x = pos.endsWith('right') ? fw / 2 - m - tw : pos.endsWith('center') ? -tw / 2 : -fw / 2 + m;
  const y = pos.startsWith('bottom') ? fh / 2 - m - size : -fh / 2 + m;
  if (tc.background) { ctx.fillStyle = tc.background; const pad = size * 0.25; ctx.fillRect(x - pad, y - pad, tw + pad * 2, size + pad * 2); }
  ctx.fillStyle = tc.color || '#fff';
  ctx.fillText(text, x, y);
}

function drawCaptions(t) {
  const caps = captionsAt(state.project, t);
  if (!caps.length) return;
  const st = state.project.caption_style || {};
  const s = scaleFactor, W = canvas.width, H = canvas.height;
  const size = (st.font_size || 48) * s;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.font = `${st.weight === 'regular' ? 400 : 700} ${size}px "${fontFamilyFor(st.font_file)}", Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  const lines = caps.flatMap(c => c.text.split('\n'));
  const lh = size * 1.2;
  const blockH = lh * lines.length;
  const margin = (st.margin ?? 60) * s;
  const y0 = st.position === 'top' ? margin : H - margin - blockH;
  const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
  if (st.background) { ctx.fillStyle = st.background; const pad = size * 0.25; ctx.fillRect(W / 2 - widest / 2 - pad, y0 - pad, widest + pad * 2, blockH + pad * 2); }
  ctx.fillStyle = st.color || '#fff';
  lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * lh + (lh - size) / 2));
  ctx.restore();
}

function drawTransition(prev, cur, t, p, type) {
  const def = TRANSITIONS.find(x => x.id === type)?.preview || 'crossfade';
  const s = scaleFactor, W = canvas.width, H = canvas.height;
  switch (def) {
    case 'fadeblack':
      drawClip(prev, t, 1 - Math.min(1, p * 2));
      drawClip(cur, t, Math.max(0, p * 2 - 1));
      break;
    case 'fadewhite':
      drawClip(prev, t, 1);
      drawClip(cur, t, p > 0.5 ? (p - 0.5) * 2 : 0);
      ctx.save(); ctx.globalAlpha = 1 - Math.abs(2 * p - 1); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore();
      break;
    case 'wipe': {
      drawClip(prev, t, 1);
      ctx.save(); ctx.beginPath();
      if (type === 'wipeleft') ctx.rect(W * (1 - p), 0, W * p, H);
      else if (type === 'wiperight') ctx.rect(0, 0, W * p, H);
      else if (type === 'wipeup') ctx.rect(0, H * (1 - p), W, H * p);
      else ctx.rect(0, 0, W, H * p);
      ctx.clip(); drawClip(cur, t, 1); ctx.restore();
      break;
    }
    case 'slide': {
      const dx = type === 'slideleft' ? -1 : type === 'slideright' ? 1 : 0;
      const dy = type === 'slideup' ? -1 : type === 'slidedown' ? 1 : 0;
      ctx.save(); ctx.translate(dx * W * p, dy * H * p); drawClip(prev, t, 1); ctx.restore();
      ctx.save(); ctx.translate(-dx * W * (1 - p), -dy * H * (1 - p)); drawClip(cur, t, 1); ctx.restore();
      break;
    }
    case 'circle': {
      const R = Math.hypot(W, H) / 2;
      if (type === 'circleopen') {
        drawClip(cur, t, 1);
        ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H / 2, R * (1 - p), 0, Math.PI * 2); ctx.clip(); drawClip(prev, t, 1); ctx.restore();
      } else {
        drawClip(prev, t, 1);
        ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H / 2, R * p, 0, Math.PI * 2); ctx.clip(); drawClip(cur, t, 1); ctx.restore();
      }
      break;
    }
    default:
      drawClip(prev, t, 1);
      drawClip(cur, t, p);
  }
  void s;
}

function updateBadge() {
  const items = [];
  const t = state.playhead;
  const approx = activeAt(t).some(({ clip }) => hasExportOnlyEffect(clip) || (clip.transition_in && t < clip.start + clip.transition_in.duration && ['crossfade', 'fade', 'fadewhite', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'slideleft', 'slideright', 'slideup', 'slidedown', 'circleopen', 'circleclose'].indexOf(clip.transition_in.type) < 0));
  if (approx && !accurate) items.push(h('span', { class: 'pill warn', title: 'Some effects or transitions here are approximated in the preview. Press the camera button for an exact frame.' }, h('span', { class: 'dot' }), 'approximate'));
  if (accurate) items.push(h('span', { class: 'pill ok' }, h('span', { class: 'dot' }), 'ffmpeg frame'));
  if (badge.childElementCount !== items.length) badge.replaceChildren(...items);
}

async function renderAccurate() {
  if (state.playing) pause();
  if (!isTauri) { toast('Accurate preview needs the desktop app', 'error'); return; }
  const t = state.playhead;
  try {
    const path = await invoke('render_frame', { project: state.project, time: t, width: canvas.width, customDir: state.settings.ffmpegDir || null });
    const img = new Image();
    img.onload = () => { if (Math.abs(state.playhead - t) < 1e-6) accurate = { t, img }; };
    img.src = fileSrc(path) + '?' + Date.now();
  } catch (e) {
    toast(`Frame render failed: ${e}`, 'error', 6000);
  }
}

// ---------- gizmo: move / scale / rotate the selected clip on the canvas ----------
function gizmoTarget() {
  if (state.playing || state.selection.size !== 1) return null;
  const p = primaryClip();
  if (!p || !isVisual(p.clip) || p.track.hidden) return null;
  const t = state.playhead;
  if (!(p.clip.start <= t && t < clipEnd(p.clip))) return null;
  return p;
}
function handlePoints(r) {
  const s = scaleFactor;
  const cos = Math.cos(r.rotation * Math.PI / 180), sin = Math.sin(r.rotation * Math.PI / 180);
  const pt = (lx, ly) => ({ x: (r.cx + lx * cos - ly * sin) * s, y: (r.cy + lx * sin + ly * cos) * s });
  const hw = r.w / 2, hh = r.h / 2;
  return {
    corners: [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)],
    rotate: pt(0, -hh - 40 / s),
    top: pt(0, -hh),
    center: pt(0, 0),
  };
}
function drawGizmo() {
  const target = gizmoTarget();
  if (!target) { canvas.classList.remove('gizmo-cursor'); return; }
  const r = clipRect(target.clip, state.playhead);
  const hp = handlePoints(r);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.filter = 'none';
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#4f8cff';
  ctx.beginPath();
  hp.corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath(); ctx.moveTo(hp.top.x, hp.top.y); ctx.lineTo(hp.rotate.x, hp.rotate.y); ctx.stroke();
  ctx.fillStyle = '#fff';
  for (const c of hp.corners) { ctx.beginPath(); ctx.rect(c.x - 5, c.y - 5, 10, 10); ctx.fill(); ctx.stroke(); }
  ctx.beginPath(); ctx.arc(hp.rotate.x, hp.rotate.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.restore();
}
function canvasPoint(ev) {
  const b = canvas.getBoundingClientRect();
  return { x: (ev.clientX - b.left) * canvas.width / b.width, y: (ev.clientY - b.top) * canvas.height / b.height };
}
function hitGizmo(pt) {
  const target = gizmoTarget();
  if (!target) return null;
  const r = clipRect(target.clip, state.playhead);
  const hp = handlePoints(r);
  const near = (a, d) => Math.hypot(a.x - pt.x, a.y - pt.y) <= d;
  if (near(hp.rotate, 10)) return { mode: 'rotate', target, r };
  for (let i = 0; i < 4; i++) if (near(hp.corners[i], 9)) return { mode: 'scale', corner: i, target, r };
  // inside the (rotated) rect?
  const s = scaleFactor;
  const cos = Math.cos(-r.rotation * Math.PI / 180), sin = Math.sin(-r.rotation * Math.PI / 180);
  const dx = pt.x / s - r.cx, dy = pt.y / s - r.cy;
  const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
  if (Math.abs(lx) <= r.w / 2 && Math.abs(ly) <= r.h / 2) return { mode: 'move', target, r };
  return null;
}
function topClipAt(pt) {
  const t = state.playhead;
  const s = scaleFactor;
  for (const track of state.project.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    for (const clip of track.clips) {
      if (!(clip.start <= t && t < clipEnd(clip))) continue;
      const r = clipRect(clip, t);
      const cos = Math.cos(-r.rotation * Math.PI / 180), sin = Math.sin(-r.rotation * Math.PI / 180);
      const dx = pt.x / s - r.cx, dy = pt.y / s - r.cy;
      const lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
      if (Math.abs(lx) <= r.w / 2 && Math.abs(ly) <= r.h / 2) return { clip, track };
    }
  }
  return null;
}
function setProp(clip, key, value) {
  const local = state.playhead - clip.start;
  if (clip.keyframes?.[key]?.length) setKeyframe(clip, key, local, value);
  else clip.transform[key] = value;
}
function onPointerDown(ev) {
  if (ev.button !== 0) return;
  const pt = canvasPoint(ev);
  const hit = hitGizmo(pt);
  if (!hit) {
    const found = topClipAt(pt);
    if (found) select([found.clip.id]);
    return;
  }
  ev.preventDefault();
  canvas.setPointerCapture(ev.pointerId);
  const { clip } = hit.target;
  const tf = transformAt(clip, state.playhead - clip.start);
  gizmo = { ...hit, clip, start: pt, tf0: { ...tf }, token: beginEdit(hit.mode === 'move' ? 'Move' : hit.mode === 'scale' ? 'Scale' : 'Rotate') };
}
function onPointerMove(ev) {
  const pt = canvasPoint(ev);
  if (!gizmo) {
    const hit = hitGizmo(pt);
    const cur = hit ? (hit.mode === 'move' ? 'move' : hit.mode === 'rotate' ? 'grab' : 'nwse-resize') : '';
    if (cur !== hoverCursor) { hoverCursor = cur; canvas.style.cursor = cur; }
    return;
  }
  const s = scaleFactor;
  const { clip, tf0, r } = gizmo;
  if (gizmo.mode === 'move') {
    setProp(clip, 'x', Math.round(tf0.x + (pt.x - gizmo.start.x) / s));
    setProp(clip, 'y', Math.round(tf0.y + (pt.y - gizmo.start.y) / s));
  } else if (gizmo.mode === 'scale') {
    const c = { x: r.cx * s, y: r.cy * s };
    const d0 = Math.hypot(gizmo.start.x - c.x, gizmo.start.y - c.y) || 1;
    const d1 = Math.hypot(pt.x - c.x, pt.y - c.y);
    setProp(clip, 'scale', Math.max(0.02, Math.round(tf0.scale * d1 / d0 * 1000) / 1000));
  } else if (gizmo.mode === 'rotate') {
    const c = { x: r.cx * s, y: r.cy * s };
    const a0 = Math.atan2(gizmo.start.y - c.y, gizmo.start.x - c.x);
    const a1 = Math.atan2(pt.y - c.y, pt.x - c.x);
    let deg = tf0.rotation + (a1 - a0) * 180 / Math.PI;
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    setProp(clip, 'rotation', Math.round(deg * 10) / 10);
  }
  bus.emit('transform-live', clip.id);
}
function onPointerUp(ev) {
  if (!gizmo) return;
  const token = gizmo.token;
  gizmo = null;
  try { canvas.releasePointerCapture(ev.pointerId); } catch {}
  endEdit(token);
}
