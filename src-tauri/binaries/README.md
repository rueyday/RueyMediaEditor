FFmpeg sidecar binaries go here, named with the Rust target triple, for example:

    ffmpeg-aarch64-apple-darwin
    ffprobe-aarch64-apple-darwin
    ffmpeg-x86_64-pc-windows-msvc.exe
    ffprobe-x86_64-pc-windows-msvc.exe

Run `scripts/fetch-ffmpeg.sh` (or `.ps1` on Windows) to download them. They are optional for
development: RueyMediaEditor also finds FFmpeg on your PATH, or can download it from the Settings panel.
The release workflow bundles them so downloads run out of the box.
