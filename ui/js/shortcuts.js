// Keyboard shortcuts.

import { state, bus, undo, redo, setPlayhead } from './state.js';
import { projectDuration } from './model.js';
import * as ops from './ops.js';
import * as timeline from './timeline.js';
import { togglePlay, pause, play, stepFrame, seekTo } from './preview.js';
import { closeContextMenu } from './ui.js';

export function initShortcuts(actions) {
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
    if (document.querySelector('.modal-backdrop')) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    const fps = state.project.settings.fps || 30;
    const handled = () => { e.preventDefault(); closeContextMenu(); };
    if (mod) {
      switch (key.toLowerCase()) {
        case 'z': handled(); e.shiftKey ? redo() : undo(); return;
        case 'y': handled(); redo(); return;
        case 's': handled(); e.shiftKey ? actions.saveAs() : actions.save(); return;
        case 'o': handled(); actions.open(); return;
        case 'n': handled(); actions.newProject(); return;
        case 'e': handled(); actions.exportDialog(); return;
        case 'i': handled(); actions.importMedia(); return;
        case 'a': handled(); ops.selectAll(); return;
        case 'c': handled(); ops.copySelected(); return;
        case 'x': handled(); ops.cutSelected(); return;
        case 'v': handled(); ops.paste(); return;
        case 'd': handled(); ops.duplicateSelected(); return;
        case ',': handled(); actions.settings(); return;
        case '=': case '+': handled(); timeline.zoomBy(1.4); return;
        case '-': handled(); timeline.zoomBy(1 / 1.4); return;
        default: return;
      }
    }
    switch (key) {
      case ' ': handled(); togglePlay(); return;
      case 'k': case 'K': handled(); pause(); return;
      case 'l': case 'L': handled(); play(); return;
      case 'j': case 'J': handled(); seekTo(state.playhead - 1); return;
      case 'ArrowLeft': handled(); e.shiftKey ? seekTo(state.playhead - 1) : stepFrame(-1); return;
      case 'ArrowRight': handled(); e.shiftKey ? seekTo(state.playhead + 1) : stepFrame(1); return;
      case 'ArrowUp': handled(); ops.goToPrevEdit(); return;
      case 'ArrowDown': handled(); ops.goToNextEdit(); return;
      case 'Home': handled(); seekTo(0); return;
      case 'End': handled(); seekTo(projectDuration(state.project)); return;
      case 'Delete': case 'Backspace': handled(); ops.deleteSelected({ ripple: e.shiftKey }); return;
      case 's': case 'S': handled(); ops.splitAtPlayhead(); return;
      case 'm': case 'M': handled(); ops.addMarker(); return;
      case 'i': handled(); ops.setInPoint(); return;
      case 'o': handled(); ops.setOutPoint(); return;
      case 'I': case 'O': handled(); ops.clearInOut(); return;
      case 'v': case 'V': handled(); timeline.setTool('select'); return;
      case 'c': case 'C': handled(); timeline.setTool('razor'); return;
      case 'n': case 'N': handled(); timeline.toggleSnap(); return;
      case '+': case '=': handled(); timeline.zoomBy(1.4); return;
      case '-': case '_': handled(); timeline.zoomBy(1 / 1.4); return;
      case 'Z': handled(); timeline.zoomToFit(); return;
      case ',': handled(); ops.nudgeSelected(-1 / fps); return;
      case '.': handled(); ops.nudgeSelected(1 / fps); return;
      case 'Escape': handled(); bus.emit('escape'); return;
      default: return;
    }
  });
}
