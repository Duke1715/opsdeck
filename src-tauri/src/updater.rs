//! In-app updates from GitHub Releases (tauri-plugin-updater). Releases are signed in CI with
//! the project's private key; the app only installs packages whose signature matches the public
//! key in tauri.conf.json.

use crate::store::err;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct UpdateInfo {
    current: String,
    available: bool,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let update = app.updater().map_err(err)?.check().await.map_err(|e| {
        let e = e.to_string();
        // no published release yet (or no latest.json in it) — not an error for the user
        if e.contains("404") || e.contains("valid release JSON") {
            "релизов с обновлениями пока нет".to_string()
        } else {
            format!("не удалось проверить обновления: {e}")
        }
    })?;
    Ok(match update {
        Some(u) => UpdateInfo {
            current,
            available: true,
            version: Some(u.version.clone()),
            notes: u.body.clone(),
            date: u.date.map(|d| d.to_string()),
        },
        None => UpdateInfo { current, available: false, version: None, notes: None, date: None },
    })
}

/// Downloads, verifies the signature, installs and restarts. Progress: `update-progress` events.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = app.updater().map_err(err)?.check().await.map_err(err)?.ok_or("обновлений нет")?;
    let mut done: u64 = 0;
    let progress = app.clone();
    let finished = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = progress.emit("update-progress", json!({ "downloaded": done, "total": total }));
            },
            move || {
                let _ = finished.emit("update-progress", json!({ "installing": true }));
            },
        )
        .await
        .map_err(|e| format!("не удалось установить обновление: {e}"))?;
    app.restart();
}
