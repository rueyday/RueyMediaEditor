//! Helper analyses that run ffmpeg (and optionally whisper.cpp): freeze
//! frames, silence detection, audio-based clip sync, transcription.

use crate::ffmpeg::{command, run_simple, Tools};
use regex::Regex;
use std::path::{Path, PathBuf};

/// Saves the source frame at `time` (seconds) as a PNG.
pub fn extract_frame(tools: &Tools, path: &Path, time: f64, out: &Path) -> Result<(), String> {
    let mut cmd = command(&tools.ffmpeg);
    cmd.args([
        "-hide_banner",
        "-y",
        "-loglevel",
        "error",
        "-ss",
        &format!("{:.4}", time.max(0.0)),
        "-i",
    ])
    .arg(path)
    .args(["-frames:v", "1", "-update", "1"])
    .arg(out);
    run_simple(cmd).map(|_| ())
}

/// Silent ranges (source seconds) inside `[in, out]` of a file.
pub fn detect_silence(
    tools: &Tools,
    path: &Path,
    in_: f64,
    out: f64,
    threshold_db: f64,
    min_duration: f64,
) -> Result<Vec<(f64, f64)>, String> {
    let len = (out - in_).max(0.0);
    let mut cmd = command(&tools.ffmpeg);
    cmd.args([
        "-hide_banner",
        "-nostats",
        "-ss",
        &format!("{in_:.4}"),
        "-t",
        &format!("{len:.4}"),
        "-i",
    ])
    .arg(path)
    .args([
        "-vn",
        "-af",
        &format!(
            "silencedetect=n={threshold_db}dB:d={}",
            min_duration.max(0.05)
        ),
        "-f",
        "null",
        "-",
    ]);
    let output = cmd
        .output()
        .map_err(|e| format!("Cannot run ffmpeg: {e}"))?;
    let text = String::from_utf8_lossy(&output.stderr);
    let re_start = Regex::new(r"silence_start:\s*(-?[\d.]+)").unwrap();
    let re_end = Regex::new(r"silence_end:\s*(-?[\d.]+)").unwrap();
    let mut ranges = Vec::new();
    let mut open: Option<f64> = None;
    for line in text.lines() {
        if let Some(c) = re_start.captures(line) {
            open = c[1].parse::<f64>().ok();
        } else if let Some(c) = re_end.captures(line) {
            if let (Some(s), Ok(e)) = (open.take(), c[1].parse::<f64>()) {
                ranges.push((in_ + s.max(0.0), in_ + e.min(len)));
            }
        }
    }
    if let Some(s) = open {
        ranges.push((in_ + s.max(0.0), out));
    }
    Ok(ranges
        .into_iter()
        .filter(|(a, b)| b - a >= min_duration * 0.5)
        .collect())
}

const ENV_RATE: usize = 100; // envelope samples per second

fn envelope(tools: &Tools, path: &Path, start: f64, max_secs: f64) -> Result<Vec<f32>, String> {
    const SR: usize = 8000;
    let mut cmd = command(&tools.ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        &format!("{start:.4}"),
        "-t",
        &format!("{max_secs:.3}"),
        "-i",
    ])
    .arg(path)
    .args([
        "-vn",
        "-ac",
        "1",
        "-ar",
        &SR.to_string(),
        "-f",
        "s16le",
        "-",
    ]);
    let bytes = run_simple(cmd)?;
    let window = SR / ENV_RATE;
    let mut env = Vec::with_capacity(bytes.len() / 2 / window + 1);
    let mut acc = 0f64;
    let mut count = 0usize;
    for pair in bytes.chunks_exact(2) {
        let v = i16::from_le_bytes([pair[0], pair[1]]) as f64 / 32768.0;
        acc += v * v;
        count += 1;
        if count == window {
            env.push((acc / window as f64).sqrt() as f32);
            acc = 0.0;
            count = 0;
        }
    }
    // remove the mean so silence does not correlate with silence
    let mean = env.iter().sum::<f32>() / env.len().max(1) as f32;
    for v in &mut env {
        *v -= mean;
    }
    Ok(env)
}

