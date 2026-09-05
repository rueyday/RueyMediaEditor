//! Turns a project into an ffmpeg command line.
//!
//! Every visual clip becomes a full-frame RGBA "layer" of exact length. Each
//! video track is folded into one continuous stream (gaps are transparent,
//! adjacent clips are joined with `concat` or `xfade`). Tracks are stacked
//! with `overlay` onto a black base. Audio is mixed with `amix`.

use crate::project::*;
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize)]
pub struct ExportSettings {
    pub output: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub fps: f64,
    #[serde(default = "d_vcodec")]
    pub video_codec: String,
    /// CRF-like quality, 0 (best) .. 51 (worst). Mapped to a bitrate for hardware encoders.
    #[serde(default = "d_quality")]
    pub quality: u32,
    /// If > 0, use this bitrate instead of `quality`.
    #[serde(default)]
    pub bitrate_kbps: u32,
    #[serde(default = "d_preset")]
    pub preset: String,
    #[serde(default = "d_acodec")]
    pub audio_codec: String,
    #[serde(default = "d_abitrate")]
    pub audio_bitrate_kbps: u32,
    /// Export only this part of the timeline (seconds).
    #[serde(default)]
    pub range: Option<(f64, f64)>,
}
fn d_vcodec() -> String {
    "libx264".into()
}
fn d_quality() -> u32 {
    20
}
fn d_preset() -> String {
    "medium".into()
}
fn d_acodec() -> String {
    "aac".into()
}
fn d_abitrate() -> u32 {
    192
}

pub struct Fonts {
    pub regular: PathBuf,
    pub bold: PathBuf,
}

pub struct Built {
    /// Arguments after the ffmpeg binary.
    pub args: Vec<String>,
    /// Output duration in seconds (for progress).
    pub duration: f64,
    /// The filter graph, for the log.
    pub graph: String,
}

fn n(x: f64) -> String {
    if x.is_finite() {
        let s = format!("{x:.4}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        "0".into()
    }
}

/// Escape a path for use inside a single-quoted filter option value.
fn esc_path(p: &Path) -> String {
    p.to_string_lossy()
        .replace('\\', "/")
        .replace('\'', "'\\''")
        .replace(':', "\\:")
}

/// "#rrggbb" / "#rrggbbaa" / names -> ffmpeg colour syntax.
fn color(c: &str) -> String {
    let c = c.trim();
    if let Some(hex) = c.strip_prefix('#') {
        if hex.len() == 6 || hex.len() == 8 {
            return format!("0x{hex}");
        }
        if hex.len() == 3 {
            let b: Vec<char> = hex.chars().collect();
            return format!("0x{0}{0}{1}{1}{2}{2}", b[0], b[1], b[2]);
        }
    }
    if c.is_empty() {
        "black".into()
    } else {
        c.to_string()
    }
}

/// Piecewise-linear (optionally eased) keyframe expression in ffmpeg's
/// expression language. `tvar` is the time variable (`t`, or `T` in geq).
pub fn kf_expr(kfs: &[Keyframe], base: f64, tvar: &str) -> String {
    let mut k: Vec<&Keyframe> = kfs.iter().filter(|k| k.t.is_finite() && k.v.is_finite()).collect();
    if k.is_empty() {
        return n(base);
    }
    k.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    if k.len() == 1 {
        return n(k[0].v);
    }
    let mut expr = n(k[k.len() - 1].v);
    for i in (0..k.len() - 1).rev() {
        let (a, b) = (k[i], k[i + 1]);
        let span = (b.t - a.t).max(1e-6);
        let p = format!("(({tvar}-{})/{})", n(a.t), n(span));
        let p = if a.ease == "ease" {
            format!("({p}*{p}*(3-2*{p}))")
        } else {
            p
        };
        expr = format!(
            "if(lt({tvar},{}),{}+({})*{p},{expr})",
            n(b.t),
            n(a.v),
            n(b.v - a.v)
        );
    }
    format!("if(lt({tvar},{}),{},{expr})", n(k[0].t), n(k[0].v))
}

fn has_kf(clip: &Clip, key: &str) -> bool {
    clip.keyframes.get(key).map(|v| !v.is_empty()).unwrap_or(false)
}

fn prop_expr(clip: &Clip, key: &str, base: f64, tvar: &str) -> String {
    match clip.keyframes.get(key) {
        Some(k) if !k.is_empty() => kf_expr(k, base, tvar),
        _ => n(base),
    }
}

/// Map UI transition names onto xfade transition names.
fn xfade_name(kind: &str) -> &str {
    match kind {
        "crossfade" | "dissolve" | "" => "fade",
        "fade" => "fadeblack",
        other => other,
    }
}

pub fn effect_filters(e: &Effect) -> Vec<String> {
    if !e.enabled {
        return vec![];
    }
    match e.kind.as_str() {
        "color" => {
            let mut v = vec![format!(
                "eq=brightness={}:contrast={}:saturation={}:gamma={}",
                n(e.num("brightness", 0.0).clamp(-1.0, 1.0)),
                n(e.num("contrast", 1.0).clamp(0.0, 3.0)),
                n(e.num("saturation", 1.0).clamp(0.0, 3.0)),
                n(e.num("gamma", 1.0).clamp(0.1, 10.0))
            )];
            let hue = e.num("hue", 0.0);
            if hue.abs() > 0.01 {
                v.push(format!("hue=h={}", n(hue)));
            }
            let exposure = e.num("exposure", 0.0);
            if exposure.abs() > 0.001 {
                v.push(format!("exposure=exposure={}", n(exposure.clamp(-3.0, 3.0))));
            }
            let temp = e.num("temperature", 6500.0);
            if (temp - 6500.0).abs() > 1.0 {
                v.push(format!("colortemperature=temperature={}", n(temp.clamp(1000.0, 40000.0))));
            }
            v
        }
        "blur" => vec![format!("gblur=sigma={}", n(e.num("radius", 4.0).max(0.0)))],
        "sharpen" => vec![format!("unsharp=5:5:{}", n(e.num("amount", 1.0).clamp(-2.0, 5.0)))],
        "flip" => {
            let mut v = vec![];
            if e.flag("horizontal", true) {
                v.push("hflip".to_string());
            }
            if e.flag("vertical", false) {
                v.push("vflip".to_string());
            }
            v
        }
        "grayscale" => vec!["hue=s=0".into()],
        "sepia" => vec!["colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131".into()],
        "invert" => vec!["negate".into()],
        "vignette" => vec![format!("vignette=angle={}", n(e.num("angle", 0.6).clamp(0.0, 1.57)))],
        "chromakey" => vec![format!(
            "colorkey=color={}:similarity={}:blend={}",
            color(&e.str("color", "#00ff00")),
            n(e.num("similarity", 0.3).clamp(0.01, 1.0)),
            n(e.num("blend", 0.1).clamp(0.0, 1.0))
        )],
        "lut" => {
            let p = e.str("path", "");
            if p.is_empty() {
                vec![]
            } else {
                vec![format!("lut3d=file='{}'", esc_path(Path::new(&p)))]
            }
        }
        "noise" => vec![format!("noise=alls={}:allf=t", n(e.num("strength", 20.0).clamp(0.0, 100.0)))],
        _ => vec![],
    }
}

struct Builder<'a> {
    project: &'a Project,
    w: u32,
    h: u32,
    fps: f64,
    inputs: Vec<Vec<String>>,
    filters: Vec<String>,
    counter: usize,
    work_dir: &'a Path,
    fonts: &'a Fonts,
    audio_labels: Vec<String>,
    video_enabled: bool,
    audio_enabled: bool,
}

