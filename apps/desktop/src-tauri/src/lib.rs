pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("desktop runtime failed");
}
