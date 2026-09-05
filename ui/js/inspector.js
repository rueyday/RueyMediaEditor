// Inspector: properties of the selected clip or track.

import { state, bus, edit, beginEdit, endEdit, primaryClip, selectedClips } from './state.js';
import { KEYFRAMABLE, kfValue, setKeyframe, removeKeyframe, keyframeAt, clipDuration, clipEnd, isVisual, hasAudio, TRANSITIONS, EFFECTS, newEffect, prevClip, nextClip, transformAt } from './model.js';
import * as ops from './ops.js';
import { h, btn, icon, propRow, numberInput, rangeInput, selectInput, fmtTimecode, fmtNum, clamp, toast } from './ui.js';
import { dialog } from './bridge.js';

let root, body, current = null, liveToken = null;
const kfControls = new Map(); // key -> { range, num, diamond }

export function initInspector(el) {
  root = el;
  body = h('div', { class: 'panel-body inspector-body' });
  root.append(h('div', { class: 'panel-head' }, 'Inspector'), body);
  bus.on('selection', render);
  bus.on('project', render);
  bus.on('playhead', refreshKeyframed);
  bus.on('transform-live', refreshKeyframed);
  bus.on('focus-inspector', () => { render(); body.scrollTop = 0; });
  render();
}

const fps = () => state.project.settings.fps;

function render() {
  const items = selectedClips();
  kfControls.clear();
  if (items.length === 1) { current = items[0]; body.replaceChildren(clipPanel(items[0])); return; }
  current = null;
  if (items.length > 1) { body.replaceChildren(multiPanel(items)); return; }
  const track = state.project.tracks.find(t => t.id === state.selectedTrack);
  if (track) { body.replaceChildren(trackPanel(track)); return; }
  body.replaceChildren(emptyPanel());
}

function section(title, children, { open = true, extra = null } = {}) {
  const d = h('details', { class: 'section', open },
    h('summary', {}, title, h('span', { class: 'spacer' }), extra),
    h('div', { class: 'section-body' }, children));
  return d;
}

/** Continuous edit helper for sliders: one undo step per drag. */
function live(label) {
  return {
    input: fn => { if (!liveToken) liveToken = beginEdit(label); fn(); bus.emit('project-live'); },
    commit: fn => { if (liveToken) { fn && fn(); const t = liveToken; liveToken = null; endEdit(t); } else edit(label, fn || (() => {})); },
  };
}

// ---------- clip ----------
function clipPanel({ clip, track }) {
  const media = state.project.media[clip.media_id];
  const frag = document.createDocumentFragment();
  const nameInput = h('input', { class: 'input', value: clip.name || media?.name || clip.kind, title: 'Clip name' });
  nameInput.addEventListener('change', () => edit('Rename', () => { clip.name = nameInput.value; }));
  nameInput.addEventListener('keydown', e => e.stopPropagation());
  frag.append(h('div', { class: 'insp-title' }, nameInput));
  frag.append(h('div', { class: 'insp-sub' },
    `${kindLabel(clip)} · ${fmtTimecode(clip.start, fps())} → ${fmtTimecode(clipEnd(clip), fps())} · ${clipDuration(clip).toFixed(2)}s`,
    media ? h('div', { class: 'hint', title: media.path }, media.name, media.width ? ` · ${media.width}×${media.height}` : '', media.fps ? ` · ${fmtNum(media.fps)} fps` : '') : null,
  ));

  if (isVisual(clip)) frag.append(transformSection(clip));
  if (clip.kind === 'video' || clip.kind === 'image') frag.append(cropSection(clip));
  frag.append(timingSection(clip, track));
  if (hasAudio(clip, state.project) || clip.kind === 'audio') frag.append(audioSection(clip));
  if (isVisual(clip)) frag.append(transitionSection(clip, track));
  if (isVisual(clip)) frag.append(effectsSection(clip));
  if (clip.kind === 'title') frag.append(titleSection(clip));
  if (clip.kind === 'color') frag.append(colorSection(clip));
  return frag;
}

function kindLabel(clip) {
  return { video: 'Video clip', audio: 'Audio clip', image: 'Image', title: 'Title', color: 'Color' }[clip.kind] || clip.kind;
}

function localTime(clip) { return clamp(state.playhead - clip.start, 0, clipDuration(clip)); }

