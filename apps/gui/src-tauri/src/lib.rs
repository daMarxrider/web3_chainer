// The app is the web UI in a webview; this shell only opens the window and lets the UI make
// network requests through the HTTP plugin (the webview itself may not call other origins).
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("chainer could not start");
}
