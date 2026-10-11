use super::{
    approval::{submit_approval, ApprovalInput, ApprovalSession},
    supervision::DesktopService,
};
use crate::{
    control::{
        b3_contract::B3Request,
        client::{DesktopControlClient, NonSecretControlRequest},
        types::{ControlError, InstanceIdentity},
    },
    preferences::{DesktopPreferences, PreferenceStore},
    untrusted_result::{SafeAppResult, UntrustedAppResult},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{State, WebviewWindow};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Selection(pub std::collections::BTreeMap<String, Value>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlInput {
    pub request: B3Request,
    pub selection: Option<Selection>,
}

#[derive(Debug, Serialize)]
pub struct ControlResponse {
    pub result: SafeAppResult,
    pub association: Option<Selection>,
    pub generation: u64,
}

#[derive(Default)]
pub struct ControlState {
    pub approval: ApprovalSession,
    identity: Option<InstanceIdentity>,
    generation: u64,
}
impl ControlState {
    fn owner(&mut self, identity: InstanceIdentity) {
        if self.identity.as_ref() != Some(&identity) {
            self.generation += 1;
            self.identity = Some(identity);
            self.approval.clear();
        }
    }
}

pub fn execute_control(
    input: ControlInput,
    generation: u64,
    call: impl FnOnce(&B3Request) -> Result<Value, ControlError>,
) -> Result<ControlResponse, ControlError> {
    input.request.generic_dispatch_allowed()?;
    let reply = input.request.result(call(&input.request)?)?;
    let value = reply.checked_value();
    let required_scope = input.request.expected_scope();
    if (input.selection.as_ref().is_some_and(|provided| {
        required_scope
            .iter()
            .any(|(field, expected)| provided.0.get(field) != Some(expected))
    })) || !input.request.result_matches_request_scope(&value)
    {
        return Err(ControlError::new(
            "SCOPE_MISMATCH",
            "result does not match the schema-derived request identity",
        ));
    }
    if let Some(selected) = &input.selection {
        // Only request-derived nested fields or schema-closed root fields are eligible. Opaque arrays stay opaque.
        if selected.0.iter().any(|(field, expected)| {
            (!required_scope.contains_key(field)
                && (!input.request.scope_fields().contains(&field.as_str())
                    || value.get(field) != Some(expected)))
                || (!expected.is_string()
                    && !expected.is_number()
                    && !expected
                        .as_array()
                        .is_some_and(|values| values.iter().all(Value::is_string)))
                || input
                    .request
                    .args()
                    .get(field)
                    .is_some_and(|requested| requested != expected)
        }) {
            return Err(ControlError::new(
                "SCOPE_MISMATCH",
                "result has no matching stable scope",
            ));
        }
    }
    Ok(ControlResponse {
        result: UntrustedAppResult::from_b3(reply),
        association: input.selection,
        generation,
    })
}

/// The native approval command's control path. Keeping the authenticated exchange here makes its owner fence usable
/// by the Tauri command and by the compiled real-owner integration test; the webview never provides a preview.
pub fn app_approval_over_control(
    state: &mut ControlState,
    input: &ApprovalInput,
    now: i64,
    client: &DesktopControlClient,
) -> Result<SafeAppResult, ControlError> {
    if input.typed_response.is_some() {
        let expected = state.identity.clone().ok_or_else(|| {
            ControlError::new("CONTROL_OWNER_CHANGED", "approval view has no owner")
        })?;
        return submit_approval(&mut state.approval, input, now, |request| {
            let reply = client.request(NonSecretControlRequest::B3(Box::new(request.clone())))?;
            if reply.identity != expected {
                return Err(ControlError::new(
                    "CONTROL_OWNER_CHANGED",
                    "owner changed during approval",
                ));
            }
            Ok(reply.data)
        });
    }
    let request = B3Request::parse(
        serde_json::json!({"operation":"approvalView","args":{"approvalId":input.approval_id,"digest":input.digest}}),
    )?;
    let reply = client.request(NonSecretControlRequest::B3(Box::new(request)))?;
    state.owner(reply.identity);
    state.approval.view(input, now, |_| Ok(reply.data))
}

pub fn save_preferences(
    store: &PreferenceStore,
    expected_revision: u64,
    open_at_login: bool,
    keep_collecting_after_quit: bool,
) -> Result<DesktopPreferences, ControlError> {
    let mut preferences = store.load()?;
    preferences.open_at_login = open_at_login;
    preferences.keep_collecting_after_quit = keep_collecting_after_quit;
    preferences.revision = expected_revision
        .checked_add(1)
        .ok_or_else(|| ControlError::new("PREFERENCES_CHANGED", "revision overflow"))?;
    store.save_if_revision(&preferences, expected_revision)?;
    Ok(preferences)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceView {
    pub revision: u64,
    pub open_at_login: bool,
    pub keep_collecting_after_quit: bool,
}
fn preferences_view(preferences: DesktopPreferences) -> PreferenceView {
    PreferenceView {
        revision: preferences.revision,
        open_at_login: preferences.open_at_login,
        keep_collecting_after_quit: preferences.keep_collecting_after_quit,
    }
}

fn settings_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("WINDOW_NOT_AUTHORIZED".into());
    }
    #[cfg(windows)]
    return Err(ControlError::windows_unavailable().code);
    #[cfg(not(windows))]
    Ok(())
}

#[tauri::command]
pub fn desktop_control(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
    input: ControlInput,
) -> Result<ControlResponse, String> {
    settings_only(&window)?;
    input
        .request
        .generic_dispatch_allowed()
        .map_err(|e| e.code)?;
    let profile = service
        .store
        .load()
        .map_err(|e| e.code)?
        .daemon_profile
        .ok_or("DAEMON_PROFILE_REQUIRED")?;
    let mut state = service.control.lock().map_err(|_| "CONTROL_UNAVAILABLE")?;
    let reply = DesktopControlClient::new(profile)
        .request(NonSecretControlRequest::B3(Box::new(input.request.clone())))
        .map_err(|e| e.code)?;
    state.owner(reply.identity);
    let result =
        execute_control(input, state.generation, |_| Ok(reply.data)).map_err(|e| e.code)?;
    if !matches!(
        result.result.operation.as_str(),
        "status" | "doctor" | "catalogue-list" | "sources-list" | "rules-list" | "targets-list"
    ) {
        state.approval.clear();
    }
    Ok(result)
}

#[tauri::command]
pub fn desktop_approve(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
    input: ApprovalInput,
) -> Result<SafeAppResult, String> {
    settings_only(&window)?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000;
    let mut state = service.control.lock().map_err(|_| "CONTROL_UNAVAILABLE")?;
    let profile = service
        .store
        .load()
        .map_err(|e| e.code)?
        .daemon_profile
        .ok_or("DAEMON_PROFILE_REQUIRED")?;
    let client = DesktopControlClient::with_client_name(profile, "app-approval-screen");
    app_approval_over_control(&mut state, &input, now as i64, &client).map_err(|e| e.code)
}

#[tauri::command]
pub fn desktop_preferences(
    window: WebviewWindow,
    service: State<'_, DesktopService>,
    expected_revision: Option<u64>,
    open_at_login: Option<bool>,
    keep_collecting_after_quit: Option<bool>,
) -> Result<PreferenceView, String> {
    settings_only(&window)?;
    match (expected_revision, open_at_login, keep_collecting_after_quit) {
        (None, None, None) => service
            .store
            .load()
            .map(preferences_view)
            .map_err(|e| e.code),
        (Some(revision), Some(login), Some(keep)) => {
            save_preferences(&service.store, revision, login, keep)
                .map(preferences_view)
                .map_err(|e| e.code)
        }
        _ => Err("PREFERENCES_ARGUMENTS".into()),
    }
}
