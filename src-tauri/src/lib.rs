mod connectors;
mod ide;
mod k8s;
mod keepass;
mod mikrotik;
mod notes;
mod settings;
mod snippets;
mod store;
mod pty;
mod tools;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(pty::PtyState::default())
        .manage(tools::ToolState::default())
        .manage(k8s::K8sState::default())
        .manage(keepass::KeepassState::default())
        .manage(ide::IdeState::default())
        .setup(|app| {
            keepass::spawn_autolock(app.handle().clone());
            ide::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            tools::tool_run,
            tools::tool_stop,
            connectors::connectors_list,
            connectors::connector_save,
            connectors::connector_delete,
            connectors::connector_open,
            k8s::k8s_contexts,
            k8s::k8s_import,
            k8s::k8s_remove_source,
            k8s::k8s_shell_config,
            k8s::k8s_list,
            k8s::k8s_get_yaml,
            k8s::k8s_apply_yaml,
            k8s::k8s_delete,
            k8s::k8s_scale,
            k8s::k8s_restart,
            k8s::k8s_logs_start,
            k8s::k8s_logs_stop,
            k8s::k8s_prefs_get,
            k8s::k8s_prefs_set,
            settings::settings_get,
            settings::settings_set,
            settings::settings_detect,
            keepass::kp_status,
            keepass::kp_unlock,
            keepass::kp_lock,
            keepass::kp_entries,
            keepass::kp_copy,
            keepass::kp_reveal,
            keepass::kp_notes,
            keepass::kp_open_external,
            keepass::clip_write,
            keepass::clip_read,
            mikrotik::mt_list,
            mikrotik::mt_save,
            mikrotik::mt_delete,
            mikrotik::mt_winbox,
            mikrotik::mt_ssh,
            notes::notes_list,
            notes::note_read,
            notes::note_write,
            notes::note_search,
            notes::note_open_obsidian,
            notes::note_daily,
            snippets::snippets_list,
            snippets::snippets_save,
            ide::ide_selection,
            ide::ide_editor,
            ide::ide_at_mention,
            ide::ide_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building OpsDeck")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                ide::cleanup(app);
            }
        });
}

