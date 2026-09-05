// Application state, undo/redo and a tiny event bus.

import { newProject, findClip } from './model.js';

const listeners = new Map();
export const bus = {
  on(evt, cb) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(cb); return () => listeners.get(evt).delete(cb); },
  emit(evt, data) { for (const cb of listeners.get(evt) || []) { try { cb(data); } catch (e) { console.error(e); } } },
};

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  previewQuality: 'half',    // 'full' | 'half' | 'quarter'
  autoProxy: 'above1080',    // 'never' | 'above1080' | 'always'
  proxyWidth: 1280,
  ffmpegDir: '',
  autosave: true,
  snapToClips: true,
  defaultImageDuration: 5,
  defaultTitleDuration: 5,
  defaultTransition: 1,
  recent: [],
  whisperBin: '',
  whisperModel: '',
  whisperLanguage: 'auto',
};

export const state = {
  selectedCaption: null,
  project: newProject(),
  path: null,
  dirty: false,
  playhead: 0,
  playing: false,
  selection: new Set(),      // clip ids
  selectedTrack: null,       // track id
  selectedMedia: null,
  zoom: 60,                  // pixels per second
  tool: 'select',            // 'select' | 'razor'
  snapping: true,
  loop: false,
  inPoint: null,
  outPoint: null,
  assets: {},                // mediaId -> { filmstrip, waveform, proxy, key, status, progress }
  ffmpeg: null,              // FfmpegStatus
  clipboard: [],
  settings: loadSettings(),
};



function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('rve.settings') || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings() {
  try { localStorage.setItem('rve.settings', JSON.stringify(state.settings)); } catch {}
  bus.emit('settings');
}

// ---------- undo / redo ----------
const history = [];
const future = [];
const MAX_HISTORY = 200;
let openEdit = null;

function snapshot() { return JSON.stringify(state.project); }

/** Wrap a mutation of state.project in an undoable step. */
export function edit(label, fn) {
  if (openEdit) { fn(); state.dirty = true; bus.emit('project', { label }); return; }
  const before = snapshot();
  fn();
  const after = snapshot();
  if (after === before) return;
  history.push({ label, before, after });
  if (history.length > MAX_HISTORY) history.shift();
  future.length = 0;
  state.dirty = true;
  bus.emit('project', { label });
}

/** For drags: many intermediate changes, one undo step. */
export function beginEdit(label) {
  if (openEdit) return openEdit;
  openEdit = { label, before: snapshot() };
  return openEdit;
}
export function endEdit(token) {
  if (!openEdit || token !== openEdit) return;
  const after = snapshot();
  if (after !== openEdit.before) {
    history.push({ label: openEdit.label, before: openEdit.before, after });
    if (history.length > MAX_HISTORY) history.shift();
    future.length = 0;
    state.dirty = true;
  }
  openEdit = null;
  bus.emit('project', { label: token.label });
}
export function cancelEdit(token) {
  if (!openEdit || token !== openEdit) return;
  state.project = JSON.parse(openEdit.before);
  openEdit = null;
  bus.emit('project', { label: 'cancel' });
}

export function undo() {
  const step = history.pop();
  if (!step) return false;
  future.push(step);
  state.project = JSON.parse(step.before);
  pruneSelection();
  state.dirty = true;
  bus.emit('project', { label: 'undo' });
  return true;
}
export function redo() {
  const step = future.pop();
  if (!step) return false;
  history.push(step);
  state.project = JSON.parse(step.after);
  pruneSelection();
  state.dirty = true;
  bus.emit('project', { label: 'redo' });
  return true;
}
export const canUndo = () => history.length > 0;
export const canRedo = () => future.length > 0;
export const undoLabel = () => history[history.length - 1]?.label;
export const redoLabel = () => future[future.length - 1]?.label;

export function replaceProject(project, path = null) {
  state.project = project;
  state.path = path;
  state.dirty = false;
  history.length = 0;
  future.length = 0;
  state.selection.clear();
  state.selectedTrack = null;
  state.playhead = 0;
  state.inPoint = null;
  state.outPoint = null;
  bus.emit('project', { label: 'load' });
  bus.emit('playhead');
  bus.emit('selection');
}

// ---------- selection & playhead ----------
export function select(ids, { additive = false, toggle = false } = {}) {
  if (!additive && !toggle) state.selection.clear();
  for (const id of ids) {
    if (toggle && state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
  }
  bus.emit('selection');
}
export function clearSelection() {
  if (!state.selection.size && !state.selectedTrack) return;
  state.selection.clear();
  state.selectedTrack = null;
  bus.emit('selection');
}
function pruneSelection() {
  for (const id of [...state.selection]) if (!findClip(state.project, id)) state.selection.delete(id);
}
export function selectedClips() {
  return [...state.selection].map(id => findClip(state.project, id)).filter(Boolean);
}
export function primaryClip() {
  return selectedClips()[0] || null;
}
export function setPlayhead(t, { emit = true } = {}) {
  state.playhead = Math.max(0, t);
  if (emit) bus.emit('playhead');
}
