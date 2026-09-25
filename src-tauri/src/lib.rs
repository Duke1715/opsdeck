mod connectors;
mod pty;
mod tools;

pub fn run() {
    tauri::Builder::default()
        .manage(pty::PtyState::default())
        .manage(tools::ToolState::default())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpsDeck");
}
