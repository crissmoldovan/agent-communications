#[cfg(unix)]
use super::frame::SUPPORTED;
#[cfg(unix)]
use super::types::InstanceIdentity;
use super::types::{AuthenticatedReply, ControlError};
use crate::preferences::DaemonProfile;
#[cfg(unix)]
use serde_json::Value;

#[derive(Clone, Debug)]
pub enum NonSecretControlRequest {
    Status,
    Doctor,
    Stop,
    B3(Box<super::b3_contract::B3Request>),
}
impl NonSecretControlRequest {
    #[cfg(unix)]
    fn operation(&self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Doctor => "doctor",
            Self::Stop => "stop",
            Self::B3(request) => request.operation().wire(),
        }
    }
}

pub struct DesktopControlClient {
    profile: DaemonProfile,
    client_name: &'static str,
}
impl DesktopControlClient {
    pub fn new(profile: DaemonProfile) -> Self {
        Self::with_client_name(profile, "desktop")
    }

    /// Approval owns a separate authenticated session so its origin is explicit to the daemon and audit fence.
    pub fn with_client_name(profile: DaemonProfile, client_name: &'static str) -> Self {
        Self {
            profile,
            client_name,
        }
    }

    pub fn request(
        &self,
        operation: NonSecretControlRequest,
    ) -> Result<AuthenticatedReply, ControlError> {
        #[cfg(windows)]
        {
            let _ = operation;
            return Self::windows_pre_read_refusal(&self.profile);
        }
        #[cfg(unix)]
        {
            self.request_checked(operation, &SUPPORTED, None)
        }
    }

    /// Kept platform-independent so the no-profile-read refusal can be exercised in Unix CI.
    pub fn windows_pre_read_refusal(
        _profile: &DaemonProfile,
    ) -> Result<AuthenticatedReply, ControlError> {
        Err(ControlError::windows_unavailable())
    }

    #[cfg(unix)]
    pub fn request_for_identity(
        &self,
        operation: NonSecretControlRequest,
        expected: &InstanceIdentity,
    ) -> Result<AuthenticatedReply, ControlError> {
        self.request_checked(operation, &SUPPORTED, Some(expected))
    }

    /// The probe can request an intentionally disjoint version; the app always uses SUPPORTED.
    #[cfg(unix)]
    pub fn request_with_versions(
        &self,
        operation: NonSecretControlRequest,
        versions: &[u32],
    ) -> Result<AuthenticatedReply, ControlError> {
        self.request_checked(operation, versions, None)
    }

