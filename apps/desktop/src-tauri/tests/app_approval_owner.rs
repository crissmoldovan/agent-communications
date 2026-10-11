//! Driven by `apps/desktop/test/app-approval-owner.test.mjs`, which starts a sealed real B3 owner.
//! Kept ignored for ordinary Cargo runs because it needs that owner process and its owner-only Unix socket.
#[cfg(unix)]
use agentcomms_desktop::{
    commands::{
        approval::ApprovalInput,
        control::{app_approval_over_control, ControlState},
    },
    control::{
        b3_contract::B3Request,
        client::{DesktopControlClient, NonSecretControlRequest},
    },
    preferences::DaemonProfile,
};
#[cfg(unix)]
use serde_json::json;
#[cfg(unix)]
use std::{env, path::PathBuf};

#[cfg(unix)]
fn environment(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| panic!("{name} is required by the real-owner harness"))
}

#[cfg(unix)]
#[test]
#[ignore = "requires the loopback-sealed real B3 owner harness"]
fn desktop_app_approval_real_owner() {
    let profile = DaemonProfile::new(
        PathBuf::from(environment("APP_APPROVAL_EXECUTABLE")),
        PathBuf::from(environment("APP_APPROVAL_STATE_DIR")),
        PathBuf::from(environment("APP_APPROVAL_CONFIG_DIR")),
    )
    .unwrap();
    let first_id = environment("APP_APPROVAL_ID");
    let first_digest = environment("APP_APPROVAL_DIGEST");
    let mut state = ControlState::default();
    let approval_client =
        DesktopControlClient::with_client_name(profile.clone(), "app-approval-screen");
    let first_view: ApprovalInput = serde_json::from_value(json!({
        "approvalId":first_id,"digest":first_digest,"typedResponse":null
    }))
    .unwrap();
    let shown =
        app_approval_over_control(&mut state, &first_view, 1_000, &approval_client).unwrap();
    let answer = shown
        .approval
        .as_ref()
        .expect("only the real owner's view creates the screen challenge")
        .challenge
        .clone();
    let completed: ApprovalInput = serde_json::from_value(json!({
        "approvalId":first_id,"digest":first_digest,"typedResponse":answer
    }))
    .unwrap();
    let done = app_approval_over_control(&mut state, &completed, 1_000, &approval_client).unwrap();
    assert_eq!(done.operation, "approve");
    assert!(done.approval.is_none());

    // The second real activation is prepared by the harness. The ordinary client creates it; only the native app
    // client can subsequently use the returned id/digest/typed answer.
    let enable = B3Request::parse(json!({
        "operation":"rule-enable","args":{"ruleId":"rule-b3-app-approval-2","version":1}
    }))
    .unwrap();
    let prepared = DesktopControlClient::new(profile.clone())
        .request(NonSecretControlRequest::B3(Box::new(enable)))
        .unwrap()
        .data;
    let second_id = prepared["approvalId"].as_str().unwrap().to_owned();
    let second_digest = prepared["binding"]["digest"].as_str().unwrap().to_owned();
    let second_view: ApprovalInput = serde_json::from_value(json!({
        "approvalId":second_id,"digest":second_digest,"typedResponse":null
    }))
    .unwrap();
    let shown =
        app_approval_over_control(&mut state, &second_view, 1_000, &approval_client).unwrap();
    let stale_answer = shown.approval.as_ref().unwrap().challenge.clone();

    // A separate B3 session views the same approval between paint and submit, replacing its challenge. The app must
    // fail closed, fetch the replacement view, and never forward the first answer again.
    let intervening_view = B3Request::parse(json!({
        "operation":"approvalView","args":{"approvalId":second_id,"digest":second_digest}
    }))
    .unwrap();
    DesktopControlClient::with_client_name(profile, "second-approval-screen")
        .request(NonSecretControlRequest::B3(Box::new(intervening_view)))
        .unwrap();
    let stale_submit: ApprovalInput = serde_json::from_value(json!({
        "approvalId":second_id,"digest":second_digest,"typedResponse":stale_answer
    }))
    .unwrap();
    let refreshed =
        app_approval_over_control(&mut state, &stale_submit, 1_000, &approval_client).unwrap();
    assert_eq!(refreshed.code.as_deref(), Some("APPROVAL_VOID"));
    assert_ne!(
        refreshed.approval.unwrap().challenge,
        stale_submit.typed_response.unwrap()
    );
}

#[cfg(not(unix))]
#[test]
#[ignore = "Unix owner harness is not available on Windows"]
fn desktop_app_approval_real_owner() {}
