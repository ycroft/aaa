pub mod commands;
pub mod hub;
pub mod hub_commands;

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

    // In-process buffer feeding the optional log_excerpt feedback attachment.
    // Capacity 200; only WARN+ERROR are pushed (by callers explicitly logging
    // through `log::warn!`/`log::error!`; third-party libs are not captured).
    let log_buf = aaa_core::log_buffer::LogBuffer::new(200);

    // Initial HubClient bound to the persisted settings. The frontend may
    // call `refresh_hub` after editing the base URL.
    let initial_settings = aaa_core::settings::load().unwrap_or_default();
    let hub_client = std::sync::Mutex::new(hub::HubClient::new(&initial_settings.hub));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(commands::RemoteTasks::default())
        .manage(log_buf)
        .manage(hub_client)
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
            hub_commands::hub_status,
            hub_commands::submit_feedback,
            hub_commands::get_feedback_status,
            hub_commands::list_local_tickets,
            hub_commands::check_update,
            hub_commands::refresh_hub,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