    #[cfg(unix)]
    fn request_checked(
        &self,
        operation: NonSecretControlRequest,
        versions: &[u32],
        expected: Option<&InstanceIdentity>,
    ) -> Result<AuthenticatedReply, ControlError> {
        use super::frame::{decode_frame, encode_frame, select_version, MAX_FRAME_BYTES};
        use super::types::{remote_code, ControlReply};
        use crate::preferences::{verify_private, ProfilePaths};
        use serde::Deserialize;
        use serde_json::json;
        use std::fs;
        use std::io::{Read, Write};
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        use std::os::unix::net::UnixStream;
        use std::path::Path;
        use std::time::Duration;

        #[derive(Deserialize, PartialEq, Eq)]
        #[serde(rename_all = "camelCase")]
        struct Instance {
            instance_id: String,
            pid: u32,
            process_start: String,
            endpoint: String,
            token_fingerprint: String,
        }

        impl Instance {
            fn identity(&self) -> Result<InstanceIdentity, ControlError> {
                if self.instance_id.len() != 32
                    || !self
                        .instance_id
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || self.pid == 0
                    || self.process_start.is_empty()
                {
                    return Err(ControlError::new(
                        "MALFORMED_INSTANCE",
                        "invalid owner identity",
                    ));
                }
                Ok(InstanceIdentity {
                    instance_id: self.instance_id.clone(),
                    pid: self.pid,
                    process_start: self.process_start.clone(),
                })
            }
        }

        fn private_file(path: &Path) -> Result<String, ControlError> {
            verify_private(path, false)?;
            fs::read_to_string(path)
                .map_err(|_| ControlError::new("CONTROL_PATH", "cannot read control record"))
        }
        fn read_instance(paths: &ProfilePaths) -> Result<Instance, ControlError> {
            let instance_text = match private_file(&paths.instance) {
                Ok(text) => text,
                Err(error) if error.code == "PRIVATE_PATH_MISSING" => {
                    return Err(ControlError::new("NOT_FOUND", "daemon is not running"))
                }
                Err(error) => return Err(error),
            };
            serde_json::from_str(&instance_text)
                .map_err(|_| ControlError::new("MALFORMED_INSTANCE", "invalid instance record"))
        }
        fn verify_endpoint(paths: &ProfilePaths, record: &Instance) -> Result<(), ControlError> {
            verify_private(&paths.root, true)?;
            verify_private(&paths.socket_dir, true)?;
            if record.endpoint != paths.socket.to_string_lossy() {
                return Err(ControlError::new(
                    "CONTROL_ENDPOINT_DRIFT",
                    "instance endpoint changed",
                ));
            }
            let metadata = fs::symlink_metadata(&paths.socket)
                .map_err(|_| ControlError::new("NOT_FOUND", "control socket is absent"))?;
            if !metadata.file_type().is_socket()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o077 != 0
            {
                return Err(ControlError::new(
                    "CONTROL_ENDPOINT_UNSAFE",
                    "socket is not private",
                ));
            }
            // The kernel traverses these ancestors before it can reach the socket.
            let mut ancestor = fs::canonicalize(
                paths
                    .socket_dir
                    .parent()
                    .ok_or_else(|| ControlError::new("CONTROL_PATH", "socket has no parent"))?,
            )
            .map_err(|_| ControlError::new("CONTROL_PATH", "cannot resolve socket parent"))?;
            loop {
                let m = fs::symlink_metadata(&ancestor).map_err(|_| {
                    ControlError::new("CONTROL_PATH", "cannot inspect socket ancestor")
                })?;
                if (m.uid() != unsafe { libc::geteuid() } && m.uid() != 0)
                    || (m.mode() & 0o022 != 0 && m.mode() & 0o1000 == 0)
                {
                    return Err(ControlError::new(
                        "CONTROL_ENDPOINT_UNSAFE",
                        "socket ancestor is unsafe",
                    ));
                }
                if !ancestor.pop() {
                    break;
                }
            }
            Ok(())
        }
        fn exchange(stream: &mut UnixStream, value: &Value) -> Result<Value, ControlError> {
            let frame = encode_frame(value)?;
            stream
                .write_all(&frame)
                .map_err(|_| ControlError::new("CONTROL_IO", "cannot send control frame"))?;
            let mut prefix = [0u8; 4];
            stream
                .read_exact(&mut prefix)
                .map_err(|_| ControlError::new("CONTROL_IO", "cannot read frame prefix"))?;
            let length = u32::from_be_bytes(prefix) as usize;
            if length > MAX_FRAME_BYTES {
                return Err(ControlError::new(
                    "FRAME_TOO_LARGE",
                    "remote frame exceeds limit",
                ));
            }
            let mut frame = Vec::with_capacity(length + 4);
            frame.extend_from_slice(&prefix);
            frame.resize(length + 4, 0);
            stream
                .read_exact(&mut frame[4..])
                .map_err(|_| ControlError::new("CONTROL_IO", "cannot read control frame"))?;
            decode_frame(&frame)
        }

        let paths = self.profile.paths()?;
        verify_private(&self.profile.state_dir, true)?;
        let record = read_instance(&paths)?;
        let identity = record.identity()?;
        if expected.is_some_and(|selected| selected != &identity) {
            return Err(ControlError::new(
                "CONTROL_OWNER_CHANGED",
                "owner identity changed",
            ));
        }
        verify_endpoint(&paths, &record)?;
        let token = read_token(&paths, &record.token_fingerprint)?;
        verify_endpoint(&paths, &record)?;
        let mut stream = UnixStream::connect(&paths.socket)
            .map_err(|_| ControlError::new("NOT_FOUND", "daemon is not listening"))?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|_| ControlError::new("CONTROL_IO", "cannot set read timeout"))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|_| ControlError::new("CONTROL_IO", "cannot set write timeout"))?;
        let hello = exchange(
            &mut stream,
            &json!({"hello":{"supportedVersions":versions,"token":token,"client":{"name":self.client_name}}}),
        )?;
        let hello: ControlReply = serde_json::from_value(hello)
            .map_err(|_| ControlError::new("MALFORMED_FRAME", "invalid hello reply"))?;
        if !hello.ok {
            return Err(ControlError::new(remote_code(hello.error), "hello refused"));
        }
        let version = hello
            .version
            .ok_or_else(|| ControlError::new("MALFORMED_FRAME", "hello has no version"))?;
        select_version(versions, &[version])?;
        let session = hello
            .session
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or_else(|| ControlError::new("MALFORMED_FRAME", "hello has no session"))?;
        if read_instance(&paths)? != record {
            return Err(ControlError::new(
                "CONTROL_OWNER_CHANGED",
                "owner changed after hello",
            ));
        }
        static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let request_id = format!(
            "desktop-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let reply = exchange(
            &mut stream,
            &json!({"version":version,"requestId":request_id,"session":session,"operation":operation.operation(),"args":match &operation { NonSecretControlRequest::B3(request) => request.args(), _ => json!({}) }}),
        )?;
        let reply: ControlReply = serde_json::from_value(reply)
            .map_err(|_| ControlError::new("MALFORMED_FRAME", "invalid operation reply"))?;
        let data = reply.data_for(&request_id)?;
        if read_instance(&paths)? != record {
            return Err(ControlError::new(
                "CONTROL_OWNER_CHANGED",
                "owner changed after reply",
            ));
        }
        Ok(AuthenticatedReply { data, identity })
    }
}

#[cfg(unix)]
fn read_token(
    paths: &crate::preferences::ProfilePaths,
    expected_fingerprint: &str,
) -> Result<String, ControlError> {
    use crate::preferences::verify_private;
    use sha2::{Digest, Sha256};
    verify_private(&paths.token, false)?;
    let token = std::fs::read_to_string(&paths.token)
        .map_err(|_| ControlError::new("CONTROL_TOKEN", "cannot read token"))?;
    let token = token.trim().to_string();
    if token.len() != 64
        || !token
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(ControlError::new("CONTROL_TOKEN", "invalid token record"));
    }
    let fingerprint = format!("{:x}", Sha256::digest(token.as_bytes()));
    if fingerprint != expected_fingerprint {
        return Err(ControlError::new(
            "CONTROL_TOKEN",
            "token fingerprint mismatch",
        ));
    }
    Ok(token)
}
