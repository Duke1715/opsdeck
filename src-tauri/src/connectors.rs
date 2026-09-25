//! Web connectors (Grafana, ArgoCD, GitLab, generic URL).
//! Metadata lives in ~/.config/opsdeck/connectors.json, secrets in the OS keyring.
//! Opening a connector creates a separate webview window with an init script that logs in
//! on the configured origin only; the window has no IPC access to the app.

use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const KEYRING_SERVICE: &str = "opsdeck";

#[derive(Serialize, Deserialize, Clone)]
pub struct Connector {
    pub id: String,
    /// grafana | argocd | gitlab | generic
    pub kind: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub username: String,
    /// password | token | none
    #[serde(default = "default_auth")]
    pub auth: String,
}

fn default_auth() -> String {
    "password".into()
}

fn config_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir().ok_or("no config dir")?.join("opsdeck");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("connectors.json"))
}

fn load() -> Result<Vec<Connector>, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn store(list: &[Connector]) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    fs::write(config_path()?, raw).map_err(|e| e.to_string())
}

fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("connector:{id}")).map_err(|e| e.to_string())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[tauri::command]
pub fn connectors_list() -> Result<Vec<Connector>, String> {
    load()
}

/// `secret`: Some(non-empty) replaces the stored secret, None/empty keeps the existing one.
#[tauri::command]
pub fn connector_save(connector: Connector, secret: Option<String>) -> Result<(), String> {
    if !valid_id(&connector.id) {
        return Err("invalid id".into());
    }
    let url = Url::parse(&connector.url).map_err(|e| format!("bad URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("URL must be http(s)".into());
    }
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        entry(&connector.id)?.set_password(&s).map_err(|e| e.to_string())?;
    }
    let mut list = load()?;
    match list.iter_mut().find(|c| c.id == connector.id) {
        Some(c) => *c = connector,
        None => list.push(connector),
    }
    store(&list)
}

#[tauri::command]
pub fn connector_delete(id: String) -> Result<(), String> {
    let mut list = load()?;
    list.retain(|c| c.id != id);
    if let Ok(e) = entry(&id) {
        let _ = e.delete_credential();
    }
    store(&list)
}

#[tauri::command]
pub fn connector_open(app: AppHandle, id: String) -> Result<(), String> {
    let c = load()?.into_iter().find(|c| c.id == id).ok_or("connector not found")?;
    let label = format!("conn-{}", c.id);
    if let Some(w) = app.get_webview_window(&label) {
        return w.set_focus().map_err(|e| e.to_string());
    }

    let url = Url::parse(&c.url).map_err(|e| e.to_string())?;
    let secret = match c.auth.as_str() {
        "none" => String::new(),
        _ => entry(&c.id)?.get_password().unwrap_or_default(),
    };

    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url.clone()))
        .title(format!("{} — OpsDeck", c.name))
        .inner_size(1360.0, 860.0);
    if !secret.is_empty() {
        builder = builder.initialization_script(&login_script(&c, &url, &secret));
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// JS that runs before page scripts on every navigation in the connector window.
/// Values are embedded as JSON literals and kept inside a closure (not on window).
fn login_script(c: &Connector, url: &Url, secret: &str) -> String {
    let origin = url.origin().ascii_serialization();
    let base = c.url.trim_end_matches('/');
    let cfg = serde_json::json!({
        "kind": c.kind, "auth": c.auth, "origin": origin, "base": base,
        "user": c.username, "secret": secret,
    });
    format!("(function(cfg){{\n{}\n}})({});", LOGIN_JS, cfg)
}

const LOGIN_JS: &str = r#"
if (location.origin !== cfg.origin) return;
const path = location.pathname.replace(/\/+$/, '');
// retry at most once a minute so a wrong password doesn't loop
const KEY = '__opsdeck_login';
const last = Number(sessionStorage.getItem(KEY) || 0);
const mayTry = () => Date.now() - last > 60000 && (sessionStorage.setItem(KEY, String(Date.now())), true);
const post = (url, body) => fetch(url, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

if (cfg.kind === 'grafana') {
  if (path.endsWith('/login') && mayTry())
    post(cfg.base + '/login', { user: cfg.user, password: cfg.secret })
      .then(r => { if (r.ok) location.replace(cfg.base + '/'); });
}

if (cfg.kind === 'argocd') {
  if (cfg.auth === 'token') {
    if (!document.cookie.includes('argocd.token='))
      document.cookie = 'argocd.token=' + cfg.secret + '; path=/' + (location.protocol === 'https:' ? '; secure' : '');
    if (path.endsWith('/login')) location.replace(cfg.base + '/applications');
  } else if (path.endsWith('/login') && mayTry()) {
    post(cfg.base + '/api/v1/session', { username: cfg.user, password: cfg.secret })
      .then(r => { if (r.ok) location.replace(cfg.base + '/applications'); });
  }
}

if (cfg.kind === 'gitlab') {
  if (path.endsWith('/users/sign_in') && mayTry()) {
    const fill = () => {
      const u = document.querySelector('#user_login'), p = document.querySelector('#user_password');
      if (!u || !p) return false;
      const set = (el, v) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set(u, cfg.user); set(p, cfg.secret);
      const form = p.closest('form');
      const btn = form && form.querySelector('[type=submit]');
      btn ? btn.click() : form && form.submit();
      return true;
    };
    document.addEventListener('DOMContentLoaded', () => {
      if (!fill()) { let n = 0; const t = setInterval(() => { if (fill() || ++n > 20) clearInterval(t); }, 250); }
    });
  }
}
"#;
