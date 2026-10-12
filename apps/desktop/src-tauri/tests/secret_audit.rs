use agentcomms_desktop::control::{secret_window_capability::SecretOperation, types::SecretResult};
use serde_json::json;

#[test]
fn hidden_input_operations_never_accept_reveal_or_extra_fields() {
    for operation in [
        SecretOperation::JudgeKeySet,
        SecretOperation::JudgeKeyRotate,
        SecretOperation::TargetUrlSet,
        SecretOperation::MigrateSecrets,
    ] {
        assert!(SecretResult::checked(
            operation,
            json!({"kind":"RevealOnce","material":"synthetic-entry"})
        )
        .is_err());
    }
    for field in ["host", "fingerprint", "secretReference"] {
        assert!(SecretResult::checked(
            SecretOperation::JudgeKeySet,
            json!({"kind":"Acknowledgement",field:"synthetic"})
        )
        .is_err());
    }
    assert!(SecretResult::checked(
        SecretOperation::TargetSecretCreate,
        json!({"kind":"RevealOnce","material":"synthetic-generated"})
    )
    .is_ok());
}

#[test]
fn native_lifecycle_invalidates_all_pending_results() {
    let lifecycle = agentcomms_desktop::commands::secrets::SecretLifecycle::default();
    let epoch = lifecycle.begin();
    assert!(lifecycle.current(epoch));
    lifecycle.clear();
    assert!(!lifecycle.current(epoch));
    let next = lifecycle.begin();
    assert!(!lifecycle.current(epoch));
    assert!(lifecycle.current(next));
}

#[cfg(unix)]
#[test]
fn native_lifecycle_closes_pending_secret_stream() {
    use agentcomms_desktop::commands::secrets::SecretLifecycle;
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    let lifecycle = SecretLifecycle::default();
    let epoch = lifecycle.begin();
    let (stream, mut peer) = UnixStream::pair().unwrap();
    peer.set_read_timeout(Some(std::time::Duration::from_millis(100)))
        .unwrap();
    let _pending = lifecycle.watch(epoch, &stream).unwrap();
    lifecycle.clear();
    assert_eq!(peer.read(&mut [0_u8; 1]).unwrap(), 0);
    assert!(lifecycle.watch(epoch, &stream).is_err());
}