function setTransformValue(clip, key, v, lv) {
  if (clip.keyframes?.[key]?.length) setKeyframe(clip, key, localTime(clip), v);
  else clip.transform[key] = v;
}

function kfDiamond(clip, key) {
  const d = h('div', { class: 'kf', title: 'Toggle keyframe at the playhead (Shift-click clears all keyframes of this property)' }, icon('diamond'));
  d.addEventListener('click', e => {
    const t = localTime(clip);
    if (e.shiftKey) { edit('Clear keyframes', () => { delete clip.keyframes[key]; }); return; }
    edit('Keyframe', () => {
      if (keyframeAt(clip, key, t)) removeKeyframe(clip, key, t);
      else setKeyframe(clip, key, t, kfValue(clip, key, t));
    });
  });
  d.addEventListener('contextmenu', e => {
    e.preventDefault();
    const k = keyframeAt(clip, key, localTime(clip));
    if (k) edit('Ease', () => { k.ease = k.ease === 'ease' ? 'linear' : 'ease'; toast(`Keyframe easing: ${k.ease}`); });
  });
  return d;
}
function updateDiamond(d, clip, key) {
  const has = !!clip.keyframes?.[key]?.length;
  const on = has && !!keyframeAt(clip, key, localTime(clip));
  d.classList.toggle('has', has);
  d.classList.toggle('on', on);
  d.title = on ? `Keyframe at this time (${keyframeAt(clip, key, localTime(clip)).ease || 'linear'}). Click to remove, right-click to toggle easing.` : has ? 'Keyframed property. Click to add a keyframe here.' : 'Add a keyframe at the playhead';
}

function transformRow(clip, key, label, { min, max, step, factor = 1, unit = '' }) {
  const value = () => kfValue(clip, key, localTime(clip)) * factor;
  const lv = live(`Change ${label}`);
  const range = rangeInput(value(), { min, max, step,
    onInput: v => lv.input(() => setTransformValue(clip, key, v / factor)),
    onChange: v => lv.commit(() => setTransformValue(clip, key, v / factor)) });
  const num = numberInput(value(), { min: undefined, max: undefined, step, onChange: v => edit(`Change ${label}`, () => setTransformValue(clip, key, v / factor)) });
  const diamond = kfDiamond(clip, key);
  updateDiamond(diamond, clip, key);
  kfControls.set(key, { range, num, diamond, factor });
  return propRow(label + (unit ? ` (${unit})` : ''), range, [num, diamond].reduce((f, e) => (f.append(e), f), document.createDocumentFragment()));
}

function refreshKeyframed() {
  if (!current) return;
  const { clip } = current;
  for (const [key, c] of kfControls) {
    const v = kfValue(clip, key, localTime(clip)) * c.factor;
    if (document.activeElement !== c.num) c.num.value = fmtNum(v);
    if (document.activeElement !== c.range) c.range.value = v;
    updateDiamond(c.diamond, clip, key);
  }
}

function transformSection(clip) {
  const rows = [
    transformRow(clip, 'x', 'Position X', { min: -state.project.settings.width, max: state.project.settings.width, step: 1, unit: 'px' }),
    transformRow(clip, 'y', 'Position Y', { min: -state.project.settings.height, max: state.project.settings.height, step: 1, unit: 'px' }),
    transformRow(clip, 'scale', 'Scale', { min: 1, max: 400, step: 1, factor: 100, unit: '%' }),
    transformRow(clip, 'rotation', 'Rotation', { min: -180, max: 180, step: 1, unit: '°' }),
    transformRow(clip, 'opacity', 'Opacity', { min: 0, max: 100, step: 1, factor: 100, unit: '%' }),
    h('div', { class: 'row' },
      btn('Reset', { class: 'sm', onClick: () => edit('Reset transform', () => { clip.transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }; for (const k of KEYFRAMABLE) delete clip.keyframes[k]; }) }),
      btn('Fit', { class: 'sm', title: 'Fit inside the frame', onClick: () => edit('Fit', () => setTransformValue(clip, 'scale', 1)) }),
      btn('Fill', { class: 'sm', title: 'Fill the frame (crops edges)', onClick: () => edit('Fill', () => setTransformValue(clip, 'scale', fillScale(clip))) }),
      h('span', { class: 'hint grow', style: { textAlign: 'right' } }, 'Drag in the preview to move, corners to scale, top handle to rotate'),
    ),
  ];
  return section('Transform', rows);
}
function fillScale(clip) {
  const m = state.project.media[clip.media_id];
  if (!m || !m.width) return 1;
  const { width: W, height: H } = state.project.settings;
  const fit = Math.min(W / m.width, H / m.height);
  return Math.max(W / (m.width * fit), H / (m.height * fit));
}

