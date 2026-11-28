// The app is the web UI in a webview; this shell opens the window, lets the UI make network
// requests through the HTTP plugin (the webview itself may not call other origins), and keeps the
// wallet, settings and journal as files in the data folder (store.rs). On Android it also offers
// fingerprint unlock through FingerprintPlugin.kt in the Android project.

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

#[cfg(target_os = "android")]
struct Fingerprint(tauri::plugin::PluginHandle<tauri::Wry>);

/// Runs one of FingerprintPlugin.kt's commands. Everywhere but Android there is no fingerprint
/// unlock, and `status` says so.
#[tauri::command]
async fn fingerprint(app: tauri::AppHandle, command: String, args: serde_json::Value) -> Result<serde_json::Value, String> {
    if !matches!(command.as_str(), "status" | "enable" | "unlock" | "disable") {
        return Err(format!("unknown fingerprint command {command}"));
    }
    #[cfg(target_os = "android")]
    {
        let plugin = app.state::<Fingerprint>();
        plugin.0.run_mobile_plugin_async(&command, args).await.map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, args);
        match command.as_str() {
            "status" => Ok(serde_json::json!({ "available": false, "enabled": false })),
            _ => Err("Fingerprint unlock is only on Android".into()),
        }
    }
}

fn fingerprint_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("fingerprint")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _app.manage(Fingerprint(_api.register_android_plugin("app.chainer", "FingerprintPlugin")?));
            Ok(())
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(fingerprint_plugin())
        .setup(|app| {
            // Desktop: the command line's folder, so both share one wallet. Phones have no such
            // folder (and no command line), so a folder of its own inside the app's private data
            // is used there, apart from what the web view keeps in the same place.
            let dir = if cfg!(mobile) { None } else { store::cli_data_dir() };
            let dir = match dir {
                Some(dir) => dir,
                None => app.path().app_data_dir()?.join("chainer"),
            };
            app.manage(FileStore::new(dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![store_get, store_set, store_keys, fingerprint])
        .run(tauri::generate_context!())
        .expect("chainer could not start");
}
