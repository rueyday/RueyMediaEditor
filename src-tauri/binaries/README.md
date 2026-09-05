FFmpeg sidecar binaries go here, named with the Rust target triple, for example:

    ffmpeg-aarch64-apple-darwin
    ffprobe-aarch64-apple-darwin
    ffmpeg-x86_64-pc-windows-msvc.exe
    ffprobe-x86_64-pc-windows-msvc.exe

They are optional. RueyMediaEditor also finds FFmpeg on your PATH (and the usual
Homebrew / Linux locations), or downloads a static build from Settings → FFmpeg.
To bundle a sidecar, download the matching `ffmpeg-*` and `ffprobe-*` files from
https://github.com/eugeneware/ffmpeg-static/releases, rename them as above, and add
`"externalBin": ["binaries/ffmpeg", "binaries/ffprobe"]` to the `bundle` section
of `tauri.conf.json` before running `cargo tauri build`.
