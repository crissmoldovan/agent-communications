use agentcomms_desktop::commands::control::{execute_control, ControlInput};
// Only the Unix-only settings test below uses these.
#[cfg(unix)]
use agentcomms_desktop::{
    commands::control::save_preferences, preferences::PreferenceStore,
    supervisor::DesktopSupervisor,
};
use serde_json::json;

// desktop-rust-mutation: desktop-generic-approve-refusal | cargo --test control_commands | desktop_control_command_closed_boundary
#[test]
fn desktop_control_command_closed_boundary() {
    let input: ControlInput = serde_json::from_value(json!({"request":{"operation":"ruleTestRetained","args":{"eventId":"event-1","ruleId":"rule-1","ruleVersion":1}},"selection":null})).unwrap();
    let response = execute_control(input, 1, |request| {
        assert_eq!(request.operation().wire(), "ruleTestRetained");
        Ok(json!({"agentic":"not-evaluated","outcome":"matched","rendered":"<script>hostile</script>"}))
    }).unwrap();
    assert!(response
        .result
        .segments
        .iter()
        .all(|s| !s.text.contains("<script>")));
    let input: ControlInput = serde_json::from_value(json!({"request":{"operation":"approve","args":{"approvalId":"approval-1","answer":"answer"}},"selection":null})).unwrap();
    assert_eq!(
        execute_control(input, 1, |_| panic!("generic approve must never call B3"))
            .unwrap_err()
            .code,
        "APPROVAL_SCREEN_REQUIRED"
    );
}

#[test]
fn desktop_id_scope_native() {
    let input: ControlInput = serde_json::from_value(json!({"request":{"operation":"dryrun-show","args":{"deliveryId":"delivery-1"}},"selection":{"id":"delivery-1","version":1,"accountId":"account-1","source":"source-1"}})).unwrap();
    let result = json!({"deliveryId":"delivery-1","ruleId":"rule-1","ruleVersion":1,"targetId":"target-1","targetVersion":1,"eventId":"event-1","accountId":"account-2","deliveredAt":1000,"expiresAt":2000,"record":{"cloudEventBytes":"{}","untrusted":[],"representation":"plain"}});
    assert_eq!(
        execute_control(input, 1, |_| Ok(result)).unwrap_err().code,
        "SCOPE_MISMATCH"
    );
}

// desktop-rust-mutation: desktop-nested-document-scope | cargo --test control_commands | desktop_rule_update_rejects_cross_scope_document_before_paint
#[test]
fn desktop_rule_update_rejects_cross_scope_document_before_paint() {
    let document = json!({
        "ruleId":"rule-1",
        "version":1,
        "source": {
            "channel":"gmail",
            "accountIds":["account-1"],
            "options":{"channel":"gmail","labels":"inbox","includeSpamTrash":false}
        },
        "event":{"type":"gmail.message.received","version":1},
        "condition":{"path":"/subject","op":"exists"},
        "mapping":{"constant":"synthetic"},
        "targets":[{"targetId":"target-1","version":1,"kind":"dry-run","retentionMs":1}],
        "subscribers":[],
        "judges":[],
        "deliveryRateCap":1,
        "retention":{"ingestMs":1,"holdMs":1,"deliveryMs":1,"dryrunMs":1,"sseReplayMs":1,"deadLetterMs":1,"decisionMetadataMs":1}
    });
    let input: ControlInput = serde_json::from_value(json!({
        "request":{"operation":"rule-update","args":{"document":document}},
        "selection":{
            "objectId":"rule-1","version":1,
            "document.ruleId":"rule-1","document.version":1,
            "document.source.channel":"gmail","document.source.accountIds":["account-1"]
        }
    }))
    .unwrap();
    let cross_scope = json!({
        "id":"version-2","kind":"rule","objectId":"rule-2","version":2,
        "document":{
            "ruleId":"rule-2","version":2,
            "source":{"channel":"gmail","accountIds":["account-1"],"options":{"channel":"gmail","labels":"inbox","includeSpamTrash":false}},
            "event":{"type":"gmail.message.received","version":1},"condition":{"path":"/subject","op":"exists"},"mapping":{"constant":"synthetic"},
            "targets":[{"targetId":"target-1","version":1,"kind":"dry-run","retentionMs":1}],"subscribers":[],"judges":[],"deliveryRateCap":1,
            "retention":{"ingestMs":1,"holdMs":1,"deliveryMs":1,"dryrunMs":1,"sseReplayMs":1,"deadLetterMs":1,"decisionMetadataMs":1}
        },"digest":"digest-2","state":null
    });
    assert_eq!(
        execute_control(input, 1, |_| Ok(cross_scope))
            .unwrap_err()
            .code,
        "SCOPE_MISMATCH"
    );
}

