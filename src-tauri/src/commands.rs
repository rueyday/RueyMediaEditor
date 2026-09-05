//! Tauri commands: the API the front end calls with `invoke`.

use crate::export::{self, ExportSettings, Fonts};
use crate::ffmpeg::{self, ChildSlot, Tools};
use crate::probe::{self, MediaInfo};
use crate::project::Project;
use crate::thumbs;
use crate::tools as analysis;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct AppState {
    pub export: ChildSlot,
    pub export_cancelled: Arc<std::sync::atomic::AtomicBool>,
    pub proxies: Mutex<HashMap<String, ChildSlot>>,
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn app_cache(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn tools(app: &AppHandle, custom_dir: Option<String>) -> Result<Tools, String> {
    let data = app_data(app)?;
    let custom = custom_dir
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);
    ffmpeg::locate(&data, custom.as_deref()).ok_or_else(|| {
        "FFmpeg was not found. Download it from Settings or install it on your PATH.".to_string()
    })
}

fn fonts(app: &AppHandle) -> Result<Fonts, String> {
    let dir = app_data(app)?.join("fonts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let regular = dir.join("Inter-Regular.ttf");
    let bold = dir.join("Inter-Bold.ttf");
    if !regular.exists() {
        std::fs::write(&regular, include_bytes!("../../ui/fonts/Inter-Regular.ttf"))
            .map_err(|e| e.to_string())?;
    }
    if !bold.exists() {
        std::fs::write(&bold, include_bytes!("../../ui/fonts/Inter-Bold.ttf"))
            .map_err(|e| e.to_string())?;
    }
    Ok(Fonts { regular, bold })
}

#[derive(Serialize)]
pub struct FfmpegStatus {
    pub found: bool,
    pub tools: Option<Tools>,
    pub encoders: Vec<String>,
    pub target: String,
}

#[tauri::command(async)]
pub fn ffmpeg_status(app: AppHandle, custom_dir: Option<String>) -> FfmpegStatus {
    match tools(&app, custom_dir) {
        Ok(t) => {
            let encoders = ffmpeg::available_encoders(&t);
            FfmpegStatus {
                found: true,
                tools: Some(t),
                encoders,
                target: ffmpeg::target_triple().into(),
            }
        }
        Err(_) => FfmpegStatus {
            found: false,
            tools: None,
            encoders: vec![],
            target: ffmpeg::target_triple().into(),
        },
    }
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    name: String,
    downloaded: u64,
    total: u64,
}

#[tauri::command(async)]
pub fn download_ffmpeg(app: AppHandle) -> Result<Tools, String> {
    let data = app_data(&app)?;
    let handle = app.clone();
    ffmpeg::download(&data, move |name, downloaded, total| {
        let _ = handle.emit(
            "ffmpeg-download",
            DownloadProgress {
                name: name.into(),
                downloaded,
                total,
            },
        );
    })
}

#[tauri::command(async)]
pub fn probe_media(
    app: AppHandle,
    path: String,
    custom_dir: Option<String>,
) -> Result<MediaInfo, String> {
    let t = tools(&app, custom_dir)?;
    probe::probe(&t, Path::new(&path))
}

#[derive(Serialize)]
pub struct MediaAssets {
    pub key: String,
    pub filmstrip: Option<String>,
    pub waveform: Option<Vec<f32>>,
    pub proxy: Option<String>,
}

/// Filmstrip + waveform for a media file (cached by path/size/mtime).
#[tauri::command(async)]
pub fn generate_assets(
    app: AppHandle,
    path: String,
    kind: String,
    duration: f64,
    has_audio: bool,
    custom_dir: Option<String>,
) -> Result<MediaAssets, String> {
    let t = tools(&app, custom_dir)?;
    let p = Path::new(&path);
    let key = thumbs::media_key(p);
    let dir = app_cache(&app)?.join("media").join(&key);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut filmstrip = None;
    if kind == "video" || kind == "image" {
        let out = dir.join("filmstrip.jpg");
        match thumbs::filmstrip(&t, p, duration, kind == "image", &out) {
            Ok(()) => filmstrip = Some(out.to_string_lossy().to_string()),
            Err(e) => eprintln!("filmstrip failed for {path}: {e}"),
        }
    }
    let mut waveform = None;
    if has_audio {
        let wf = dir.join("waveform.json");
        if wf.exists() {
            waveform = std::fs::read_to_string(&wf)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok());
        }
        if waveform.is_none() {
            match thumbs::waveform(&t, p) {
                Ok(peaks) => {
                    let _ = std::fs::write(&wf, serde_json::to_string(&peaks).unwrap_or_default());
                    waveform = Some(peaks);
                }
                Err(e) => eprintln!("waveform failed for {path}: {e}"),
            }
        }
    }
    let proxy_path = dir.join(thumbs::proxy_name());
    let proxy = if proxy_path.exists() {
        Some(proxy_path.to_string_lossy().to_string())
    } else {
        None
    };
    Ok(MediaAssets {
        key,
        filmstrip,
        waveform,
        proxy,
    })
}

#[derive(Serialize, Clone)]
struct ProxyProgress {
    media_id: String,
    ratio: f64,
}

#[tauri::command(async)]
pub fn make_proxy(
    app: AppHandle,
    state: State<'_, AppState>,
    media_id: String,
    path: String,
    duration: f64,
    max_width: u32,
    custom_dir: Option<String>,
) -> Result<String, String> {
    let t = tools(&app, custom_dir)?;
    let p = Path::new(&path);
    let dir = app_cache(&app)?.join("media").join(thumbs::media_key(p));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(thumbs::proxy_name());
    if out.exists() {
        return Ok(out.to_string_lossy().to_string());
    }
    let slot: ChildSlot = Arc::new(Mutex::new(None));
    state
        .proxies
        .lock()
        .map_err(|_| "lock")?
        .insert(media_id.clone(), slot.clone());
    let handle = app.clone();
    let id = media_id.clone();
    let result = thumbs::proxy(&t, p, &out, max_width.max(320), &slot, move |pr| {
        let ratio = if duration > 0.0 {
            (pr.out_time / duration).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let _ = handle.emit(
            "proxy-progress",
            ProxyProgress {
                media_id: id.clone(),
                ratio,
            },
        );
    });
    state.proxies.lock().map_err(|_| "lock")?.remove(&media_id);
    result.map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn cancel_proxy(state: State<'_, AppState>, media_id: String) -> bool {
    match state.proxies.lock() {
        Ok(map) => map.get(&media_id).map(ffmpeg::kill_slot).unwrap_or(false),
        Err(_) => false,
    }
}

#[tauri::command(async)]
pub fn save_project(path: String, json: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let tmp = p.with_extension("rve.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Cannot write {path}: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("Cannot write {path}: {e}"))
}

#[tauri::command(async)]
pub fn load_project(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Cannot read {path}: {e}"))
}

#[tauri::command(async)]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[derive(Serialize)]
pub struct Paths {
    pub data: String,
    pub cache: String,
    pub autosave: String,
}

#[tauri::command]
pub fn app_paths(app: AppHandle) -> Result<Paths, String> {
    let data = app_data(&app)?;
    let cache = app_cache(&app)?;
    Ok(Paths {
        autosave: data.join("autosave.rve").to_string_lossy().to_string(),
        data: data.to_string_lossy().to_string(),
        cache: cache.to_string_lossy().to_string(),
    })
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                total += dir_size(&path);
            } else if let Ok(m) = e.metadata() {
                total += m.len();
            }
        }
    }
    total
}

#[tauri::command(async)]
pub fn cache_size(app: AppHandle) -> Result<u64, String> {
    Ok(dir_size(&app_cache(&app)?))
}

#[tauri::command(async)]
pub fn clear_cache(app: AppHandle) -> Result<u64, String> {
    let cache = app_cache(&app)?;
    let size = dir_size(&cache);
    for sub in ["media", "export", "frames"] {
        let _ = std::fs::remove_dir_all(cache.join(sub));
    }
    Ok(size)
}

#[derive(Serialize, Clone)]
struct ExportProgress {
    out_time: f64,
    duration: f64,
    percent: f64,
    frame: u64,
    fps: f64,
    speed: f64,
}

#[derive(Serialize, Clone)]
struct ExportDone {
    ok: bool,
    error: Option<String>,
    output: String,
    cancelled: bool,
}

#[derive(Serialize)]
pub struct ExportStarted {
    pub command: String,
    pub duration: f64,
    pub log: String,
}

/// Starts an export in the background. Progress arrives as `export-progress`
/// events, completion as `export-done`.
#[tauri::command(async)]
pub fn start_export(
    app: AppHandle,
    state: State<'_, AppState>,
    project: Project,
    settings: ExportSettings,
    custom_dir: Option<String>,
) -> Result<ExportStarted, String> {
    let t = tools(&app, custom_dir)?;
    let work = app_cache(&app)?.join("export");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let f = fonts(&app)?;
    let built = export::build(&project, &settings, &work, &f)?;

    let command_text = std::iter::once(t.ffmpeg.to_string_lossy().to_string())
        .chain(built.args.iter().map(|a| {
            if a.contains(' ') {
                format!("\"{a}\"")
            } else {
                a.clone()
            }
        }))
        .collect::<Vec<_>>()
        .join(" ");
    let log_path = work.join("export.log");
    let _ = std::fs::write(
        &log_path,
        format!("{command_text}\n\n--- filter graph ---\n{}\n", built.graph),
    );

    let slot = state.export.clone();
    let cancelled = state.export_cancelled.clone();
    cancelled.store(false, std::sync::atomic::Ordering::SeqCst);
    let duration = built.duration;
    let output = settings.output.clone();
    let handle = app.clone();
    let mut cmd = ffmpeg::command(&t.ffmpeg);
    cmd.args(&built.args);
    std::thread::spawn(move || {
        let h2 = handle.clone();
        let result = ffmpeg::run_with_progress(cmd, &slot, move |pr| {
            let percent = if duration > 0.0 {
                (pr.out_time / duration * 100.0).clamp(0.0, 100.0)
            } else {
                0.0
            };
            let _ = h2.emit(
                "export-progress",
                ExportProgress {
                    out_time: pr.out_time,
                    duration,
                    percent,
                    frame: pr.frame,
                    fps: pr.fps,
                    speed: pr.speed,
                },
            );
        });
        let was_cancelled = cancelled.load(std::sync::atomic::Ordering::SeqCst);
        let done = match result {
            Ok(()) if !was_cancelled => ExportDone {
                ok: true,
                error: None,
                output: output.clone(),
                cancelled: false,
            },
            Ok(()) => ExportDone {
                ok: false,
                error: None,
                output: output.clone(),
                cancelled: true,
            },
            Err(e) => {
                if was_cancelled {
                    let _ = std::fs::remove_file(&output);
                }
                ExportDone {
                    ok: false,
                    error: if was_cancelled { None } else { Some(e) },
                    output: output.clone(),
                    cancelled: was_cancelled,
                }
            }
        };
        let _ = handle.emit("export-done", done);
    });
    Ok(ExportStarted {
        command: command_text,
        duration,
        log: log_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn cancel_export(state: State<'_, AppState>) -> bool {
    state
        .export_cancelled
        .store(true, std::sync::atomic::Ordering::SeqCst);
    ffmpeg::kill_slot(&state.export)
}

/// Renders the exact frame at `time` through ffmpeg (for effects the canvas
/// preview can only approximate). Returns the PNG path.
#[tauri::command(async)]
pub fn render_frame(
    app: AppHandle,
    project: Project,
    time: f64,
    width: u32,
    custom_dir: Option<String>,
) -> Result<String, String> {
    let t = tools(&app, custom_dir)?;
    let work = app_cache(&app)?.join("frames");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let f = fonts(&app)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let out = work.join(format!("frame-{stamp}.png"));
    let args = export::build_frame(&project, time, width, &out, &work, &f)?;
    let mut cmd = ffmpeg::command(&t.ffmpeg);
    cmd.args(&args);
    ffmpeg::run_simple(cmd)?;
    // keep the folder small
    if let Ok(rd) = std::fs::read_dir(&work) {
        let mut files: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map(|e| e == "png").unwrap_or(false))
            .collect();
        files.sort();
        while files.len() > 6 {
            let _ = std::fs::remove_file(files.remove(0));
        }
    }
    Ok(out.to_string_lossy().to_string())
}

#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_title(window: tauri::Window, title: String) {
    let _ = window.set_title(&title);
}

/// Closes the app. Called by the UI after it has confirmed discarding changes.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------- analysis helpers: freeze frames, silence, sync, captions ----------

/// Saves the source frame of a media file at `time` as PNG in the cache. Used for freeze frames.
#[tauri::command(async)]
pub fn extract_frame(
    app: AppHandle,
    path: String,
    time: f64,
    custom_dir: Option<String>,
) -> Result<String, String> {
    let t = tools(&app, custom_dir)?;
    let dir = app_cache(&app)?.join("frames");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!(
        "freeze-{}-{}.png",
        thumbs::media_key(Path::new(&path)),
        (time * 1000.0).round() as i64
    ));
    if !out.exists() {
        analysis::extract_frame(&t, Path::new(&path), time, &out)?;
    }
    Ok(out.to_string_lossy().to_string())
}

/// Renders the composited frame at `time` to a user-chosen PNG or JPEG.
#[tauri::command(async)]
pub fn export_frame(
    app: AppHandle,
    project: Project,
    time: f64,
    output: String,
    width: u32,
    custom_dir: Option<String>,
) -> Result<String, String> {
    let t = tools(&app, custom_dir)?;
    let work = app_cache(&app)?.join("frames");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let f = fonts(&app)?;
    let out = PathBuf::from(&output);
    let mut args = export::build_frame(&project, time, width, &out, &work, &f)?;
    let jpeg = out
        .extension()
        .map(|e| {
            let e = e.to_string_lossy().to_lowercase();
            e == "jpg" || e == "jpeg"
        })
        .unwrap_or(false);
    if jpeg {
        for a in args.iter_mut() {
            if a == "rgb24" {
                *a = "yuvj420p".into();
            }
        }
        let last = args.pop().unwrap_or_default();
        args.extend(["-q:v".into(), "2".into(), last]);
    }
    let mut cmd = ffmpeg::command(&t.ffmpeg);
    cmd.args(&args);
    ffmpeg::run_simple(cmd)?;
    Ok(output)
}

/// Writes a data: URL (PNG rendered by the UI, e.g. a shape) into the cache and returns its path.
#[tauri::command(async)]
pub fn save_data_url(app: AppHandle, name: String, data_url: String) -> Result<String, String> {
    use base64::Engine;
    let dir = app_cache(&app)?.join("shapes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let comma = data_url.find(',').ok_or("Not a data URL")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_url[comma + 1..])
        .map_err(|e| e.to_string())?;
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let out = dir.join(format!("{safe}.png"));
    std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
    Ok(out.to_string_lossy().to_string())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn detect_silence(
    app: AppHandle,
    path: String,
    r#in: f64,
    out: f64,
    threshold_db: f64,
    min_duration: f64,
    custom_dir: Option<String>,
) -> Result<Vec<(f64, f64)>, String> {
    let t = tools(&app, custom_dir)?;
    analysis::detect_silence(&t, Path::new(&path), r#in, out, threshold_db, min_duration)
}

#[tauri::command(async)]
pub fn sync_offset(
    app: AppHandle,
    path_a: String,
    in_a: f64,
    path_b: String,
    in_b: f64,
    max_lag: f64,
    custom_dir: Option<String>,
) -> Result<f64, String> {
    let t = tools(&app, custom_dir)?;
    analysis::sync_offset(
        &t,
        Path::new(&path_a),
        in_a,
        Path::new(&path_b),
        in_b,
        max_lag,
        600.0,
    )
}

#[derive(Serialize)]
pub struct WhisperStatus {
    pub found: bool,
    pub path: Option<String>,
}

#[tauri::command(async)]
pub fn whisper_status(custom_bin: Option<String>) -> WhisperStatus {
    let custom = custom_bin
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);
    match analysis::locate_whisper(custom.as_deref()) {
        Some(p) => WhisperStatus {
            found: true,
            path: Some(p.to_string_lossy().to_string()),
        },
        None => WhisperStatus {
            found: false,
            path: None,
        },
    }
}

/// Runs whisper.cpp on part of a media file; returns SRT text relative to `in`.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
pub fn transcribe(
    app: AppHandle,
    path: String,
    r#in: f64,
    out: f64,
    whisper_bin: Option<String>,
    model: String,
    language: String,
    custom_dir: Option<String>,
) -> Result<String, String> {
    let t = tools(&app, custom_dir)?;
    let custom = whisper_bin
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from);
    let whisper = analysis::locate_whisper(custom.as_deref()).ok_or("whisper.cpp was not found. Install it (for example `brew install whisper-cpp`) or set its path in Settings → Captions.")?;
    if model.trim().is_empty() || !Path::new(&model).exists() {
        return Err("Choose a whisper model file (ggml-*.bin) in Settings → Captions.".into());
    }
    let work = app_cache(&app)?.join("whisper");
    analysis::transcribe(
        &t,
        &whisper,
        Path::new(&model),
        Path::new(&path),
        r#in,
        out,
        &language,
        &work,
    )
}
