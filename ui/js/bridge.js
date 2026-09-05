// Bridge to the Rust engine. In a plain browser (no Tauri) a mock is used so
// the UI can be developed and tested without compiling anything.

const T = window.__TAURI__;
export const isTauri = !!T;

let mock = null;
async function getMock() {
  if (!mock) mock = (await import('./mock.js')).default;
  return mock;
}
if (!isTauri) getMock();

export async function invoke(cmd, args = {}) {
  if (isTauri) return T.core.invoke(cmd, args);
  return (await getMock()).invoke(cmd, args);
}

export async function listen(name, cb) {
  if (isTauri) return T.event.listen(name, e => cb(e.payload));
  return (await getMock()).listen(name, cb);
}

/** URL the webview can load for a local file path. */
export function fileSrc(path) {
  if (!path) return '';
  if (isTauri) return T.core.convertFileSrc(path);
  return path;
}

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'flv', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'mts', '3gp', 'ogv', 'mxf', 'vob', 'gif'];
const AUDIO_EXT = ['mp3', 'wav', 'aac', 'm4a', 'flac', 'ogg', 'opus', 'aiff', 'aif', 'wma'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'heic', 'avif'];
export const MEDIA_FILTERS = [
  { name: 'Media', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT] },
  { name: 'Video', extensions: VIDEO_EXT },
  { name: 'Audio', extensions: AUDIO_EXT },
  { name: 'Images', extensions: IMAGE_EXT },
  { name: 'All files', extensions: ['*'] },
];
export const PROJECT_FILTER = [{ name: 'RueyMediaEditor project', extensions: ['rve'] }];

export const dialog = {
  async openFiles(filters = MEDIA_FILTERS, multiple = true) {
    if (isTauri) {
      const r = await T.dialog.open({ multiple, filters, title: 'Import media' });
      if (!r) return [];
      return Array.isArray(r) ? r : [r];
    }
    return (await getMock()).openFiles(filters, multiple);
  },
  async openProject() {
    if (isTauri) return T.dialog.open({ multiple: false, filters: PROJECT_FILTER, title: 'Open project' });
    const r = await (await getMock()).openFiles(PROJECT_FILTER, false);
    return r[0] || null;
  },
  async saveFile(defaultPath, filters) {
    if (isTauri) return T.dialog.save({ defaultPath, filters });
    return (await getMock()).saveFile(defaultPath);
  },
  async pickDir(title = 'Choose folder') {
    if (isTauri) return T.dialog.open({ directory: true, multiple: false, title });
    return null;
  },
  async message(text, opts = {}) {
    if (isTauri) return T.dialog.message(text, opts);
    alert(text);
  },
};

/** cb(paths[]) when files are dropped on the window. */
export async function onFileDrop(cb, onHover) {
  if (isTauri) {
    await T.event.listen('tauri://drag-enter', () => onHover && onHover(true));
    await T.event.listen('tauri://drag-over', () => onHover && onHover(true));
    await T.event.listen('tauri://drag-leave', () => onHover && onHover(false));
    await T.event.listen('tauri://drag-drop', e => { onHover && onHover(false); const p = e.payload?.paths || []; if (p.length) cb(p); });
    return;
  }
  (await getMock()).onFileDrop(cb, onHover);
}

export function kindFromPath(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  if (AUDIO_EXT.includes(ext)) return 'audio';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return 'video';
}
