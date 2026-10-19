//! The Rust port of `resolvePaths` gives what core gives, for every case recorded from core in
//! `fixtures/resolve-paths.json`, POSIX and Windows alike (the TypeScript half, `src/test/paths-parity.test.ts` and
//! `paths-parity-windows.test.ts`, re-checks the fixture against core itself, so it cannot drift). The port builds
//! paths with the platform it is given, not the host's, so the Windows cases run on every host.

use agentcomms_desktop::paths::{resolve_folders, Folders, PathEnv, Platform};
use serde_json::Value;

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

#[test]
fn the_port_matches_resolve_paths_for_every_recorded_case() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/resolve-paths.json")).expect("the fixture");
    let cases = fixture["cases"].as_array().expect("cases");
    assert!(cases.len() >= 20, "{} cases", cases.len());
    let windows = cases
        .iter()
        .filter(|case| case["platform"] == "win32")
        .count();
    assert!(windows >= 10, "{windows} Windows cases");
    for case in cases {
        let name = case["name"].as_str().expect("a name");
        let platform = match case["platform"].as_str().expect("a platform") {
            "linux" => Platform::Linux,
            "darwin" => Platform::MacOs,
            "win32" => Platform::Windows,
            other => panic!("{name}: no platform called {other}"),
        };
        let env = &case["env"];
        let path_env = PathEnv {
            platform,
            home: case["home"].as_str().expect("a home").to_string(),
            appdata: text(env, "APPDATA"),
            localappdata: text(env, "LOCALAPPDATA"),
            xdg_config_home: text(env, "XDG_CONFIG_HOME"),
            xdg_data_home: text(env, "XDG_DATA_HOME"),
            config_dir: text(env, "AGENT_COMMS_CONFIG_DIR"),
            state_dir: text(env, "AGENT_COMMS_STATE_DIR"),
            data_dir: text(env, "AGENT_COMMS_DATA_DIR"),
        };
        let expected = &case["expected"];
        assert_eq!(
            resolve_folders(&path_env),
            Folders {
                config_dir: text(expected, "configDir").expect("configDir"),
                state_dir: text(expected, "stateDir").expect("stateDir"),
                data_dir: text(expected, "dataDir").expect("dataDir"),
                secrets_dir: text(expected, "secretsDir").expect("secretsDir"),
            },
            "{name}"
        );
    }
}
