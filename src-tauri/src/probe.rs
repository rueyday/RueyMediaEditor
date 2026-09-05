//! Media probing through `ffprobe -print_format json`.

use crate::ffmpeg::{command, Tools};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MediaInfo {
    pub path: String,
    pub name: String,
    /// "video" | "audio" | "image"
    pub kind: String,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub video_codec: String,
    pub audio_codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub rotation: i32,
    pub size: u64,
    pub container: String,
}

fn parse_rate(s: &str) -> f64 {
    if let Some((a, b)) = s.split_once('/') {
        let a: f64 = a.parse().unwrap_or(0.0);
        let b: f64 = b.parse().unwrap_or(0.0);
        if b > 0.0 {
            return a / b;
        }
        return 0.0;
    }
    s.parse().unwrap_or(0.0)
}

fn f64_of(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(s) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn u64_of(v: &Value) -> u64 {
    match v {
        Value::Number(n) => n.as_u64().unwrap_or(0),
        Value::String(s) => s.parse().unwrap_or(0),
        _ => 0,
    }
}

const IMAGE_CODECS: &[&str] = &[
    "png", "mjpeg", "webp", "bmp", "tiff", "gif", "jpeg2000", "heif", "avif",
];

pub fn parse_ffprobe_json(path: &Path, json: &str) -> Result<MediaInfo, String> {
    let v: Value =
        serde_json::from_str(json).map_err(|e| format!("ffprobe output unreadable: {e}"))?;
    let mut info = MediaInfo {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        ..Default::default()
    };
    let format = &v["format"];
    info.duration = f64_of(&format["duration"]);
    info.size = u64_of(&format["size"]);
    info.container = format["format_name"].as_str().unwrap_or("").to_string();

    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let mut video_frames: u64 = 0;
    for s in &streams {
        let codec_type = s["codec_type"].as_str().unwrap_or("");
        let attached_pic = s["disposition"]["attached_pic"].as_i64().unwrap_or(0) == 1;
        if codec_type == "video" && !info.has_video && !attached_pic {
            info.has_video = true;
            info.video_codec = s["codec_name"].as_str().unwrap_or("").to_string();
            info.width = s["width"].as_u64().unwrap_or(0) as u32;
            info.height = s["height"].as_u64().unwrap_or(0) as u32;
            let avg = parse_rate(s["avg_frame_rate"].as_str().unwrap_or("0/0"));
            let r = parse_rate(s["r_frame_rate"].as_str().unwrap_or("0/0"));
            info.fps = if avg > 0.0 && avg < 1000.0 { avg } else { r };
            video_frames = u64_of(&s["nb_frames"]);
            if info.duration <= 0.0 {
                info.duration = f64_of(&s["duration"]);
            }
            // Rotation: newer ffprobe puts it in side_data_list, older in tags.rotate
            let mut rot = 0i32;
            if let Some(list) = s["side_data_list"].as_array() {
                for sd in list {
                    if let Some(r) = sd["rotation"].as_f64() {
                        rot = r.round() as i32;
                    }
                }
            }
            if rot == 0 {
                if let Some(r) = s["tags"]["rotate"].as_str() {
                    rot = r.parse().unwrap_or(0);
                }
            }
            info.rotation = rot.rem_euclid(360);
            if info.rotation == 90 || info.rotation == 270 {
                std::mem::swap(&mut info.width, &mut info.height);
            }
        } else if codec_type == "audio" && !info.has_audio {
            info.has_audio = true;
            info.audio_codec = s["codec_name"].as_str().unwrap_or("").to_string();
            info.sample_rate = u64_of(&s["sample_rate"]) as u32;
            info.channels = s["channels"].as_u64().unwrap_or(0) as u32;
            if info.duration <= 0.0 {
                info.duration = f64_of(&s["duration"]);
            }
        }
    }

    let image_container = info.container.contains("image2")
        || info.container.ends_with("_pipe")
        || info.container == "png_pipe";
    let still = info.has_video
        && (image_container
            || (IMAGE_CODECS.contains(&info.video_codec.as_str())
                && video_frames <= 1
                && info.container != "gif"));

    info.kind = if still {
        "image".into()
    } else if info.has_video {
        "video".into()
    } else if info.has_audio {
        "audio".into()
    } else {
        return Err("No video or audio streams found".into());
    };
    if info.kind == "image" {
        info.duration = 0.0;
        info.has_audio = false;
    }
    Ok(info)
}

pub fn probe(tools: &Tools, path: &Path) -> Result<MediaInfo, String> {
    let out = command(&tools.ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Could not run ffprobe: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "ffprobe failed".into()
        } else {
            err
        });
    }
    parse_ffprobe_json(path, &String::from_utf8_lossy(&out.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_video_with_rotation() {
        let json = r#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,
            "r_frame_rate":"30000/1001","avg_frame_rate":"30000/1001","nb_frames":"300",
            "side_data_list":[{"side_data_type":"Display Matrix","rotation":-90}]},
            {"codec_type":"audio","codec_name":"aac","sample_rate":"48000","channels":2}],
            "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"10.010000","size":"123456"}}"#;
        let info = parse_ffprobe_json(Path::new("/tmp/clip.mp4"), json).unwrap();
        assert_eq!(info.kind, "video");
        assert_eq!((info.width, info.height), (1080, 1920));
        assert!((info.fps - 29.97).abs() < 0.01);
        assert_eq!(info.rotation, 270);
        assert!(info.has_audio);
        assert_eq!(info.channels, 2);
        assert!((info.duration - 10.01).abs() < 1e-6);
    }

    #[test]
    fn detects_images_and_audio() {
        let png = r#"{"streams":[{"codec_type":"video","codec_name":"png","width":640,"height":480,"r_frame_rate":"25/1","avg_frame_rate":"0/0"}],
            "format":{"format_name":"png_pipe","size":"100"}}"#;
        let info = parse_ffprobe_json(Path::new("a.png"), png).unwrap();
        assert_eq!(info.kind, "image");
        assert_eq!(info.duration, 0.0);

        let mp3 = r#"{"streams":[{"codec_type":"audio","codec_name":"mp3","sample_rate":"44100","channels":2,"duration":"3.5"},
            {"codec_type":"video","codec_name":"mjpeg","width":300,"height":300,"disposition":{"attached_pic":1}}],
            "format":{"format_name":"mp3","duration":"3.5"}}"#;
        let info = parse_ffprobe_json(Path::new("a.mp3"), mp3).unwrap();
        assert_eq!(info.kind, "audio");
        assert!(!info.has_video);
    }
}