struct Seg {
    label: String,
    len: f64,
    xfade: Option<(String, f64)>,
}

impl<'a> Builder<'a> {
    fn label(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}{}", self.counter)
    }

    fn add_input(&mut self, args: Vec<String>) -> usize {
        self.inputs.push(args);
        self.inputs.len() - 1
    }

    fn transparent(&mut self, len: f64) -> String {
        let l = self.label("gap");
        self.filters.push(format!(
            "color=c=black@0.0:s={}x{}:r={}:d={},format=rgba[{l}]",
            self.w,
            self.h,
            n(self.fps),
            n(len.max(1.0 / self.fps))
        ));
        l
    }

    fn drawtext(&self, title: &Title) -> Result<String, String> {
        let file = self.work_dir.join(format!("title-{}.txt", self.counter));
        std::fs::write(&file, &title.text).map_err(|e| format!("Cannot write title text: {e}"))?;
        let font: PathBuf = match title.font_file.as_ref().filter(|f| !f.is_empty() && Path::new(f).exists()) {
            Some(f) => PathBuf::from(f),
            None => if title.weight == "bold" { self.fonts.bold.clone() } else { self.fonts.regular.clone() },
        };
        let size = title.font_size.max(4.0);
        let x = match title.align.as_str() {
            "left" => "w*0.05".to_string(),
            "right" => "w*0.95-text_w".to_string(),
            _ => "(w-text_w)/2".to_string(),
        };
        let mut f = format!(
            "drawtext=textfile='{}':fontfile='{}':fontsize={}:fontcolor={}:x={x}:y=(h-text_h)/2:line_spacing={}",
            esc_path(&file),
            esc_path(&font),
            n(size),
            color(&title.color),
            n(size * (title.line_height - 1.0).max(-0.5))
        );
        if let Some(bg) = &title.background {
            if !bg.is_empty() {
                f.push_str(&format!(":box=1:boxcolor={}:boxborderw={}", color(bg), n(title.padding.max(0.0))));
            }
        }
        if title.shadow {
            f.push_str(&format!(":shadowcolor=black@0.6:shadowx={}:shadowy={}", n(size * 0.04), n(size * 0.04)));
        }
        Ok(f)
    }

    fn drawtimecode(&self, tc: &Timecode, clip_start: f64) -> String {
        let offset = tc.offset + if tc.source == "clip" { 0.0 } else { clip_start };
        let size = tc.font_size.max(4.0);
        let m = n(size * 0.5);
        let text = match tc.format.as_str() {
            "frames" => format!("%{{eif\\:n+{}\\:d}}", (offset * self.fps).round() as i64),
            _ => format!("%{{pts\\:hms\\:{}}}", n(offset)),
        };
        let label = if tc.label.is_empty() { String::new() } else { format!("{} ", tc.label.replace('\\', "").replace(':', "\\:").replace('\'', "")) };
        let (x, y) = match tc.position.as_str() {
            "top-right" => (format!("w-text_w-{m}"), m.clone()),
            "top-center" => ("(w-text_w)/2".to_string(), m.clone()),
            "bottom-left" => (m.clone(), format!("h-text_h-{m}")),
            "bottom-right" => (format!("w-text_w-{m}"), format!("h-text_h-{m}")),
            "bottom-center" => ("(w-text_w)/2".to_string(), format!("h-text_h-{m}")),
            _ => (m.clone(), m.clone()),
        };
        let mut f = format!(
            "drawtext=text='{label}{text}':fontfile='{}':fontsize={}:fontcolor={}:x={x}:y={y}",
            esc_path(&self.fonts.bold),
            n(size),
            color(&tc.color)
        );
        if let Some(bg) = tc.background.as_ref().filter(|b| !b.is_empty()) {
            f.push_str(&format!(":box=1:boxcolor={}:boxborderw={}", color(bg), n(size * 0.25)));
        }
        f
    }

    fn drawcaption(&self, cap: &Caption, style: &CaptionStyle, idx: usize) -> Result<String, String> {
        let file = self.work_dir.join(format!("caption-{idx}.txt"));
        std::fs::write(&file, &cap.text).map_err(|e| format!("Cannot write caption text: {e}"))?;
        let font: PathBuf = match style.font_file.as_ref().filter(|f| !f.is_empty() && Path::new(f).exists()) {
            Some(f) => PathBuf::from(f),
            None => if style.weight == "regular" { self.fonts.regular.clone() } else { self.fonts.bold.clone() },
        };
        let size = style.font_size.max(4.0);
        let y = if style.position == "top" { n(style.margin.max(0.0)) } else { format!("h-text_h-{}", n(style.margin.max(0.0))) };
        let mut f = format!(
            "drawtext=textfile='{}':fontfile='{}':fontsize={}:fontcolor={}:x=(w-text_w)/2:y={y}:line_spacing={}",
            esc_path(&file),
            esc_path(&font),
            n(size),
            color(&style.color),
            n(size * 0.2)
        );
        if let Some(bg) = style.background.as_ref().filter(|b| !b.is_empty()) {
            f.push_str(&format!(":box=1:boxcolor={}:boxborderw={}", color(bg), n(size * 0.25)));
        }
        f.push_str(&format!(":enable='between(t,{},{})'", n(cap.start), n(cap.end)));
        Ok(f)
    }

    /// Builds a full-frame RGBA layer of exactly `len` seconds for a visual clip.
    /// `ext_out` is how much of that length is extra tail for an xfade.
    fn layer(&mut self, clip: &Clip, len: f64, ext_out: f64, fade_in: Option<f64>, fade_out: Option<f64>) -> Result<(String, Option<usize>), String> {
        let speed = if clip.speed > 0.0 { clip.speed } else { 1.0 };
        let (w, h, fps) = (self.w, self.h, self.fps);
        let mut chain: Vec<String> = Vec::new();
        let mut input_idx: Option<usize> = None;
        let mut cxr = 1.0;
        let mut cyr = 1.0;
        let src: String;

        match clip.kind.as_str() {
            "video" | "image" | "audio" | "shape" => {
                let is_still = clip.kind == "image" || clip.kind == "shape";
                let path = if clip.kind == "shape" {
                    clip.image_path.clone().filter(|p| !p.is_empty()).ok_or_else(|| format!("Shape clip {} has not been rendered", clip.id))?
                } else {
                    clip.media_id
                        .as_ref()
                        .and_then(|id| self.project.media.get(id))
                        .map(|m| m.path.clone())
                        .ok_or_else(|| format!("Clip {} refers to missing media", clip.id))?
                };
                let src_len = len * speed;
                let idx = if is_still {
                    self.add_input(vec![
                        "-loop".into(), "1".into(),
                        "-framerate".into(), n(fps),
                        "-t".into(), n(len + 1.0),
                        "-i".into(), path,
                    ])
                } else if clip.reverse {
                    self.add_input(vec![
                        "-ss".into(), n(clip.in_.max(0.0)),
                        "-t".into(), n((clip.out - clip.in_).max(0.04)),
                        "-i".into(), path,
                    ])
                } else {
                    self.add_input(vec![
                        "-ss".into(), n(clip.in_.max(0.0)),
                        "-t".into(), n(src_len + 1.0),
                        "-i".into(), path,
                    ])
                };
                input_idx = Some(idx);
                src = format!("[{idx}:v]");
                if is_still {
                    chain.push(format!("fps={}", n(fps)));
                    chain.push("setpts=PTS-STARTPTS".into());
                } else if clip.reverse {
                    chain.push(format!("trim=duration={}", n((clip.out - clip.in_).max(0.04))));
                    chain.push("reverse".into());
                    chain.push(format!("setpts=(PTS-STARTPTS)/{}", n(speed)));
                    chain.push(format!("fps={}", n(fps)));
                } else {
                    chain.push(format!("setpts=(PTS-STARTPTS)/{}", n(speed)));
                    chain.push(format!("fps={}", n(fps)));
                }
                let c = &clip.crop;
                if !c.is_none() {
                    cxr = (1.0 - c.left - c.right).clamp(0.02, 1.0);
                    cyr = (1.0 - c.top - c.bottom).clamp(0.02, 1.0);
                    chain.push(format!(
                        "crop=w=iw*{}:h=ih*{}:x=iw*{}:y=ih*{}",
                        n(cxr), n(cyr), n(c.left.clamp(0.0, 0.98)), n(c.top.clamp(0.0, 0.98))
                    ));
                }
            }
            "title" => {
                let title = clip.title.clone().unwrap_or(Title {
                    text: String::new(), font_size: 72.0, color: "#ffffff".into(), weight: String::new(),
                    align: String::new(), background: None, padding: 0.0, shadow: false, line_height: 1.0, font_file: None,
                });
                src = format!("color=c=black@0.0:s={w}x{h}:r={}:d={},format=rgba", n(fps), n(len + 1.0));
                chain.push(self.drawtext(&title)?);
            }
            "color" => {
                src = format!(
                    "color=c={}:s={w}x{h}:r={}:d={},format=rgba",
                    color(clip.color.as_deref().unwrap_or("#000000")),
                    n(fps),
                    n(len + 1.0)
                );
            }
            "timecode" => {
                let tc = clip.timecode.clone().unwrap_or_default();
                src = format!("color=c=black@0.0:s={w}x{h}:r={}:d={},format=rgba", n(fps), n(len + 1.0));
                chain.push(self.drawtimecode(&tc, clip.start));
            }
            other => return Err(format!("Unknown clip kind {other}")),
        }

        for e in &clip.effects {
            chain.extend(effect_filters(e));
        }
        chain.push("format=rgba".into());

        // Fit into the frame, then user scale (possibly keyframed).
        let scale_expr = prop_expr(clip, "scale", clip.transform.scale, "t");
        let kf_scale = has_kf(clip, "scale");
        let fit = if clip.kind == "title" || clip.kind == "color" || clip.kind == "timecode" {
            "1".to_string()
        } else {
            format!("min({}/iw,{}/ih)", n(w as f64 * cxr), n(h as f64 * cyr))
        };
        if fit != "1" || kf_scale || (clip.transform.scale - 1.0).abs() > 1e-6 {
            chain.push(format!(
                "scale=w='max(2,iw*{fit}*({scale_expr}))':h='max(2,ih*{fit}*({scale_expr}))':eval={}:flags=bicubic",
                if kf_scale { "frame" } else { "init" }
            ));
        }

        if has_kf(clip, "rotation") || clip.transform.rotation.abs() > 1e-6 {
            let r = prop_expr(clip, "rotation", clip.transform.rotation, "t");
            chain.push(format!(
                "rotate=a='({r})*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=black@0.0"
            ));
        }

        if has_kf(clip, "opacity") {
            let o = prop_expr(clip, "opacity", clip.transform.opacity, "T");
            chain.push(format!("geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip({o},0,1)'"));
        } else if clip.transform.opacity < 0.999 {
            chain.push(format!("colorchannelmixer=aa={}", n(clip.transform.opacity.clamp(0.0, 1.0))));
        }

        if let Some(d) = fade_in {
            chain.push(format!("fade=t=in:st=0:d={}:alpha=1", n(d)));
        }
        if let Some(d) = fade_out {
            let base_len = len - ext_out;
            chain.push(format!("fade=t=out:st={}:d={}:alpha=1", n((base_len - d).max(0.0)), n(d)));
        }

        chain.push("tpad=stop_mode=clone:stop_duration=3".into());
        chain.push(format!("trim=duration={}", n(len)));
        chain.push("setpts=PTS-STARTPTS".into());

        let layer = self.label("lay");
        let sep = if src.starts_with('[') { "" } else { "," };
        self.filters.push(format!("{src}{sep}{}[{layer}]", chain.join(",")));

        // Place onto a transparent full frame at the (possibly keyframed) position.
        let canvas = self.transparent(len);
        let x = prop_expr(clip, "x", clip.transform.x, "t");
        let y = prop_expr(clip, "y", clip.transform.y, "t");
        let out = self.label("pos");
        self.filters.push(format!(
            "[{canvas}][{layer}]overlay=x='(W-w)/2+({x})':y='(H-h)/2+({y})':format=auto:eof_action=pass[{out}]"
        ));
        Ok((out, input_idx))
    }

    fn audio(&mut self, clip: &Clip, media: &Media, input_idx: Option<usize>, len: f64, fade_in: f64, fade_out: f64) {
        if !self.audio_enabled {
            return;
        }
        let speed = if clip.speed > 0.0 { clip.speed } else { 1.0 };
        let idx = match input_idx {
            Some(i) => i,
            None => self.add_input(vec![
                "-ss".into(), n(clip.in_.max(0.0)),
                "-t".into(), n(if clip.reverse { (clip.out - clip.in_).max(0.04) } else { len * speed + 1.0 }),
                "-vn".into(),
                "-i".into(), media.path.clone(),
            ]),
        };
        let sr = self.project.settings.sample_rate.max(8000);
        let mut chain = vec![
            format!("aformat=sample_rates={sr}:channel_layouts=stereo"),
            "asetpts=PTS-STARTPTS".to_string(),
        ];
        if clip.reverse {
            chain.push(format!("atrim=duration={}", n((clip.out - clip.in_).max(0.04))));
            chain.push("areverse".into());
        }
        let mut s = speed;
        while s > 2.0 {
            chain.push("atempo=2".into());
            s /= 2.0;
        }
        while s < 0.5 {
            chain.push("atempo=0.5".into());
            s *= 2.0;
        }
        if (s - 1.0).abs() > 1e-4 {
            chain.push(format!("atempo={}", n(s)));
        }
        chain.push(format!("atrim=duration={}", n(len)));
        if has_kf(clip, "volume") {
            let expr = prop_expr(clip, "volume", clip.volume, "t");
            chain.push(format!("volume=volume='max(0,{expr})':eval=frame"));
        } else if (clip.volume - 1.0).abs() > 1e-4 {
            chain.push(format!("volume={}", n(clip.volume.max(0.0))));
        }
        if fade_in > 0.0 {
            chain.push(format!("afade=t=in:st=0:d={}", n(fade_in.min(len))));
        }
        if fade_out > 0.0 {
            chain.push(format!("afade=t=out:st={}:d={}", n((len - fade_out).max(0.0)), n(fade_out.min(len))));
        }
        let delay_ms = (clip.start.max(0.0) * 1000.0).round() as i64;
        if delay_ms > 0 {
            chain.push(format!("adelay={delay_ms}:all=1"));
        }
        let l = self.label("aud");
        self.filters.push(format!("[{idx}:a]{}[{l}]", chain.join(",")));
        self.audio_labels.push(l);
    }

    /// One continuous full-frame stream for a video track, `total` seconds long.
    fn track_stream(&mut self, track: &Track, total: f64, audible: bool) -> Result<Option<String>, String> {
        let mut clips: Vec<&Clip> = track.clips.iter().filter(|c| c.duration() > 1e-4).collect();
        clips.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

        // Effective transition length between adjacent clips i-1 and i.
        let mut pair_d: Vec<f64> = vec![0.0; clips.len()];
        for i in 1..clips.len() {
            let (a, b) = (clips[i - 1], clips[i]);
            if let Some(tr) = &b.transition_in {
                if (b.start - a.end()).abs() < 0.002 && tr.duration > 0.0 {
                    pair_d[i] = tr.duration.min(a.duration()).min(b.duration()).max(2.0 / self.fps);
                }
            }
        }

        let render_video = !track.hidden && self.video_enabled;
        let mut segs: Vec<Seg> = Vec::new();
        let mut cursor = 0.0;
        for (i, clip) in clips.iter().enumerate() {
            let start = clip.start.max(cursor);
            if clip.end() - start <= 1e-4 {
                continue; // fully covered by the previous clip (overlaps are not allowed, be safe)
            }
            if render_video && start > cursor + 0.001 {
                let l = self.transparent(start - cursor);
                segs.push(Seg { label: l, len: start - cursor, xfade: None });
            }
            let d_in = pair_d[i];
            let d_out = pair_d.get(i + 1).copied().unwrap_or(0.0);
            let base_len = clip.end() - start;
            let len = base_len + d_out;

            let standalone_in = clip.transition_in.as_ref().filter(|t| d_in <= 0.0 && t.duration > 0.0).map(|t| t.duration.min(base_len));
            let standalone_out = clip.transition_out.as_ref().filter(|t| d_out <= 0.0 && t.duration > 0.0).map(|t| t.duration.min(base_len));

            let no_video = !render_video;
            let (label, input_idx) = if no_video {
                (String::new(), None)
            } else {
                self.layer(clip, len, d_out, standalone_in, standalone_out)?
            };

            // Audio that belongs to this visual clip.
            if audible && clip.kind == "video" && !clip.muted && !clip.audio_detached {
                if let Some(media) = clip.media_id.as_ref().and_then(|id| self.project.media.get(id)) {
                    if media.has_audio {
                        let fi = if d_in > 0.0 { d_in } else { clip.fade_in.max(standalone_in.unwrap_or(0.0)) };
                        let fo = if d_out > 0.0 { d_out } else { clip.fade_out.max(standalone_out.unwrap_or(0.0)) };
                        let m = media.clone();
                        self.audio(clip, &m, if no_video { None } else { input_idx }, len, fi, fo);
                    }
                }
            }

            if !no_video {
                let xfade = if d_in > 0.0 {
                    Some((xfade_name(&clip.transition_in.as_ref().unwrap().kind).to_string(), d_in))
                } else {
                    None
                };
                segs.push(Seg { label, len, xfade });
            }
            cursor = clip.end();
        }
        if !render_video {
            return Ok(None);
        }
        if cursor < total - 0.001 {
            let l = self.transparent(total - cursor);
            segs.push(Seg { label: l, len: total - cursor, xfade: None });
        }
        if segs.is_empty() {
            return Ok(None);
        }

        let mut cur = segs[0].label.clone();
        let mut cur_len = segs[0].len;
        for seg in segs.iter().skip(1) {
            let out = self.label("trk");
            match &seg.xfade {
                Some((name, d)) => {
                    self.filters.push(format!(
                        "[{cur}][{}]xfade=transition={name}:duration={}:offset={}[{out}]",
                        seg.label,
                        n(*d),
                        n((cur_len - d).max(0.0))
                    ));
                    cur_len = cur_len + seg.len - d;
                }
                None => {
                    self.filters.push(format!("[{cur}][{}]concat=n=2:v=1:a=0[{out}]", seg.label));
                    cur_len += seg.len;
                }
            }
            cur = out;
        }
        let _ = cur_len;
        Ok(Some(cur))
    }

    fn audio_track(&mut self, track: &Track) {
        for clip in &track.clips {
            if clip.muted || clip.duration() <= 1e-4 {
                continue;
            }
            if let Some(media) = clip.media_id.as_ref().and_then(|id| self.project.media.get(id)) {
                if media.has_audio {
                    let m = media.clone();
                    self.audio(clip, &m, None, clip.duration(), clip.fade_in, clip.fade_out);
                }
            }
        }
    }
}

