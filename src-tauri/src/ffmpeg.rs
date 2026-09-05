//! Finding, downloading and running FFmpeg.
//!
//! Lookup order: a user-chosen directory, a sidecar next to the executable
//! (release bundles), a copy RueyVideoEditor downloaded itself, then the PATH.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

/// Release of https://github.com/eugeneware/ffmpeg-static used for downloads.
pub const FFMPEG_STATIC_TAG: &str = "b6.1.1";

#[derive(Clone, Debug, Serialize)]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    /// "custom" | "sidecar" | "downloaded" | "path"
    pub source: String,
    pub version: String,
}

pub fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// Rust target triple of this build, used for Tauri sidecar file names.
pub fn target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "x86_64-pc-windows-msvc"
    } else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
        "aarch64-pc-windows-msvc"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else {
        "unknown"
    }
}

/// Asset name suffix on the ffmpeg-static release page for this platform.
fn asset_platform() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("darwin-arm64")
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some("darwin-x64")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("win32-x64")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("linux-x64")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("linux-arm64")
    } else {
        None
    }
}

/// A `Command` that doesn't pop up a console window on Windows.
pub fn command(path: &Path) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn version_of(path: &Path) -> Option<String> {
    let out = command(path)
        .arg("-version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next()?;
    // "ffmpeg version 6.0 Copyright (c) ..." -> "6.0"
    Some(first.split_whitespace().nth(2).unwrap_or("?").to_string())
}

fn pair_in_dir(dir: &Path, suffix: &str) -> Option<(PathBuf, PathBuf)> {
    let f = dir.join(exe_name(&format!("ffmpeg{suffix}")));
    let p = dir.join(exe_name(&format!("ffprobe{suffix}")));
    if f.is_file() && p.is_file() {
        Some((f, p))
    } else {
        None
    }
}

pub fn downloaded_dir(app_data: &Path) -> PathBuf {
    app_data.join("ffmpeg")
}

pub fn locate(app_data: &Path, custom_dir: Option<&Path>) -> Option<Tools> {
    let mut candidates: Vec<(&str, PathBuf, PathBuf)> = Vec::new();
    if let Some(dir) = custom_dir {
        if let Some((f, p)) = pair_in_dir(dir, "") {
            candidates.push(("custom", f, p));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some((f, p)) = pair_in_dir(dir, "") {
                candidates.push(("sidecar", f, p));
            }
            let suffix = format!("-{}", target_triple());
            if let Some((f, p)) = pair_in_dir(dir, &suffix) {
                candidates.push(("sidecar", f, p));
            }
            // `cargo run` / `tauri dev`: binaries live in src-tauri/binaries
            for up in [dir.join("../../binaries"), dir.join("../../../binaries")] {
                if let Some((f, p)) = pair_in_dir(&up, &suffix) {
                    candidates.push(("sidecar", f, p));
                }
            }
        }
    }
    if let Some((f, p)) = pair_in_dir(&downloaded_dir(app_data), "") {
        candidates.push(("downloaded", f, p));
    }
    candidates.push((
        "path",
        PathBuf::from(exe_name("ffmpeg")),
        PathBuf::from(exe_name("ffprobe")),
    ));
    // GUI apps on macOS / Linux often don't inherit the shell PATH.
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"] {
        if let Some((f, p)) = pair_in_dir(Path::new(dir), "") {
            candidates.push(("path", f, p));
        }
    }
    for (source, f, p) in candidates {
        if let Some(version) = version_of(&f) {
            if version_of(&p).is_some() {
                return Some(Tools { ffmpeg: f, ffprobe: p, source: source.to_string(), version });
            }
        }
    }
    None
}

