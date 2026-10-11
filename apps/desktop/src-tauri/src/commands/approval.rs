use crate::{
    control::{b3_contract::B3Request, types::ControlError},
    preview::render_disclosure_preview,
    untrusted_result::{
        SafeAppResult, SafeApproval, SafeSegment, UntrustedAppResult, MAX_RESULT_BYTES,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalInput {
    pub approval_id: String,
    pub digest: String,
    pub typed_response: Option<String>,
}

#[derive(Default)]
pub struct ApprovalSession {
    current: Option<SafeApproval>,
}
impl ApprovalSession {
    pub fn clear(&mut self) {
        self.current = None;
    }
    pub fn view(
        &mut self,
        input: &ApprovalInput,
        now: i64,
        call: impl FnOnce(&B3Request) -> Result<Value, ControlError>,
    ) -> Result<SafeAppResult, ControlError> {
        self.clear();
        let request = approval_view_request(input)?;
        self.accept_view(input, now, call(&request)?)
    }

    fn accept_view(
        &mut self,
        input: &ApprovalInput,
        now: i64,
        reply: Value,
    ) -> Result<SafeAppResult, ControlError> {
        let request = approval_view_request(input)?;
        request.result(reply.clone())?;
        let kind = reply["kind"].as_str().unwrap();
        if kind != "READY" {
            return Err(ControlError::new(kind, "approval unavailable"));
        }
        if reply["approvalId"] != input.approval_id
            || reply["challenge"]["approvalId"] != input.approval_id
        {
            return Err(ControlError::new("STALE_APPROVAL", "approval id changed"));
        }
        if reply["digest"] != input.digest || reply["challenge"]["digest"] != input.digest {
            return Err(ControlError::new(
                "DIGEST_MISMATCH",
                "approval digest changed",
            ));
        }
        let approval = SafeApproval {
            approval_id: input.approval_id.clone(),
            digest: input.digest.clone(),
            challenge: reply["challenge"]["challenge"].as_str().unwrap().into(),
            expires_at: reply["challenge"]["expiresAt"].as_i64().unwrap(),
        };
        if approval.expires_at <= now {
            return Err(ControlError::new("CHALLENGE_EXPIRED", "challenge expired"));
        }
        let preview = String::from_utf8(render_disclosure_preview(&reply)?).unwrap();
        let result = SafeAppResult {
            operation: "approvalView".into(),
            segments: vec![SafeSegment {
                path: "preview".into(),
                text: preview,
                trust: "untrusted",
            }],
            code: None,
            truncated: false,
            approval: Some(approval.clone()),
        };
        // An approval must be complete: refuse an oversized preview instead of truncating authority fields.
        if serde_json::to_vec(&result).unwrap().len() > MAX_RESULT_BYTES {
            return Err(ControlError::new(
                "APPROVAL_PREVIEW_TOO_LARGE",
                "complete approval preview exceeds the IPC display bound",
            ));
        }
        self.current = Some(approval);
        Ok(result)
    }

    /// Consumes the daemon-issued challenge before any network I/O. A response can never be replayed locally.
    pub fn submit(&mut self, input: &ApprovalInput, now: i64) -> Result<B3Request, ControlError> {
        let current = self
            .current
            .as_ref()
            .ok_or_else(|| ControlError::new("STALE_APPROVAL", "no current preview"))?;
        if current.approval_id != input.approval_id {
            return Err(ControlError::new("STALE_APPROVAL", "approval changed"));
        }
        if current.digest != input.digest {
            return Err(ControlError::new("DIGEST_MISMATCH", "digest changed"));
        }
        if current.expires_at <= now {
            return Err(ControlError::new("CHALLENGE_EXPIRED", "challenge expired"));
        }
        if input.typed_response.as_deref() != Some(current.challenge.as_str()) {
            return Err(ControlError::new(
                "CHALLENGE_MISMATCH",
                "challenge must match",
            ));
        }
        self.clear(); // consume this challenge before the daemon sees its answer
        B3Request::parse(
            json!({"operation":"approve","args":{"approvalId":input.approval_id,"answer":input.typed_response}}),
        )
    }
}

fn approval_view_request(input: &ApprovalInput) -> Result<B3Request, ControlError> {
    B3Request::parse(
        json!({"operation":"approvalView","args":{"approvalId":input.approval_id,"digest":input.digest}}),
    )
}

/// Runs the two native-only calls. A typed daemon void or expiry is resolved only by a fresh view; the old answer
/// was consumed before this call and is never sent again.
pub fn submit_approval(
    session: &mut ApprovalSession,
    input: &ApprovalInput,
    now: i64,
    mut call: impl FnMut(&B3Request) -> Result<Value, ControlError>,
) -> Result<SafeAppResult, ControlError> {
    let request = session.submit(input, now)?;
    match call(&request).and_then(|reply| request.result(reply)) {
        Ok(reply) => Ok(UntrustedAppResult::from_b3(reply)),
        Err(error) if matches!(error.code.as_str(), "CHALLENGE_EXPIRED" | "APPROVAL_VOID") => {
            let code = error.code;
            let mut refreshed = session.view(input, now, |view| call(view))?;
            refreshed.code = Some(code);
            Ok(refreshed)
        }
        Err(error) => Err(error),
    }
}
