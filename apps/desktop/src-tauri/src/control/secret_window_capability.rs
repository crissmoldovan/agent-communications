use super::types::ControlError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretOperation {
    TargetSecretCreate,
    TargetSecretRotate,
    TargetUrlSet,
    SubscriberTokenCreate,
    SubscriberTokenRotate,
    JudgeKeySet,
    JudgeKeyRotate,
    MigrateSecrets,
}
impl SecretOperation {
    pub fn wire(self) -> &'static str {
        match self {
            Self::TargetSecretCreate => "targetSecretCreate",
            Self::TargetSecretRotate => "targetSecretRotate",
            Self::TargetUrlSet => "targetUrlSet",
            Self::SubscriberTokenCreate => "subscriberTokenCreate",
            Self::SubscriberTokenRotate => "subscriberTokenRotate",
            Self::JudgeKeySet => "judgeKeySet",
            Self::JudgeKeyRotate => "judgeKeyRotate",
            Self::MigrateSecrets => "migrateSecrets",
        }
    }
}

/// No Deserialize/Clone/Debug or string-label constructor: only a native window can create this witness.
pub struct SecretWindowCapability {
    _native: (),
}
impl SecretWindowCapability {
    pub fn for_window<R: tauri::Runtime>(
        window: &tauri::WebviewWindow<R>,
    ) -> Result<Self, ControlError> {
        if window.label() != "secrets" {
            return Err(ControlError::new(
                "WINDOW_NOT_AUTHORIZED",
                "secret window required",
            ));
        }
        Ok(Self { _native: () })
    }

    pub fn proof(
        &self,
        key: &DesktopCapabilityKey,
        session: &str,
        operation: &str,
        nonce: &str,
    ) -> Result<SecretProof, ControlError> {
        let _: SecretOperation =
            serde_json::from_value(serde_json::Value::String(operation.to_owned()))
                .map_err(|_| ControlError::new("SECRET_OPERATION", "unknown secret operation"))?;
        if session.is_empty()
            || session.len() > 256
            || nonce.len() != 64
            || !nonce
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        {
            return Err(ControlError::new(
                "SECRET_CAPABILITY",
                "invalid nonce binding",
            ));
        }
        // RFC 2104 HMAC-SHA256 with a fixed 32-byte key. Pads and intermediate digest are zeroized.
        let mut inner_pad = Zeroizing::new([0x36_u8; 64]);
        let mut outer_pad = Zeroizing::new([0x5c_u8; 64]);
        for index in 0..32 {
            inner_pad[index] ^= key.0[index];
            outer_pad[index] ^= key.0[index];
        }
        let mut inner = Sha256::new();
        inner.update(inner_pad.as_slice());
        inner.update(session.as_bytes());
        inner.update(operation.as_bytes());
        inner.update(nonce.as_bytes());
        let mut digest = inner.finalize();
        let mut outer = Sha256::new();
        outer.update(outer_pad.as_slice());
        outer.update(digest.as_slice());
        digest.as_mut_slice().zeroize();
        let mut digest = outer.finalize();
        let mac = Zeroizing::new(digest.iter().map(|byte| format!("{byte:02x}")).collect());
        digest.as_mut_slice().zeroize();
        Ok(SecretProof {
            nonce: Zeroizing::new(nonce.to_owned()),
            mac,
        })
    }
}

#[derive(Serialize)]
pub struct SecretProof {
    nonce: Zeroizing<String>,
    mac: Zeroizing<String>,
}

pub struct DesktopCapabilityKey(Zeroizing<[u8; 32]>);
impl DesktopCapabilityKey {
    pub fn generate() -> Result<Self, ControlError> {
        let mut bytes = Zeroizing::new([0_u8; 32]);
        getrandom::fill(bytes.as_mut())
            .map_err(|_| ControlError::new("SECRET_CAPABILITY", "random source unavailable"))?;
        Ok(Self(bytes))
    }

    /// Writes before spawn, so the child's sole read sees exactly 32 bytes and EOF; neither end survives exec.
    #[cfg(unix)]
    pub fn spawn(
        &self,
        command: &mut std::process::Command,
    ) -> Result<std::process::Child, ControlError> {
        use std::{
            io::Write,
            os::{
                fd::{AsRawFd, FromRawFd, OwnedFd},
                unix::process::CommandExt,
            },
        };
        let mut descriptors = [-1; 2];
        if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
            return Err(ControlError::new(
                "DAEMON_SPAWN",
                "capability pipe unavailable",
            ));
        }
        let read = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
        let write = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
        for fd in [read.as_raw_fd(), write.as_raw_fd()] {
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                return Err(ControlError::new(
                    "DAEMON_SPAWN",
                    "capability pipe unavailable",
                ));
            }
        }
        let mut write = std::fs::File::from(write);
        write
            .write_all(self.0.as_ref())
            .map_err(|_| ControlError::new("DAEMON_SPAWN", "capability pipe unavailable"))?;
        drop(write);
        command
            .env("AGENTCOMMS_DESKTOP_CAPABILITY_FD", "3")
            .env_remove("AGENTCOMMS_DESKTOP_CAPABILITY_KEY")
            .env_remove("AGENTCOMMS_DESKTOP_CAPABILITY_FILE");
        unsafe {
            command.pre_exec(move || {
                if read.as_raw_fd() != 3 && libc::dup2(read.as_raw_fd(), 3) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::fcntl(3, libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
            .spawn()
            .map_err(|_| ControlError::new("DAEMON_SPAWN", "cannot spawn capability owner"))
    }
}
