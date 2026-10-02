//! Local AI under the hood: llama.cpp's `llama-server` + Qwen2.5-Coder 1.5B, downloaded on demand
//! from Settings (nothing is bundled into the installer) into the app's data folder, started in
//! the background on first use and stopped after a while without requests.
//! Used to turn a request in plain words into a shell command, with the user's notes as context.

use crate::store::err;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

/// Pinned llama.cpp build: a known-good one instead of whatever nightly is newest.
const ENGINE_TAG: &str = "b11351";
const MODEL_FILE: &str = "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf";
const MODEL_URL: &str = "https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf";
const MODEL_SHA256: &str = "cc324af070c2ecbfd324a30884d2f951a7ff756aba85cb811a6ec436933bb046";
const MODEL_SIZE: u64 = 1_117_320_768;
/// Stop the server after this long without requests (frees ~1.5 GB of RAM).
const IDLE_STOP: Duration = Duration::from_secs(15 * 60);

fn ai_dir() -> Result<PathBuf, String> {
    let d = dirs::data_local_dir().ok_or("no data dir")?.join("opsdeck").join("ai");
    fs::create_dir_all(&d).map_err(err)?;
    Ok(d)
}

/// The engine archive for this OS/CPU (CPU builds; macOS builds include Metal).
fn engine_asset() -> Result<&'static str, String> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "bin-ubuntu-x64.tar.gz",
        ("linux", "aarch64") => "bin-ubuntu-arm64.tar.gz",
        ("macos", "aarch64") => "bin-macos-arm64.tar.gz",
        ("macos", "x86_64") => "bin-macos-x64.tar.gz",
        ("windows", "x86_64") => "bin-win-cpu-x64.zip",
        ("windows", "aarch64") => "bin-win-cpu-arm64.zip",
        (os, arch) => return Err(format!("локальный ИИ пока не поддерживается на {os}/{arch}")),
    })
}

fn server_name() -> &'static str {
    if cfg!(windows) { "llama-server.exe" } else { "llama-server" }
}

/// llama-server somewhere inside the unpacked engine folder.
fn find_server(dir: &Path) -> Option<PathBuf> {
    let rd = fs::read_dir(dir).ok()?;
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_server(&p) {
                return Some(f);
            }
        } else if p.file_name().is_some_and(|n| n == server_name()) {
            return Some(p);
        }
    }
    None
}

fn engine_dir() -> Result<PathBuf, String> {
    Ok(ai_dir()?.join(format!("llama-{ENGINE_TAG}")))
}
fn model_path() -> Result<PathBuf, String> {
    Ok(ai_dir()?.join(MODEL_FILE))
}

struct Server {
    child: Child,
    port: u16,
    last_used: Instant,
}

#[derive(Default)]
pub struct AiState {
    server: Mutex<Option<Server>>,
    /// a download in progress (cancel flag)
    installing: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
}

impl Drop for AiState {
    fn drop(&mut self) {
        if let Some(mut s) = self.server.lock().unwrap().take() {
            let _ = s.child.kill();
        }
    }
}

#[derive(Serialize)]
pub struct AiStatus {
    engine: bool,
    model: bool,
    running: bool,
    installing: bool,
    /// bytes on disk
    size: u64,
    download_size: u64,
    dir: String,
    supported: bool,
}

fn dir_size(p: &Path) -> u64 {
    match fs::metadata(p) {
        Ok(m) if m.is_dir() => fs::read_dir(p).map(|rd| rd.flatten().map(|e| dir_size(&e.path())).sum()).unwrap_or(0),
        Ok(m) => m.len(),
        Err(_) => 0,
    }
}

#[tauri::command]
pub fn ai_status(state: tauri::State<AiState>) -> Result<AiStatus, String> {
    let dir = ai_dir()?;
    let engine = engine_dir().ok().and_then(|d| find_server(&d)).is_some();
    let model = model_path()?.metadata().map(|m| m.len() == MODEL_SIZE).unwrap_or(false);
    Ok(AiStatus {
        engine,
        model,
        running: state.server.lock().unwrap().is_some(),
        installing: state.installing.lock().unwrap().is_some(),
        size: dir_size(&dir),
        download_size: MODEL_SIZE + 40 * 1024 * 1024,
        dir: dir.to_string_lossy().into_owned(),
        supported: engine_asset().is_ok(),
    })
}

