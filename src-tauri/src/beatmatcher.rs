use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const POLL_INTERVAL: Duration = Duration::from_millis(50);
const STALE_THRESHOLD_MS: i64 = 500;

#[derive(Clone, Deserialize, Serialize)]
pub struct Deck {
    id: String,
    #[serde(rename = "isPlaying")]
    is_playing: bool,
    bpm: Option<f64>,
    #[serde(rename = "beatOffsetSec")]
    beat_offset_sec: f64,
    #[serde(rename = "positionSec")]
    position_sec: f64,
    #[serde(rename = "playbackRate")]
    playback_rate: f64,
    #[serde(rename = "nudgeFactor")]
    nudge_factor: f64,
    #[serde(rename = "effectiveBpm")]
    effective_bpm: Option<f64>,
    #[serde(rename = "currentBeat")]
    current_beat: Option<f64>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct BeatmatcherState {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    #[serde(rename = "epochMs")]
    epoch_ms: i64,
    #[serde(rename = "sampleRate")]
    sample_rate: u32,
    decks: Vec<Deck>,
}

#[cfg(target_os = "macos")]
fn data_root() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Application Support"))
}

#[cfg(target_os = "linux")]
fn data_root() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
}

#[cfg(target_os = "windows")]
fn data_root() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

fn state_path() -> Option<PathBuf> {
    Some(data_root()?.join("com.berrutti.beatmatcher").join("state.json"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_state(path: &PathBuf) -> Option<BeatmatcherState> {
    let bytes = std::fs::read(path).ok()?;
    let state: BeatmatcherState = serde_json::from_slice(&bytes).ok()?;
    if now_ms() - state.epoch_ms > STALE_THRESHOLD_MS {
        return None;
    }
    Some(state)
}

// Polls Beatmatcher's state.json (rewritten atomically every 50ms) rather than
// connecting to its Unix socket, since the file works identically on every
// platform including Windows, where the socket does not exist.
pub fn start(app: AppHandle) {
    let Some(path) = state_path() else { return };

    thread::spawn(move || {
        let mut connected = false;

        loop {
            match read_state(&path) {
                Some(state) => {
                    connected = true;
                    let _ = app.emit("beatmatcher:state", state);
                }
                None if connected => {
                    connected = false;
                    let _ = app.emit("beatmatcher:disconnected", ());
                }
                None => {}
            }

            thread::sleep(POLL_INTERVAL);
        }
    });
}
