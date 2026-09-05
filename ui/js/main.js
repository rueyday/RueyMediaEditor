// Application bootstrap: wires the panels together and handles project files.

import { state, bus, replaceProject, undo, redo, canUndo, canRedo, undoLabel, redoLabel, clearSelection, saveSettings } from './state.js';
import { newProject, PROJECT_VERSION, projectDuration } from './model.js';
import { invoke, dialog, onFileDrop, isTauri, PROJECT_FILTER } from './bridge.js';
import { h, btn, icon, modal, confirmDialog, toast, baseName, $ } from './ui.js';
import { initPreview, pause } from './preview.js';
import { initTimeline, zoomToFit } from './timeline.js';
import { initInspector } from './inspector.js';
import { initMedia, importDialog, importPaths, loadAssets } from './media.js';
import { initCaptions, addAtPlayhead as addCaption } from './captions.js';
import * as ops from './ops.js';
import { openExportDialog, exportFrameDialog } from './export.js';
import { openSettings, openProjectSettings, refreshFfmpeg, applyTheme } from './settings.js';
import { initShortcuts } from './shortcuts.js';
import { APP_NAME, PROJECT_EXT } from './config.js';

let undoBtn, redoBtn, titleEl, ffmpegPill, autosavePath = null, closing = false;

async function boot() {
  applyTheme();
  buildTopbar();
  initLeftPanel();
  initPreview($('#preview-panel'));
  initInspector($('#inspector-panel'));
  initTimeline($('#timeline-panel'));
  initSplitter();
  initShortcuts({ save, saveAs, open, newProject: newProjectAction, exportDialog: openExportDialog, importMedia: importDialog, settings: openSettings });

  bus.on('project', updateTitle);
  bus.on('ffmpeg', updateFfmpegPill);
  bus.on('escape', () => { clearSelection(); });
  bus.on('cmd', c => { if (c === 'in') ops.setInPoint(); else if (c === 'out') ops.setOutPoint(); else if (c === 'export-frame') exportFrameDialog(); else if (c === 'add-caption') addCaption(); });
  bus.on('open-settings', tab => openSettings(tab));
  bus.on('show-captions', () => showLeftTab('captions'));
  bus.on('need-assets', id => loadAssets(id));
  onFileDrop(paths => importPaths(paths), hover => { $('#drop-hint').hidden = !hover; });

  await refreshFfmpeg();
  if (isTauri && !state.ffmpeg?.found) {
    modal({
      title: 'FFmpeg is needed',
      body: h('div', {}, 'RueyMediaEditor uses FFmpeg to read media and render exports. It was not found on this computer. You can download it now (about 90 MB, one time), or install it yourself and point RueyMediaEditor at it in Settings.'),
      buttons: [{ label: 'Later' }, { label: 'Open FFmpeg settings', primary: true, onClick: c => { c(); openSettings('ffmpeg'); } }],
    });
  }
  try { const p = await invoke('app_paths'); autosavePath = p.autosave; } catch {}
  await maybeRecover();
  setInterval(autosave, 60000);
  if (isTauri) {
    try {
      const win = window.__TAURI__.window.getCurrentWindow();
      await win.onCloseRequested(async e => {
        if (!state.dirty || closing) return;
        e.preventDefault();
        if (await confirmDialog('Unsaved changes', `Close ${APP_NAME} and discard unsaved changes?`, { okLabel: 'Discard', danger: true })) {
          closing = true;
          state.dirty = false;
          try { await invoke('quit_app'); } catch { try { await win.destroy(); } catch { win.close(); } }
        }
      });
    } catch (err) { console.warn(err); }
  } else {
    window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
  }
  updateTitle();
}

let leftTabs;
function initLeftPanel() {
  const panel = $('#media-panel');
  leftTabs = h('div', { class: 'left-tabs' }, h('div', { class: 'tab active', dataset: { tab: 'media' }, onClick: () => showLeftTab('media') }, 'Media'), h('div', { class: 'tab', dataset: { tab: 'captions' }, onClick: () => showLeftTab('captions') }, 'Captions'));
  const media = h('div', { class: 'left-page', dataset: { page: 'media' } });
  const captions = h('div', { class: 'left-page', dataset: { page: 'captions' }, hidden: true });
  panel.append(leftTabs, media, captions);
  initMedia(media);
  initCaptions(captions);
}
function showLeftTab(id) {
  for (const t of leftTabs.children) t.classList.toggle('active', t.dataset.tab === id);
  for (const p of $('#media-panel').querySelectorAll('.left-page')) p.hidden = p.dataset.page !== id;
}

function buildTopbar() {
  const nav = $('#topbar-nav');
  undoBtn = btn('', { icon: 'undo', class: 'ghost', title: 'Undo (⌘Z)', onClick: undo });
  redoBtn = btn('', { icon: 'redo', class: 'ghost', title: 'Redo (⌘⇧Z)', onClick: redo });
  nav.append(
    btn('New', { class: 'ghost', title: 'New project (⌘N)', onClick: newProjectAction }),
    btn('Open', { class: 'ghost', title: 'Open project (⌘O)', onClick: open }),
    btn('Save', { class: 'ghost', title: 'Save project (⌘S)', onClick: save }),
    btn('Save as', { class: 'ghost', title: 'Save project as… (⌘⇧S)', onClick: saveAs }),
    h('span', { class: 'sep' }),
    undoBtn, redoBtn,
    h('span', { class: 'sep' }),
    btn('Project', { icon: 'film', class: 'ghost', title: 'Project settings: name, resolution, frame rate', onClick: openProjectSettings }),
    btn('', { icon: 'settings', class: 'ghost', title: 'Settings (⌘,)', onClick: () => openSettings() }),
  );
  titleEl = h('span', { class: 'project-title' });
  ffmpegPill = h('span', { class: 'pill clickable', onClick: () => openSettings('ffmpeg') }, h('span', { class: 'dot' }), 'FFmpeg');
  $('#topbar-right').append(titleEl, ffmpegPill, btn('Export', { icon: 'export', primary: true, title: 'Export (⌘E)', onClick: openExportDialog }));
}

