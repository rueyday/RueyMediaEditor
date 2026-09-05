// Captions panel: manual captions, SRT import/export, whisper.cpp auto-captions, style.

import { state, bus, edit, setPlayhead } from './state.js';
import { newCaption, parseSrt, formatSrt, defaultCaptionStyle, clipEnd, hasAudio, projectDuration } from './model.js';
import { invoke, dialog, isTauri } from './bridge.js';
import { h, btn, icon, modal, propRow, numberInput, rangeInput, selectInput, fmtTimecode, toast, confirmDialog, baseName } from './ui.js';
import { selectedClips } from './state.js';

let root, listEl;

export function initCaptions(el) {
  root = el;
  listEl = h('div', { class: 'caption-list' });
  root.append(
    h('div', { class: 'media-tools' },
      btn('Add', { icon: 'plus', primary: true, title: 'Add a caption at the playhead (⇧C)', onClick: addAtPlayhead }),
      btn('Import SRT', { class: 'sm', onClick: importSrt }),
      btn('Export SRT', { class: 'sm', onClick: exportSrt }),
      btn('Auto', { icon: 'wand', class: 'sm', title: 'Transcribe the selected clip with whisper.cpp', onClick: autoCaption }),
    ),
    h('div', { class: 'panel-body' }, listEl, styleSection()),
  );
  bus.on('project', render);
  bus.on('caption-selected', render);
  render();
}

const style = () => state.project.caption_style || (state.project.caption_style = defaultCaptionStyle());

function render() {
  const caps = [...(state.project.captions || [])].sort((a, b) => a.start - b.start);
  if (!caps.length) {
    listEl.replaceChildren(h('div', { class: 'media-empty' }, h('div', { class: 'big' }, '💬'), h('div', {}, 'No captions yet'), h('div', { class: 'hint' }, 'Add one at the playhead, import an SRT file, or transcribe a clip automatically.')));
    return;
  }
  listEl.replaceChildren(...caps.map(row));
  const sel = listEl.querySelector('.caption-row.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function row(cap) {
  const fps = state.project.settings.fps;
  const start = h('input', { class: 'input num', value: cap.start.toFixed(2), title: 'Start (s)' });
  const end = h('input', { class: 'input num', value: cap.end.toFixed(2), title: 'End (s)' });
  const text = h('textarea', { class: 'input', rows: 2 }, cap.text);
  for (const i of [start, end, text]) i.addEventListener('keydown', e => e.stopPropagation());
  start.addEventListener('change', () => edit('Caption time', () => { cap.start = Math.max(0, parseFloat(start.value) || 0); if (cap.end <= cap.start) cap.end = cap.start + 0.5; }));
  end.addEventListener('change', () => edit('Caption time', () => { cap.end = Math.max(cap.start + 0.1, parseFloat(end.value) || 0); }));
  text.addEventListener('change', () => edit('Caption text', () => { cap.text = text.value; }));
  const el = h('div', { class: `caption-row ${state.selectedCaption === cap.id ? 'selected' : ''}`, dataset: { id: cap.id } },
    h('div', { class: 'row' },
      h('span', { class: 'hint mono', style: { minWidth: '76px' } }, fmtTimecode(cap.start, fps)),
      start, h('span', { class: 'hint' }, '→'), end,
      h('span', { class: 'grow' }),
      btn('', { icon: 'in', class: 'ghost sm', title: 'Set start to playhead', onClick: () => edit('Caption time', () => { cap.start = state.playhead; if (cap.end <= cap.start) cap.end = cap.start + 0.5; }) }),
      btn('', { icon: 'out', class: 'ghost sm', title: 'Set end to playhead', onClick: () => edit('Caption time', () => { if (state.playhead > cap.start) cap.end = state.playhead; }) }),
      btn('', { icon: 'x', class: 'ghost sm', title: 'Delete caption', onClick: () => edit('Delete caption', () => { state.project.captions = state.project.captions.filter(c => c !== cap); }) }),
    ),
    text,
  );
  el.addEventListener('click', e => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.closest('button')) return; selectCaption(cap.id); setPlayhead(cap.start); });
  return el;
}

