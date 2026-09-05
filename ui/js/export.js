// Export dialog and progress.

import { state, bus } from './state.js';
import { projectDuration } from './model.js';
import { invoke, listen, dialog, isTauri } from './bridge.js';
import { h, btn, icon, modal, selectInput, numberInput, rangeInput, fmtTimecode, toast, baseName } from './ui.js';
import { pause } from './preview.js';
import { RESOLUTIONS, FRAME_RATES } from './model.js';

const HW = ['h264_videotoolbox', 'hevc_videotoolbox', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf', 'h264_vaapi', 'hevc_vaapi'];
const VIDEO_CODECS = [
  { id: 'libx264', name: 'H.264 (libx264)', ext: 'mp4' },
  { id: 'libx265', name: 'H.265 / HEVC (libx265)', ext: 'mp4' },
  { id: 'h264_videotoolbox', name: 'H.264 · Apple hardware', ext: 'mp4' },
  { id: 'hevc_videotoolbox', name: 'HEVC · Apple hardware', ext: 'mp4' },
  { id: 'h264_nvenc', name: 'H.264 · NVIDIA NVENC', ext: 'mp4' },
  { id: 'hevc_nvenc', name: 'HEVC · NVIDIA NVENC', ext: 'mp4' },
  { id: 'h264_qsv', name: 'H.264 · Intel Quick Sync', ext: 'mp4' },
  { id: 'hevc_qsv', name: 'HEVC · Intel Quick Sync', ext: 'mp4' },
  { id: 'h264_amf', name: 'H.264 · AMD AMF', ext: 'mp4' },
  { id: 'hevc_amf', name: 'HEVC · AMD AMF', ext: 'mp4' },
  { id: 'libvpx-vp9', name: 'VP9 (WebM)', ext: 'webm' },
  { id: 'libaom-av1', name: 'AV1 (libaom)', ext: 'mp4' },
  { id: 'libsvtav1', name: 'AV1 (SVT)', ext: 'mp4' },
  { id: 'prores_ks', name: 'ProRes 422 HQ (MOV)', ext: 'mov' },
  { id: 'gif', name: 'GIF animation', ext: 'gif' },
  { id: 'none', name: 'No video (audio only)', ext: 'm4a' },
];
const AUDIO_CODECS = [
  { id: 'aac', name: 'AAC' }, { id: 'libopus', name: 'Opus' }, { id: 'libmp3lame', name: 'MP3' }, { id: 'pcm_s16le', name: 'PCM (uncompressed)' }, { id: 'flac', name: 'FLAC' }, { id: 'none', name: 'No audio' },
];
const PRESETS = [
  { id: 'h264', name: 'MP4 · H.264 — plays everywhere', video_codec: 'libx264', audio_codec: 'aac', quality: 20 },
  { id: 'h265', name: 'MP4 · HEVC — smaller files', video_codec: 'libx265', audio_codec: 'aac', quality: 24 },
  { id: 'hw', name: 'MP4 · hardware encoder — fastest', video_codec: 'auto-hw', audio_codec: 'aac', quality: 20 },
  { id: 'prores', name: 'MOV · ProRes — for further editing', video_codec: 'prores_ks', audio_codec: 'pcm_s16le', quality: 0 },
  { id: 'webm', name: 'WebM · VP9', video_codec: 'libvpx-vp9', audio_codec: 'libopus', quality: 31 },
  { id: 'gif', name: 'GIF', video_codec: 'gif', audio_codec: 'none', quality: 0 },
  { id: 'mp3', name: 'Audio only · MP3', video_codec: 'none', audio_codec: 'libmp3lame', quality: 0 },
  { id: 'wav', name: 'Audio only · WAV', video_codec: 'none', audio_codec: 'pcm_s16le', quality: 0 },
  { id: 'custom', name: 'Custom', video_codec: null },
];
const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'];

function extFor(codec, audio) {
  if (codec === 'none') return audio === 'libmp3lame' ? 'mp3' : audio === 'pcm_s16le' ? 'wav' : audio === 'flac' ? 'flac' : audio === 'libopus' ? 'opus' : 'm4a';
  return VIDEO_CODECS.find(c => c.id === codec)?.ext || 'mp4';
}

function loadLast() {
  try { return JSON.parse(localStorage.getItem('rve.export') || '{}'); } catch { return {}; }
}
function saveLast(s) { try { localStorage.setItem('rve.export', JSON.stringify(s)); } catch {} }

export function openExportDialog() {
  pause();
  if (projectDuration(state.project) <= 0) { toast('The timeline is empty', 'error'); return; }
  const encoders = state.ffmpeg?.encoders || [];
  const available = id => !encoders.length || encoders.includes(id) || id === 'none' || id === 'gif';
  const hw = HW.find(e => encoders.includes(e));
  const last = loadLast();
  const ps = state.project.settings;
  const s = {
    preset: last.preset || 'h264',
    video_codec: last.video_codec || 'libx264',
    quality: last.quality ?? 20,
    bitrate_kbps: last.bitrate_kbps || 0,
    useBitrate: !!last.useBitrate,
    preset_speed: last.preset_speed || 'medium',
    audio_codec: last.audio_codec || 'aac',
    audio_bitrate_kbps: last.audio_bitrate_kbps || 192,
    resolution: last.resolution || 'project',
    width: last.width || ps.width,
    height: last.height || ps.height,
    fps: last.fps || 'project',
    range: state.inPoint != null || state.outPoint != null ? 'inout' : 'all',
    outputDir: last.outputDir || '',
  };
  if (!available(s.video_codec)) s.video_codec = 'libx264';

  const form = h('div', { class: 'form' });
  const rebuild = () => {
    form.replaceChildren();
    const row = (label, ctl) => form.append(h('label', {}, label), ctl);
    row('Preset', selectInput(s.preset, PRESETS.filter(p => p.id !== 'hw' || hw), v => {
      s.preset = v;
      const p = PRESETS.find(x => x.id === v);
      if (p && p.video_codec) { s.video_codec = p.video_codec === 'auto-hw' ? hw : p.video_codec; s.audio_codec = p.audio_codec; s.quality = p.quality; s.useBitrate = false; }
      rebuild();
    }));
    form.append(h('h4', {}, 'Video'));
    row('Codec', selectInput(s.video_codec, VIDEO_CODECS.filter(c => available(c.id)), v => { s.video_codec = v; s.preset = 'custom'; rebuild(); }));
    if (s.video_codec !== 'none' && s.video_codec !== 'gif' && s.video_codec !== 'prores_ks') {
      const q = h('div', { class: 'row' });
      const qLabel = h('span', { class: 'hint', style: { minWidth: '150px' } });
      const setLabel = () => { qLabel.textContent = s.useBitrate ? `${s.bitrate_kbps} kbps` : `${s.quality} — ${s.quality <= 16 ? 'visually lossless' : s.quality <= 22 ? 'high quality' : s.quality <= 28 ? 'good' : 'small file'}`; };
      const mode = selectInput(s.useBitrate ? 'bitrate' : 'quality', [{ id: 'quality', name: 'Constant quality' }, { id: 'bitrate', name: 'Bitrate' }], v => { s.useBitrate = v === 'bitrate'; if (s.useBitrate && !s.bitrate_kbps) s.bitrate_kbps = 8000; rebuild(); });
      row('Rate control', mode);
      if (s.useBitrate) {
        q.append(numberInput(s.bitrate_kbps, { min: 100, max: 200000, step: 100, onChange: v => { s.bitrate_kbps = v; setLabel(); } }), h('span', { class: 'hint' }, 'kbps'));
      } else {
        q.append(rangeInput(s.quality, { min: 0, max: 51, step: 1, onInput: v => { s.quality = v; setLabel(); } }), qLabel);
      }
      setLabel();
      row(s.useBitrate ? 'Bitrate' : 'Quality (CRF)', q);
      if (s.video_codec === 'libx264' || s.video_codec === 'libx265') row('Encoder speed', selectInput(s.preset_speed, X264_PRESETS.map(p => ({ id: p, name: p })), v => { s.preset_speed = v; }));
    }
    if (s.video_codec !== 'none') {
      const resOpts = [{ id: 'project', name: `Project (${ps.width}×${ps.height})` }, ...RESOLUTIONS.map(r => ({ id: `${r.w}x${r.h}`, name: r.label })), { id: 'custom', name: 'Custom…' }];
      row('Resolution', selectInput(s.resolution, resOpts, v => { s.resolution = v; rebuild(); }));
      if (s.resolution === 'custom') row('Size', h('div', { class: 'row' }, numberInput(s.width, { min: 16, max: 8192, step: 2, onChange: v => { s.width = v; } }), '×', numberInput(s.height, { min: 16, max: 8192, step: 2, onChange: v => { s.height = v; } })));
      row('Frame rate', selectInput(String(s.fps), [{ id: 'project', name: `Project (${ps.fps})` }, ...FRAME_RATES.map(f => ({ id: String(f), name: String(f) }))], v => { s.fps = v; }));
    }
    if (s.video_codec !== 'gif') {
      form.append(h('h4', {}, 'Audio'));
      row('Codec', selectInput(s.audio_codec, AUDIO_CODECS.filter(c => available(c.id)), v => { s.audio_codec = v; s.preset = 'custom'; rebuild(); }));
      if (s.audio_codec !== 'none' && s.audio_codec !== 'pcm_s16le' && s.audio_codec !== 'flac') row('Bitrate', selectInput(String(s.audio_bitrate_kbps), [96, 128, 160, 192, 256, 320].map(b => ({ id: String(b), name: `${b} kbps` })), v => { s.audio_bitrate_kbps = parseInt(v); }));
    }
    form.append(h('h4', {}, 'Range'));
    const hasInOut = state.inPoint != null || state.outPoint != null;
    row('Export', selectInput(s.range, [{ id: 'all', name: `Whole timeline (${fmtTimecode(projectDuration(state.project), ps.fps)})` }, ...(hasInOut ? [{ id: 'inout', name: `In → out (${fmtTimecode(state.inPoint ?? 0, ps.fps)} → ${fmtTimecode(state.outPoint ?? projectDuration(state.project), ps.fps)})` }] : [])], v => { s.range = v; }));
  };
  rebuild();

  const m = modal({
    title: 'Export', wide: true, body: form,
    buttons: [
      { label: 'Cancel' },
      { label: 'Export…', primary: true, icon: 'export', onClick: async close => {
        const settings = buildSettings(s);
        const name = (state.project.name || 'export').replace(/[^\w\- ]+/g, '').trim() || 'export';
        const ext = extFor(s.video_codec, s.audio_codec);
        const defaultPath = (s.outputDir ? s.outputDir + '/' : '') + `${name}.${ext}`;
        const out = await dialog.saveFile(defaultPath, [{ name: ext.toUpperCase(), extensions: [ext] }]);
        if (!out) return;
        settings.output = out;
        s.outputDir = out.replace(/[\\/][^\\/]*$/, '');
        saveLast(s);
        close();
        runExport(settings);
      } },
    ],
  });
  void m;
}

function buildSettings(s) {
  const ps = state.project.settings;
  let width = 0, height = 0;
  if (s.resolution === 'custom') { width = s.width; height = s.height; }
  else if (s.resolution !== 'project') { [width, height] = s.resolution.split('x').map(Number); }
  const range = s.range === 'inout' ? [state.inPoint ?? 0, state.outPoint ?? projectDuration(state.project)] : null;
  return {
    output: '', width, height, fps: s.fps === 'project' ? 0 : parseFloat(s.fps),
    video_codec: s.video_codec, quality: s.quality, bitrate_kbps: s.useBitrate ? s.bitrate_kbps : 0, preset: s.preset_speed,
    audio_codec: s.audio_codec, audio_bitrate_kbps: s.audio_bitrate_kbps, range,
  };
  void ps;
}

let unlistenProgress = null, unlistenDone = null;

async function runExport(settings) {
  const bar = h('div', { class: 'progress' }, h('div'));
  const status = h('div', { class: 'hint' }, 'Starting ffmpeg…');
  const stats = h('div', { class: 'hint mono' }, '');
  const body = h('div', {}, h('div', { class: 'mono hint', style: { marginBottom: '8px' } }, baseName(settings.output)), bar, h('div', { style: { height: '8px' } }), status, stats);
  let started = null;
  let finished = false;
  const t0 = performance.now();
  const dlg = modal({
    title: 'Exporting', body, closable: false,
    buttons: [
      { label: 'Cancel', class: 'danger', onClick: async close => { if (finished) { close(); return; } await invoke('cancel_export'); status.textContent = 'Cancelling…'; } },
    ],
  });
  if (unlistenProgress) unlistenProgress();
  if (unlistenDone) unlistenDone();
  unlistenProgress = await listen('export-progress', p => {
    bar.firstChild.style.width = `${p.percent.toFixed(1)}%`;
    const elapsed = (performance.now() - t0) / 1000;
    const eta = p.percent > 1 ? elapsed * (100 - p.percent) / p.percent : null;
    status.textContent = `${p.percent.toFixed(0)}% — ${fmtTimecode(p.out_time, state.project.settings.fps)} of ${fmtTimecode(p.duration, state.project.settings.fps)}${eta != null ? ` · about ${Math.ceil(eta)}s left` : ''}`;
    stats.textContent = `frame ${p.frame} · ${p.fps.toFixed(0)} fps · ${p.speed.toFixed(2)}× realtime`;
  });
  unlistenDone = await listen('export-done', d => {
    finished = true;
    dlg.close();
    if (d.cancelled) { toast('Export cancelled'); return; }
    if (!d.ok) { showError(d.error || 'Unknown error', started); return; }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    modal({
      title: 'Export finished',
      body: h('div', {}, h('div', {}, h('b', {}, baseName(d.output))), h('div', { class: 'hint' }, `Rendered in ${secs}s`)),
      buttons: [
        { label: 'Show ffmpeg command', left: true, onClick: () => showCommand(started) },
        { label: 'Close' },
        ...(isTauri ? [{ label: 'Show in folder', onClick: c => { invoke('reveal_path', { path: d.output }); c(); } }, { label: 'Open', primary: true, onClick: c => { invoke('open_path', { path: d.output }); c(); } }] : []),
      ],
    });
  });
  try {
    started = await invoke('start_export', { project: state.project, settings, customDir: state.settings.ffmpegDir || null });
  } catch (e) {
    finished = true;
    dlg.close();
    showError(String(e), null);
  }
}

function showError(message, started) {
  modal({
    title: 'Export failed',
    body: h('div', {}, h('div', { class: 'log-box mono' }, message), started ? h('div', { class: 'hint', style: { marginTop: '8px' } }, `Full log: ${started.log}`) : null),
    buttons: [
      ...(started ? [{ label: 'Show ffmpeg command', left: true, onClick: () => showCommand(started) }] : []),
      { label: 'Close', primary: true },
    ],
  });
}
function showCommand(started) {
  if (!started) return;
  modal({
    title: 'ffmpeg command', wide: true,
    body: h('div', {}, h('div', { class: 'hint', style: { marginBottom: '6px' } }, 'This is what RueyVideoEditor ran. The filter graph is in graph.txt next to the log.'), h('div', { class: 'log-box mono' }, started.command)),
    buttons: [{ label: 'Copy', onClick: c => { navigator.clipboard?.writeText(started.command); toast('Copied'); c(); } }, { label: 'Close', primary: true }],
  });
}
