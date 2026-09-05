// Settings, FFmpeg setup, project settings and About.

import { state, bus, edit, saveSettings, DEFAULT_SETTINGS } from './state.js';
import { RESOLUTIONS, FRAME_RATES } from './model.js';
import { invoke, listen, dialog, isTauri } from './bridge.js';
import { h, btn, modal, selectInput, numberInput, fmtBytes, toast } from './ui.js';
import { APP_NAME, APP_VERSION, REPO_URL } from './config.js';

export async function refreshFfmpeg() {
  try {
    state.ffmpeg = await invoke('ffmpeg_status', { customDir: state.settings.ffmpegDir || null });
  } catch (e) {
    state.ffmpeg = { found: false, error: String(e) };
  }
  bus.emit('ffmpeg');
  return state.ffmpeg;
}

export function openSettings(tab = 'general') {
  const tabs = h('div', { class: 'tabs' });
  const body = h('div', {});
  const pages = { general: generalPage, ffmpeg: ffmpegPage, cache: cachePage, about: aboutPage };
  const show = id => {
    for (const t of tabs.children) t.classList.toggle('active', t.dataset.id === id);
    body.replaceChildren(pages[id]());
  };
  for (const [id, label] of [['general', 'General'], ['ffmpeg', 'FFmpeg'], ['cache', 'Cache'], ['about', 'About']]) {
    tabs.append(h('div', { class: 'tab', dataset: { id }, onClick: () => show(id) }, label));
  }
  show(tab);
  modal({ title: 'Settings', wide: true, body: h('div', {}, tabs, h('div', { style: { paddingTop: '12px' } }, body)), buttons: [{ label: 'Done', primary: true }] });
}

function generalPage() {
  const s = state.settings;
  const form = h('div', { class: 'form' });
  const row = (label, ctl, hint) => { form.append(h('label', {}, label), h('div', {}, ctl, hint ? h('div', { class: 'hint' }, hint) : null)); };
  row('Theme', selectInput(s.theme, [{ id: 'dark', name: 'Dark' }, { id: 'light', name: 'Light' }], v => { s.theme = v; saveSettings(); applyTheme(); }));
  row('Preview quality', selectInput(s.previewQuality, [{ id: 'full', name: 'Full resolution' }, { id: 'half', name: 'Half (recommended)' }, { id: 'quarter', name: 'Quarter (fastest)' }], v => { s.previewQuality = v; saveSettings(); }), 'Only affects the preview, never the export.');
  row('Proxies', selectInput(s.autoProxy, [{ id: 'never', name: 'Only when a file cannot be played' }, { id: 'above1080', name: 'For media above 1080p' }, { id: 'always', name: 'For all video' }], v => { s.autoProxy = v; saveSettings(); }), 'Smaller H.264 copies for smooth playback. Export always uses the originals.');
  row('Proxy width', numberInput(s.proxyWidth, { min: 320, max: 3840, step: 10, onChange: v => { s.proxyWidth = v; saveSettings(); } }));
  row('Image duration (s)', numberInput(s.defaultImageDuration, { min: 0.1, step: 0.5, onChange: v => { s.defaultImageDuration = v; saveSettings(); } }));
  row('Title duration (s)', numberInput(s.defaultTitleDuration, { min: 0.1, step: 0.5, onChange: v => { s.defaultTitleDuration = v; saveSettings(); } }));
  row('Transition length (s)', numberInput(s.defaultTransition, { min: 0.1, max: 10, step: 0.1, onChange: v => { s.defaultTransition = v; saveSettings(); } }));
  const auto = h('input', { class: 'check', type: 'checkbox', checked: s.autosave });
  auto.addEventListener('change', () => { s.autosave = auto.checked; saveSettings(); });
  row('Autosave', h('label', { class: 'row' }, auto, ' Keep a recovery copy every minute'));
  form.append(h('div', { class: 'full' }, btn('Reset to defaults', { class: 'sm', onClick: () => { Object.assign(state.settings, DEFAULT_SETTINGS, { recent: s.recent }); saveSettings(); applyTheme(); toast('Settings reset'); } })));
  return form;
}

export function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme === 'light' ? 'light' : 'dark';
}