export function selectCaption(id) {
  state.selectedCaption = id;
  bus.emit('caption-selected');
}

export function addAtPlayhead() {
  const t = state.playhead;
  const next = (state.project.captions || []).filter(c => c.start > t + 0.05).sort((a, b) => a.start - b.start)[0];
  const end = Math.min(t + 2.5, next ? next.start : Infinity, Math.max(projectDuration(state.project), t + 1));
  const cap = newCaption(t, Math.max(t + 0.3, end), '');
  edit('Add caption', () => { if (!state.project.captions) state.project.captions = []; state.project.captions.push(cap); });
  selectCaption(cap.id);
  bus.emit('show-captions');
  setTimeout(() => { const ta = listEl.querySelector(`.caption-row[data-id="${cap.id}"] textarea`); ta && ta.focus(); }, 50);
}

export async function importSrt() {
  const files = await dialog.openFiles([{ name: 'Subtitles', extensions: ['srt', 'vtt', 'txt'] }], false);
  if (!files[0]) return;
  let text;
  try { text = await invoke('read_text_file', { path: files[0] }); } catch (e) { toast(`Cannot read file: ${e}`, 'error'); return; }
  const caps = parseSrt(text.replace(/^WEBVTT[^\n]*\n/, ''));
  if (!caps.length) { toast('No captions found in that file', 'error'); return; }
  const replace = state.project.captions?.length ? await confirmDialog('Import captions', `Replace the ${state.project.captions.length} existing captions? (Cancel to add to them)`, { okLabel: 'Replace' }) : true;
  edit('Import captions', () => { state.project.captions = replace ? caps : [...state.project.captions, ...caps]; });
  toast(`Imported ${caps.length} captions`, 'success');
  bus.emit('show-captions');
}

export async function exportSrt() {
  const caps = state.project.captions || [];
  if (!caps.length) { toast('No captions to export'); return; }
  const path = await dialog.saveFile(`${(state.project.name || 'captions').replace(/[^\w\- ]+/g, '')}.srt`, [{ name: 'SubRip', extensions: ['srt'] }]);
  if (!path) return;
  try { await invoke('write_text_file', { path, contents: formatSrt(caps) }); toast(`Saved ${baseName(path)}`, 'success'); }
  catch (e) { toast(`Save failed: ${e}`, 'error'); }
}

export async function autoCaption() {
  if (!isTauri) { toast('Auto-captions need the desktop app and whisper.cpp', 'error'); return; }
  const target = selectedClips().find(({ clip }) => clip.media_id && hasAudio(clip, state.project));
  if (!target) { toast('Select a clip with speech first'); return; }
  const { clip } = target;
  const m = state.project.media[clip.media_id];
  const s = state.settings;
  if (!s.whisperModel) {
    modal({ title: 'Set up auto-captions', body: h('div', {}, 'Auto-captions run whisper.cpp locally (nothing leaves your computer). Install it, download a model such as ggml-base.en.bin, and set both paths in Settings → Captions.'), buttons: [{ label: 'Close' }, { label: 'Open settings', primary: true, onClick: c => { c(); bus.emit('open-settings', 'captions'); } }] });
    return;
  }
  const status = h('div', { class: 'hint' }, `Transcribing ${m.name}… this runs at roughly real time on a laptop.`);
  const dlg = modal({ title: 'Auto-captions', body: h('div', {}, h('div', { class: 'progress indeterminate' }, h('div')), h('div', { style: { height: '8px' } }), status), buttons: [], closable: false });
  try {
    const srt = await invoke('transcribe', { path: m.path, in: clip.in, out: clip.out, whisperBin: s.whisperBin || null, model: s.whisperModel, language: s.whisperLanguage || 'auto', customDir: s.ffmpegDir || null });
    const caps = parseSrt(srt).map(c => ({ ...c, start: clip.start + c.start / clip.speed, end: clip.start + c.end / clip.speed })).filter(c => c.end <= clipEnd(clip) + 0.5);
    dlg.close();
    if (!caps.length) { toast('No speech was recognised', 'error'); return; }
    edit('Auto-captions', () => { state.project.captions = [...(state.project.captions || []).filter(c => c.end <= clip.start || c.start >= clipEnd(clip)), ...caps]; });
    toast(`Added ${caps.length} captions`, 'success');
    bus.emit('show-captions');
  } catch (e) {
    dlg.close();
    modal({ title: 'Auto-captions failed', body: h('div', { class: 'log-box mono' }, String(e)), buttons: [{ label: 'Close', primary: true }] });
  }
}