function cropSection(clip) {
  const row = (key, label) => {
    const lv = live('Crop');
    const range = rangeInput(clip.crop[key] * 100, { min: 0, max: 90, step: 1, onInput: v => lv.input(() => { clip.crop[key] = v / 100; }), onChange: v => lv.commit(() => { clip.crop[key] = v / 100; }) });
    const num = numberInput(clip.crop[key] * 100, { min: 0, max: 90, step: 1, onChange: v => edit('Crop', () => { clip.crop[key] = v / 100; }) });
    return propRow(label + ' (%)', range, num, { class: 'no-kf' });
  };
  return section('Crop', [row('left', 'Left'), row('top', 'Top'), row('right', 'Right'), row('bottom', 'Bottom')], { open: false });
}

function timingSection(clip, track) {
  const rows = [];
  const startNum = numberInput(clip.start, { min: 0, step: 0.01, onChange: v => edit('Move', () => { const nx = nextClip(track, clip), pv = prevClip(track, clip); const lo = pv ? clipEnd(pv) : 0; const hi = nx ? nx.start - clipDuration(clip) : Infinity; clip.start = clamp(v, lo, Math.max(lo, hi)); }) });
  rows.push(propRow('Start (s)', h('span', { class: 'hint' }, fmtTimecode(clip.start, fps())), startNum, { class: 'no-kf' }));
  if (clip.kind === 'video' || clip.kind === 'audio') {
    const lv = live('Speed');
    const range = rangeInput(clip.speed, { min: 0.1, max: 4, step: 0.05, onInput: v => lv.input(() => { clip.speed = v; }), onChange: v => lv.commit(() => applySpeed(clip, track, v)) });
    const num = numberInput(clip.speed, { min: 0.1, max: 16, step: 0.05, onChange: v => edit('Speed', () => applySpeed(clip, track, v)) });
    rows.push(propRow('Speed (×)', range, num, { class: 'no-kf' }));
    rows.push(propRow('Source in / out', h('span', { class: 'hint' }, `${clip.in.toFixed(2)}s → ${clip.out.toFixed(2)}s`), null, { class: 'wide' }));
  } else {
    const num = numberInput(clipDuration(clip), { min: 0.1, step: 0.1, onChange: v => edit('Duration', () => { const nx = nextClip(track, clip); const max = nx ? nx.start - clip.start : Infinity; clip.out = clip.in + clamp(v, 0.1, max); }) });
    rows.push(propRow('Duration (s)', h('span', { class: 'hint' }, fmtTimecode(clipDuration(clip), fps())), num, { class: 'no-kf' }));
  }
  return section('Timing', rows);
}
function applySpeed(clip, track, v) {
  clip.speed = clamp(v, 0.1, 16);
  const nx = nextClip(track, clip);
  if (nx && clipEnd(clip) > nx.start) clip.out = clip.in + (nx.start - clip.start) * clip.speed;
}

function audioSection(clip) {
  const lv = live('Volume');
  const range = rangeInput(clip.volume * 100, { min: 0, max: 200, step: 1, onInput: v => lv.input(() => { clip.volume = v / 100; }), onChange: v => lv.commit(() => { clip.volume = v / 100; }) });
  const num = numberInput(clip.volume * 100, { min: 0, max: 400, step: 1, onChange: v => edit('Volume', () => { clip.volume = v / 100; }) });
  const fadeIn = numberInput(clip.fade_in, { min: 0, step: 0.1, onChange: v => edit('Fade', () => { clip.fade_in = clamp(v, 0, clipDuration(clip)); }) });
  const fadeOut = numberInput(clip.fade_out, { min: 0, step: 0.1, onChange: v => edit('Fade', () => { clip.fade_out = clamp(v, 0, clipDuration(clip)); }) });
  const mute = h('input', { class: 'check', type: 'checkbox', checked: clip.muted });
  mute.addEventListener('change', () => edit('Mute', () => { clip.muted = mute.checked; }));
  const rows = [
    propRow('Volume (%)', range, num, { class: 'no-kf' }),
    propRow('Fade in (s)', h('span'), fadeIn, { class: 'no-kf' }),
    propRow('Fade out (s)', h('span'), fadeOut, { class: 'no-kf' }),
    h('div', { class: 'row' }, h('label', { class: 'row' }, mute, ' Mute'), h('span', { class: 'grow' }),
      clip.kind === 'video' ? btn('Detach audio', { class: 'sm', onClick: ops.detachAudio }) : null),
  ];
  return section('Audio', rows);
}

