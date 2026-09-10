// Prevents an extra console window from opening alongside the app on Windows
// in release builds (the window itself is the UI).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lifementor_desktop_lib::run()
}
