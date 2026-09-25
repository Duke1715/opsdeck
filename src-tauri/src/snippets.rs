//! Saved command snippets ("workflows"): `{{name}}` / `{{name:default}}` placeholders are filled in the UI.

use crate::store;
use serde::{Deserialize, Serialize};

const FILE: &str = "snippets.json";

#[derive(Serialize, Deserialize, Clone)]
pub struct Snippet {
    pub id: String,
    pub title: String,
    pub command: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[tauri::command]
pub fn snippets_list() -> Result<Vec<Snippet>, String> {
    store::load_json(FILE)
}

#[tauri::command]
pub fn snippets_save(snippets: Vec<Snippet>) -> Result<(), String> {
    if snippets.iter().any(|s| !store::valid_id(&s.id) || s.command.trim().is_empty()) {
        return Err("у каждого сниппета должна быть команда".into());
    }
    store::save_json(FILE, &snippets)
}
