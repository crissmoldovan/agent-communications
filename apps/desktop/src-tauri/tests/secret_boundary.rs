use serde_json::Value;
use tauri::Manager;

fn secret_context() -> tauri::Context<tauri::test::MockRuntime> {
    tauri::generate_context!()
}

const COMMANDS: [&str; 8] = [
    "desktop_target_secret_create",
    "desktop_target_secret_rotate",
    "desktop_target_url_set",
    "desktop_subscriber_token_create",
    "desktop_subscriber_token_rotate",
    "desktop_judge_key_set",
    "desktop_judge_key_rotate",
    "desktop_secrets_migrate",
];

#[test]
fn generic_dispatch_refuses_all_secret_operations() {
    use agentcomms_desktop::control::b3_contract::{B3Request, SECRET_OPERATIONS};
    let public_schema: Value = serde_json::from_str(include_str!(
        "../../../../packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json"
    ))
    .unwrap();
    assert_eq!(
        public_schema["$defs"]["secretCapabilityUnavailable"]["additionalProperties"],
        false
    );
    assert_eq!(
        public_schema["$defs"]["secretCapabilityUnavailable"]["properties"]["code"]["const"],
        "APP_SECRET_CAPABILITY_UNAVAILABLE"
    );
    for operation in SECRET_OPERATIONS {
        assert_eq!(
            public_schema["$defs"]["resultsByOperation"]["$defs"][operation]["$ref"],
            "#/$defs/secretCapabilityUnavailable"
        );
        let result = B3Request::parse(
            serde_json::json!({"operation":operation,"args":{"targetId":"synthetic","version":1}}),
        );
        assert!(result.is_err());
        assert_eq!(
            result.err().unwrap().code,
            "APP_SECRET_CAPABILITY_UNAVAILABLE"
        );
    }
}

#[test]
fn secret_manifest_grants_exactly_eight_families_only_to_secrets() {
    let manifest: Value =
        serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
    let secrets: Value =
        serde_json::from_str(include_str!("../capabilities/secrets.json")).unwrap();
    let settings: Value =
        serde_json::from_str(include_str!("../capabilities/settings.json")).unwrap();
    let permissions = secrets["permissions"].as_array().unwrap();
    assert_eq!(permissions.len(), 8, "the secret command set is closed");
    for command in COMMANDS {
        assert!(agentcomms_desktop::security::APP_COMMANDS.contains(&command));
        let permission = format!("allow-{}", command.replace('_', "-"));
        assert!(permissions.contains(&Value::String(permission.clone())));
        assert!(!settings["permissions"]
            .as_array()
            .unwrap()
            .contains(&Value::String(permission.clone())));
        assert_eq!(
            manifest["__app-acl__"]["permissions"][&permission]["commands"]["allow"][0],
            command
        );
    }
}

#[test]
fn secret_raw_commands_use_native_window_authority() {
    let temp = tempfile::tempdir().unwrap();
    let app = tauri::test::mock_builder()
        .manage(
            agentcomms_desktop::commands::supervision::DesktopService::new(
                temp.path().join("prefs"),
            ),
        )
        .invoke_handler(agentcomms_desktop::desktop_secret_command_handler!())
        .build(secret_context())
        .unwrap();
    for label in ["settings", "secrets", "synthetic-third"] {
        let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .unwrap();
        for command in COMMANDS {
            let response = tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: command.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "tauri://localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(
                        serde_json::json!({"input": {"id":"synthetic", "version":1}}),
                    ),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_owned(),
                },
            );
            if label == "secrets" {
                #[cfg(windows)]
                assert!(
                    response.is_err(),
                    "Windows must refuse before reading control state"
                );
                #[cfg(unix)]
                {
                    let value: Value = response
                        .expect("allowed secret IPC reaches the native unavailable result")
                        .deserialize()
                        .unwrap();
                    assert_eq!(value["code"], "APP_SECRET_CAPABILITY_UNAVAILABLE");
                }
            } else {
                assert!(
                    response.is_err(),
                    "raw secret command reached an ordinary window"
                );
            }
        }
    }
    let settings = app.get_webview_window("settings").unwrap();
    let response = tauri::test::get_ipc_response(
        &settings,
        tauri::webview::InvokeRequest {
            cmd: "desktop_open_secrets".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_owned(),
        },
    );
    assert!(
        response.is_err(),
        "the shared production secret registration must not add a non-secret command"
    );
}

#[test]
fn secret_capability_is_native_and_zeroizing() {
    use agentcomms_desktop::control::secret_window_capability::{
        DesktopCapabilityKey, SecretWindowCapability,
    };
    let app = tauri::test::mock_app();
    let settings = tauri::WebviewWindowBuilder::new(&app, "settings", Default::default())
        .build()
        .unwrap();
    assert!(SecretWindowCapability::for_window(&settings).is_err());
    let secrets = tauri::WebviewWindowBuilder::new(&app, "secrets", Default::default())
        .build()
        .unwrap();
    let capability = SecretWindowCapability::for_window(&secrets).unwrap();
    let key = DesktopCapabilityKey::generate().unwrap();
    assert!(capability
        .proof(&key, "session", "targetSecretCreate", &"a".repeat(64))
        .is_ok());
    assert!(capability
        .proof(&key, "session", "status", &"a".repeat(64))
        .is_err());
}

