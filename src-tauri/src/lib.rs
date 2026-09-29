use tauri::Manager;

mod alerts;
mod connectors;
mod embed;
mod ide;
mod k8s;
mod keepass;
mod mikrotik;
mod notes;
mod settings;
mod snippets;
mod ssh;
mod sysmon;
mod store;
mod ports;
mod pty;
mod tools;
mod updater;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(pty::PtyState::default())
        .manage(tools::ToolState::default())
        .manage(k8s::K8sState::default())
        .manage(keepass::KeepassState::default())
        .manage(ide::IdeState::default())
        .manage(alerts::AlertsState::default())
        .manage(sysmon::SysState::default())
        .setup(|app| {
            keepass::spawn_autolock(app.handle().clone());
            ide::start(app.handle().clone());
            embed::install(app.handle());
            alerts::load_data(&app.state::<alerts::AlertsState>());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = alerts::restart(&handle).await {
                    eprintln!("alerts: {e}");
                    let _ = tauri::Emitter::emit(&handle, "alerts-error", e);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_record_start,
            pty::pty_record_stop,
            pty::pty_records_open,
            tools::tool_run,
            tools::tool_stop,
            connectors::connectors_list,
            connectors::connector_save,
            connectors::connector_delete,
            connectors::connector_open,
            connectors::connector_regen_token,
            embed::web_embed_show,
            embed::web_embed_hide,
            embed::web_embed_close,
            embed::web_embed_nav,
            embed::open_external,
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
            k8s::k8s_logs_workload_start,
            k8s::k8s_prefs_get,
            k8s::k8s_prefs_set,
            k8s::k8s_delete_context,
            k8s::k8s_system_contexts,
            k8s::k8s_import_contexts,
            k8s::k8s_watch_start,
            k8s::k8s_watch_stop,
            k8s::k8s_metrics,
            k8s::k8s_helm_releases,
            k8s::k8s_helm_release,
            k8s::k8s_argo_action,
            k8s::k8s_crds,
            k8s::k8s_object_events,
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
            updater::update_check,
            updater::app_version,
            updater::update_install,
            alerts::alerts_get,
            alerts::alerts_ack,
            alerts::alerts_clear,
            alerts::alerts_config_get,
            alerts::alerts_config_set,
            alerts::alerts_poll_now,
            alerts::alerts_resolve,
            alerts::alerts_mute,
            alerts::alerts_test_source,
            alerts::alerts_sources,
            ssh::ssh_list,
            ssh::ssh_keys,
            ssh::ssh_save,
            ssh::ssh_delete,
            ssh::ssh_connect,
            ssh::ssh_local_user,
            sysmon::sys_local,
            sysmon::sys_remote,
            ports::ports_scan,
            ports::ports_listening,
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

