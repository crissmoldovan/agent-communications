use agentcomms_desktop::security::is_app_origin;
use tauri::Url;

#[test]
fn compiled_app_origin_is_the_only_navigation_origin() {
    let app_origin = if cfg!(target_os = "macos") {
        "tauri://localhost/settings.html"
    } else {
        "http://tauri.localhost/settings.html"
    };
    assert!(is_app_origin(&Url::parse(app_origin).unwrap()));
    for hostile in [
        "https://example.test/",
        "http://127.0.0.1:48999/",
        "http://tauri.localhost.evil.test/",
        "mailto:synthetic@example.test",
        "custom-protocol://example.test/value",
        "file:///tmp/secret",
        "data:text/html,hello",
    ] {
        assert!(!is_app_origin(&Url::parse(hostile).unwrap()), "{hostile}");
    }
}

#[test]
fn same_origin_path_does_not_make_a_different_origin_safe() {
    let hostile = Url::parse("https://example.test/settings.html").unwrap();
    assert!(!is_app_origin(&hostile));
}

#[cfg(feature = "no-egress-probe")]
#[test]
fn effective_window_navigation_guard_records_each_denial_before_returning() {
    use agentcomms_desktop::security::{allow_window_navigation, probe_snapshot};

    let before = probe_snapshot("settings");
    let before: Vec<usize> = before
        .split(',')
        .map(|part| part.parse().unwrap())
        .collect();
    assert!(!allow_window_navigation(
        "settings",
        &Url::parse("desktop-probe://synthetic.test/blocked").unwrap()
    ));
    assert!(!allow_window_navigation(
        "settings",
        &Url::parse("http://127.0.0.1:48999/probe/navigation").unwrap()
    ));
    assert!(allow_window_navigation(
        "settings",
        &Url::parse(if cfg!(target_os = "macos") {
            "tauri://localhost/settings.html"
        } else {
            "http://tauri.localhost/settings.html"
        })
        .unwrap()
    ));
    let after = probe_snapshot("settings");
    let after: Vec<usize> = after.split(',').map(|part| part.parse().unwrap()).collect();
    assert_eq!(after[0], before[0] + 1, "custom protocol was not counted");
    assert_eq!(after[1], before[1] + 1, "remote navigation was not counted");
    assert_eq!(after[2], before[2], "a refused URL was counted as allowed");
}