function styleSection() {
  const st = style();
  const body = h('div', { class: 'section-body' });
  const rebuild = () => {
    const st = style();
    body.replaceChildren(
      propRow('Size', rangeInput(st.font_size, { min: 12, max: 160, step: 1, onInput: v => { st.font_size = v; bus.emit('project-live'); }, onChange: v => edit('Caption style', () => { st.font_size = v; }) }), numberInput(st.font_size, { min: 8, max: 400, step: 1, onChange: v => edit('Caption style', () => { st.font_size = v; }) }), { class: 'no-kf' }),
      propRow('Color', colorInput(st.color, v => edit('Caption style', () => { st.color = v; })), null, { class: 'wide' }),
      propRow('Background', h('div', { class: 'row' }, checkbox(!!st.background, on => edit('Caption style', () => { st.background = on ? '#000000a0' : null; rebuild(); })), st.background ? colorInput(st.background.slice(0, 7), v => edit('Caption style', () => { st.background = v + (st.background.slice(7) || 'a0'); })) : null), null, { class: 'wide' }),
      propRow('Position', selectInput(st.position || 'bottom', [{ id: 'bottom', name: 'Bottom' }, { id: 'top', name: 'Top' }], v => edit('Caption style', () => { st.position = v; })), null, { class: 'wide' }),
      propRow('Margin (px)', h('span'), numberInput(st.margin, { min: 0, max: 1000, step: 5, onChange: v => edit('Caption style', () => { st.margin = v; }) }), { class: 'no-kf' }),
      propRow('Weight', selectInput(st.weight || 'bold', [{ id: 'bold', name: 'Bold' }, { id: 'regular', name: 'Regular' }], v => edit('Caption style', () => { st.weight = v; })), null, { class: 'wide' }),
      propRow('Font', h('div', { class: 'row' }, btn(st.font_file ? baseName(st.font_file) : 'Inter (built in)', { class: 'sm', onClick: async () => { const r = await dialog.openFiles([{ name: 'Font', extensions: ['ttf', 'otf'] }], false); if (r[0]) edit('Caption font', () => { st.font_file = r[0]; rebuild(); }); } }), st.font_file ? btn('', { icon: 'x', class: 'ghost sm', title: 'Use the built-in font', onClick: () => edit('Caption font', () => { st.font_file = null; rebuild(); }) }) : null), null, { class: 'wide' }),
    );
  };
  rebuild();
  bus.on('project', rebuild);
  void st;
  return h('details', { class: 'section', open: false }, h('summary', {}, 'Caption style'), body);
}
function colorInput(value, onChange) {
  const c = h('input', { class: 'color', type: 'color', value });
  c.addEventListener('input', () => { bus.emit('project-live'); });
  c.addEventListener('change', () => onChange(c.value));
  return c;
}
function checkbox(checked, onChange) {
  const cb = h('input', { class: 'check', type: 'checkbox', checked });
  cb.addEventListener('change', () => onChange(cb.checked));
  return cb;
}
