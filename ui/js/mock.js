// Browser stand-in for the Rust engine. Lets you open ui/index.html in a
// browser and work on the interface without building the app. Export and
// proxies are not available here; media is probed with browser decoders.

const files = new Map(); // fake path -> File
const listeners = new Map();

function emit(name, payload) {
  for (const cb of listeners.get(name) || []) cb(payload);
}

function register(file) {
  const path = URL.createObjectURL(file) + '#' + encodeURIComponent(file.name);
  files.set(path, file);
  return path;
}
const nameOf = path => decodeURIComponent(String(path).split('#').pop());
const urlOf = path => String(path).split('#')[0];

function loadEl(tag, src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement(tag);
    el.preload = 'auto';
    el.muted = true;
    el.onerror = () => reject(new Error('Unsupported format'));
    if (tag === 'img') { el.onload = () => resolve(el); }
    else { el.onloadedmetadata = () => resolve(el); }
    el.src = src;
  });
}

async function probe(path) {
  const file = files.get(path);
  const name = nameOf(path);
  const url = urlOf(path);
  const type = file?.type || '';
  const ext = name.split('.').pop().toLowerCase();
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
    const img = await loadEl('img', url);
    return { path, name, kind: 'image', duration: 0, width: img.naturalWidth, height: img.naturalHeight, fps: 0, has_video: true, has_audio: false, video_codec: ext, audio_codec: '', sample_rate: 0, channels: 0, rotation: 0, size: file?.size || 0, container: ext };
  }
  if (type.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext)) {
    const a = await loadEl('audio', url);
    return { path, name, kind: 'audio', duration: a.duration, width: 0, height: 0, fps: 0, has_video: false, has_audio: true, video_codec: '', audio_codec: ext, sample_rate: 44100, channels: 2, rotation: 0, size: file?.size || 0, container: ext };
  }
  const v = await loadEl('video', url);
  let duration = v.duration;
  if (!isFinite(duration)) {
    duration = await new Promise(res => { v.ondurationchange = () => { if (isFinite(v.duration)) res(v.duration); }; v.currentTime = 1e101; });
    v.currentTime = 0;
  }
  return { path, name, kind: 'video', duration, width: v.videoWidth, height: v.videoHeight, fps: 30, has_video: v.videoWidth > 0, has_audio: true, video_codec: ext, audio_codec: '', sample_rate: 48000, channels: 2, rotation: 0, size: file?.size || 0, container: ext };
}

async function filmstrip(path, kind, duration) {
  const url = urlOf(path);
  const W = 160, H = 90, N = kind === 'image' ? 1 : 12;
  const canvas = document.createElement('canvas');
  canvas.width = W * N; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const draw = (src, i, sw, sh) => {
    const s = Math.max(W / sw, H / sh);
    const w = sw * s, hh = sh * s;
    ctx.drawImage(src, i * W + (W - w) / 2, (H - hh) / 2, w, hh);
  };
  if (kind === 'image') {
    const img = await loadEl('img', url);
    draw(img, 0, img.naturalWidth, img.naturalHeight);
  } else {
    const v = await loadEl('video', url);
    for (let i = 0; i < N; i++) {
      await new Promise(res => { v.onseeked = res; v.currentTime = Math.min(duration - 0.05, (i + 0.5) * duration / N); });
      draw(v, i, v.videoWidth, v.videoHeight);
    }
  }
  return canvas.toDataURL('image/jpeg', 0.7);
}

async function waveform(path) {
  const file = files.get(path);
  if (!file) return null;
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const data = buf.getChannelData(0);
    const window_ = Math.floor(buf.sampleRate / 25);
    const peaks = [];
    for (let i = 0; i < data.length; i += window_) {
      let m = 0;
      for (let j = i; j < Math.min(i + window_, data.length); j += 4) m = Math.max(m, Math.abs(data[j]));
      peaks.push(m);
    }
    return peaks;
  } catch { return null; } finally { ctx.close(); }
}

