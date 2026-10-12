#[cfg(unix)]
use super::supervision::DesktopService;
use crate::control::{
    secret_window_capability::{SecretOperation, SecretWindowCapability},
    types::{ControlError, SecretResult},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(unix)]
use tauri::Manager;
use tauri::{Runtime, WebviewWindow};
use zeroize::Zeroizing;

#[derive(Default)]
pub struct SecretLifecycle(
    AtomicU64,
    #[cfg(unix)] std::sync::Mutex<Option<(u64, std::os::unix::net::UnixStream)>>,
);
impl SecretLifecycle {
    pub fn clear(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
        self.close_pending();
    }
    pub fn begin(&self) -> u64 {
        let epoch = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        self.close_pending();
        epoch
    }
    pub fn current(&self, epoch: u64) -> bool {
        self.0.load(Ordering::SeqCst) == epoch
    }
    fn close_pending(&self) {
        #[cfg(unix)]
        if let Some((_, stream)) = self
            .1
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
    #[cfg(unix)]
    pub fn watch(
        &self,
        epoch: u64,
        stream: &std::os::unix::net::UnixStream,
    ) -> Result<SecretPending<'_>, ControlError> {
        let mut pending = self.1.lock().unwrap_or_else(|error| error.into_inner());
        if !self.current(epoch) {
            return Err(ControlError::new("SECRET_CLEARED", "secret window changed"));
        }
        *pending = Some((
            epoch,
            stream
                .try_clone()
                .map_err(|_| ControlError::new("CONTROL_IO", "cannot track secret connection"))?,
        ));
        Ok(SecretPending {
            lifecycle: self,
            epoch,
        })
    }
}