#[cfg(unix)]
#[test]
fn spawned_capability_uses_only_inherited_pipe_and_matches_node_hmac() {
    use agentcomms_desktop::control::secret_window_capability::{
        DesktopCapabilityKey, SecretWindowCapability,
    };
    use std::process::{Command, Stdio};
    let app = tauri::test::mock_app();
    let window = tauri::WebviewWindowBuilder::new(&app, "secrets", Default::default())
        .build()
        .unwrap();
    let capability = SecretWindowCapability::for_window(&window).unwrap();
    let key = DesktopCapabilityKey::generate().unwrap();
    let nonce = "a".repeat(64);
    let proof = serde_json::to_value(
        capability
            .proof(&key, "session", "targetSecretCreate", &nonce)
            .unwrap(),
    )
    .unwrap();
    let script = "import { readDesktopCapabilityPipe } from './packages/events-daemon/src/runtime/desktop-capability-pipe.ts'; import {createHmac} from 'node:crypto'; import {fstatSync} from 'node:fs'; const key=readDesktopCapabilityPipe(); if(key?.length!==32) process.exit(11); let closed=false;try{fstatSync(3)}catch{closed=true} if(!closed)process.exit(12); const mac=createHmac('sha256',key).update('sessiontargetSecretCreate'+'a'.repeat(64)).digest('hex');key.fill(0);process.stdout.write(mac);";
    let mut command = Command::new("node");
    command
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
        .args([
            "--experimental-strip-types",
            "--disable-warning=ExperimentalWarning",
            "--input-type=module",
            "-e",
            script,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let output = key.spawn(&mut command).unwrap().wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "pipe-only daemon key intake failed"
    );
    assert!(
        output.stdout.as_slice() == proof["mac"].as_str().unwrap().as_bytes(),
        "Rust and Node must agree on the exact HMAC binding"
    );
}

#[cfg(unix)]
#[test]
#[ignore = "requires the loopback sealed real-owner Node harness"]
fn native_commands_over_spawned_owner() {
    use agentcomms_desktop::{
        commands::{secrets, supervision::DesktopService},
        preferences::DaemonProfile,
    };
    use tauri::Manager;
    let root = std::path::PathBuf::from(std::env::var("SECRET_TRACE_ROOT").unwrap());
    let profile = DaemonProfile::new(
        root.join("agent-events"),
        root.join("state"),
        root.join("config"),
    )
    .unwrap();
    let app = tauri::test::mock_builder()
        .manage(DesktopService::new(root.join("preferences/desktop.json")))
        .invoke_handler(secrets::handler())
        .build(secret_context())
        .unwrap();
    let service = app.state::<DesktopService>();
    service
        .supervisor
        .start_selected(&service.store, 0, profile, false)
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "secrets", Default::default())
        .build()
        .unwrap();
    let mut material = Vec::new();
    for (command, input, expected) in [
        (
            "desktop_target_secret_create",
            serde_json::json!({"id":"target-native","version":1}),
            "RevealOnce",
        ),
        (
            "desktop_target_secret_rotate",
            serde_json::json!({"id":"target-native","version":1}),
            "RevealOnce",
        ),
        (
            "desktop_subscriber_token_create",
            serde_json::json!({"id":"subscriber-native","version":1}),
            "RevealOnce",
        ),
        (
            "desktop_subscriber_token_rotate",
            serde_json::json!({"id":"subscriber-native","version":1}),
            "RevealOnce",
        ),
        (
            "desktop_judge_key_set",
            serde_json::json!({"id":"judge-native","version":1,"hidden":"synthetic-hidden-set"}),
            "Acknowledgement",
        ),
        (
            "desktop_judge_key_rotate",
            serde_json::json!({"id":"judge-native","version":1,"hidden":"synthetic-hidden-rotate"}),
            "Acknowledgement",
        ),
        (
            "desktop_target_url_set",
            serde_json::json!({"id":"url-native","version":1,"hidden":"https://example.test/synthetic-hidden-path","inertDraft":{"kind":"webhook","approvedAddressSet":["8.8.8.8"],"signing":"standard-webhooks","ordering":"strict","retryLimit":20,"representation":"enveloped"}}),
            "UrlFingerprint",
        ),
        (
            "desktop_secrets_migrate",
            serde_json::json!({"to":"file"}),
            "MigrationStatus",
        ),
    ] {
        let response = tauri::test::get_ipc_response(
            &window,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(serde_json::json!({"input":input})),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_owned(),
            },
        );
        assert!(response.is_ok(), "native secret operation failed");
        let response: Value = response.unwrap().deserialize().unwrap();
        assert!(
            response["kind"] == expected,
            "native secret result variant mismatch"
        );
        if let Some(secret) = response["material"].as_str() {
            material.push(secret.to_owned());
        } else {
            assert!(
                !response.to_string().contains("synthetic-hidden"),
                "input echoed in a secret response"
            );
        }
    }
    material.extend(
        [
            "synthetic-hidden-set",
            "synthetic-hidden-rotate",
            "synthetic-hidden-path",
        ]
        .map(str::to_owned),
    );
    fn scan(path: &std::path::Path, material: &[String]) {
        if path.file_name().is_some_and(|name| name == "secrets") {
            return;
        }
        if path.is_dir() {
            for entry in std::fs::read_dir(path).unwrap() {
                scan(&entry.unwrap().path(), material);
            }
        } else if let Ok(bytes) = std::fs::read(path) {
            for secret in material {
                assert!(
                    !bytes
                        .windows(secret.len())
                        .any(|part| part == secret.as_bytes()),
                    "secret reached a non-secret durable surface"
                );
            }
        }
    }
    scan(&root, &material);
    service.secrets.clear();
    service.supervisor.stop_daemon(&service.store).unwrap();
}