function transitionSection(clip, track) {
  const prev = prevClip(track, clip), next = nextClip(track, clip);
  const adjIn = prev && Math.abs(clipEnd(prev) - clip.start) < 0.002;
  const adjOut = next && Math.abs(next.start - clipEnd(clip)) < 0.002;
  const options = [{ id: '', name: 'None' }, ...TRANSITIONS];
  const mk = (side, tr, adjacent) => {
    const sel = selectInput(tr ? tr.type : '', options, v => edit('Transition', () => { clip[side] = v ? { type: v, duration: tr?.duration || state.settings.defaultTransition } : null; }));
    const dur = numberInput(tr ? tr.duration : state.settings.defaultTransition, { min: 0.1, max: 10, step: 0.1, onChange: v => edit('Transition length', () => { if (clip[side]) clip[side].duration = v; }) });
    dur.disabled = !tr;
    return [propRow(side === 'transition_in' ? 'In' : 'Out', sel, dur, { class: 'no-kf' }),
      h('div', { class: 'hint' }, adjacent ? (side === 'transition_in' ? `Blends from "${prev.name || 'previous clip'}"` : next.transition_in ? `Handled by "${next.name || 'next clip'}"'s In transition` : 'Fades to transparent (the next clip has its own In transition setting)') : (side === 'transition_in' ? 'No adjacent clip before: fades in from transparent' : 'No adjacent clip after: fades out to transparent'))];
  };
  return section('Transitions', [...mk('transition_in', clip.transition_in, adjIn), ...mk('transition_out', clip.transition_out, adjOut)], { open: !!(clip.transition_in || clip.transition_out) });
}

function effectsSection(clip) {
  const list = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } });
  (clip.effects || []).forEach((e, i) => list.append(effectCard(clip, e, i)));
  const add = selectInput('', [{ id: '', name: '+ Add effect…' }, ...Object.entries(EFFECTS).map(([id, d]) => ({ id, name: d.name }))], v => { if (v) edit('Add effect', () => { clip.effects.push(newEffect(v)); }); });
  return section('Effects', [list, add], { open: true });
}
function effectCard(clip, e, i) {
  const def = EFFECTS[e.type];
  if (!def) return h('div', { class: 'effect-card' }, `Unknown effect ${e.type}`);
  const enabled = h('input', { class: 'check', type: 'checkbox', checked: e.enabled });
  enabled.addEventListener('change', () => edit('Toggle effect', () => { e.enabled = enabled.checked; }));
  const head = h('div', { class: 'effect-head' }, enabled, h('span', { class: 'name' }, def.name),
    def.preview ? null : h('span', { class: 'tag', title: 'The canvas preview cannot show this effect. Use the camera button for an exact frame; the export is always exact.' }, 'export only'),
    btn('', { icon: 'prev', class: 'ghost sm', title: 'Move up', onClick: () => edit('Reorder effect', () => { if (i > 0) [clip.effects[i - 1], clip.effects[i]] = [clip.effects[i], clip.effects[i - 1]]; }) }),
    btn('', { icon: 'x', class: 'ghost sm', title: 'Remove effect', onClick: () => edit('Remove effect', () => { clip.effects.splice(i, 1); }) }));
  const card = h('div', { class: 'effect-card' }, head);
  for (const p of def.params) {
    if (p.type === 'bool') {
      const cb = h('input', { class: 'check', type: 'checkbox', checked: !!e.params[p.key] });
      cb.addEventListener('change', () => edit(def.name, () => { e.params[p.key] = cb.checked; }));
      card.append(h('label', { class: 'row' }, cb, ' ', p.name));
    } else if (p.type === 'color') {
      const c = h('input', { class: 'color', type: 'color', value: e.params[p.key] || p.def });
      c.addEventListener('change', () => edit(def.name, () => { e.params[p.key] = c.value; }));
      card.append(propRow(p.name, c, null, { class: 'wide' }));
    } else if (p.type === 'file') {
      const pick = btn(e.params[p.key] ? String(e.params[p.key]).split(/[\\/]/).pop() : 'Choose file…', { class: 'sm', onClick: async () => { const r = await dialog.openFiles([{ name: 'LUT', extensions: ['cube', '3dl', 'dat', 'm3d'] }], false); if (r[0]) edit(def.name, () => { e.params[p.key] = r[0]; }); } });
      card.append(propRow(p.name, pick, null, { class: 'wide' }));
    } else {
      const lv = live(def.name);
      const range = rangeInput(e.params[p.key] ?? p.def, { min: p.min, max: p.max, step: p.step, onInput: v => lv.input(() => { e.params[p.key] = v; }), onChange: v => lv.commit(() => { e.params[p.key] = v; }) });
      const num = numberInput(e.params[p.key] ?? p.def, { min: p.min, max: p.max, step: p.step, onChange: v => edit(def.name, () => { e.params[p.key] = v; }) });
      card.append(propRow(p.name, range, num));
    }
  }
  return card;
}

