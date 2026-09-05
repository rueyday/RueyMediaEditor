//! Filmstrips, waveforms and proxies for the media bin, generated with ffmpeg.

use crate::ffmpeg::{command, run_simple, run_with_progress, ChildSlot, Tools};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

/// Cache key for a media file: path + size + modification time.
pub fn media_key(path: &Path) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.to_string_lossy().hash(&mut h);
    if let Ok(meta) = std::fs::metadata(path) {
        meta.len().hash(&mut h);
        if let Ok(m) = meta.modified() {
            if let Ok(d) = m.duration_since(std::time::UNIX_EPOCH) {
                d.as_secs().hash(&mut h);
            }
        }
    }
    format!("{:016x}", h.finish())
}

pub const FILMSTRIP_FRAMES: u32 = 40;
pub const FILMSTRIP_W: u32 = 160;
pub const FILMSTRIP_H: u32 = 90;

/// One JPEG holding `FILMSTRIP_FRAMES` thumbnails side by side.
pub fn filmstrip(
    tools: &Tools,
    path: &Path,
    duration: f64,
    is_image: bool,
    out: &Path,
) -> Result<(), String> {
    if out.exists() {
        return Ok(());
    }
    let mut cmd = command(&tools.ffmpeg);
    cmd.args(["-hide_banner", "-y", "-loglevel", "error"]);
    if is_image || duration <= 0.0 {
        cmd.arg("-i").arg(path).args([
            "-vf",
            &format!("scale={FILMSTRIP_W}:{FILMSTRIP_H}:force_original_aspect_ratio=increase,crop={FILMSTRIP_W}:{FILMSTRIP_H}"),
            "-frames:v", "1", "-q:v", "4",
        ]);
    } else {
        let frames = FILMSTRIP_FRAMES;
        let rate = frames as f64 / duration;
        cmd.arg("-i").arg(path).args([
            "-vf",
            &format!(
                "fps={rate:.6},scale={FILMSTRIP_W}:{FILMSTRIP_H}:force_original_aspect_ratio=increase,crop={FILMSTRIP_W}:{FILMSTRIP_H},tile={frames}x1"
            ),
            "-frames:v", "1", "-q:v", "4",
        ]);
    }
    cmd.arg(out);
    run_simple(cmd).map(|_| ())
}

pub const WAVEFORM_PPS: usize = 25; // peaks per second

/// Mono peak values, `WAVEFORM_PPS` per second, 0..1.
pub fn waveform(tools: &Tools, path: &Path) -> Result<Vec<f32>, String> {
    const RATE: usize = 4000;
    let mut cmd = command(&tools.ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args([
            "-vn",
            "-ac",
            "1",
            "-ar",
            &RATE.to_string(),
            "-f",
            "s16le",
            "-",
        ]);
    let bytes = run_simple(cmd)?;
    let window = RATE / WAVEFORM_PPS;
    let mut peaks = Vec::with_capacity(bytes.len() / 2 / window + 1);
    let mut max: i32 = 0;
    let mut count = 0usize;
    for pair in bytes.chunks_exact(2) {
        let v = i16::from_le_bytes([pair[0], pair[1]]) as i32;
        max = max.max(v.abs());
        count += 1;
        if count == window {
            peaks.push(max as f32 / 32768.0);
            max = 0;
            count = 0;
        }
    }
    if count > 0 {
        peaks.push(max as f32 / 32768.0);
    }
    Ok(peaks)
}

/// File name of the proxy for the current platform. Linux's WebKitGTK usually
/// lacks an H.264 decoder but ships VP8 via gst-plugins-good, so use WebM there.
pub fn proxy_name() -> &'static str {
    if cfg!(target_os = "linux") {
        "proxy.webm"
    } else {
        "proxy.mp4"
    }
}

/// Small preview copy of a video for formats the webview can't play (or heavy 4K).
pub fn proxy(
    tools: &Tools,
    path: &Path,
    out: &Path,
    max_width: u32,
    slot: &ChildSlot,
    on_progress: impl FnMut(crate::ffmpeg::Progress),
) -> Result<PathBuf, String> {
    let webm = out.extension().map(|e| e == "webm").unwrap_or(false);
    let tmp = out.with_extension(if webm { "part.webm" } else { "part.mp4" });
    let mut cmd = command(&tools.ffmpeg);
    cmd.args([
        "-hide_banner",
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-i",
    ])
    .arg(path)
    .args([
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-sn",
        "-dn",
        "-vf",
        &format!("scale='min({max_width},iw)':-2,format=yuv420p"),
    ]);
    if webm {
        cmd.args([
            "-c:v",
            "libvpx",
            "-deadline",
            "realtime",
            "-cpu-used",
            "6",
            "-b:v",
            "4M",
            "-g",
            "30",
            "-c:a",
            "libopus",
            "-b:a",
            "128k",
            "-ac",
            "2",
        ]);
    } else {
        cmd.args([
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "22",
            "-g",
            "30",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ac",
            "2",
            "-movflags",
            "+faststart",
        ]);
    }
    cmd.arg(&tmp);
    run_with_progress(cmd, slot, on_progress)?;
    std::fs::rename(&tmp, out).map_err(|e| format!("Cannot finish proxy: {e}"))?;
    Ok(out.to_path_buf())
}
