use agentcomms_desktop::control::frame::{
    decode_frame, encode_frame, select_version, MAX_FRAME_BYTES,
};
use agentcomms_desktop::control::types::{ControlError, ControlReply};
use serde_json::json;

#[test]
fn frame_prefix_is_big_endian_and_exact() {
    let encoded = encode_frame(&json!({"ok":true})).unwrap();
    assert_eq!(&encoded[..4], &[0, 0, 0, 11]);
    assert_eq!(decode_frame(&encoded).unwrap(), json!({"ok":true}));
    assert!(decode_frame(&encoded[..encoded.len() - 1]).is_err());
    assert!(decode_frame(&[0, 0, 0, 0, b'{']).is_err());
}

// desktop-rust-mutation: desktop-frame-bounds | cargo --test control_frames | malformed_and_oversized_frames_are_rejected
#[test]
fn malformed_and_oversized_frames_are_rejected() {
    assert!(decode_frame(&[0, 0, 0]).is_err());
    assert!(decode_frame(&[0, 0, 0, 1, 0xff]).is_err());
    let mut too_large = vec![0; 4];
    too_large.copy_from_slice(&((MAX_FRAME_BYTES + 1) as u32).to_be_bytes());
    assert!(decode_frame(&too_large).is_err());
    let oversized_json = serde_json::to_vec(&"x".repeat(MAX_FRAME_BYTES)).unwrap();
    let mut complete_oversized = (oversized_json.len() as u32).to_be_bytes().to_vec();
    complete_oversized.extend_from_slice(&oversized_json);
    assert!(decode_frame(&complete_oversized).is_err());
}

// desktop-rust-mutation: desktop-no-overlap | cargo --test control_frames | negotiation_picks_highest_mutual_and_rejects_disjoint
#[test]
fn negotiation_picks_highest_mutual_and_rejects_disjoint() {
    assert_eq!(select_version(&[1, 3], &[1, 2, 3]).unwrap(), 3);
    assert_eq!(
        select_version(&[1], &[2]).unwrap_err().code,
        "PROTOCOL_UNSUPPORTED"
    );
}

// desktop-rust-mutation: desktop-control-stale-reply | cargo --test control_frames | reply_requires_exact_request_id
#[test]
fn reply_requires_exact_request_id() {
    let reply: ControlReply =
        serde_json::from_value(json!({"ok":true,"requestId":"wrong","data":{}})).unwrap();
    assert_eq!(
        reply.data_for("expected").unwrap_err().code,
        "CONTROL_STALE_REPLY"
    );
}

// desktop-rust-mutation: desktop-token-redaction | cargo --test control_frames | control_error_never_exposes_token
#[test]
fn control_error_never_exposes_token() {
    let secret = "f".repeat(64);
    let error = ControlError::new("AUTH_REQUIRED", format!("invalid token {secret}"));
    assert!(!error.to_string().contains(&secret));
    assert!(!format!("{error:?}").contains(&secret));
}

