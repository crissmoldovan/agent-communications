// No console window behind the app on Windows, in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agentcomms_desktop::run();
}
