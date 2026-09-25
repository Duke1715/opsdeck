//! Network/DNS utilities. Runs the system binaries (no shell) and streams output line by line.

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, process::Stdio, sync::Mutex};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::Command,
    sync::oneshot,
};

#[derive(Default)]
pub struct ToolState {
    running: Mutex<HashMap<String, oneshot::Sender<()>>>,
}

#[derive(Deserialize)]
pub struct ToolRequest {
    tool: String,
    target: String,
    count: Option<u32>,
    server: Option<String>,
    record: Option<String>,
    port: Option<u16>,
}

#[derive(Serialize, Clone)]
struct Line {
    stream: &'static str,
    text: String,
}

/// Hostnames, IPv4/IPv6 literals. Rejects anything that could be parsed as a flag.
pub fn valid_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_'))
}

const RECORDS: &[&str] = &["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "SRV", "PTR", "CAA", "ANY"];

fn build(req: &ToolRequest) -> Result<(&'static str, Vec<String>), String> {
    if !valid_host(&req.target) {
        return Err("invalid target".into());
    }
    let server = match req.server.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if valid_host(s) => Some(s.to_string()),
        Some(_) => return Err("invalid DNS server".into()),
        None => None,
    };
    let record = req.record.as_deref().unwrap_or("A").to_uppercase();
    if !RECORDS.contains(&record.as_str()) {
        return Err("invalid record type".into());
    }
    let count = req.count.unwrap_or(4).clamp(1, 1000).to_string();
    let t = req.target.clone();

    Ok(match req.tool.as_str() {
        "ping" => ("ping", vec!["-c".into(), count, t]),
        "traceroute" => ("traceroute", vec!["-w".into(), "2".into(), t]),
        "mtr" => ("mtr", vec!["-r".into(), "-w".into(), "-b".into(), "-c".into(), count, t]),
        "dig" => {
            let mut a = Vec::new();
            if let Some(s) = server {
                a.push(format!("@{s}"));
            }
            a.extend([t, record]);
            ("dig", a)
        }
        "nslookup" => {
            let mut a = vec![format!("-type={record}"), t];
            a.extend(server);
            ("nslookup", a)
        }
        "port" => {
            let port = req.port.ok_or("port required")?;
            ("nc", vec!["-zv".into(), "-w".into(), "3".into(), t, port.to_string()])
        }
        _ => return Err("unknown tool".into()),
    })
}

fn pump<R: AsyncRead + Unpin + Send + 'static>(app: AppHandle, event: String, stream: &'static str, r: R) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(r).lines();
        while let Ok(Some(text)) = lines.next_line().await {
            let _ = app.emit(&event, Line { stream, text });
        }
    });
}

#[tauri::command]
pub async fn tool_run(
    app: AppHandle,
    state: State<'_, ToolState>,
    run_id: String,
    req: ToolRequest,
) -> Result<String, String> {
    let (program, args) = build(&req)?;
    let cmdline = format!("{program} {}", args.join(" "));

    let mut child = Command::new(program)
        .args(&args)
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("{program}: {e}"))?;

    let line_event = format!("tool-line-{run_id}");
    pump(app.clone(), line_event.clone(), "out", child.stdout.take().unwrap());
    pump(app.clone(), line_event, "err", child.stderr.take().unwrap());

    let (tx, rx) = oneshot::channel();
    state.running.lock().unwrap().insert(run_id.clone(), tx);

    tauri::async_runtime::spawn(async move {
        let code = tokio::select! {
            status = child.wait() => status.ok().and_then(|s| s.code()),
            _ = rx => { let _ = child.kill().await; None }
        };
        let _ = app.emit(&format!("tool-exit-{run_id}"), code);
    });
    Ok(cmdline)
}

#[tauri::command]
pub fn tool_stop(state: State<ToolState>, run_id: String) {
    if let Some(tx) = state.running.lock().unwrap().remove(&run_id) {
        let _ = tx.send(());
    }
}