const mock = {
  async invoke(cmd, args) {
    switch (cmd) {
      case 'ffmpeg_status': return { found: false, tools: null, encoders: [], target: 'browser', mock: true };
      case 'download_ffmpeg': throw new Error('Downloading FFmpeg needs the desktop app.');
      case 'probe_media': return probe(args.path);
      case 'generate_assets': return { key: args.path, filmstrip: args.kind === 'audio' ? null : await filmstrip(args.path, args.kind, args.duration), waveform: args.has_audio ? await waveform(args.path) : null, proxy: null };
      case 'make_proxy': throw new Error('Proxies need the desktop app.');
      case 'cancel_proxy': return false;
      case 'save_project': {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([args.json], { type: 'application/json' }));
        a.download = nameOf(args.path) || 'project.rve';
        a.click();
        return;
      }
      case 'load_project': { const f = files.get(args.path); if (!f) throw new Error('File not found'); return f.text(); }
      case 'read_text_file': { if (args.path === 'mock://autosave') return localStorage.getItem('rve.autosave') || ''; const f = files.get(args.path); if (!f) throw new Error('not found'); return f.text(); }
      case 'write_text_file': { if (args.path === 'mock://autosave') localStorage.setItem('rve.autosave', args.contents); return; }
      case 'file_exists': return args.path === 'mock://autosave' ? !!localStorage.getItem('rve.autosave') : files.has(args.path);
      case 'app_paths': return { data: 'mock://data', cache: 'mock://cache', autosave: 'mock://autosave' };
      case 'cache_size': return 0;
      case 'clear_cache': return 0;
      case 'start_export': {
        const duration = 2;
        const t0 = performance.now();
        const tick = () => {
          const t = (performance.now() - t0) / 1000;
          if (t < duration) { emit('export-progress', { out_time: t, duration, percent: t / duration * 100, frame: Math.round(t * 30), fps: 30, speed: 1 }); requestAnimationFrame(tick); }
          else emit('export-done', { ok: false, error: 'Exporting needs the desktop app. This browser preview cannot encode video.', output: args.settings.output, cancelled: false });
        };
        requestAnimationFrame(tick);
        return { command: 'ffmpeg (mock)', duration, log: '' };
      }
      case 'cancel_export': return true;
      case 'render_frame': throw new Error('Accurate preview needs the desktop app.');
      case 'reveal_path': case 'open_path': return;
      case 'open_url': window.open(args.url, '_blank'); return;
      case 'set_title': document.title = args.title; return;
      case 'quit_app': window.close(); return;
      case 'extract_frame': {
        const v = await loadEl('video', urlOf(args.path));
        await new Promise(res => { v.onseeked = res; v.currentTime = Math.max(0, args.time); });
        const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext('2d').drawImage(v, 0, 0);
        return c.toDataURL('image/png');
      }
      case 'export_frame': {
        const canvas = document.querySelector('.preview-stage canvas');
        const a = document.createElement('a');
        a.href = canvas.toDataURL(args.output.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
        a.download = nameOf(args.output) || 'frame.png';
        a.click();
        return args.output;
      }
      case 'save_data_url': return args.dataUrl;
      case 'detect_silence': return [];
      case 'sync_offset': return 0;
      case 'whisper_status': return { found: false, path: null };
      case 'transcribe': throw new Error('Auto-captions need the desktop app and whisper.cpp.');
      default: throw new Error(`mock: unknown command ${cmd}`);
    }
  },
  listen(name, cb) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    return () => listeners.get(name).delete(cb);
  },
  openFiles(filters, multiple) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = !!multiple;
      const exts = (filters || []).flatMap(f => f.extensions).filter(e => e !== '*');
      if (exts.length) input.accept = exts.map(e => '.' + e).join(',');
      input.onchange = () => resolve([...input.files].map(register));
      input.oncancel = () => resolve([]);
      input.click();
    });
  },
  saveFile(defaultPath) { return Promise.resolve(defaultPath || 'export.mp4'); },
  onFileDrop(cb, onHover) {
    let depth = 0;
    document.addEventListener('dragenter', e => { if ([...e.dataTransfer.types].includes('Files')) { depth++; onHover && onHover(true); } });
    document.addEventListener('dragleave', () => { if (depth > 0 && --depth === 0) onHover && onHover(false); });
    document.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    document.addEventListener('drop', e => { depth = 0; onHover && onHover(false); if (!e.dataTransfer.files.length) return; e.preventDefault(); cb([...e.dataTransfer.files].map(register)); });
  },
  register,
};
export default mock;
