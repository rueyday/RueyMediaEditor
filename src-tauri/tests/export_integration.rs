//! End-to-end export through a real ffmpeg. Runs only when RVE_FFMPEG_DIR
//! points at a folder containing ffmpeg and ffprobe:
//!
//!     RVE_FFMPEG_DIR=/path/to/bin cargo test --test export_integration

use ruey_video_editor_lib::export::{build, build_frame, ExportSettings, Fonts};
use ruey_video_editor_lib::probe;
use ruey_video_editor_lib::project::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

fn tools() -> Option<ruey_video_editor_lib::ffmpeg::Tools> {
    let dir = std::env::var("RVE_FFMPEG_DIR").ok()?;
    ruey_video_editor_lib::ffmpeg::locate(Path::new("/nonexistent"), Some(Path::new(&dir)))
}

fn gen(ffmpeg: &Path, out: &Path, color: &str, secs: f64, tone: u32) {
    let st = Command::new(ffmpeg)
        .args(["-y", "-v", "error", "-f", "lavfi", "-i", &format!("color=c={color}:s=320x180:r=30:d={secs}"), "-f", "lavfi", "-i", &format!("sine=frequency={tone}:d={secs}"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
        .arg(out)
        .status()
        .unwrap();
    assert!(st.success());
}

fn pixel(ffmpeg: &Path, file: &Path, t: f64, x: u32, y: u32) -> (u8, u8, u8) {
    let out = Command::new(ffmpeg)
        .args(["-v", "error", "-i"]).arg(file)
        .args(["-ss", &t.to_string(), "-frames:v", "1", "-vf", &format!("crop=2:2:{x}:{y}"), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    (out.stdout[0], out.stdout[1], out.stdout[2])
}

fn media(id: &str, path: &Path, info: &probe::MediaInfo) -> (String, Media) {
    (id.into(), Media { path: path.to_string_lossy().into(), name: info.name.clone(), kind: info.kind.clone(), duration: info.duration, width: info.width, height: info.height, fps: info.fps, has_video: info.has_video, has_audio: info.has_audio, proxy: None })
}

fn clip(kind: &str, media: Option<&str>, start: f64, in_: f64, out: f64) -> Clip {
    Clip { id: format!("c{start}{in_}"), kind: kind.into(), media_id: media.map(String::from), start, in_, out, speed: 1.0, volume: 1.0, muted: false, audio_detached: false, fade_in: 0.0, fade_out: 0.0, transform: Transform::default(), keyframes: HashMap::new(), crop: Crop::default(), effects: vec![], transition_in: None, transition_out: None, title: None, color: None, name: String::new(), reverse: false, image_path: None, timecode: None }
}

#[test]
fn exports_a_real_project() {
    let Some(t) = tools() else { eprintln!("skipping: set RVE_FFMPEG_DIR"); return; };
    let dir = std::env::temp_dir().join(format!("rve-it-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let red = dir.join("red.mp4");
    let blue = dir.join("blue.mp4");
    gen(&t.ffmpeg, &red, "red", 3.0, 440);
    gen(&t.ffmpeg, &blue, "blue", 3.0, 880);
    let red_info = probe::probe(&t, &red).unwrap();
    let blue_info = probe::probe(&t, &blue).unwrap();
    assert_eq!(red_info.kind, "video");
    assert!(red_info.has_audio);

    let fonts_dir = dir.join("fonts");
    std::fs::create_dir_all(&fonts_dir).unwrap();
    let regular = fonts_dir.join("Inter-Regular.ttf");
    let bold = fonts_dir.join("Inter-Bold.ttf");
    std::fs::write(&regular, include_bytes!("../../ui/fonts/Inter-Regular.ttf")).unwrap();
    std::fs::write(&bold, include_bytes!("../../ui/fonts/Inter-Bold.ttf")).unwrap();
    let fonts = Fonts { regular, bold };

    let mut p = Project { version: 1, name: "it".into(), settings: Settings { width: 640, height: 360, fps: 30.0, sample_rate: 48000 }, media: HashMap::new(), tracks: vec![], markers: vec![], captions: vec![Caption { start: 0.2, end: 1.8, text: "Hello caption".into() }], caption_style: CaptionStyle::default() };
    p.media.extend([media("red", &red, &red_info), media("blue", &blue, &blue_info)]);
    // V1: red 0-2, blue 2-5 with a 1 s wipe, sped up 1.5x
    let mut b = clip("video", Some("blue"), 2.0, 0.0, 3.0);
    b.speed = 1.5;
    b.transition_in = Some(Transition { kind: "wipeleft".into(), duration: 1.0 });
    b.keyframes.insert("x".into(), vec![Keyframe { t: 0.0, v: 0.0, ease: String::new() }, Keyframe { t: 1.0, v: 50.0, ease: "ease".into() }]);
    b.effects.push(Effect { kind: "color".into(), params: HashMap::from([("saturation".to_string(), serde_json::json!(1.2)), ("exposure".to_string(), serde_json::json!(0.2)), ("temperature".to_string(), serde_json::json!(7000))]), enabled: true });
    b.reverse = true;
    // V2: small green colour clip top-left 1-4 with 50% opacity, and a title
    let mut g = clip("color", None, 1.0, 0.0, 3.0);
    g.color = Some("#00ff00".into());
    g.transform = Transform { x: -200.0, y: -100.0, scale: 0.25, rotation: 0.0, opacity: 0.5 };
    let mut title = clip("title", None, 0.5, 0.0, 2.0);
    title.title = Some(Title { text: "Hello\nWorld".into(), font_size: 48.0, color: "#ffffff".into(), weight: "bold".into(), align: "center".into(), background: Some("#00000080".into()), padding: 8.0, shadow: true, line_height: 1.2, font_file: None });
    let mut a = clip("audio", Some("red"), 3.0, 0.0, 1.0);
    a.volume = 0.5;
    a.fade_in = 0.2;
    a.keyframes.insert("volume".into(), vec![Keyframe { t: 0.0, v: 0.2, ease: String::new() }, Keyframe { t: 1.0, v: 1.0, ease: String::new() }]);
    // A shape (green box rendered to a transparent PNG, as the UI would do) and a timecode overlay.
    let shape_png = dir.join("shape.png");
    let st = Command::new(&t.ffmpeg)
        .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=black@0.0:s=640x360:d=1,format=rgba", "-vf", "drawbox=x=400:y=250:w=160:h=90:color=green@1:t=fill", "-frames:v", "1"])
        .arg(&shape_png).status().unwrap();
    assert!(st.success());
    let mut shape = clip("shape", None, 0.5, 0.0, 1.0);
    shape.image_path = Some(shape_png.to_string_lossy().into());
    let mut tc = clip("timecode", None, 0.0, 0.0, 4.0);
    tc.timecode = Some(Timecode { position: "top-right".into(), label: "t=".into(), ..Default::default() });
    p.tracks = vec![
        Track { id: "v4".into(), kind: "video".into(), name: "V4".into(), clips: vec![tc], ..Default::default() },
        Track { id: "v5".into(), kind: "video".into(), name: "V5".into(), clips: vec![shape], ..Default::default() },
        Track { id: "v3".into(), kind: "video".into(), name: "V3".into(), clips: vec![title], ..Default::default() },
        Track { id: "v2".into(), kind: "video".into(), name: "V2".into(), clips: vec![g], ..Default::default() },
        Track { id: "v1".into(), kind: "video".into(), name: "V1".into(), clips: vec![clip("video", Some("red"), 0.0, 0.0, 2.0), b], ..Default::default() },
        Track { id: "a1".into(), kind: "audio".into(), name: "A1".into(), clips: vec![a], ..Default::default() },
    ];
    let expected = 4.0; // 2 + 3/1.5

    let out = dir.join("out.mp4");
    let settings = ExportSettings { output: out.to_string_lossy().into(), width: 0, height: 0, fps: 0.0, video_codec: "libx264".into(), quality: 20, bitrate_kbps: 0, preset: "ultrafast".into(), audio_codec: "aac".into(), audio_bitrate_kbps: 128, range: None };
    let built = build(&p, &settings, &dir, &fonts).unwrap();
    assert!((built.duration - expected).abs() < 1e-6);
    let status = Command::new(&t.ffmpeg).args(&built.args).output().unwrap();
    assert!(status.status.success(), "ffmpeg failed:\n{}\n{}", String::from_utf8_lossy(&status.stderr), built.graph);

    let info = probe::probe(&t, &out).unwrap();
    assert!(info.has_video && info.has_audio, "{info:?}");
    assert!((info.duration - expected).abs() < 0.15, "duration {}", info.duration);
    assert_eq!((info.width, info.height), (640, 360));

    // Centre pixel: red before the cut, blue after the wipe.
    let (r, g_, bl) = pixel(&t.ffmpeg, &out, 0.3, 320, 300);
    assert!(r > 200 && g_ < 60 && bl < 60, "expected red at 0.3s, got {:?}", (r, g_, bl));
    let (r, g_, bl) = pixel(&t.ffmpeg, &out, 3.5, 320, 300);
    assert!(bl > 200 && r < 60 && g_ < 60, "expected blue at 3.5s, got {:?}", (r, g_, bl));
    // Shape box (bottom right) is green at 1.0s.
    let (r, g_, _) = pixel(&t.ffmpeg, &out, 1.0, 480, 300);
    assert!(g_ > 100 && r < 60, "expected green shape at 1.0s, got {:?}", (r, g_));
    // Green 50% box near top-left over red at 1.5s -> mix of red and green.
    let (r, g_, _) = pixel(&t.ffmpeg, &out, 1.5, 120, 80);
    assert!(g_ > 90 && r > 90, "expected red+green mix at 1.5s, got {:?}", (r, g_));

    // Range export and gif and audio-only should build without error.
    for (codec, acodec, ext) in [("gif", "none", "gif"), ("none", "libmp3lame", "mp3"), ("libvpx-vp9", "libopus", "webm")] {
        let o = dir.join(format!("out.{ext}"));
        let s = ExportSettings { output: o.to_string_lossy().into(), video_codec: codec.into(), audio_codec: acodec.into(), range: Some((0.5, 1.5)), ..settings.clone() };
        let b = build(&p, &s, &dir, &fonts).unwrap();
        let st = Command::new(&t.ffmpeg).args(&b.args).output().unwrap();
        assert!(st.status.success(), "{codec} failed: {}", String::from_utf8_lossy(&st.stderr));
        let i = probe::probe(&t, &o).unwrap();
        assert!((i.duration - 1.0).abs() < 0.2, "{codec} duration {}", i.duration);
    }

    // Single accurate frame.
    let png = dir.join("frame.png");
    let args = build_frame(&p, 1.5, 320, &png, &dir, &fonts).unwrap();
    let st = Command::new(&t.ffmpeg).args(&args).output().unwrap();
    assert!(st.status.success(), "frame failed: {}", String::from_utf8_lossy(&st.stderr));
    let fi = probe::probe(&t, &png).unwrap();
    assert_eq!(fi.kind, "image");
    assert_eq!(fi.width, 320);

    let _ = std::fs::remove_dir_all(&dir);
    let _: PathBuf = out;
}
