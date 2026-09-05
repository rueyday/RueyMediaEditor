//! RueyMediaEditor engine: the Rust side of the app. The UI lives in `../ui`.

pub mod commands;
pub mod export;
pub mod ffmpeg;
pub mod probe;
pub mod project;
pub mod thumbs;
pub mod tools;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(commands::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::ffmpeg_status,
            commands::download_ffmpeg,
            commands::probe_media,
            commands::generate_assets,
            commands::make_proxy,
            commands::cancel_proxy,
            commands::save_project,
            commands::load_project,
            commands::read_text_file,
            commands::write_text_file,
            commands::file_exists,
            commands::app_paths,
            commands::cache_size,
            commands::clear_cache,
            commands::start_export,
            commands::cancel_export,
            commands::render_frame,
            commands::reveal_path,
            commands::open_url,
            commands::open_path,
            commands::set_title,
            commands::quit_app,
            commands::extract_frame,
            commands::export_frame,
            commands::save_data_url,
            commands::detect_silence,
            commands::sync_offset,
            commands::whisper_status,
            commands::transcribe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running RueyMediaEditor");
}
