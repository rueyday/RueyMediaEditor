//! The project model. This mirrors `ui/js/model.js`; the front end is the
//! source of truth and sends the whole project as JSON for export.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

fn one() -> f64 {
    1.0
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Project {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub media: HashMap<String, Media>,
    #[serde(default)]
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub markers: Vec<Marker>,
    #[serde(default)]
    pub captions: Vec<Caption>,
    #[serde(default)]
    pub caption_style: CaptionStyle,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Caption {
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CaptionStyle {
    #[serde(default = "default_caption_size")]
    pub font_size: f64,
    #[serde(default = "default_white")]
    pub color: String,
    #[serde(default = "default_caption_bg")]
    pub background: Option<String>,
    /// "bottom" | "top"
    #[serde(default)]
    pub position: String,
    #[serde(default = "default_caption_margin")]
    pub margin: f64,
    /// "regular" | "bold"
    #[serde(default)]
    pub weight: String,
    #[serde(default)]
    pub font_file: Option<String>,
}
fn default_caption_size() -> f64 {
    48.0
}
fn default_caption_bg() -> Option<String> {
    Some("#000000a0".into())
}
fn default_caption_margin() -> f64 {
    60.0
}
impl Default for CaptionStyle {
    fn default() -> Self {
        CaptionStyle {
            font_size: 48.0,
            color: "#ffffff".into(),
            background: default_caption_bg(),
            position: "bottom".into(),
            margin: 60.0,
            weight: "bold".into(),
            font_file: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Timecode {
    /// "hms" | "frames"
    #[serde(default)]
    pub format: String,
    /// "timeline" | "clip"
    #[serde(default)]
    pub source: String,
    #[serde(default = "default_tc_size")]
    pub font_size: f64,
    #[serde(default = "default_white")]
    pub color: String,
    #[serde(default = "default_caption_bg")]
    pub background: Option<String>,
    /// "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right"
    #[serde(default)]
    pub position: String,
    /// Seconds added to the displayed time (used by single-frame renders).
    #[serde(default)]
    pub offset: f64,
    #[serde(default)]
    pub label: String,
}
fn default_tc_size() -> f64 {
    40.0
}
impl Default for Timecode {
    fn default() -> Self {
        Timecode {
            format: "hms".into(),
            source: "timeline".into(),
            font_size: 40.0,
            color: "#ffffff".into(),
            background: default_caption_bg(),
            position: "top-left".into(),
            offset: 0.0,
            label: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Settings {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    #[serde(default = "default_sample_rate")]
    pub sample_rate: u32,
}
fn default_sample_rate() -> u32 {
    48000
}
impl Default for Settings {
    fn default() -> Self {
        Settings {
            width: 1920,
            height: 1080,
            fps: 30.0,
            sample_rate: 48000,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Media {
    pub path: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub duration: f64,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub fps: f64,
    #[serde(default)]
    pub has_video: bool,
    #[serde(default)]
    pub has_audio: bool,
    #[serde(default)]
    pub proxy: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Track {
    pub id: String,
    /// "video" | "audio"
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub solo: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub clips: Vec<Clip>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Clip {
    pub id: String,
    /// "video" | "audio" | "image" | "title" | "color" | "shape" | "timecode"
    pub kind: String,
    #[serde(default)]
    pub media_id: Option<String>,
    /// Position on the timeline, seconds.
    #[serde(default)]
    pub start: f64,
    /// Source in point, seconds (0 for generated clips).
    #[serde(rename = "in", default)]
    pub in_: f64,
    /// Source out point, seconds (duration for generated clips).
    #[serde(default)]
    pub out: f64,
    #[serde(default = "one")]
    pub speed: f64,
    #[serde(default)]
    pub reverse: bool,
    #[serde(default = "one")]
    pub volume: f64,
    #[serde(default)]
    pub muted: bool,
    #[serde(default)]
    pub audio_detached: bool,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    #[serde(default)]
    pub transform: Transform,
    /// Property name -> keyframes. Times are seconds from the clip start on the timeline.
    #[serde(default)]
    pub keyframes: HashMap<String, Vec<Keyframe>>,
    #[serde(default)]
    pub crop: Crop,
    #[serde(default)]
    pub effects: Vec<Effect>,
    #[serde(default)]
    pub transition_in: Option<Transition>,
    #[serde(default)]
    pub transition_out: Option<Transition>,
    #[serde(default)]
    pub title: Option<Title>,
    #[serde(default)]
    pub color: Option<String>,
    /// Pre-rendered PNG for "shape" clips (the UI rasterises shapes at project size).
    #[serde(default)]
    pub image_path: Option<String>,
    #[serde(default)]
    pub timecode: Option<Timecode>,
    #[serde(default)]
    pub name: String,
}

impl Clip {
    /// Length on the timeline, seconds.
    pub fn duration(&self) -> f64 {
        let speed = if self.speed > 0.0 { self.speed } else { 1.0 };
        ((self.out - self.in_) / speed).max(0.0)
    }
    pub fn end(&self) -> f64 {
        self.start + self.duration()
    }
    pub fn is_visual(&self) -> bool {
        self.kind != "audio"
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transform {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    #[serde(default = "one")]
    pub scale: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default = "one")]
    pub opacity: f64,
}
impl Default for Transform {
    fn default() -> Self {
        Transform {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: 1.0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Keyframe {
    pub t: f64,
    pub v: f64,
    /// "linear" | "ease"
    #[serde(default)]
    pub ease: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Crop {
    #[serde(default)]
    pub left: f64,
    #[serde(default)]
    pub top: f64,
    #[serde(default)]
    pub right: f64,
    #[serde(default)]
    pub bottom: f64,
}
impl Crop {
    pub fn is_none(&self) -> bool {
        self.left <= 0.0 && self.top <= 0.0 && self.right <= 0.0 && self.bottom <= 0.0
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Effect {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub params: HashMap<String, serde_json::Value>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

impl Effect {
    pub fn num(&self, key: &str, default: f64) -> f64 {
        match self.params.get(key) {
            Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(default),
            Some(serde_json::Value::String(s)) => s.parse().unwrap_or(default),
            _ => default,
        }
    }
    pub fn str(&self, key: &str, default: &str) -> String {
        match self.params.get(key) {
            Some(serde_json::Value::String(s)) => s.clone(),
            _ => default.to_string(),
        }
    }
    pub fn flag(&self, key: &str, default: bool) -> bool {
        match self.params.get(key) {
            Some(serde_json::Value::Bool(b)) => *b,
            _ => default,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transition {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default = "one")]
    pub duration: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Title {
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default = "default_white")]
    pub color: String,
    /// "regular" | "bold"
    #[serde(default)]
    pub weight: String,
    /// "left" | "center" | "right"
    #[serde(default)]
    pub align: String,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default)]
    pub padding: f64,
    #[serde(default)]
    pub shadow: bool,
    #[serde(default = "one")]
    pub line_height: f64,
    /// Optional path to a .ttf/.otf; otherwise the bundled Inter is used.
    #[serde(default)]
    pub font_file: Option<String>,
}
fn default_font_size() -> f64 {
    72.0
}
fn default_white() -> String {
    "#ffffff".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Marker {
    pub t: f64,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub color: String,
}

impl Project {
    pub fn duration(&self) -> f64 {
        self.tracks
            .iter()
            .flat_map(|t| t.clips.iter())
            .map(|c| c.end())
            .fold(0.0, f64::max)
    }
}
