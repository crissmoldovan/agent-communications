use agentcomms_desktop::{
    commands::approval::{submit_approval, ApprovalInput, ApprovalSession},
    preview::render_disclosure_preview,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

fn ready() -> Value {
    serde_json::from_str::<Value>(include_str!(
        "../../../../packages/events-daemon/test/fixtures/b3-approval-preview-v1/ready.json"
    ))
    .unwrap()["result"]
        .clone()
}

// desktop-rust-mutation: desktop-preview-controls | cargo --test preview | desktop_preview_controls
#[test]
fn desktop_preview_controls() {
    let mut value = ready();
    value["preview"] = json!({"documentVersion":1,"kind":"enable-all","switchGeneration":1,"ruleVersions":[{"ruleId":"safe\u{202e}\u{200b}evil","ruleVersion":1}]});
    let text = String::from_utf8(render_disclosure_preview(&value).unwrap()).unwrap();
    assert!(text.contains("safeevil"));
    assert!(!text.contains('\u{202e}'));
    assert!(!text.contains('\u{200b}'));
}

#[test]
fn desktop_preview_shared_fixtures() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("test/fixtures/disclosure-preview");
    let mut files: Vec<_> = fs::read_dir(&folder)
        .expect("the shared disclosure-preview fixture directory must be readable")
        .map(|entry| {
            entry
                .expect("every shared fixture directory entry must be readable")
                .path()
        })
        .collect();
    files.sort();
    assert!(
        !files.is_empty(),
        "the shared disclosure-preview fixture directory must not be empty"
    );
    for file in files {
        assert!(
            file.is_file(),
            "the shared disclosure-preview directory must contain only fixture files: {}",
            file.display()
        );
        let value: Value = serde_json::from_slice(
            &fs::read(&file)
                .unwrap_or_else(|_| panic!("cannot read shared fixture {}", file.display())),
        )
        .unwrap_or_else(|_| panic!("invalid shared fixture {}", file.display()));
        let b3 = b3_terminal_bytes(&value["result"]);
        assert_eq!(
            render_disclosure_preview(&value["result"]).unwrap(),
            b3,
            "Rust and B3 terminal output diverged for {}",
            file.display()
        );
    }
}

#[test]
fn desktop_preview_numbers_match_b3_terminal_bytes() {
    let canonical: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/disclosure-preview/canonical-json.json"
    ))
    .unwrap();
    for number in [
        "1e21",
        "1e-7",
        "-0",
        "9007199254740991",
        "9007199254740992",
        "18446744073709551615",
        "999999999999999900000",
        "1.2345678901234567e-7",
        "2.2250738585072014e-308",
        "0.12345678901234568",
    ] {
        let mut value = canonical["result"].clone();
        value["preview"]["rule"]["mapping"]["constant"]["number"] =
            serde_json::from_str(number).unwrap();
        assert_eq!(
            render_disclosure_preview(&value).unwrap(),
            b3_terminal_bytes(&value),
            "ECMAScript Number-to-String drifted for {number}"
        );
    }
}

