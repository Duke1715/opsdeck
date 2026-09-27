//! SSH host profiles: OpsDeck's own list (~/.config/opsdeck/ssh.json, secrets in keyring/KeePass)
//! plus read-only hosts from ~/.ssh/config. Connecting opens `ssh` in a terminal tab; a known
//! password goes to the clipboard for 30 s (ssh itself only reads passwords from the tty).

use crate::{
    keepass::{self, KeepassState},
    store,
    tools::valid_host,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, State};

const FILE: &str = "ssh.json";

#[derive(Serialize, Deserialize, Clone)]
pub struct SshHost {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub identity_file: String,
    #[serde(default)]
    pub jump: String,
    /// key | keepass | password | none
    #[serde(default = "default_auth")]
    pub auth: String,
    #[serde(default)]
    pub keepass_entry: String,
}

fn default_port() -> u16 {
    22
}
fn default_auth() -> String {
    "key".into()
}

#[derive(Serialize, Default)]
pub struct ConfigHost {
    alias: String,
    hostname: String,
    user: String,
    port: String,
    identity_file: String,
    proxy_jump: String,
}

#[derive(Serialize)]
pub struct SshList {
    hosts: Vec<SshHost>,
    config: Vec<ConfigHost>,
}

fn secret_key(id: &str) -> String {
    format!("ssh:{id}")
}

fn load() -> Result<Vec<SshHost>, String> {
    store::load_json(FILE)
}

fn ssh_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".ssh")
}

/// Concrete `Host` entries of ~/.ssh/config (patterns with * ? ! are skipped; Include is not followed).
fn parse_config() -> Vec<ConfigHost> {
    let Ok(raw) = std::fs::read_to_string(ssh_dir().join("config")) else { return Vec::new() };
    let mut out: Vec<ConfigHost> = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_lowercase(), v.trim_start_matches(|c: char| c.is_whitespace() || c == '=').trim().to_string()),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace().filter(|a| !a.contains(['*', '?', '!'])) {
                    current.push(out.len());
                    out.push(ConfigHost { alias: alias.into(), ..Default::default() });
                }
            }
            "match" => current.clear(),
            _ => {
                for &i in &current {
                    let h = &mut out[i];
                    // first value wins, like ssh itself
                    let slot = match key.as_str() {
                        "hostname" => &mut h.hostname,
                        "user" => &mut h.user,
                        "port" => &mut h.port,
                        "identityfile" => &mut h.identity_file,
                        "proxyjump" => &mut h.proxy_jump,
                        _ => continue,
                    };
                    if slot.is_empty() {
                        *slot = value.clone();
                    }
                }
            }
        }
    }
    out
}

#[tauri::command]
pub fn ssh_list() -> Result<SshList, String> {
    Ok(SshList { hosts: load()?, config: parse_config() })
}

/// Private key candidates in ~/.ssh (files that have a matching .pub, or start with id_).
#[tauri::command]
pub fn ssh_keys() -> Vec<String> {
    let dir = ssh_dir();
    let mut keys: Vec<String> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_none_or(|e| e != "pub"))
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            dir.join(format!("{name}.pub")).exists() || name.starts_with("id_")
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    keys.sort();
    keys
}

fn valid_user(u: &str) -> bool {
    // '@' is allowed: AD-style logins like user@domain (ssh splits the destination on the last '@')
    u.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '@')) && !u.starts_with('-')
}

/// Jump spec: [user@]host[:port][,...]
fn valid_jump(j: &str) -> bool {
    j.split(',').all(|hop| {
        let (user, rest) = hop.rsplit_once('@').map_or(("", hop), |(u, r)| (u, r));
        let host = rest.split(':').next().unwrap_or_default();
        valid_user(user) && valid_host(host)
    })
}

#[tauri::command]
pub fn ssh_save(host: SshHost, secret: Option<String>) -> Result<(), String> {
    if !store::valid_id(&host.id) {
        return Err("invalid id".into());
    }
    if !valid_host(&host.host) {
        return Err("некорректный адрес".into());
    }
    if !valid_user(&host.user) {
        return Err("некорректный пользователь".into());
    }
    if !host.jump.is_empty() && !valid_jump(&host.jump) {
        return Err("некорректный jump-хост (формат user@host:port)".into());
    }
    if host.identity_file.starts_with('-') {
        return Err("некорректный путь к ключу".into());
    }
    if host.auth == "keepass" && host.keepass_entry.is_empty() {
        return Err("выберите запись KeePass".into());
    }
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        store::secret_set(&secret_key(&host.id), &s)?;
    }
    let mut list = load()?;
    match list.iter_mut().find(|h| h.id == host.id) {
        Some(h) => *h = host,
        None => list.push(host),
    }
    store::save_json(FILE, &list)
}

#[tauri::command]
pub fn ssh_delete(id: String) -> Result<(), String> {
    let mut list = load()?;
    list.retain(|h| h.id != id);
    store::secret_delete(&secret_key(&id));
    store::save_json(FILE, &list)
}

#[derive(Serialize)]
pub struct SshSpec {
    program: String,
    args: Vec<String>,
    password_copied: bool,
}

/// What to run for a saved profile (`id`) or a ~/.ssh/config alias (`alias`).
#[tauri::command]
pub fn ssh_connect(app: AppHandle, kp: State<KeepassState>, id: Option<String>, alias: Option<String>) -> Result<SshSpec, String> {
    if let Some(alias) = alias {
        if alias.starts_with('-') || !parse_config().iter().any(|h| h.alias == alias) {
            return Err("хост не найден в ~/.ssh/config".into());
        }
        return Ok(SshSpec { program: "ssh".into(), args: vec![alias], password_copied: false });
    }
    let id = id.ok_or("не указан хост")?;
    let h = load()?.into_iter().find(|h| h.id == id).ok_or("профиль не найден")?;
    let (user, pass) = match h.auth.as_str() {
        "keepass" => {
            let (u, p) = keepass::credentials(&kp, &h.keepass_entry)?;
            (if h.user.is_empty() { u } else { h.user.clone() }, p)
        }
        "password" => (h.user.clone(), store::secret_get(&secret_key(&h.id)).unwrap_or_default()),
        _ => (h.user.clone(), String::new()),
    };
    if !valid_user(&user) {
        return Err("некорректный пользователь в записи KeePass".into());
    }
    let mut args = vec!["-p".to_string(), h.port.to_string()];
    if !h.identity_file.is_empty() {
        args.extend(["-i".into(), h.identity_file.clone()]);
    }
    if !h.jump.is_empty() {
        args.extend(["-J".into(), h.jump.clone()]);
    }
    args.push(if user.is_empty() { h.host.clone() } else { format!("{user}@{}", h.host) });
    let copied = !pass.is_empty();
    if copied {
        keepass::copy_secret(&app, pass)?;
    }
    Ok(SshSpec { program: "ssh".into(), args, password_copied: copied })
}

