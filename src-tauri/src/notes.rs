//! Obsidian vault: list / search / read / write markdown notes, open a note in Obsidian.
//! All paths are relative to the vault and must stay inside it.

use crate::{settings, store::err};
use serde::Serialize;
use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri::Url;

async fn vault() -> Result<PathBuf, String> {
    let v = settings::current().await.obsidian_vault;
    let p = PathBuf::from(&v);
    if v.is_empty() || !p.is_dir() {
        return Err("не задан Obsidian vault — укажите папку в настройках".into());
    }
    p.canonicalize().map_err(err)
}

/// Relative, no `..`, stays inside the vault even through symlinks.
fn resolve(vault: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel_path = Path::new(rel);
    if rel.is_empty() || !rel_path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err("недопустимый путь".into());
    }
    let full = vault.join(rel_path);
    // canonicalize the deepest existing ancestor to catch symlinks pointing outside
    let mut probe = full.clone();
    while !probe.exists() {
        probe = probe.parent().ok_or("недопустимый путь")?.to_path_buf();
    }
    if !probe.canonicalize().map_err(err)?.starts_with(vault) {
        return Err("путь вне vault".into());
    }
    Ok(full)
}

fn is_md(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    walk_all(root, dir, out, &mut Vec::new());
}

/// Notes and (non-hidden) folders, relative to `root`; folders are listed so empty ones show in the tree.
fn walk_all(root: &Path, dir: &Path, out: &mut Vec<PathBuf>, dirs: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue; // .obsidian, .trash, .git
        }
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => {
                dirs.push(p.strip_prefix(root).unwrap_or(&p).to_path_buf());
                walk_all(root, &p, out, dirs)
            }
            Ok(t) if t.is_file() && is_md(&p) => out.push(p.strip_prefix(root).unwrap_or(&p).to_path_buf()),
            _ => {}
        }
    }
}

#[derive(Serialize)]
pub struct NoteInfo {
    path: String,
    mtime: u64,
}

#[derive(Serialize)]
pub struct VaultInfo {
    root: String,
    name: String,
    notes: Vec<NoteInfo>,
    folders: Vec<String>,
}

#[tauri::command]
pub async fn notes_list() -> Result<VaultInfo, String> {
    let root = vault().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let (mut files, mut dirs) = (Vec::new(), Vec::new());
        walk_all(&root, &root, &mut files, &mut dirs);
        let notes = files
            .into_iter()
            .map(|rel| {
                let mtime = fs::metadata(root.join(&rel))
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs());
                NoteInfo { path: rel.to_string_lossy().into_owned(), mtime }
            })
            .collect();
        VaultInfo {
            name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            root: root.to_string_lossy().into_owned(),
            notes,
            folders: dirs.into_iter().map(|d| d.to_string_lossy().into_owned()).collect(),
        }
    })
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn note_read(path: String) -> Result<String, String> {
    let full = resolve(&vault().await?, &path)?;
    fs::read_to_string(full).map_err(err)
}

#[tauri::command]
pub async fn note_write(path: String, content: String) -> Result<(), String> {
    let full = resolve(&vault().await?, &path)?;
    if !is_md(&full) {
        return Err("можно сохранять только .md".into());
    }
    if let Some(dir) = full.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::write(full, content).map_err(err)
}

/// Move/rename a note or a whole folder inside the vault. Never overwrites.
#[tauri::command]
pub async fn note_move(from: String, to: String) -> Result<(), String> {
    let root = vault().await?;
    let src = resolve(&root, &from)?;
    let dst = resolve(&root, &to)?;
    if !src.exists() {
        return Err(format!("«{from}» не найден"));
    }
    if dst.exists() {
        return Err(format!("«{to}» уже существует"));
    }
    if src.is_dir() {
        if dst.starts_with(&src) {
            return Err("нельзя переместить папку внутрь неё самой".into());
        }
    } else if !is_md(&src) || !is_md(&dst) {
        return Err("перемещать можно только .md и папки".into());
    }
    if let Some(dir) = dst.parent() {
        fs::create_dir_all(dir).map_err(err)?;
    }
    fs::rename(&src, &dst).map_err(err)
}

#[derive(Serialize)]
pub struct Hit {
    path: String,
    line: usize,
    text: String,
}

#[tauri::command]
pub async fn note_search(query: String) -> Result<Vec<Hit>, String> {
    let root = vault().await?;
    let q = query.trim().to_lowercase();
    if q.len() < 2 {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        walk(&root, &root, &mut files);
        let mut hits = Vec::new();
        'files: for rel in files {
            let path = rel.to_string_lossy().into_owned();
            if path.to_lowercase().contains(&q) {
                hits.push(Hit { path: path.clone(), line: 0, text: String::new() });
            }
            let Ok(text) = fs::read_to_string(root.join(&rel)) else { continue };
            for (i, l) in text.lines().enumerate() {
                if l.to_lowercase().contains(&q) {
                    hits.push(Hit { path: path.clone(), line: i + 1, text: l.trim().chars().take(200).collect() });
                    if hits.len() >= 300 {
                        break 'files;
                    }
                }
            }
        }
        hits
    })
    .await
    .map_err(err)
}

/// Opens the note in the Obsidian app via its URI scheme.
#[tauri::command]
pub async fn note_open_obsidian(path: String) -> Result<(), String> {
    let root = vault().await?;
    resolve(&root, &path)?;
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let file = path.strip_suffix(".md").unwrap_or(&path);
    let url = Url::parse_with_params("obsidian://open", &[("vault", name.as_str()), ("file", file)]).map_err(err)?;
    crate::store::open_with_system(url.as_str())
}

/// Today's daily note (Obsidian "Daily notes" plugin settings: folder + YYYY/MM/DD format).
/// Creates the file if it does not exist; returns its vault-relative path.
#[tauri::command]
pub async fn note_daily() -> Result<String, String> {
    let root = vault().await?;
    let cfg: serde_json::Value = fs::read_to_string(root.join(".obsidian/daily-notes.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let folder = cfg["folder"].as_str().unwrap_or("").trim_matches('/');
    let format = cfg["format"].as_str().filter(|f| !f.is_empty()).unwrap_or("YYYY-MM-DD");
    let now = chrono::Local::now();
    let name = format
        .replace("YYYY", &now.format("%Y").to_string())
        .replace("MM", &now.format("%m").to_string())
        .replace("DD", &now.format("%d").to_string());
    let rel = if folder.is_empty() { format!("{name}.md") } else { format!("{folder}/{name}.md") };
    let full = resolve(&root, &rel)?;
    if !full.exists() {
        if let Some(dir) = full.parent() {
            fs::create_dir_all(dir).map_err(err)?;
        }
        fs::write(&full, format!("# {name}\n\n")).map_err(err)?;
    }
    Ok(rel)
}
