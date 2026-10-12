use serde::Deserialize;
use serde_json::Value;
use std::fmt;

#[derive(serde::Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
pub enum SecretResult {
    Acknowledgement,
    RevealOnce {
        material: zeroize::Zeroizing<String>,
    },
    UrlFingerprint {
        scheme: String,
        host: String,
        port: u16,
        sha256: String,
    },
    MigrationStatus {
        moved: u64,
        leftovers: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    #[serde(rename = "unavailable")]
    Unavailable {
        code: String,
    },
}
impl SecretResult {
    pub fn unavailable() -> Self {
        Self::Unavailable {
            code: "APP_SECRET_CAPABILITY_UNAVAILABLE".into(),
        }
    }
    pub fn checked(
        operation: super::secret_window_capability::SecretOperation,
        mut value: Value,
    ) -> Result<Self, ControlError> {
        use super::secret_window_capability::SecretOperation::*;
        let expected = match operation {
            TargetSecretCreate
            | TargetSecretRotate
            | SubscriberTokenCreate
            | SubscriberTokenRotate => "RevealOnce",
            TargetUrlSet => "UrlFingerprint",
            JudgeKeySet | JudgeKeyRotate => "Acknowledgement",
            MigrateSecrets => "MigrationStatus",
        };
        let kind = value.get("kind").and_then(Value::as_str).unwrap_or("");
        let allowed: &[&str] = match kind {
            "RevealOnce" => &["kind", "material"],
            "UrlFingerprint" => &["kind", "scheme", "host", "port", "sha256"],
            "Acknowledgement" => &["kind"],
            "MigrationStatus" => &["kind", "moved", "leftovers", "code"],
            "unavailable" => &["kind", "code"],
            _ => &[],
        };
        if (kind != expected && kind != "unavailable")
            || value
                .as_object()
                .is_none_or(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
        {
            clear_secret_json(&mut value);
            return Err(ControlError::new(
                "SECRET_RESULT",
                "secret result shape refused",
            ));
        }
        let result = Self::deserialize(&value);
        clear_secret_json(&mut value);
        let result =
            result.map_err(|_| ControlError::new("SECRET_RESULT", "invalid secret result"))?;
        if matches!(&result, Self::Unavailable {code} if code != "APP_SECRET_CAPABILITY_UNAVAILABLE")
        {
            return Err(ControlError::new(
                "SECRET_RESULT",
                "unknown capability refusal",
            ));
        }
        Ok(result)
    }
}

pub fn clear_secret_json(value: &mut Value) {
    use zeroize::Zeroize;
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(clear_secret_json),
        Value::Object(values) => values.values_mut().for_each(clear_secret_json),
        _ => (),
    }
}

pub(crate) struct SecretJson(pub Value);
impl Drop for SecretJson {
    fn drop(&mut self) {
        clear_secret_json(&mut self.0);
    }
}

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
    pub fn data_for(mut self, expected: &str) -> Result<Value, ControlError> {
        let has_data = self.data.is_some();
        let mut data = SecretJson(self.data.take().unwrap_or(Value::Null));
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
        if !has_data {
            return Err(ControlError::new("MALFORMED_FRAME", "missing reply data"));
        }
        Ok(std::mem::take(&mut data.0))
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