fn quality_to_kbps(q: u32, w: u32, h: u32, fps: f64) -> u32 {
    // bits per pixel per frame: ~0.30 at q=0 down to ~0.03 at q=51
    let t = (q.min(51) as f64) / 51.0;
    let bpp = 0.30 * (1.0 - t) + 0.03 * t;
    ((w as f64 * h as f64 * fps.max(1.0) * bpp) / 1000.0).round().max(300.0) as u32
}

fn video_codec_args(s: &ExportSettings, w: u32, h: u32, fps: f64) -> Vec<String> {
    let q = s.quality.min(51);
    let mut a: Vec<String> = Vec::new();
    let bitrate = if s.bitrate_kbps > 0 { s.bitrate_kbps } else { quality_to_kbps(q, w, h, fps) };
    let push = |a: &mut Vec<String>, items: &[&str]| a.extend(items.iter().map(|s| s.to_string()));
    match s.video_codec.as_str() {
        "libx264" => {
            push(&mut a, &["-c:v", "libx264", "-preset", &s.preset, "-pix_fmt", "yuv420p", "-profile:v", "high"]);
            if s.bitrate_kbps > 0 { push(&mut a, &["-b:v", &format!("{bitrate}k")]); } else { push(&mut a, &["-crf", &q.to_string()]); }
            push(&mut a, &["-movflags", "+faststart"]);
        }
        "libx265" => {
            push(&mut a, &["-c:v", "libx265", "-preset", &s.preset, "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]);
            if s.bitrate_kbps > 0 { push(&mut a, &["-b:v", &format!("{bitrate}k")]); } else { push(&mut a, &["-crf", &q.to_string()]); }
            push(&mut a, &["-movflags", "+faststart"]);
        }
        "h264_videotoolbox" | "hevc_videotoolbox" => {
            push(&mut a, &["-c:v", &s.video_codec, "-b:v", &format!("{bitrate}k"), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]);
            if s.video_codec == "hevc_videotoolbox" { push(&mut a, &["-tag:v", "hvc1"]); }
        }
        "h264_nvenc" | "hevc_nvenc" => {
            push(&mut a, &["-c:v", &s.video_codec, "-preset", "p5", "-rc", "vbr", "-cq", &q.to_string(), "-b:v", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]);
            if s.video_codec == "hevc_nvenc" { push(&mut a, &["-tag:v", "hvc1"]); }
        }
        "h264_qsv" | "hevc_qsv" => {
            push(&mut a, &["-c:v", &s.video_codec, "-global_quality", &q.max(1).to_string(), "-pix_fmt", "nv12", "-movflags", "+faststart"]);
        }
        "h264_amf" | "hevc_amf" => {
            push(&mut a, &["-c:v", &s.video_codec, "-rc", "cqp", "-qp_i", &q.to_string(), "-qp_p", &q.to_string(), "-pix_fmt", "yuv420p", "-movflags", "+faststart"]);
        }
        "h264_vaapi" | "hevc_vaapi" => {
            push(&mut a, &["-c:v", &s.video_codec, "-b:v", &format!("{bitrate}k")]);
        }
        "libvpx-vp9" => {
            push(&mut a, &["-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2"]);
            if s.bitrate_kbps > 0 { push(&mut a, &["-b:v", &format!("{bitrate}k")]); } else { push(&mut a, &["-crf", &q.to_string(), "-b:v", "0"]); }
        }
        "libaom-av1" => {
            push(&mut a, &["-c:v", "libaom-av1", "-pix_fmt", "yuv420p", "-crf", &q.to_string(), "-b:v", "0", "-cpu-used", "6", "-row-mt", "1"]);
        }
        "libsvtav1" => {
            push(&mut a, &["-c:v", "libsvtav1", "-pix_fmt", "yuv420p", "-crf", &q.to_string(), "-preset", "8"]);
        }
        "prores_ks" => {
            push(&mut a, &["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"]);
        }
        "gif" => {}
        "none" => push(&mut a, &["-vn"]),
        other => {
            push(&mut a, &["-c:v", other, "-pix_fmt", "yuv420p"]);
        }
    }
    a
}

fn audio_codec_args(s: &ExportSettings) -> Vec<String> {
    let br = format!("{}k", s.audio_bitrate_kbps.max(32));
    let v: Vec<&str> = match s.audio_codec.as_str() {
        "aac" => vec!["-c:a", "aac", "-b:a", &br],
        "libopus" => vec!["-c:a", "libopus", "-b:a", &br],
        "libmp3lame" => vec!["-c:a", "libmp3lame", "-b:a", &br],
        "pcm_s16le" => vec!["-c:a", "pcm_s16le"],
        "flac" => vec!["-c:a", "flac"],
        "none" => vec!["-an"],
        other => vec!["-c:a", other, "-b:a", &br],
    };
    v.into_iter().map(String::from).collect()
}

/// Build the complete ffmpeg argument list for exporting `project`.
pub fn build(project: &Project, settings: &ExportSettings, work_dir: &Path, fonts: &Fonts) -> Result<Built, String> {
    let ps = &project.settings;
    let w = if settings.width > 0 { settings.width } else { ps.width } & !1;
    let h = if settings.height > 0 { settings.height } else { ps.height } & !1;
    let fps = if settings.fps > 0.0 { settings.fps } else { ps.fps };
    if w < 2 || h < 2 || fps <= 0.0 {
        return Err("Invalid output size or frame rate".into());
    }
    let total = project.duration();
    if total <= 0.0 {
        return Err("The timeline is empty".into());
    }

    let mut b = Builder {
        project,
        w: ps.width.max(2) & !1,
        h: ps.height.max(2) & !1,
        fps,
        inputs: vec![],
        filters: vec![],
        counter: 0,
        work_dir,
        fonts,
        audio_labels: vec![],
        video_enabled: settings.video_codec != "none",
        audio_enabled: settings.audio_codec != "none" && settings.video_codec != "gif",
    };

    let any_solo = project.tracks.iter().any(|t| t.solo);
    let audible = |t: &Track| !t.muted && (!any_solo || t.solo);

    // Video tracks: the array is ordered top -> bottom in the UI; render bottom first.
    let mut track_labels: Vec<String> = Vec::new();
    for track in project.tracks.iter().filter(|t| t.kind == "video").rev() {
        if let Some(l) = b.track_stream(track, total, audible(track))? {
            track_labels.push(l);
        }
    }
    for track in project.tracks.iter().filter(|t| t.kind == "audio") {
        if audible(track) {
            b.audio_track(track);
        }
    }

    let out_dur = if let Some((a, bnd)) = settings.range {
        let (a, bnd) = (a.max(0.0), bnd.min(total));
        if bnd - a <= 0.0 {
            return Err("Export range is empty".into());
        }
        bnd - a
    } else {
        total
    };

    let mut vout = String::new();
    if b.video_enabled {
        // Stack tracks on a black base.
        let mut base = b.label("base");
        b.filters.push(format!(
            "color=c=black:s={}x{}:r={}:d={},format=rgba[{base}]",
            b.w, b.h, n(fps), n(total)
        ));
        for tl in &track_labels {
            let out = b.label("base");
            b.filters.push(format!("[{base}][{tl}]overlay=format=auto:eof_action=pass[{out}]"));
            base = out;
        }

        // Final video chain: captions, optional range, resize, pixel format / gif palette.
        let mut vchain: Vec<String> = Vec::new();
        for (i, cap) in project.captions.iter().enumerate() {
            if cap.end > cap.start && !cap.text.trim().is_empty() {
                vchain.push(b.drawcaption(cap, &project.caption_style, i)?);
            }
        }
        if let Some((a, bnd)) = settings.range {
            vchain.push(format!("trim=start={}:end={},setpts=PTS-STARTPTS", n(a.max(0.0)), n(bnd.min(total))));
        }
        if w != b.w || h != b.h {
            vchain.push(format!("scale={w}:{h}:flags=lanczos"));
        }
        match settings.video_codec.as_str() {
            "gif" => vchain.push("split[gifa][gifb];[gifa]palettegen=stats_mode=diff[pal];[gifb][pal]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle".into()),
            "prores_ks" => vchain.push("format=yuv422p10le".into()),
            _ => vchain.push("format=yuv420p".into()),
        }
        b.filters.push(format!("[{base}]{}[vout]", vchain.join(",")));
        vout = "vout".to_string();
    }

    // Audio mix.
    let want_audio = b.audio_enabled && !b.audio_labels.is_empty();
    let aout = if want_audio {
        let labels: Vec<String> = b.audio_labels.iter().map(|l| format!("[{l}]")).collect();
        let mixed = if labels.len() == 1 {
            b.audio_labels[0].clone()
        } else {
            b.filters.push(format!(
                "{}amix=inputs={}:normalize=0:duration=longest:dropout_transition=0[amix]",
                labels.join(""),
                labels.len()
            ));
            "amix".to_string()
        };
        let mut achain = vec![format!("apad=whole_dur={}", n(total)), format!("atrim=duration={}", n(total))];
        if let Some((a, bnd)) = settings.range {
            achain.push(format!("atrim=start={}:end={},asetpts=PTS-STARTPTS", n(a.max(0.0)), n(bnd.min(total))));
        }
        b.filters.push(format!("[{mixed}]{}[aout]", achain.join(",")));
        Some("aout".to_string())
    } else {
        None
    };

    let graph = b.filters.join(";\n");
    let graph_file = work_dir.join("graph.txt");
    std::fs::write(&graph_file, &graph).map_err(|e| format!("Cannot write filter graph: {e}"))?;

    let mut args: Vec<String> = vec![
        "-hide_banner".into(), "-y".into(), "-loglevel".into(), "error".into(),
        "-progress".into(), "pipe:1".into(), "-nostats".into(),
    ];
    for inp in &b.inputs {
        args.extend(inp.iter().cloned());
    }
    args.push("-filter_complex_script".into());
    args.push(graph_file.to_string_lossy().to_string());
    if b.video_enabled {
        args.push("-map".into());
        args.push(format!("[{vout}]"));
    }
    if let Some(a) = &aout {
        args.push("-map".into());
        args.push(format!("[{a}]"));
    } else {
        args.push("-an".into());
    }
    args.extend(video_codec_args(settings, w, h, fps));
    if aout.is_some() {
        args.extend(audio_codec_args(settings));
    }
    if settings.video_codec != "none" {
        args.push("-r".into());
        args.push(n(fps));
    }
    args.push(settings.output.clone());

    Ok(Built { args, duration: out_dur, graph })
}

/// A project containing only what is visible at `t`, shifted so `t` is at 0.
pub fn single_frame_project(project: &Project, t: f64) -> Project {
    let mut p = project.clone();
    let two_frames = 2.0 / p.settings.fps.max(1.0);
    for cap in &mut p.captions {
        cap.start -= t;
        cap.end -= t;
    }
    for track in &mut p.tracks {
        if track.kind != "video" {
            track.clips.clear();
            continue;
        }
        let mut kept = Vec::new();
        for clip in track.clips.drain(..) {
            if clip.start <= t && t < clip.end() {
                let speed = if clip.speed > 0.0 { clip.speed } else { 1.0 };
                let offset = t - clip.start;
                let mut c = clip.clone();
                if clip.reverse {
                    c.out = clip.out - offset * speed;
                    c.in_ = (c.out - two_frames * speed).max(clip.in_);
                } else {
                    c.in_ = clip.in_ + offset * speed;
                    c.out = c.in_ + two_frames * speed;
                }
                if let Some(tc) = c.timecode.as_mut() {
                    tc.offset += offset + if tc.source == "clip" { 0.0 } else { clip.start };
                }
                c.start = 0.0;
                c.transition_in = None;
                c.transition_out = None;
                c.fade_in = 0.0;
                c.fade_out = 0.0;
                for kfs in c.keyframes.values_mut() {
                    for k in kfs.iter_mut() {
                        k.t -= offset;
                    }
                }
                kept.push(c);
            }
        }
        track.clips = kept;
    }
    p
}

/// ffmpeg arguments that render the frame at `t` to `out_png` at `width` pixels wide.
pub fn build_frame(project: &Project, t: f64, width: u32, out_png: &Path, work_dir: &Path, fonts: &Fonts) -> Result<Vec<String>, String> {
    let p = single_frame_project(project, t);
    if p.duration() <= 0.0 {
        return Err("empty".into());
    }
    let ratio = p.settings.height as f64 / p.settings.width.max(1) as f64;
    let w = width.max(16) & !1;
    let h = ((w as f64 * ratio).round() as u32).max(2) & !1;
    let settings = ExportSettings {
        output: out_png.to_string_lossy().to_string(),
        width: w,
        height: h,
        fps: 0.0,
        video_codec: "png".into(),
        quality: 0,
        bitrate_kbps: 0,
        preset: String::new(),
        audio_codec: "none".into(),
        audio_bitrate_kbps: 0,
        range: None,
    };
    let built = build(&p, &settings, work_dir, fonts)?;
    // Replace the generic "-c:v png -pix_fmt yuv420p" tail with a single RGB frame.
    let mut args: Vec<String> = Vec::new();
    let mut skip = 0;
    for a in built.args.iter() {
        if skip > 0 {
            skip -= 1;
            continue;
        }
        if a == "-c:v" || a == "-pix_fmt" || a == "-r" {
            skip = 1;
            continue;
        }
        args.push(a.clone());
    }
    let out = args.pop().unwrap_or_default();
    args.extend(["-frames:v".into(), "1".into(), "-update".into(), "1".into(), "-pix_fmt".into(), "rgb24".into(), out]);
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn media(id: &str, dur: f64, audio: bool) -> (String, Media) {
        (
            id.to_string(),
            Media {
                path: format!("/tmp/{id}.mp4"),
                name: format!("{id}.mp4"),
                kind: "video".into(),
                duration: dur,
                width: 1280,
                height: 720,
                fps: 30.0,
                has_video: true,
                has_audio: audio,
                proxy: None,
            },
        )
    }

    fn clip(id: &str, media: &str, start: f64, in_: f64, out: f64) -> Clip {
        Clip {
            id: id.into(),
            kind: "video".into(),
            media_id: Some(media.into()),
            start,
            in_,
            out,
            speed: 1.0,
            volume: 1.0,
            muted: false,
            audio_detached: false,
            fade_in: 0.0,
            fade_out: 0.0,
            transform: Transform::default(),
            keyframes: HashMap::new(),
            crop: Crop::default(),
            effects: vec![],
            transition_in: None,
            transition_out: None,
            title: None,
            color: None,
            name: String::new(),
            reverse: false,
            image_path: None,
            timecode: None,
        }
    }

    fn fonts() -> Fonts {
        Fonts { regular: PathBuf::from("/tmp/Inter-Regular.ttf"), bold: PathBuf::from("/tmp/Inter-Bold.ttf") }
    }

    #[test]
    fn keyframe_expression_is_piecewise_linear() {
        let kfs = vec![Keyframe { t: 0.0, v: 0.0, ease: String::new() }, Keyframe { t: 2.0, v: 100.0, ease: String::new() }];
        let e = kf_expr(&kfs, 5.0, "t");
        assert!(e.contains("if(lt(t,0),0,"), "{e}");
        assert!(e.contains("if(lt(t,2),0+(100)*((t-0)/2),100)"), "{e}");
        assert_eq!(kf_expr(&[], 0.5, "t"), "0.5");
    }

    #[test]
    fn builds_graph_with_xfade_title_and_audio() {
        let mut p = Project {
            version: 1,
            name: "t".into(),
            settings: Settings { width: 640, height: 360, fps: 30.0, sample_rate: 48000 },
            media: HashMap::new(),
            tracks: vec![],
            markers: vec![],
            captions: vec![],
            caption_style: Default::default(),
        };
        p.media.extend([media("a", 10.0, true), media("b", 10.0, true)]);
        let mut c2 = clip("c2", "b", 3.0, 1.0, 5.0);
        c2.transition_in = Some(Transition { kind: "wipeleft".into(), duration: 1.0 });
        c2.keyframes.insert("x".into(), vec![Keyframe { t: 0.0, v: -100.0, ease: String::new() }, Keyframe { t: 1.0, v: 100.0, ease: "ease".into() }]);
        c2.effects.push(Effect { kind: "color".into(), params: HashMap::from([("saturation".to_string(), serde_json::json!(1.5))]), enabled: true });
        let title = Clip {
            kind: "title".into(),
            media_id: None,
            title: Some(Title { text: "Hello".into(), font_size: 60.0, color: "#ff0000".into(), weight: "bold".into(), align: "center".into(), background: Some("#00000080".into()), padding: 10.0, shadow: true, line_height: 1.2, font_file: None }),
            ..clip("t1", "a", 1.0, 0.0, 2.0)
        };
        p.tracks = vec![
            Track { id: "v2".into(), kind: "video".into(), name: "V2".into(), clips: vec![title], ..Default::default() },
            Track { id: "v1".into(), kind: "video".into(), name: "V1".into(), clips: vec![clip("c1", "a", 0.0, 0.0, 3.0), c2], ..Default::default() },
        ];
        let dir = std::env::temp_dir().join("rve-test-graph");
        std::fs::create_dir_all(&dir).unwrap();
        let s = ExportSettings { output: "/tmp/out.mp4".into(), width: 0, height: 0, fps: 0.0, video_codec: "libx264".into(), quality: 20, bitrate_kbps: 0, preset: "fast".into(), audio_codec: "aac".into(), audio_bitrate_kbps: 192, range: None };
        let built = build(&p, &s, &dir, &fonts()).unwrap();
        assert!((built.duration - 7.0).abs() < 1e-6);
        assert!(built.graph.contains("xfade=transition=wipeleft:duration=1:offset=3"), "{}", built.graph);
        assert!(built.graph.contains("drawtext=textfile="), "{}", built.graph);
        assert!(built.graph.contains("fontfile='/tmp/Inter-Bold.ttf'"), "{}", built.graph);
        assert!(built.graph.contains("eq=brightness=0:contrast=1:saturation=1.5:gamma=1"), "{}", built.graph);
        assert!(built.graph.contains("amix=inputs=2"), "{}", built.graph);
        assert!(built.graph.contains("adelay=3000:all=1"), "{}", built.graph);
        assert!(built.args.iter().any(|a| a == "libx264"));
        assert_eq!(built.args.last().unwrap(), "/tmp/out.mp4");
        // The clip before the transition is extended by the transition length.
        assert!(built.graph.contains("trim=duration=4"), "{}", built.graph);
    }

    #[test]
    fn single_frame_project_shifts_time() {
        let mut p = Project { version: 1, name: String::new(), settings: Settings::default(), media: HashMap::new(), tracks: vec![], markers: vec![], captions: vec![], caption_style: Default::default() };
        p.media.extend([media("a", 10.0, false)]);
        let mut c = clip("c", "a", 2.0, 1.0, 6.0);
        c.speed = 2.0;
        c.keyframes.insert("x".into(), vec![Keyframe { t: 1.0, v: 5.0, ease: String::new() }]);
        p.tracks = vec![Track { id: "v1".into(), kind: "video".into(), clips: vec![c], ..Default::default() }];
        let f = single_frame_project(&p, 3.0);
        let c = &f.tracks[0].clips[0];
        assert_eq!(c.start, 0.0);
        assert!((c.in_ - 3.0).abs() < 1e-9); // 1.0 + (3-2)*2
        assert!((c.keyframes["x"][0].t - 0.0).abs() < 1e-9);
        assert!(single_frame_project(&p, 0.5).tracks[0].clips.is_empty());
    }
}