// desktop-rust-mutation: desktop-windows-pre-read-refusal | cargo --test control_frames | windows_refusal_does_not_open_token_even_if_read_error_is_discarded
#[cfg(unix)]
#[test]
fn windows_refusal_does_not_open_token_even_if_read_error_is_discarded() {
    use agentcomms_desktop::control::client::DesktopControlClient;
    use agentcomms_desktop::preferences::DaemonProfile;
    use std::ffi::CString;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::PermissionsExt;
    use std::thread;
    use std::time::Duration;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executable = root.join("agent-events");
    let state_dir = root.join("state");
    let config_dir = root.join("config");
    let events = state_dir.join("events");
    fs::write(&executable, b"synthetic executable").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(&state_dir).unwrap();
    fs::create_dir(&config_dir).unwrap();
    fs::create_dir(&events).unwrap();
    for directory in [&state_dir, &config_dir, &events] {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let token = events.join("control.token");
    let token_c = CString::new(token.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(token_c.as_ptr(), 0o600) }, 0);
    let trap = DaemonProfile::new(executable, state_dir, config_dir).unwrap();
    let worker = thread::spawn(move || DesktopControlClient::windows_pre_read_refusal(&trap));
    let mut token_opened = false;
    for _ in 0..200 {
        if worker.is_finished() {
            break;
        }
        // O_WRONLY|O_NONBLOCK succeeds only while a reader is opening this FIFO.
        let writer = unsafe { libc::open(token_c.as_ptr(), libc::O_WRONLY | libc::O_NONBLOCK) };
        if writer >= 0 {
            token_opened = true;
            assert_eq!(unsafe { libc::write(writer, b"x".as_ptr().cast(), 1) }, 1);
            assert_eq!(unsafe { libc::close(writer) }, 0);
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    // Rescue a blocked mutant worker so the assertion reports a failure, not a hang.
    if !worker.is_finished() && !token_opened {
        let writer = unsafe { libc::open(token_c.as_ptr(), libc::O_RDWR | libc::O_NONBLOCK) };
        assert!(writer >= 0);
        assert_eq!(unsafe { libc::write(writer, b"x".as_ptr().cast(), 1) }, 1);
        assert_eq!(unsafe { libc::close(writer) }, 0);
    }
    assert_eq!(
        worker.join().unwrap().unwrap_err().code,
        "WINDOWS_CONTROL_UNAVAILABLE"
    );
    assert!(!token_opened, "Windows refusal opened the token path");
}

// desktop-rust-mutation: desktop-endpoint-proof | cargo --test control_frames | endpoint_is_proved_before_token_file_is_opened
#[cfg(unix)]
#[test]
fn endpoint_is_proved_before_token_file_is_opened() {
    use agentcomms_desktop::control::client::{DesktopControlClient, NonSecretControlRequest};
    use agentcomms_desktop::preferences::DaemonProfile;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executable = root.join("agent-events");
    let state_dir = root.join("state");
    let config_dir = root.join("config");
    fs::write(&executable, b"fixture").unwrap();
    fs::create_dir(&state_dir).unwrap();
    fs::create_dir(&config_dir).unwrap();
    for path in [&executable, &state_dir, &config_dir] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let events = state_dir.join("events");
    fs::create_dir(&events).unwrap();
    fs::set_permissions(&events, fs::Permissions::from_mode(0o700)).unwrap();
    fs::create_dir(events.join("socket")).unwrap();
    fs::set_permissions(events.join("socket"), fs::Permissions::from_mode(0o700)).unwrap();
    let endpoint = events.join("socket/control.sock");
    fs::write(
        events.join("instance.json"),
        serde_json::to_vec(&json!({
            "instanceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "pid":42,
            "processStart":"42:fixture", "endpoint":endpoint,
            "tokenFingerprint":"unused"
        }))
        .unwrap(),
    )
    .unwrap();
    fs::set_permissions(
        events.join("instance.json"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let profile = DaemonProfile::new(executable, state_dir, config_dir).unwrap();
    let error = DesktopControlClient::new(profile)
        .request(NonSecretControlRequest::Status)
        .unwrap_err();
    assert_eq!(error.code, "NOT_FOUND"); // socket is absent before token access
}

#[test]
fn shared_node_vectors_decode_in_rust() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/events-daemon/test/fixtures/control-protocol-v1.json"
    ))
    .unwrap();
    for name in ["validHello", "validRequest", "success", "failure"] {
        let value = &vectors[name];
        assert_eq!(decode_frame(&encode_frame(value).unwrap()).unwrap(), *value);
    }
    let bytes = hex::decode(vectors["simpleFrameHex"].as_str().unwrap()).unwrap();
    assert_eq!(encode_frame(&json!({"ok":true})).unwrap(), bytes);
    assert_eq!(decode_frame(&bytes).unwrap(), json!({"ok":true}));
}

#[cfg(windows)]
#[test]
fn windows_refusal_does_not_open_token_even_if_read_error_is_discarded() {
    use agentcomms_desktop::control::client::{DesktopControlClient, NonSecretControlRequest};
    use agentcomms_desktop::preferences::DaemonProfile;
    use std::ffi::{c_void, OsStr};
    use std::fs;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::symlink_file;
    use std::ptr;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    #[allow(non_snake_case)] // Keep the exact Win32 ABI names in the test-only declarations.
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateNamedPipeW(
            name: *const u16,
            open_mode: u32,
            pipe_mode: u32,
            max_instances: u32,
            out_buffer: u32,
            in_buffer: u32,
            default_timeout: u32,
            security: *mut c_void,
        ) -> *mut c_void;
        fn ConnectNamedPipe(pipe: *mut c_void, overlapped: *mut c_void) -> i32;
        fn WriteFile(
            file: *mut c_void,
            buffer: *const c_void,
            bytes_to_write: u32,
            bytes_written: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
        fn GetLastError() -> u32;
    }

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let executable = root.join("agent-events");
    let state_dir = root.join("state");
    let config_dir = root.join("config");
    fs::write(&executable, b"synthetic executable").unwrap();
    fs::create_dir_all(state_dir.join("events")).unwrap();
    fs::create_dir(&config_dir).unwrap();
    let pipe_name = format!(
        r"\\.\pipe\agentcomms-desktop-pre-read-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let wide: Vec<u16> = OsStr::new(&pipe_name)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let spawn_server = || {
        let pipe = unsafe { CreateNamedPipeW(wide.as_ptr(), 3, 0, 1, 16, 16, 0, ptr::null_mut()) };
        assert_ne!(
            pipe as isize,
            -1,
            "CreateNamedPipeW: {}",
            std::io::Error::last_os_error()
        );
        let connected = Arc::new(AtomicBool::new(false));
        let observed = Arc::clone(&connected);
        let pipe_value = pipe as usize;
        let server = thread::spawn(move || {
            let pipe = pipe_value as *mut c_void;
            let ok = unsafe { ConnectNamedPipe(pipe, ptr::null_mut()) };
            assert!(
                ok != 0 || unsafe { GetLastError() } == 535,
                "ConnectNamedPipe failed"
            );
            observed.store(true, Ordering::SeqCst);
            let mut written = 0;
            let byte = b"x";
            assert_ne!(
                unsafe { WriteFile(pipe, byte.as_ptr().cast(), 1, &mut written, ptr::null_mut()) },
                0
            );
            assert_eq!(written, 1);
            assert_ne!(unsafe { CloseHandle(pipe) }, 0);
        });
        (connected, server)
    };
    let token = state_dir.join("events/control.token");
    let (canary_connected, canary_server) = spawn_server();
    symlink_file(&pipe_name, &token)
        .expect("Windows CI must permit a synthetic token symlink to the local named-pipe trap");
    assert_eq!(
        fs::read(&token).expect("the token path must reach the named-pipe trap"),
        b"x".to_vec()
    );
    assert!(canary_connected.load(Ordering::SeqCst));
    canary_server.join().unwrap();
    let (connected, server) = spawn_server();
    let profile = DaemonProfile::new(executable, state_dir, config_dir).unwrap();
    let result = DesktopControlClient::new(profile).request(NonSecretControlRequest::Status);
    assert_eq!(result.unwrap_err().code, "WINDOWS_CONTROL_UNAVAILABLE");
    assert!(
        !connected.load(Ordering::SeqCst),
        "public request opened the token path"
    );
    // Release the waiting server without observing a production client read.
    let cleanup = fs::read(&pipe_name).unwrap();
    assert_eq!(cleanup, b"x".to_vec());
    server.join().unwrap();
}