#[cfg(unix)]
pub struct SecretPending<'a> {
    lifecycle: &'a SecretLifecycle,
    epoch: u64,
}
#[cfg(unix)]
impl Drop for SecretPending<'_> {
    fn drop(&mut self) {
        let mut pending = self
            .lifecycle
            .1
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if pending
            .as_ref()
            .is_some_and(|(epoch, _)| *epoch == self.epoch)
        {
            pending.take();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretInput {
    pub id: Option<String>,
    pub version: Option<u64>,
    pub predecessor_version: Option<u64>,
    pub inert_draft: Option<Value>,
    pub hidden: Option<Zeroizing<String>>,
    pub to: Option<String>,
}
impl SecretInput {
    pub fn args(&self, operation: SecretOperation) -> Result<Value, ControlError> {
        if matches!(operation, SecretOperation::MigrateSecrets) {
            if !matches!(self.to.as_deref(), Some("file" | "keychain")) {
                return Err(ControlError::new(
                    "SECRET_ARGUMENTS",
                    "migration destination required",
                ));
            }
            return Ok(json!({"to":self.to}));
        }
        let id = self
            .id
            .as_deref()
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .ok_or_else(|| ControlError::new("SECRET_ARGUMENTS", "owner identity required"))?;
        let version = self
            .version
            .filter(|version| *version > 0 && *version <= 9_007_199_254_740_991)
            .ok_or_else(|| ControlError::new("SECRET_ARGUMENTS", "exact version required"))?;
        let id_key = match operation {
            SecretOperation::SubscriberTokenCreate | SecretOperation::SubscriberTokenRotate => {
                "subscriberId"
            }
            SecretOperation::JudgeKeySet | SecretOperation::JudgeKeyRotate => "judgeId",
            _ => "targetId",
        };
        let mut args = json!({id_key:id, "version":version});
        if matches!(operation, SecretOperation::TargetUrlSet) {
            args.as_object_mut()
                .expect("arguments object")
                .remove("version");
            args["newVersion"] = json!(version);
            if self.predecessor_version.is_some() == self.inert_draft.is_some() {
                return Err(ControlError::new(
                    "SECRET_ARGUMENTS",
                    "one predecessor or inert draft required",
                ));
            }
            if let Some(prior) = self.predecessor_version {
                args["predecessorVersion"] = json!(prior);
            }
            if let Some(draft) = &self.inert_draft {
                args["inertDraft"] = draft.clone();
            }
        }
        if matches!(
            operation,
            SecretOperation::TargetUrlSet
                | SecretOperation::JudgeKeySet
                | SecretOperation::JudgeKeyRotate
        ) {
            let hidden = self
                .hidden
                .as_ref()
                .filter(|value| !value.is_empty() && value.len() < 32_768)
                .ok_or_else(|| ControlError::new("SECRET_ARGUMENTS", "hidden input required"))?;
            args["hidden"] = json!(hidden.as_str());
        } else if self.hidden.is_some() {
            return Err(ControlError::new(
                "SECRET_ARGUMENTS",
                "generated material accepts no input",
            ));
        }
        Ok(args)
    }
}

async fn execute<R: Runtime>(
    window: WebviewWindow<R>,
    input: SecretInput,
    operation: SecretOperation,
) -> Result<SecretResult, String> {
    let capability = SecretWindowCapability::for_window(&window).map_err(|error| error.code)?;
    #[cfg(windows)]
    {
        let _ = (capability, input, operation);
        Err(ControlError::windows_unavailable().code)
    }
    #[cfg(unix)]
    {
        let handle = window.app_handle().clone();
        let service = handle.state::<DesktopService>();
        let epoch = service.secrets.begin();
        // An attached owner cannot accept secret input, even if its label looks like the native window.
        if service.supervisor.status().state != crate::supervisor::SupervisorState::Running
            || service.supervisor.status().attached
        {
            return Ok(SecretResult::unavailable());
        }
        tauri::async_runtime::spawn_blocking(move || {
            let service = handle.state::<DesktopService>();
            let args = input.args(operation).map_err(|error| error.code)?;
            service
                .supervisor
                .secret_request(&capability, operation, args, &service.secrets, epoch)
                .map_err(|error| error.code)
        })
        .await
        .map_err(|_| "SECRET_UNAVAILABLE".to_string())?
    }
}

macro_rules! secret_command {
    ($name:ident, $operation:ident) => {
        #[tauri::command]
        pub async fn $name<R: Runtime>(
            window: WebviewWindow<R>,
            input: SecretInput,
        ) -> Result<SecretResult, String> {
            execute(window, input, SecretOperation::$operation).await
        }
    };
}
secret_command!(desktop_target_secret_create, TargetSecretCreate);
secret_command!(desktop_target_secret_rotate, TargetSecretRotate);
secret_command!(desktop_target_url_set, TargetUrlSet);
secret_command!(desktop_subscriber_token_create, SubscriberTokenCreate);
secret_command!(desktop_subscriber_token_rotate, SubscriberTokenRotate);
secret_command!(desktop_judge_key_set, JudgeKeySet);
secret_command!(desktop_judge_key_rotate, JudgeKeyRotate);
secret_command!(desktop_secrets_migrate, MigrateSecrets);

/// The shipped app and the native raw-invocation proof expand this one registration list. Keeping it here prevents a
/// test-only handler from silently diverging from the commands that the production Tauri builder installs.
#[macro_export]
macro_rules! desktop_secret_command_handler {
    ($($command:path),* $(,)?) => {
        tauri::generate_handler![
            $($command,)*
            $crate::commands::secrets::desktop_target_secret_create,
            $crate::commands::secrets::desktop_target_secret_rotate,
            $crate::commands::secrets::desktop_target_url_set,
            $crate::commands::secrets::desktop_subscriber_token_create,
            $crate::commands::secrets::desktop_subscriber_token_rotate,
            $crate::commands::secrets::desktop_judge_key_set,
            $crate::commands::secrets::desktop_judge_key_rotate,
            $crate::commands::secrets::desktop_secrets_migrate
        ]
    };
}

pub fn handler<R: Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    crate::desktop_secret_command_handler!()
}