function titleSection(clip) {
  const t = clip.title;
  const text = h('textarea', { class: 'input', rows: 3 }, t.text);
  text.addEventListener('keydown', e => e.stopPropagation());
  text.addEventListener('input', () => { if (!liveToken) liveToken = beginEdit('Edit title'); t.text = text.value; bus.emit('project-live'); });
  text.addEventListener('change', () => { if (liveToken) { const tk = liveToken; liveToken = null; endEdit(tk); } });
  const size = numberInput(t.font_size, { min: 8, max: 600, step: 1, onChange: v => edit('Title size', () => { t.font_size = v; }) });
  const sizeRange = rangeInput(t.font_size, { min: 8, max: 300, step: 1, onInput: v => { if (!liveToken) liveToken = beginEdit('Title size'); t.font_size = v; bus.emit('project-live'); }, onChange: () => { if (liveToken) { const tk = liveToken; liveToken = null; endEdit(tk); } } });
  const color = h('input', { class: 'color', type: 'color', value: t.color });
  color.addEventListener('input', () => { t.color = color.value; bus.emit('project-live'); });
  color.addEventListener('change', () => edit('Title color', () => { t.color = color.value; }));
  const weight = selectInput(t.weight || 'regular', [{ id: 'regular', name: 'Regular' }, { id: 'bold', name: 'Bold' }], v => edit('Title weight', () => { t.weight = v; }));
  const align = selectInput(t.align || 'center', [{ id: 'left', name: 'Left' }, { id: 'center', name: 'Center' }, { id: 'right', name: 'Right' }], v => edit('Title align', () => { t.align = v; }));
  const bgOn = h('input', { class: 'check', type: 'checkbox', checked: !!t.background });
  const bg = h('input', { class: 'color', type: 'color', value: (t.background || '#000000').slice(0, 7) });
  const bgAlpha = rangeInput(t.background ? alphaOf(t.background) : 0.6, { min: 0, max: 1, step: 0.05, onChange: v => edit('Title background', () => { t.background = withAlpha(bg.value, v); }) });
  bgOn.addEventListener('change', () => edit('Title background', () => { t.background = bgOn.checked ? withAlpha(bg.value, parseFloat(bgAlpha.value)) : null; }));
  bg.addEventListener('change', () => edit('Title background', () => { t.background = withAlpha(bg.value, parseFloat(bgAlpha.value)); bgOn.checked = true; }));
  const pad = numberInput(t.padding, { min: 0, max: 200, step: 1, onChange: v => edit('Title padding', () => { t.padding = v; }) });
  const shadow = h('input', { class: 'check', type: 'checkbox', checked: !!t.shadow });
  shadow.addEventListener('change', () => edit('Title shadow', () => { t.shadow = shadow.checked; }));
  const lh = numberInput(t.line_height, { min: 0.6, max: 3, step: 0.05, onChange: v => edit('Line height', () => { t.line_height = v; }) });
  return section('Title', [
    text,
    propRow('Size', sizeRange, size, { class: 'no-kf' }),
    propRow('Color', h('div', { class: 'row' }, color, weight), null, { class: 'wide' }),
    propRow('Align', align, null, { class: 'wide' }),
    propRow('Background', h('div', { class: 'row' }, bgOn, bg, bgAlpha), null, { class: 'wide' }),
    propRow('Padding', h('span'), pad, { class: 'no-kf' }),
    propRow('Line height', h('span'), lh, { class: 'no-kf' }),
    h('label', { class: 'row' }, shadow, ' Drop shadow'),
  ]);
}
function alphaOf(hex) { return hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1; }
function withAlpha(hex, a) { return hex.slice(0, 7) + Math.round(clamp(a, 0, 1) * 255).toString(16).padStart(2, '0'); }

