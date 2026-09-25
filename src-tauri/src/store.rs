//! Shared persistence: JSON files in ~/.config/opsdeck and secrets in the OS keyring.

use serde::{de::DeserializeOwned, Serialize};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

const KEYRING_SERVICE: &str = "opsdeck";

pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn config_dir() -> Result<PathBuf, String> {
    let dir = dirs::config_dir().ok_or("no config dir")?.join("opsdeck");
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

pub fn load_json<T: DeserializeOwned + Default>(name: &str) -> Result<T, String> {
    let path = config_dir()?.join(name);
    if !path.exists() {
        return Ok(T::default());
    }
    let raw = fs::read_to_string(&path).map_err(err)?;
    serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn save_json<T: Serialize>(name: &str, value: &T) -> Result<(), String> {
    let path = config_dir()?.join(name);
    fs::write(&path, serde_json::to_string_pretty(value).map_err(err)?).map_err(err)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).map_err(err)
}

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, key).map_err(err)
}

pub fn secret_get(key: &str) -> Option<String> {
    entry(key).ok()?.get_password().ok()
}

pub fn secret_set(key: &str, value: &str) -> Result<(), String> {
    entry(key)?.set_password(value).map_err(err)
}

pub fn secret_delete(key: &str) {
    if let Ok(e) = entry(key) {
        let _ = e.delete_credential();
    }
}

/// Ids come from the frontend (crypto.randomUUID) and end up in keyring keys and window labels.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}
