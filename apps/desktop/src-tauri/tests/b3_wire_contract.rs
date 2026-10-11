use agentcomms_desktop::control::b3_contract::{
    B3Request, NonSecretOperation, NON_SECRET_OPERATIONS,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

// desktop-rust-mutation: desktop-b3-stale-rust-type | cargo --test b3_wire_contract | desktop_b3_wire_contract
#[test]
fn desktop_b3_wire_contract() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let folder = root.join("packages/events-daemon/test/fixtures/b3-control-contract-v1");
    let schema: Value = serde_json::from_slice(
        &fs::read(
            root.join("packages/events-daemon/src/operations/contracts/b3-control-v1.schema.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let expected: Vec<_> = schema["$defs"]["resultsByOperation"]["$defs"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, shape)| shape["$ref"] != "#/$defs/secretCapabilityUnavailable")
        .map(|(operation, _)| operation.as_str())
        .collect();
    assert_eq!(NON_SECRET_OPERATIONS, expected);
    let mut seen = std::collections::BTreeSet::new();
    for file in fs::read_dir(folder).unwrap() {
        let value: Value =
            serde_json::from_slice(&fs::read(file.unwrap().path()).unwrap()).unwrap();
        let rows = value.as_array().cloned().unwrap_or(vec![value]);
        for row in rows {
            let request = &row["request"];
            if request.get("surface").is_some() {
                continue;
            }
            let name = request["operation"].as_str().unwrap();
            if !NON_SECRET_OPERATIONS.contains(&name) {
                continue;
            }
            let mut request = request.clone();
            request.as_object_mut().unwrap().remove("origin");
            let typed = B3Request::parse(request).unwrap();
            assert_eq!(typed.operation().wire(), name);
            seen.insert(name.to_owned());
            if let Some(result) = row.get("result") {
                typed.result(result.clone()).unwrap();
            }
        }
    }
    assert_eq!(seen.into_iter().collect::<Vec<_>>(), NON_SECRET_OPERATIONS);
    assert!(serde_json::from_value::<NonSecretOperation>(json!("run")).is_err());
    assert!(B3Request::parse(json!({"operation":"status","args":{"secret":"forged"}})).is_err());
    let request = B3Request::parse(json!({"operation":"status","args":{}})).unwrap();
    assert!(request.result(json!({"owner":"running","enabled":"yes","paused":false,"switchGeneration":0,"activationIntents":[]})).is_err());
}

// desktop-rust-mutation: desktop-no-secret-generic-dispatch | cargo --test b3_wire_contract | desktop_no_secret_generic_dispatch
#[test]
fn desktop_no_secret_generic_dispatch() {
    for operation in [
        "targetSecretCreate",
        "targetSecretRotate",
        "targetUrlSet",
        "subscriberTokenCreate",
        "subscriberTokenRotate",
        "judgeKeySet",
        "judgeKeyRotate",
        "migrateSecrets",
    ] {
        assert!(
            serde_json::from_value::<NonSecretOperation>(json!(operation)).is_err(),
            "{operation}"
        );
        for origin in [
            "app",
            "secrets",
            "app-approval-screen",
            "interactive-terminal",
        ] {
            let error = B3Request::parse(json!({"operation":operation,"args":{},"origin":origin}))
                .unwrap_err();
            assert_eq!(error.code, "APP_SECRET_CAPABILITY_UNAVAILABLE");
        }
    }
}