// desktop-rust-mutation: desktop-schema-scope-native | cargo --test control_commands | desktop_schema_scoped_dryrun
#[test]
fn desktop_schema_scoped_dryrun() {
    let request = json!({"operation":"dryrun-show","args":{"deliveryId":"delivery-1"}});
    let result = json!({"deliveryId":"delivery-1","ruleId":"rule-1","ruleVersion":2,"targetId":"target-1","targetVersion":3,"eventId":"event-1","accountId":"account-1","deliveredAt":1000,"expiresAt":2000,"record":{"cloudEventBytes":"{}","untrusted":[],"representation":"plain"}});
    let selected = json!({"deliveryId":"delivery-1","accountId":"account-1","targetVersion":3});
    let input: ControlInput =
        serde_json::from_value(json!({"request":request,"selection":selected})).unwrap();
    assert!(
        execute_control(input, 1, |_| Ok(result.clone())).is_ok(),
        "dryrun has no source field in B3"
    );
    for (key, value) in [
        ("deliveryId", json!("other")),
        ("accountId", json!("other")),
        ("targetVersion", json!(4)),
        ("source", json!("invented")),
    ] {
        let mut wrong = selected.clone();
        wrong[key] = value;
        let input: ControlInput =
            serde_json::from_value(json!({"request":request,"selection":wrong})).unwrap();
        assert!(
            execute_control(input, 1, |_| Ok(result.clone())).is_err(),
            "{key}"
        );
    }
    let input: ControlInput =
        serde_json::from_value(json!({"request":request,"selection":null})).unwrap();
    let mut mismatched = result.clone();
    mismatched["deliveryId"] = json!("delivery-other");
    assert_eq!(
        execute_control(input, 1, |_| Ok(mismatched))
            .unwrap_err()
            .code,
        "SCOPE_MISMATCH",
        "request identity binds even without optional UI scope"
    );
}

#[cfg(unix)]
// desktop-rust-mutation: desktop-settings-autostart-no-spawn | cargo --test control_commands | desktop_settings_autostart_no_spawn
#[test]
fn desktop_settings_autostart_no_spawn() {
    struct NoStartupIo;
    impl agentcomms_desktop::supervisor::DaemonRuntime for NoStartupIo {
        fn status(
            &self,
            _: &agentcomms_desktop::preferences::DaemonProfile,
        ) -> Result<
            agentcomms_desktop::supervisor::AuthenticatedStatus,
            agentcomms_desktop::control::types::ControlError,
        > {
            panic!("login must not attach")
        }
        fn stop(
            &self,
            _: &agentcomms_desktop::preferences::DaemonProfile,
            _: &agentcomms_desktop::control::types::InstanceIdentity,
        ) -> Result<(), agentcomms_desktop::control::types::ControlError> {
            panic!("login must not stop")
        }
        fn spawn(
            &self,
            _: &agentcomms_desktop::preferences::DaemonProfile,
        ) -> Result<
            Box<dyn agentcomms_desktop::supervisor::DaemonProcess>,
            agentcomms_desktop::control::types::ControlError,
        > {
            panic!("login must not spawn")
        }
    }
    let temp = tempfile::tempdir().unwrap();
    let store = PreferenceStore::new(
        std::fs::canonicalize(temp.path())
            .unwrap()
            .join("preferences/desktop.json"),
    );
    let supervisor = DesktopSupervisor::with_runtime(std::sync::Arc::new(NoStartupIo));
    assert!(!store.load().unwrap().open_at_login);
    let next = save_preferences(&store, 0, true, true).unwrap();
    assert!(next.open_at_login);
    assert!(store.load().unwrap().open_at_login);
    assert_eq!(format!("{:?}", supervisor.startup().state), "Idle");
    assert!(store.load().unwrap().daemon_profile.is_none());
    assert_eq!(
        save_preferences(&store, 0, false, false).unwrap_err().code,
        "PREFERENCES_CHANGED"
    );
}
