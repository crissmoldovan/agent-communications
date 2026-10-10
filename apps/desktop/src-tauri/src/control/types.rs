use serde::Deserialize;
use serde_json::Value;
use std::fmt;

/// Public errors carry a stable code only. `message` is deliberately private and never formatted.
pub struct ControlError {
    pub code: String,
    message: String,
}

impl ControlError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn windows_unavailable() -> Self {
        Self::new(
            "WINDOWS_CONTROL_UNAVAILABLE",
            "desktop control is unavailable on Windows",
        )
    }
    pub fn public_message(&self) -> &'static str {
        let _ = &self.message;
        "local event control request failed"
    }
}

impl fmt::Display for ControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.code)
    }
}
impl fmt::Debug for ControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ControlError")
            .field("code", &self.code)
            .finish()
    }
}
impl std::error::Error for ControlError {}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceIdentity {
    pub instance_id: String,
    pub pid: u32,
    pub process_start: String,
}

#[derive(Debug)]
pub struct AuthenticatedReply {
    pub data: Value,
    pub identity: InstanceIdentity,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlReply {
    pub ok: bool,
    pub request_id: Option<String>,
    pub data: Option<Value>,
    pub version: Option<u32>,
    pub session: Option<String>,
    pub error: Option<RemoteError>,
}

#[derive(Deserialize)]
pub struct RemoteError {
    pub code: String,
}

impl ControlReply {
    pub fn data_for(self, expected: &str) -> Result<Value, ControlError> {
        let request_id = self.request_id.as_deref().unwrap_or_default();
        if request_id != expected {
            return Err(ControlError::new(
                "CONTROL_STALE_REPLY",
                "request id did not match",
            ));
        }
        if !self.ok {
            return Err(ControlError::new(
                remote_code(self.error),
                "remote operation refused",
            ));
        }
        self.data
            .ok_or_else(|| ControlError::new("MALFORMED_FRAME", "missing reply data"))
    }
}

pub fn remote_code(error: Option<RemoteError>) -> String {
    let Some(error) = error else {
        return "MALFORMED_FRAME".into();
    };
    if error.code.len() > 64
        || error.code.is_empty()
        || !error
            .code
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b == b'_' || b.is_ascii_digit())
    {
        return "MALFORMED_FRAME".into();
    }
    error.code
}