function ffmpegPage() {
  const f = state.ffmpeg;
  const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });
  const status = h('div', {});
  const render = () => {
    const f = state.ffmpeg;
    status.replaceChildren(
      f?.found
        ? h('div', {}, h('span', { class: 'pill ok' }, h('span', { class: 'dot' }), `FFmpeg ${f.tools.version} · ${f.tools.source}`), h('div', { class: 'hint mono', style: { marginTop: '6px' } }, f.tools.ffmpeg), h('div', { class: 'hint' }, `${f.encoders.length} encoders · hardware: ${f.encoders.filter(e => /videotoolbox|nvenc|qsv|amf|vaapi/.test(e)).join(', ') || 'none detected'}`))
        : h('div', {}, h('span', { class: 'pill bad' }, h('span', { class: 'dot' }), 'FFmpeg not found'), h('div', { class: 'hint', style: { marginTop: '6px' } }, isTauri ? 'RueyVideoEditor needs FFmpeg for importing, thumbnails and export. Download it here (about 90 MB), install it with your package manager, or pick a folder that contains ffmpeg and ffprobe.' : 'You are running the UI in a browser. Build the desktop app to use FFmpeg.')),
    );
  };
  render();
  const progress = h('div', { class: 'progress', hidden: true }, h('div'));
  const progressText = h('div', { class: 'hint' });
  const dl = btn('Download FFmpeg', { primary: true, icon: 'download', disabled: !isTauri, onClick: async () => {
    dl.disabled = true; progress.hidden = false;
    const un = await listen('ffmpeg-download', p => { const pct = p.total ? p.downloaded / p.total * 100 : 0; progress.firstChild.style.width = `${pct}%`; progressText.textContent = `${p.name}: ${fmtBytes(p.downloaded)}${p.total ? ` / ${fmtBytes(p.total)}` : ''}`; });
    try { await invoke('download_ffmpeg'); toast('FFmpeg installed', 'success'); await refreshFfmpeg(); render(); }
    catch (e) { toast(`Download failed: ${e}`, 'error', 8000); }
    un && un();
    dl.disabled = false; progress.hidden = true; progressText.textContent = '';
  } });
  const custom = h('input', { class: 'input', value: state.settings.ffmpegDir || '', placeholder: 'Folder containing ffmpeg and ffprobe (optional)' });
  custom.addEventListener('change', async () => { state.settings.ffmpegDir = custom.value.trim(); saveSettings(); await refreshFfmpeg(); render(); });
  custom.addEventListener('keydown', e => e.stopPropagation());
  box.append(status, h('div', { class: 'row' }, dl, btn('Choose folder…', { onClick: async () => { const d = await dialog.pickDir('Folder with ffmpeg and ffprobe'); if (d) { custom.value = d; state.settings.ffmpegDir = d; saveSettings(); await refreshFfmpeg(); render(); } } }), btn('Re-check', { icon: 'refresh', onClick: async () => { await refreshFfmpeg(); render(); } })), progress, progressText, custom,
    h('div', { class: 'hint' }, 'Lookup order: this folder → next to the app → downloaded copy → PATH. Downloads come from github.com/eugeneware/ffmpeg-static (FFmpeg is LGPL/GPL software).'));
  void f;
  return box;
}

function cachePage() {
  const size = h('span', {}, '…');
  const box = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', {}, 'Thumbnails, waveforms, proxies and export logs are cached on disk: ', size),
    h('div', { class: 'row' }, btn('Clear cache', { class: 'danger', onClick: async () => { const b = await invoke('clear_cache'); toast(`Freed ${fmtBytes(b)}`); size.textContent = '0 B'; for (const a of Object.values(state.assets)) { a.proxy = null; a.filmstrip = null; } bus.emit('assets'); } }),
      btn('Show cache folder', { disabled: !isTauri, onClick: async () => { const p = await invoke('app_paths'); invoke('open_path', { path: p.cache }); } })));
  invoke('cache_size').then(b => { size.textContent = fmtBytes(b); }).catch(() => { size.textContent = '?'; });
  return box;
}

function aboutPage() {
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('div', {}, h('b', {}, `${APP_NAME} ${APP_VERSION}`), h('div', { class: 'hint' }, 'Free and open-source video editor. Rust + FFmpeg engine, web UI in a native window (Tauri).')),
    h('div', { class: 'row' }, btn('Source code on GitHub', { icon: 'external', onClick: () => invoke('open_url', { url: REPO_URL }) }), btn('Report a problem', { onClick: () => invoke('open_url', { url: REPO_URL + '/issues' }) })),
    h('div', { class: 'hint' }, 'RueyVideoEditor is MIT licensed. It runs FFmpeg (LGPL/GPL) as a separate program and bundles the Inter font (OFL).'),
  );
}

export function openProjectSettings() {
  const s = state.project.settings;
  const draft = { ...s, name: state.project.name };
  const form = h('div', { class: 'form' });
  const name = h('input', { class: 'input', value: draft.name });
  name.addEventListener('keydown', e => e.stopPropagation());
  const resSel = selectInput(`${draft.width}x${draft.height}`, [...RESOLUTIONS.map(r => ({ id: `${r.w}x${r.h}`, name: r.label })), { id: 'custom', name: 'Custom' }], v => { if (v !== 'custom') [draft.width, draft.height] = v.split('x').map(Number); w.value = draft.width; hgt.value = draft.height; });
  if (!RESOLUTIONS.some(r => r.w === draft.width && r.h === draft.height)) resSel.value = 'custom';
  const w = numberInput(draft.width, { min: 16, max: 8192, step: 2, onChange: v => { draft.width = v; resSel.value = 'custom'; } });
  const hgt = numberInput(draft.height, { min: 16, max: 8192, step: 2, onChange: v => { draft.height = v; resSel.value = 'custom'; } });
  form.append(h('label', {}, 'Project name'), name,
    h('label', {}, 'Resolution'), resSel,
    h('label', {}, 'Size'), h('div', { class: 'row' }, w, '×', hgt),
    h('label', {}, 'Frame rate'), selectInput(String(draft.fps), FRAME_RATES.map(f => ({ id: String(f), name: `${f} fps` })), v => { draft.fps = parseFloat(v); }),
    h('label', {}, 'Audio sample rate'), selectInput(String(draft.sample_rate), [44100, 48000].map(r => ({ id: String(r), name: `${r} Hz` })), v => { draft.sample_rate = parseInt(v); }));
  modal({ title: 'Project settings', body: form, buttons: [{ label: 'Cancel' }, { label: 'Apply', primary: true, onClick: c => { edit('Project settings', () => { state.project.name = name.value.trim() || 'Untitled'; Object.assign(state.project.settings, { width: draft.width & ~1, height: draft.height & ~1, fps: draft.fps, sample_rate: draft.sample_rate }); }); c(); } }] });
}
