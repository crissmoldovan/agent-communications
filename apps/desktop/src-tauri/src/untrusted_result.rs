use crate::{control::b3_contract::B3Reply, preview::neutralise};
use serde::Serialize;
use serde_json::Value;

pub const MAX_SEGMENT_BYTES: usize = 4096;
pub const MAX_RESULT_BYTES: usize = 65536;
const MAX_SEGMENTS: usize = 48;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeSegment {
    pub path: String,
    pub text: String,
    pub trust: &'static str,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeApproval {
    pub approval_id: String,
    pub digest: String,
    pub challenge: String,
    pub expires_at: i64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeAppResult {
    pub operation: String,
    pub segments: Vec<SafeSegment>,
    pub code: Option<String>,
    pub truncated: bool,
    pub approval: Option<SafeApproval>,
}

pub struct UntrustedAppResult;
impl UntrustedAppResult {
    pub fn from_b3(reply: B3Reply) -> SafeAppResult {
        let operation = reply.operation.wire().to_owned();
        let value = reply.safe_boundary_value();
        let mut result = SafeAppResult {
            operation,
            segments: vec![],
            code: None,
            truncated: false,
            approval: None,
        };
        // Stable codes are lifted only from schema-closed unavailable variants, never from opaque list items.
        if value.get("kind").and_then(Value::as_str) == Some("unavailable") {
            result.code = value.get("code").and_then(Value::as_str).map(str::to_owned);
        }
        let mut budget = MAX_RESULT_BYTES / 4;
        result.flatten("", &value, &mut budget, 0);
        result
    }
    pub fn error(code: &str, provider_text: &str) -> SafeAppResult {
        let code = if code.len() <= 64
            && !code.is_empty()
            && code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            code
        } else {
            "CONTROL_ERROR"
        };
        let (text, truncated) = safe_text(provider_text, MAX_SEGMENT_BYTES);
        SafeAppResult {
            operation: "error".into(),
            segments: vec![SafeSegment {
                path: "error".into(),
                text,
                trust: "untrusted",
            }],
            code: Some(code.into()),
            truncated,
            approval: None,
        }
    }
}

pub fn safe_text(text: &str, limit: usize) -> (String, bool) {
    let clean = neutralise(text).replace('<', "&lt;").replace('>', "&gt;");
    let mut end = clean.len().min(limit);
    while !clean.is_char_boundary(end) {
        end -= 1;
    }
    (clean[..end].to_owned(), end < clean.len())
}

impl SafeAppResult {
    fn flatten(&mut self, path: &str, value: &Value, budget: &mut usize, depth: usize) {
        if *budget == 0 || self.segments.len() >= MAX_SEGMENTS || depth > 16 {
            self.truncated = true;
            return;
        }
        match value {
            Value::Object(object) if !object.is_empty() => {
                for (key, item) in object {
                    self.flatten(&format!("{path}/{key}"), item, budget, depth + 1);
                }
            }
            Value::Array(array) if !array.is_empty() => {
                // Open list items are opaque text: no field may become an actionable record or authority.
                for (index, item) in array.iter().enumerate() {
                    self.segment(&format!("{path}/{index}"), &item.to_string(), budget);
                }
            }
            _ => self.segment(
                path,
                value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string())
                    .as_str(),
                budget,
            ),
        }
    }
    fn segment(&mut self, path: &str, text: &str, budget: &mut usize) {
        if *budget == 0 || self.segments.len() >= MAX_SEGMENTS {
            self.truncated = true;
            return;
        }
        let (path, path_cut) = safe_text(path, 256);
        let (text, text_cut) = safe_text(text, MAX_SEGMENT_BYTES.min(*budget));
        *budget = budget.saturating_sub(text.len() + path.len() + 128);
        self.truncated |= path_cut || text_cut;
        self.segments.push(SafeSegment {
            path,
            text,
            trust: "untrusted",
        });
    }
}