/// The production B3 terminal renderer is the independent reference implementation for this text-only contract.
fn b3_terminal_bytes(value: &Value) -> Vec<u8> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let mut child = Command::new("node")
        .current_dir(root)
        .args([
            "--experimental-strip-types",
            "--disable-warning=ExperimentalWarning",
            "--input-type=module",
            "--eval",
            "import { readFileSync } from 'node:fs'; import { renderApprovalViewForTerminal } from './packages/events-daemon/src/cli/program.ts'; process.stdout.write(renderApprovalViewForTerminal(JSON.parse(readFileSync(0, 'utf8'))));",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("B3 production terminal renderer must start");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(&serde_json::to_vec(value).unwrap())
        .unwrap();
    let output = child
        .wait_with_output()
        .expect("B3 production terminal renderer must finish");
    assert!(
        output.status.success(),
        "B3 production terminal renderer failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

// desktop-rust-mutation: desktop-approval-authoritative-preview | cargo --test preview | desktop_approval_authoritative_preview
#[test]
fn desktop_approval_authoritative_preview() {
    assert!(serde_json::from_value::<ApprovalInput>(
        json!({"approvalId":"approval-1","digest":"digest-1","previewFromWebview":"forged"})
    )
    .is_err());
    let mut session = ApprovalSession::default();
    let input: ApprovalInput = serde_json::from_value(
        json!({"approvalId":"approval-1","digest":"digest-1","typedResponse":null}),
    )
    .unwrap();
    let mut calls = vec![];
    let shown = session
        .view(&input, 1000, |request| {
            calls.push(request.operation().wire());
            Ok(ready())
        })
        .unwrap();
    assert_eq!(calls, ["approvalView"]);
    assert_eq!(shown.approval.unwrap().challenge, "challenge-1");
    let mut forged = ready();
    forged["digest"] = json!("other");
    assert_eq!(
        session.view(&input, 1000, |_| Ok(forged)).unwrap_err().code,
        "DIGEST_MISMATCH"
    );
    for kind in ["STALE_APPROVAL", "DIGEST_MISMATCH", "CHALLENGE_EXPIRED"] {
        assert_eq!(
            session
                .view(&input, 1000, |_| Ok(json!({"kind":kind})))
                .unwrap_err()
                .code,
            kind
        );
    }
    session.view(&input, 1000, |_| Ok(ready())).unwrap();
    let wrong: ApprovalInput = serde_json::from_value(
        json!({"approvalId":"approval-1","digest":"digest-1","typedResponse":"wrong"}),
    )
    .unwrap();
    assert_eq!(
        session.submit(&wrong, 1000).unwrap_err().code,
        "CHALLENGE_MISMATCH"
    );
    let correct: ApprovalInput = serde_json::from_value(
        json!({"approvalId":"approval-1","digest":"digest-1","typedResponse":"challenge-1"}),
    )
    .unwrap();
    assert_eq!(
        session.submit(&correct, 1000).unwrap().operation().wire(),
        "approve"
    );
    assert_eq!(
        session.submit(&correct, 301001).unwrap_err().code,
        "STALE_APPROVAL"
    );
    let mut wrong_id = ready();
    wrong_id["challenge"]["approvalId"] = json!("other");
    assert_eq!(
        session
            .view(&input, 1000, |_| Ok(wrong_id))
            .unwrap_err()
            .code,
        "STALE_APPROVAL"
    );
    let mut missing = ready();
    missing["challenge"]
        .as_object_mut()
        .unwrap()
        .remove("challenge");
    assert_eq!(
        session
            .view(&input, 1000, |_| Ok(missing))
            .unwrap_err()
            .code,
        "B3_RESULT_SCHEMA"
    );
}

#[test]
fn desktop_approval_preview_bounds() {
    let mut value = ready();
    value["preview"] = json!({"documentVersion":1,"kind":"enable-all","switchGeneration":1,"ruleVersions":[{"ruleId":"x".repeat(100_000),"ruleVersion":1}]});
    let input: ApprovalInput =
        serde_json::from_value(json!({"approvalId":"approval-1","digest":"digest-1"})).unwrap();
    let mut session = ApprovalSession::default();
    assert_eq!(
        session.view(&input, 1000, |_| Ok(value)).unwrap_err().code,
        "APPROVAL_PREVIEW_TOO_LARGE"
    );
}

// desktop-rust-mutation: desktop-approval-fresh-view | cargo --test preview | desktop_app_approval_view_then_approve_and_reviews_void
#[test]
fn desktop_app_approval_view_then_approve_and_reviews_void() {
    let input: ApprovalInput = serde_json::from_value(
        json!({"approvalId":"approval-1","digest":"digest-1","typedResponse":null}),
    )
    .unwrap();
    let answer: ApprovalInput = serde_json::from_value(
        json!({"approvalId":"approval-1","digest":"digest-1","typedResponse":"challenge-1"}),
    )
    .unwrap();
    let approve_result = json!({
        "intentId":"activation-1",
        "status":"completed",
        "usedAt":"1970-01-01T00:00:00.000Z"
    });

    let mut session = ApprovalSession::default();
    session.view(&input, 1000, |_| Ok(ready())).unwrap();
    let mut calls = vec![];
    let complete = submit_approval(&mut session, &answer, 1000, |request| {
        calls.push(request.operation().wire());
        Ok(approve_result.clone())
    })
    .unwrap();
    assert_eq!(calls, ["approve"]);
    assert_eq!(complete.operation, "approve");
    assert!(complete.approval.is_none());
    assert_eq!(
        submit_approval(&mut session, &answer, 1000, |_| panic!(
            "a used challenge must not be sent"
        ))
        .unwrap_err()
        .code,
        "STALE_APPROVAL"
    );

    let mut session = ApprovalSession::default();
    session.view(&input, 1000, |_| Ok(ready())).unwrap();
    let mut calls = vec![];
    let refreshed = submit_approval(&mut session, &answer, 1000, |request| {
        calls.push(request.operation().wire());
        if request.operation().wire() == "approve" {
            return Err(agentcomms_desktop::control::types::ControlError::new(
                "APPROVAL_VOID",
                "the view was replaced elsewhere",
            ));
        }
        let mut next = ready();
        next["challenge"]["challenge"] = json!("challenge-2");
        Ok(next)
    })
    .unwrap();
    assert_eq!(calls, ["approve", "approvalView"]);
    assert_eq!(refreshed.code.as_deref(), Some("APPROVAL_VOID"));
    assert_eq!(refreshed.approval.unwrap().challenge, "challenge-2");

    let mut session = ApprovalSession::default();
    session.view(&input, 1000, |_| Ok(ready())).unwrap();
    let refreshed = submit_approval(&mut session, &answer, 1000, |request| {
        if request.operation().wire() == "approve" {
            return Err(agentcomms_desktop::control::types::ControlError::new(
                "CHALLENGE_EXPIRED",
                "the daemon challenge expired",
            ));
        }
        let mut next = ready();
        next["challenge"]["challenge"] = json!("challenge-3");
        Ok(next)
    })
    .unwrap();
    assert_eq!(refreshed.code.as_deref(), Some("CHALLENGE_EXPIRED"));
    assert_eq!(refreshed.approval.unwrap().challenge, "challenge-3");
}
