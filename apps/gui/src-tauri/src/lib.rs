// The app is the web UI in a webview; this shell opens the window, lets the UI make network
// requests through the HTTP plugin (the webview itself may not call other origins), and keeps the
// wallet, settings and journal as files in the data folder (store.rs).

mod store;

use store::FileStore;
use tauri::{Manager, State};

#[tauri::command]
fn store_get(store: State<FileStore>, key: String) -> Result<Option<String>, String> {
    store.get(&key)
}

#[tauri::command]
fn store_set(store: State<FileStore>, key: String, value: String) -> Result<(), String> {
    store.set(&key, &value)
}

#[tauri::command]
fn store_keys(store: State<FileStore>, prefix: String) -> Result<Vec<String>, String> {
    store.keys(&prefix)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Desktop: the command line's folder, so both share one wallet. Phones have no such
            // folder (and no command line), so the app's own data folder is used there.
            let dir = if cfg!(mobile) { None } else { store::cli_data_dir() };
            let dir = match dir {
                Some(dir) => dir,
                None => app.path().app_data_dir()?,
            };
            app.manage(FileStore::new(dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![store_get, store_set, store_keys])
        .run(tauri::generate_context!())
        .expect("chainer could not start");
}