function updateTitle() {
  const name = state.project.name || 'Untitled';
  titleEl.replaceChildren(name, state.dirty ? h('span', { class: 'dirty' }, ' •') : '');
  const t = `${name}${state.dirty ? ' •' : ''} — ${APP_NAME}`;
  document.title = t;
  if (isTauri) invoke('set_title', { title: t }).catch(() => {});
  undoBtn.disabled = !canUndo();
  redoBtn.disabled = !canRedo();
  undoBtn.title = canUndo() ? `Undo ${undoLabel()} (⌘Z)` : 'Nothing to undo';
  redoBtn.title = canRedo() ? `Redo ${redoLabel()} (⌘⇧Z)` : 'Nothing to redo';
}

function updateFfmpegPill() {
  const f = state.ffmpeg;
  ffmpegPill.className = `pill clickable ${f?.found ? 'ok' : isTauri ? 'bad' : 'warn'}`;
  ffmpegPill.lastChild.textContent = f?.found ? `FFmpeg ${f.tools.version}` : isTauri ? 'FFmpeg missing' : 'Browser preview';
  ffmpegPill.title = f?.found ? `${f.tools.ffmpeg} (${f.tools.source})` : 'Click to set up FFmpeg';
}

function initSplitter() {
  const splitter = $('#splitter');
  splitter.addEventListener('pointerdown', e => {
    splitter.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--timeline-h'));
    const move = ev => { const hgt = Math.max(160, Math.min(window.innerHeight - 300, start - (ev.clientY - startY))); document.documentElement.style.setProperty('--timeline-h', `${hgt}px`); };
    const up = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', up); };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
}

// ---------- project files ----------
function serialize() {
  return JSON.stringify({ ...state.project, version: PROJECT_VERSION, app: APP_NAME }, null, 2);
}

async function save() {
  if (!state.path) return saveAs();
  try {
    await invoke('save_project', { path: state.path, json: serialize() });
    state.dirty = false;
    remember(state.path);
    updateTitle();
    toast('Saved', 'success', 1500);
  } catch (e) { toast(`Save failed: ${e}`, 'error', 6000); }
}
async function saveAs() {
  const name = (state.project.name || 'Untitled').replace(/[^\w\- ]+/g, '');
  const path = await dialog.saveFile(`${name}.${PROJECT_EXT}`, PROJECT_FILTER);
  if (!path) return;
  state.path = path;
  if (!state.project.name || state.project.name === 'Untitled') state.project.name = baseName(path).replace(/\.[^.]+$/, '');
  await save();
}
async function open() {
  if (state.dirty && !(await confirmDialog('Unsaved changes', 'Discard unsaved changes and open another project?', { okLabel: 'Discard', danger: true }))) return;
  const path = await dialog.openProject();
  if (path) await loadProjectFile(path);
}
export async function loadProjectFile(path) {
  try {
    const text = await invoke('load_project', { path });
    const project = JSON.parse(text);
    if (!project || !Array.isArray(project.tracks)) throw new Error('Not a RueyMediaEditor project');
    pause();
    replaceProject(project, path);
    state.assets = {};
    for (const id of Object.keys(project.media)) loadAssets(id);
    remember(path);
    zoomToFit();
    toast(`Opened ${baseName(path)}`, 'success', 1500);
  } catch (e) { toast(`Could not open project: ${e}`, 'error', 6000); }
}
async function newProjectAction() {
  if (state.dirty && !(await confirmDialog('Unsaved changes', 'Discard unsaved changes and start a new project?', { okLabel: 'Discard', danger: true }))) return;
  pause();
  replaceProject(newProject());
  state.assets = {};
}
function remember(path) {
  const r = (state.settings.recent || []).filter(p => p !== path);
  r.unshift(path);
  state.settings.recent = r.slice(0, 8);
  saveSettings();
}

async function autosave() {
  if (!state.settings.autosave || !autosavePath || !state.dirty) return;
  try { await invoke('write_text_file', { path: autosavePath, contents: serialize() }); } catch {}
}
async function maybeRecover() {
  if (!autosavePath) return;
  try {
    if (!(await invoke('file_exists', { path: autosavePath }))) return;
    const text = await invoke('read_text_file', { path: autosavePath });
    const project = JSON.parse(text);
    if (!project?.tracks?.some(t => t.clips.length)) return;
    const ok = await confirmDialog('Recover project', `A recovery copy of "${project.name || 'Untitled'}" was found. Restore it?`, { okLabel: 'Restore' });
    if (ok) {
      replaceProject(project, null);
      state.dirty = true;
      for (const id of Object.keys(project.media)) loadAssets(id);
      zoomToFit();
    } else {
      await invoke('write_text_file', { path: autosavePath, contents: '' });
    }
  } catch {}
}

boot();
