//! PTY sessions: the terminal tabs and the AI side panel (claude, codex, ...) both run here.

use base64::{engine::general_purpose::STANDARD, Engine};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, Session>>,
}

#[derive(Deserialize)]
pub struct SpawnRequest {
    id: String,
    program: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    cols: u16,
    rows: u16,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
pub fn pty_spawn(app: AppHandle, state: State<PtyState>, req: SpawnRequest) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: req.rows, cols: req.cols, pixel_width: 0, pixel_height: 0 })
        .map_err(err)?;

    let plain_shell = req.program.is_none();
    let program = req
        .program
        .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()));
    let mut cmd = CommandBuilder::new(&program);
    if plain_shell {
        // best effort: without integration the tab still works, just without command blocks
        let _ = shell_integration(&program, &mut cmd);
    }
    cmd.args(req.args.unwrap_or_default());
    let cwd = req.cwd.map(Into::into).or_else(dirs::home_dir);
    if let Some(cwd) = cwd {
        cmd.cwd(cwd);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "OpsDeck");
    if let Some(port) = crate::ide::port() {
        // lets `claude` started in this terminal find OpsDeck's IDE bridge
        cmd.env("CLAUDE_CODE_SSE_PORT", port.to_string());
        cmd.env("ENABLE_IDE_INTEGRATION", "true");
    }
    for (k, v) in req.env.unwrap_or_default() {
        cmd.env(k, v);
    }

    let child = pair.slave.spawn_command(cmd).map_err(err)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(err)?;
    let writer = pair.master.take_writer().map_err(err)?;

    let id = req.id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                // base64 keeps multi-byte UTF-8 sequences split across reads intact
                Ok(n) => {
                    let _ = app.emit(&format!("pty-data-{id}"), STANDARD.encode(&buf[..n]));
                }
            }
        }
        let _ = app.emit(&format!("pty-exit-{id}"), ());
    });

    state
        .sessions
        .lock()
        .unwrap()
        .insert(req.id, Session { master: pair.master, writer, child });
    Ok(())
}

const BASH_SI: &str = include_str!("../shell/bash-integration.sh");
const ZSH_ENV: &str = include_str!("../shell/zshenv");
const ZSH_RC: &str = include_str!("../shell/zshrc");

/// Hooks OSC 133/7 marks into bash (--rcfile) or zsh (ZDOTDIR) so the UI can build command blocks.
fn shell_integration(program: &str, cmd: &mut CommandBuilder) -> Result<(), String> {
    let dir = crate::store::config_dir()?.join("shell");
    std::fs::create_dir_all(&dir).map_err(err)?;
    match std::path::Path::new(program).file_name().and_then(|n| n.to_str()) {
        Some("bash") => {
            let rc = dir.join("bash-integration.sh");
            std::fs::write(&rc, BASH_SI).map_err(err)?;
            cmd.args(["--rcfile".as_ref(), rc.as_os_str(), "-i".as_ref()]);
        }
        Some("zsh") => {
            let zdir = dir.join("zsh");
            std::fs::create_dir_all(&zdir).map_err(err)?;
            std::fs::write(zdir.join(".zshenv"), ZSH_ENV).map_err(err)?;
            std::fs::write(zdir.join(".zshrc"), ZSH_RC).map_err(err)?;
            if let Ok(orig) = std::env::var("ZDOTDIR") {
                cmd.env("OPSDECK_ORIG_ZDOTDIR", orig);
            }
            cmd.env("OPSDECK_SI_DIR", &zdir);
            cmd.env("ZDOTDIR", &zdir);
        }
        _ => return Ok(()),
    }
    cmd.env("OPSDECK_SHELL_INTEGRATION", "1");
    Ok(())
}

#[tauri::command]
pub fn pty_write(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("no such pty")?;
    s.writer.write_all(data.as_bytes()).map_err(err)
}

#[tauri::command]
pub fn pty_resize(state: State<PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("no such pty")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(err)
}

#[tauri::command]
pub fn pty_kill(state: State<PtyState>, id: String) -> Result<(), String> {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}