/// Seconds by which B lags A (positive: the same sound happens later in B).
/// Both are analysed from their `in` points for up to `max_secs`.
pub fn sync_offset(
    tools: &Tools,
    a: &Path,
    in_a: f64,
    b: &Path,
    in_b: f64,
    max_lag: f64,
    max_secs: f64,
) -> Result<f64, String> {
    let ea = envelope(tools, a, in_a, max_secs)?;
    let eb = envelope(tools, b, in_b, max_secs)?;
    if ea.len() < ENV_RATE || eb.len() < ENV_RATE {
        return Err("Not enough audio to compare".into());
    }
    let max_lag_n = (max_lag.max(0.1) * ENV_RATE as f64) as i64;
    let mut best = (f64::MIN, 0i64);
    for lag in -max_lag_n..=max_lag_n {
        // compare ea[i] with eb[i + lag]
        let (start, end) = if lag >= 0 {
            (0i64, (ea.len() as i64).min(eb.len() as i64 - lag))
        } else {
            (-lag, (ea.len() as i64).min(eb.len() as i64 - lag))
        };
        if end - start < ENV_RATE as i64 * 2 {
            continue;
        }
        let mut dot = 0f64;
        let mut na = 0f64;
        let mut nb = 0f64;
        for i in start..end {
            let x = ea[i as usize] as f64;
            let y = eb[(i + lag) as usize] as f64;
            dot += x * y;
            na += x * x;
            nb += y * y;
        }
        let corr = dot / (na.sqrt() * nb.sqrt() + 1e-9);
        if corr > best.0 {
            best = (corr, lag);
        }
    }
    if best.0 < 0.1 {
        return Err("No clear match between the two audio tracks".into());
    }
    Ok(best.1 as f64 / ENV_RATE as f64)
}

/// Finds a whisper.cpp command line binary.
pub fn locate_whisper(custom: Option<&Path>) -> Option<PathBuf> {
    if let Some(c) = custom {
        if c.is_file() {
            return Some(c.to_path_buf());
        }
    }
    let names = ["whisper-cli", "whisper-cpp", "whisper"];
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    for d in dirs {
        for n in names {
            let p = d.join(crate::ffmpeg::exe_name(n));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Transcribes `[in, out]` of a media file with whisper.cpp and returns SRT text
/// whose timestamps are relative to `in`.
#[allow(clippy::too_many_arguments)]
pub fn transcribe(
    tools: &Tools,
    whisper: &Path,
    model: &Path,
    path: &Path,
    in_: f64,
    out: f64,
    language: &str,
    work: &Path,
) -> Result<String, String> {
    std::fs::create_dir_all(work).map_err(|e| e.to_string())?;
    let wav = work.join("speech.wav");
    let len = (out - in_).max(0.1);
    let mut cmd = command(&tools.ffmpeg);
    cmd.args([
        "-hide_banner",
        "-y",
        "-loglevel",
        "error",
        "-ss",
        &format!("{in_:.4}"),
        "-t",
        &format!("{len:.4}"),
        "-i",
    ])
    .arg(path)
    .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
    .arg(&wav);
    run_simple(cmd)?;
    let prefix = work.join("speech");
    let mut w = command(whisper);
    w.arg("-m")
        .arg(model)
        .arg("-f")
        .arg(&wav)
        .arg("-osrt")
        .arg("-of")
        .arg(&prefix)
        .arg("-nt");
    if !language.is_empty() && language != "auto" {
        w.arg("-l").arg(language);
    } else {
        w.arg("-l").arg("auto");
    }
    let output = w.output().map_err(|e| format!("Cannot run whisper: {e}"))?;
    let srt = work.join("speech.srt");
    if !srt.exists() {
        return Err(format!(
            "whisper produced no output.\n{}\n{}",
            String::from_utf8_lossy(&output.stdout)
                .chars()
                .take(800)
                .collect::<String>(),
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(800)
                .collect::<String>()
        ));
    }
    let text = std::fs::read_to_string(&srt).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&wav);
    Ok(text)
}

#[cfg(test)]
mod tests {
    #[test]
    fn silence_regex_parses_ffmpeg_lines() {
        let re = regex::Regex::new(r"silence_start:\s*(-?[\d.]+)").unwrap();
        let c = re
            .captures("[silencedetect @ 0x1] silence_start: 1.234")
            .unwrap();
        assert_eq!(&c[1], "1.234");
    }
}