/// Downloads static ffmpeg + ffprobe builds into the app data directory.
/// `progress(name, downloaded_bytes, total_bytes)` is called while downloading.
pub fn download(app_data: &Path, mut progress: impl FnMut(&str, u64, u64)) -> Result<Tools, String> {
    let platform = asset_platform().ok_or_else(|| {
        "No prebuilt FFmpeg is available for this platform. Install FFmpeg yourself and point RueyVideoEditor at it in Settings.".to_string()
    })?;
    let dir = downloaded_dir(app_data);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;

    for name in ["ffmpeg", "ffprobe"] {
        let url = format!(
            "https://github.com/eugeneware/ffmpeg-static/releases/download/{FFMPEG_STATIC_TAG}/{name}-{platform}.gz"
        );
        let resp = ureq::get(&url)
            .timeout(std::time::Duration::from_secs(600))
            .call()
            .map_err(|e| format!("Download of {name} failed: {e}"))?;
        let total: u64 = resp
            .header("Content-Length")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let mut reader = resp.into_reader();
        let mut compressed = Vec::with_capacity(total as usize);
        let mut chunk = [0u8; 64 * 1024];
        let mut got = 0u64;
        loop {
            let n = reader.read(&mut chunk).map_err(|e| format!("Download of {name} failed: {e}"))?;
            if n == 0 {
                break;
            }
            compressed.extend_from_slice(&chunk[..n]);
            got += n as u64;
            progress(name, got, total);
        }
        let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
        let mut binary = Vec::new();
        decoder
            .read_to_end(&mut binary)
            .map_err(|e| format!("Could not decompress {name}: {e}"))?;
        let dest = dir.join(exe_name(name));
        let tmp = dir.join(format!("{name}.part"));
        std::fs::write(&tmp, &binary).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::rename(&tmp, &dest).map_err(|e| format!("Cannot move {}: {e}", dest.display()))?;
    }
    locate(app_data, None).ok_or_else(|| "FFmpeg was downloaded but does not run on this machine.".to_string())
}

/// Encoders of interest that this FFmpeg build reports.
pub fn available_encoders(tools: &Tools) -> Vec<String> {
    let out = match command(&tools.ffmpeg)
        .args(["-hide_banner", "-encoders"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut names = Vec::new();
    for line in text.lines() {
        // " V....D libx264              libx264 H.264 / AVC ..."
        let mut parts = line.split_whitespace();
        let flags = match parts.next() {
            Some(f) => f,
            None => continue,
        };
        if flags.len() != 6 || !(flags.starts_with('V') || flags.starts_with('A')) {
            continue;
        }
        if let Some(name) = parts.next() {
            names.push(name.to_string());
        }
    }
    names
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Progress {
    pub out_time: f64,
    pub frame: u64,
    pub fps: f64,
    pub speed: f64,
}

pub type ChildSlot = Arc<Mutex<Option<Child>>>;

pub fn kill_slot(slot: &ChildSlot) -> bool {
    if let Ok(mut guard) = slot.lock() {
        if let Some(child) = guard.as_mut() {
            let _ = child.kill();
            return true;
        }
    }
    false
}

/// Runs an ffmpeg command that was given `-progress pipe:1 -nostats`, reporting
/// progress lines as they arrive. The child is kept in `slot` so it can be killed.
pub fn run_with_progress(
    mut cmd: Command,
    slot: &ChildSlot,
    mut on_progress: impl FnMut(Progress),
) -> Result<(), String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("Could not start ffmpeg: {e}"))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    *slot.lock().map_err(|_| "lock")? = Some(child);

    let err_thread = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut text);
        text
    });

    let mut current = Progress::default();
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let (key, value) = match line.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let value = value.trim();
        match key.trim() {
            "frame" => current.frame = value.parse().unwrap_or(current.frame),
            "fps" => current.fps = value.parse().unwrap_or(current.fps),
            "out_time_us" => {
                if let Ok(us) = value.parse::<i64>() {
                    current.out_time = us.max(0) as f64 / 1_000_000.0;
                }
            }
            "speed" => current.speed = value.trim_end_matches('x').parse().unwrap_or(current.speed),
            "progress" => on_progress(current.clone()),
            _ => {}
        }
    }

    let status = {
        let mut guard = slot.lock().map_err(|_| "lock")?;
        let mut child = guard.take().ok_or("ffmpeg process vanished")?;
        child.wait().map_err(|e| e.to_string())?
    };
    let stderr_text = err_thread.join().unwrap_or_default();
    if status.success() {
        Ok(())
    } else {
        let tail: Vec<&str> = stderr_text.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
        Err(if tail.is_empty() {
            format!("ffmpeg exited with {status}")
        } else {
            tail.join("\n")
        })
    }
}

/// Runs ffmpeg to completion, returning stderr on failure.
pub fn run_simple(mut cmd: Command) -> Result<Vec<u8>, String> {
    let out = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Could not start ffmpeg: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        let text = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = text.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect();
        Err(tail.join("\n"))
    }
}
