//! App settings (paths to KeePass db, Obsidian vault, WinBox) + discovery of likely candidates.

use crate::store;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    pub keepass_path: String,
    pub keepass_keyfile: String,
    pub keepass_lock_minutes: u64,
    /// once unlocked, stay unlocked until OpsDeck exits (auto-lock minutes are ignored)
    pub keepass_keep_open: bool,
    pub obsidian_vault: String,
    pub winbox_path: String,
    /// Also list contexts from ~/.kube/config and $KUBECONFIG (off: OpsDeck uses only its own store).
    pub k8s_include_system: bool,
    /// check GitHub Releases for a newer version at startup
    pub update_auto_check: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            keepass_path: String::new(),
            keepass_keyfile: String::new(),
            keepass_lock_minutes: 15,
            keepass_keep_open: true,
            obsidian_vault: String::new(),
            winbox_path: String::new(),
            k8s_include_system: false,
            update_auto_check: true,
        }
    }
}

pub fn load() -> Settings {
    store::load_json(FILE).unwrap_or_default()
}

#[tauri::command]
pub async fn settings_get() -> Settings {
    tauri::async_runtime::spawn_blocking(filled).await.unwrap_or_default()
}

fn filled() -> Settings {
    let mut s = load();
    // first run: pre-fill from what's on disk so things work without visiting settings
    if s.keepass_path.is_empty() || s.obsidian_vault.is_empty() || s.winbox_path.is_empty() {
        let d = detect();
        if s.keepass_path.is_empty() {
            s.keepass_path = d.keepass.first().cloned().unwrap_or_default();
        }
        if s.obsidian_vault.is_empty() {
            s.obsidian_vault = d.obsidian.first().cloned().unwrap_or_default();
        }
        if s.winbox_path.is_empty() {
            s.winbox_path = d.winbox.first().cloned().unwrap_or_default();
        }
        // persist what was found so later `load()` calls don't need to rescan
        let _ = store::save_json(FILE, &s);
    }
    s
}

/// Settings with auto-detected defaults filled in (may scan $HOME on first use).
pub async fn current() -> Settings {
    settings_get().await
}

#[tauri::command]
pub fn settings_set(settings: Settings) -> Result<(), String> {
    store::save_json(FILE, &settings)
}

#[derive(Serialize, Default)]
pub struct Detected {
    keepass: Vec<String>,
    obsidian: Vec<String>,
    winbox: Vec<String>,
}

/// Shallow scan of $HOME (depth 4, skipping hidden dirs and heavy trees).
fn scan(dir: &Path, depth: u32, out: &mut Detected) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            if name == ".obsidian" {
                out.obsidian.push(dir.to_string_lossy().into_owned());
                continue;
            }
            if depth > 0 && !name.starts_with('.') && !matches!(name.as_str(), "node_modules" | "target" | "snap" | "venv" | ".venv") {
                scan(&p, depth - 1, out);
            }
        } else if name.ends_with(".kdbx") {
            out.keepass.push(p.to_string_lossy().into_owned());
        } else if is_winbox_name(&name) && crate::store::is_executable(&p) {
            out.winbox.push(p.to_string_lossy().into_owned());
        }
    }
}


pub fn detect() -> Detected {
    let mut out = Detected::default();
    for bin in ["WinBox", "winbox", "WinBox.exe", "winbox64.exe", "winbox.exe"] {
        if let Some(p) = std::env::var_os("PATH")
            .into_iter()
            .flat_map(|p| std::env::split_paths(&p).collect::<Vec<PathBuf>>())
            .map(|d| d.join(bin))
            .find(|p| crate::store::is_executable(p))
        {
            out.winbox.push(p.to_string_lossy().into_owned());
        }
    }
    if let Some(home) = dirs::home_dir() {
        scan(&home, 4, &mut out);
    }
    for v in [&mut out.keepass, &mut out.obsidian, &mut out.winbox] {
        v.sort();
        v.dedup();
    }
    out
}

#[tauri::command]
pub async fn settings_detect() -> Detected {
    tauri::async_runtime::spawn_blocking(detect).await.unwrap_or_default()
}

/// "WinBox" on Linux/macOS, "winbox64.exe" / "WinBox.exe" on Windows.
fn is_winbox_name(name: &str) -> bool {
    let n = name.to_lowercase();
    let stem = n.strip_suffix(".exe").unwrap_or(&n);
    stem == "winbox" || stem == "winbox64"
}