function colorSection(clip) {
  const c = h('input', { class: 'color', type: 'color', value: clip.color || '#000000' });
  c.addEventListener('input', () => { clip.color = c.value; bus.emit('project-live'); });
  c.addEventListener('change', () => edit('Color', () => { clip.color = c.value; }));
  return section('Color', [propRow('Fill', c, null, { class: 'wide' })]);
}

// ---------- multi / track / empty ----------
function multiPanel(items) {
  return h('div', { class: 'empty-inspector' },
    h('b', {}, `${items.length} clips selected`),
    h('div', { class: 'row wrap' },
      btn('Delete', { class: 'sm danger', onClick: () => ops.deleteSelected() }),
      btn('Duplicate', { class: 'sm', onClick: ops.duplicateSelected }),
      btn('Mute', { class: 'sm', onClick: () => edit('Mute', () => { for (const { clip } of items) clip.muted = !clip.muted; }) }),
      btn('Cross dissolve', { class: 'sm', onClick: () => ops.addTransition('crossfade') }),
    ),
    h('div', { class: 'hint' }, 'Drag to move all selected clips together. Alt-click a clip to select only it.'));
}
function trackPanel(track) {
  const name = h('input', { class: 'input', value: track.name });
  name.addEventListener('change', () => edit('Rename track', () => { track.name = name.value; }));
  name.addEventListener('keydown', e => e.stopPropagation());
  const tog = (key, label) => { const cb = h('input', { class: 'check', type: 'checkbox', checked: !!track[key] }); cb.addEventListener('change', () => edit(label, () => { track[key] = cb.checked; })); return h('label', { class: 'row' }, cb, ' ', label); };
  return h('div', {}, h('div', { class: 'insp-title' }, name), h('div', { class: 'insp-sub' }, `${track.kind === 'video' ? 'Video' : 'Audio'} track · ${track.clips.length} clips`),
    section('Track', [track.kind === 'video' ? tog('hidden', 'Hidden') : null, tog('muted', 'Muted'), tog('solo', 'Solo'), tog('locked', 'Locked'),
      h('div', { class: 'row' }, btn('Move up', { class: 'sm', onClick: () => ops.moveTrack(track.id, -1) }), btn('Move down', { class: 'sm', onClick: () => ops.moveTrack(track.id, 1) }), btn('Delete', { class: 'sm danger', onClick: () => ops.removeTrack(track.id) }))]));
}
function emptyPanel() {
  const s = state.project.settings;
  const k = (keys, what) => [h('span', {}, keys.split(' ').map(x => h('span', { class: 'kbd' }, x))), h('span', {}, what)];
  return h('div', { class: 'empty-inspector' },
    h('div', {}, h('b', {}, state.project.name), h('div', { class: 'hint' }, `${s.width}×${s.height} · ${s.fps} fps`)),
    h('div', {}, 'Select a clip to edit its transform, speed, audio, transitions and effects. Select a track header for track options.'),
    h('div', { class: 'shortcut-table' },
      ...k('Space', 'Play / pause'), ...k('← →', 'Step one frame (Shift: 1 s)'), ...k('J K L', 'Back 1 s / pause / play'),
      ...k('S', 'Split at playhead'), ...k('C', 'Razor tool'), ...k('V', 'Select tool'), ...k('N', 'Toggle snapping'),
      ...k('M', 'Add marker'), ...k('I O', 'Mark in / out'), ...k('⌘Z', 'Undo'), ...k('⌘⇧Z', 'Redo'),
      ...k('⌘C ⌘X ⌘V', 'Copy / cut / paste'), ...k('⌘D', 'Duplicate'), ...k('⌫', 'Delete (Shift: ripple)'), ...k('⌘E', 'Export'),
      ...k('+ -', 'Zoom'), ...k('⇧Z', 'Zoom to fit'), ...k('↑ ↓', 'Previous / next edit point')));
}