fn progress(app: &AppHandle, stage: &str, done: u64, total: u64) {
    let _ = app.emit("ai-progress", serde_json::json!({ "stage": stage, "done": done, "total": total }));
}

/// Stream `url` to `dest` (via a .part file), checking sha256 when given. Cancellable.
async fn download(app: &AppHandle, url: &str, dest: &Path, sha256: Option<&str>, stage: &str, cancel: &std::sync::atomic::AtomicBool) -> Result<(), String> {
    let client = reqwest::Client::builder().user_agent(concat!("OpsDeck/", env!("CARGO_PKG_VERSION"))).connect_timeout(Duration::from_secs(20)).build().map_err(err)?;
    let mut resp = client.get(url).send().await.map_err(|e| format!("загрузка {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("загрузка {url}: {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let part = dest.with_extension("part");
    let mut f = fs::File::create(&part).map_err(err)?;
    let mut hasher = Sha256::new();
    let mut done = 0u64;
    let mut last = Instant::now();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("загрузка прервалась: {e}"))? {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            drop(f);
            let _ = fs::remove_file(&part);
            return Err("установка отменена".into());
        }
        f.write_all(&chunk).map_err(err)?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        if last.elapsed() > Duration::from_millis(250) {
            progress(app, stage, done, total);
            last = Instant::now();
        }
    }
    f.flush().map_err(err)?;
    drop(f);
    progress(app, stage, done, total);
    if let Some(expected) = sha256 {
        let got = format!("{:x}", hasher.finalize());
        if !got.eq_ignore_ascii_case(expected) {
            let _ = fs::remove_file(&part);
            return Err(format!("контрольная сумма не совпала ({stage}) — файл повреждён или подменён, установка остановлена"));
        }
    }
    fs::rename(&part, dest).map_err(err)
}

fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let _ = fs::remove_dir_all(into);
    fs::create_dir_all(into).map_err(err)?;
    let name = archive.to_string_lossy();
    if name.ends_with(".zip") {
        let mut z = zip::ZipArchive::new(fs::File::open(archive).map_err(err)?).map_err(err)?;
        z.extract(into).map_err(err)?;
    } else {
        let gz = flate2::read::GzDecoder::new(fs::File::open(archive).map_err(err)?);
        let mut t = tar::Archive::new(gz);
        t.set_preserve_permissions(true);
        t.unpack(into).map_err(err)?;
    }
    #[cfg(unix)]
    if let Some(bin) = find_server(into) {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&bin, fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

/// Downloads the engine and the model in the background; progress: `ai-progress`, end: `ai-installed`.
#[tauri::command]
pub fn ai_install(app: AppHandle, state: tauri::State<AiState>) -> Result<(), String> {
    let asset_suffix = engine_asset()?;
    let cancel = {
        let mut g = state.installing.lock().unwrap();
        if g.is_some() {
            return Err("установка уже идёт".into());
        }
        let c = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        *g = Some(c.clone());
        c
    };
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let res: Result<(), String> = async {
            let dir = ai_dir()?;
            // 1. engine (small) — its sha256 comes from the GitHub release metadata
            if engine_dir().ok().and_then(|d| find_server(&d)).is_none() {
                let name = format!("llama-{ENGINE_TAG}-{asset_suffix}");
                let meta: serde_json::Value = reqwest::Client::builder()
                    .user_agent("OpsDeck")
                    .build()
                    .map_err(err)?
                    .get(format!("https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{ENGINE_TAG}"))
                    .send()
                    .await
                    .map_err(err)?
                    .json()
                    .await
                    .map_err(err)?;
                let asset = meta["assets"].as_array().into_iter().flatten().find(|a| a["name"] == name).ok_or(format!("в релизе llama.cpp {ENGINE_TAG} нет {name}"))?;
                let url = asset["browser_download_url"].as_str().ok_or("нет ссылки на движок")?;
                let digest = asset["digest"].as_str().and_then(|d| d.strip_prefix("sha256:")).map(str::to_string);
                let archive = dir.join(&name);
                download(&app2, url, &archive, digest.as_deref(), "engine", &cancel).await?;
                let into = engine_dir()?;
                let a = archive.clone();
                tauri::async_runtime::spawn_blocking(move || unpack(&a, &into)).await.map_err(err)??;
                let _ = fs::remove_file(&archive);
                if engine_dir().ok().and_then(|d| find_server(&d)).is_none() {
                    return Err("в архиве движка не найден llama-server".into());
                }
            }
            // 2. model (~1 GB), pinned sha256
            let model = model_path()?;
            if model.metadata().map(|m| m.len() != MODEL_SIZE).unwrap_or(true) {
                download(&app2, MODEL_URL, &model, Some(MODEL_SHA256), "model", &cancel).await?;
            }
            Ok(())
        }
        .await;
        app2.state::<AiState>().installing.lock().unwrap().take();
        match res {
            Ok(()) => {
                log::info!("ai: engine {ENGINE_TAG} and model installed");
                let _ = app2.emit("ai-installed", serde_json::json!({ "ok": true }));
            }
            Err(e) => {
                log::warn!("ai install: {e}");
                let _ = app2.emit("ai-installed", serde_json::json!({ "ok": false, "error": e }));
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn ai_cancel(state: tauri::State<AiState>) {
    if let Some(c) = state.installing.lock().unwrap().as_ref() {
        c.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Remove the engine and the model (≈1.1 GB).
#[tauri::command]
pub fn ai_remove(state: tauri::State<AiState>) -> Result<(), String> {
    if let Some(mut s) = state.server.lock().unwrap().take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
    let dir = ai_dir()?;
    fs::remove_dir_all(&dir).map_err(err)
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(err)?;
    Ok(l.local_addr().map_err(err)?.port())
}

/// The running server's port; starts it (and waits until the model is loaded) if needed.
async fn ensure_server(app: &AppHandle) -> Result<u16, String> {
    let state = app.state::<AiState>();
    {
        let mut g = state.server.lock().unwrap();
        if let Some(s) = g.as_mut() {
            if s.child.try_wait().ok().flatten().is_none() {
                s.last_used = Instant::now();
                return Ok(s.port);
            }
            *g = None; // it died: start again
        }
    }
    let bin = engine_dir().ok().and_then(|d| find_server(&d)).ok_or("локальный ИИ не установлен — ⚙ Настройки → Локальный ИИ")?;
    let model = model_path()?;
    if !model.exists() {
        return Err("модель не скачана — ⚙ Настройки → Локальный ИИ".into());
    }
    let port = free_port()?;
    let threads = std::thread::available_parallelism().map(|n| n.get().clamp(2, 8)).unwrap_or(4);
    let mut cmd = Command::new(&bin);
    cmd.arg("-m")
        .arg(&model)
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "-c", "4096", "-t", &threads.to_string()])
        .args(["-ngl", if cfg!(target_os = "macos") { "99" } else { "0" }])
        .current_dir(bin.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| format!("не удалось запустить llama-server: {e}"))?;
    *state.server.lock().unwrap() = Some(Server { child, port, last_used: Instant::now() });
    // wait for the model to load
    let client = reqwest::Client::new();
    let started = Instant::now();
    loop {
        if let Ok(r) = client.get(format!("http://127.0.0.1:{port}/health")).send().await {
            if r.status().is_success() {
                break;
            }
        }
        let dead = state.server.lock().unwrap().as_mut().is_none_or(|s| s.child.try_wait().ok().flatten().is_some());
        if dead {
            state.server.lock().unwrap().take();
            return Err("llama-server завершился при запуске (не хватает памяти или библиотек?) — подробности: запустите его из терминала".into());
        }
        if started.elapsed() > Duration::from_secs(90) {
            if let Some(mut s) = state.server.lock().unwrap().take() {
                let _ = s.child.kill();
            }
            return Err("модель не загрузилась за 90 с".into());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    log::info!("ai: llama-server on 127.0.0.1:{port}");
    Ok(port)
}

/// On app exit: Tauri does not drop managed state, so stop llama-server explicitly
/// (otherwise it would keep running and holding ~1.5 GB after OpsDeck is closed).
pub fn shutdown(app: &AppHandle) {
    if let Some(mut s) = app.state::<AiState>().server.lock().unwrap().take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
}

/// Background: stop the server after IDLE_STOP without requests.
pub fn spawn_idle_stop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let state = app.state::<AiState>();
            let mut g = state.server.lock().unwrap();
            if g.as_ref().is_some_and(|s| s.last_used.elapsed() > IDLE_STOP) {
                if let Some(mut s) = g.take() {
                    let _ = s.child.kill();
                    let _ = s.child.wait();
                    log::info!("ai: llama-server stopped after idle");
                }
            }
        }
    });
}

#[derive(Serialize)]
pub struct AiAnswer {
    command: String,
    /// commands from notes that were given to the model as context
    from_notes: Vec<String>,
    elapsed_ms: u64,
}

/// Plain-words request → one shell command. `context` = cwd, recent commands, shell.
#[tauri::command]
pub async fn ai_command(app: AppHandle, request: String, cwd: Option<String>, recent: Vec<String>, shell: Option<String>) -> Result<AiAnswer, String> {
    let started = Instant::now();
    let notes = crate::cmdindex::related(&request, 8).await;
    let port = ensure_server(&app).await?;
    let mut context = String::new();
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        context += &format!("Текущая папка: {c}\n");
    }
    context += &format!("Shell: {}, ОС: {}\n", shell.unwrap_or_else(|| "bash".into()), std::env::consts::OS);
    if !recent.is_empty() {
        context += "Недавние команды пользователя:\n";
        for r in recent.iter().rev().take(10).rev() {
            context += &format!("  {r}\n");
        }
    }
    if !notes.is_empty() {
        context += "Команды из заметок пользователя (используй их стиль, имена хостов, неймспейсов и ресурсов):\n";
        for n in &notes {
            context += &format!("  {n}\n");
        }
    }
    let body = serde_json::json!({
        "messages": [
            { "role": "system", "content": "Ты помощник DevOps-инженера в терминале. На запрос отвечай ровно одной командой shell (можно с | и &&), без пояснений, без markdown и без $ в начале. Если в контексте есть похожие команды пользователя — бери оттуда имена хостов, неймспейсов, контекстов и флаги. Не придумывай опасных команд (rm -rf /, удаление без запроса)." },
            { "role": "user", "content": format!("{context}\nЗапрос: {request}") }
        ],
        "temperature": 0.1,
        "max_tokens": 160,
        "stream": false
    });
    let resp: serde_json::Value = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .timeout(Duration::from_secs(120))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("локальный ИИ не ответил: {e}"))?
        .json()
        .await
        .map_err(err)?;
    if let Some(s) = app.state::<AiState>().server.lock().unwrap().as_mut() {
        s.last_used = Instant::now();
    }
    let raw = resp["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
    Ok(AiAnswer { command: clean_command(&raw), from_notes: notes, elapsed_ms: started.elapsed().as_millis() as u64 })
}

/// Models like to wrap the answer in ``` or prefix it with "$ ".
fn clean_command(raw: &str) -> String {
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix("```") {
        s = rest.split_once('\n').map(|(_, b)| b).unwrap_or(rest);
        s = s.trim_end().trim_end_matches("```");
    }
    s.lines()
        .map(|l| l.trim().trim_start_matches("$ ").trim_matches('`'))
        .filter(|l| !l.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    #[test]
    fn clean() {
        assert_eq!(super::clean_command("```bash\n$ kubectl get pods -n prod\n```"), "kubectl get pods -n prod");
        assert_eq!(super::clean_command("`ls -la`"), "ls -la");
    }
}
