mod beatmatcher;
mod midi;

use tauri::menu::{AboutMetadataBuilder, MenuBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(midi::MidiState::default())
        .setup(|app| {
            midi::start(app.handle().clone());
            beatmatcher::start(app.handle().clone());
            let icon = app.default_window_icon().cloned();
            let about = AboutMetadataBuilder::new()
                .name(Some("Performer"))
                .copyright(Some("Copyright 2026 Matias Berrutti\ngithub.com/berrutti/performer"))
                .icon(icon)
                .build();
            let app_menu = SubmenuBuilder::new(app, "Performer")
                .item(&PredefinedMenuItem::about(app, None, Some(about))?)
                .separator()
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;
            let menu = MenuBuilder::new(app).item(&app_menu).build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![midi::midi_status, midi::midi_send])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
