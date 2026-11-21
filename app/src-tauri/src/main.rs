// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // An existing external assistant configuration can call these retired entry points.
    if matches!(std::env::args().nth(1).as_deref(), Some("--claude-hook" | "--mcp" | "--mcp-deck" | "--mcp-assistant")) {
        return;
    }
    // the guard MasterDeck starts for itself: hands the deck back if MasterDeck dies (guard.rs)
    if std::env::args().nth(1).as_deref() == Some("--guard") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        return masterdeck_lib::guard(&args);
    }
    // the release gate: what Install would get for the most popular catalog plugins here
    if std::env::args().nth(1).as_deref() == Some("--catalog-check") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(masterdeck_lib::catalog_check(&args));
    }
    // a terminal or a script: `hubdeck cli status`, `hubdeck cli profile Desk`...
    if std::env::args().nth(1).as_deref() == Some("cli") {
        let args: Vec<String> = std::env::args().skip(2).collect();
        std::process::exit(masterdeck_lib::cli(&args));
    }
    masterdeck_lib::run()
}
