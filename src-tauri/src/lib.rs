mod connectors;
mod k8s;
mod pty;
mod tools;

pub fn run() {
    tauri::Builder::default()
        .manage(pty::PtyState::default())
        .manage(tools::ToolState::default())
        .manage(k8s::K8sState::default())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpsDeck");
}
