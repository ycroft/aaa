pub mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Best-effort logger init. Failure to set up file logging should not
    // prevent the app from running, so we swallow the error and fall back
    // to a quiet runtime — only the very first stderr line carries the
    // failure reason.
    match aaa_core::logger::init() {
        Ok(dir) => log::info!(
            "aaa starting (version {}, log dir {})",
            env!("CARGO_PKG_VERSION"),
            dir.display()
        ),
        Err(e) => eprintln!("aaa: logger init failed, continuing without file logs: {}", e),
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::RemoteTasks::default())
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::list_providers,
            commands::list_sessions,
            commands::load_session,
            commands::session_skill_usage,
            commands::get_settings,
            commands::save_settings,
            commands::list_remotes,
            commands::save_remote,
            commands::delete_remote,
            commands::list_remote_caches,
            commands::remote_probe,
            commands::remote_open,
            commands::remote_cancel,
            commands::export_session,
            commands::check_command_exists,
            commands::export_all_sessions,
            commands::launch_agent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
