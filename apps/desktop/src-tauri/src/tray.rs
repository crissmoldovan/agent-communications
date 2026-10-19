//! The tray (desktop design DA2): its icon counts the approvals waiting, and its menu opens the window, pauses update
//! notices for a day, ends every standing approval, checks for an update to the app, and quits.
//!
//! The count is core's `approvals list --state pending`, run through the allow-list every 60 seconds (DA4), and again
//! whenever the window runs it. It shows beside the icon on macOS and Linux, and in the tooltip everywhere: Windows
//! shows no title beside a tray icon (DA15).

use crate::allowlist::{Call, PauseDays};
use crate::commands::context;
use crate::ipc::CliResult;
use crate::launchers::discover;
use crate::runner::run;
use crate::version::at_least;
use crate::{updater, window};
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Wry};

/// The tray's id.
pub const TRAY_ID: &str = "agentcomms-tray";

/// The event that tells the window to read again: each tray action sends it.
pub const DATA_CHANGED: &str = "data-changed";

/// A black `AC` on transparent, 44×44, which macOS draws as a template in the menu bar's own colour.
const ICON: &[u8] = include_bytes!("../icons/tray.png");

/// How often the count is read (DA4, DA14).
const COUNT_EVERY: Duration = Duration::from_secs(60);

/// What the tray's menu can do: one item each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayAction {
    Open,
    PauseDay,
    StandingOff,
    CheckUpdates,
    Quit,
}

impl TrayAction {
    pub const ALL: [TrayAction; 5] = [
        TrayAction::Open,
        TrayAction::PauseDay,
        TrayAction::StandingOff,
        TrayAction::CheckUpdates,
        TrayAction::Quit,
    ];

    /// The menu item's id.
    pub fn id(self) -> &'static str {
        match self {
            TrayAction::Open => "open",
            TrayAction::PauseDay => "pause-day",
            TrayAction::StandingOff => "standing-off",
            TrayAction::CheckUpdates => "check-updates",
            TrayAction::Quit => "quit",
        }
    }

    /// The menu item's words.
    pub fn label(self) -> &'static str {
        match self {
            TrayAction::Open => "Open",
            TrayAction::PauseDay => "Pause update notices for a day",
            TrayAction::StandingOff => "End every standing approval",
            TrayAction::CheckUpdates => "Check for Updates…",
            TrayAction::Quit => "Quit",
        }
    }

    /// The action a menu item's id names.
    pub fn from_id(id: &str) -> Option<TrayAction> {
        TrayAction::ALL.into_iter().find(|action| action.id() == id)
    }

    /// The allow-list call the action runs, for the two that run one: the tray builds no words of its own.
    pub fn call(self) -> Option<Call> {
        match self {
            TrayAction::PauseDay => Some(Call::UpdatePause {
                days: PauseDays::One,
            }),
            TrayAction::StandingOff => Some(Call::StandingOff {}),
            TrayAction::Open | TrayAction::CheckUpdates | TrayAction::Quit => None,
        }
    }
}

/// The tray's tooltip: the app's name, and how many approvals wait.
pub fn tooltip(n: usize) -> String {
    match n {
        0 => "Agent Comms".into(),
        1 => "Agent Comms — 1 approval waiting".into(),
        n => format!("Agent Comms — {n} approvals waiting"),
    }
}

/// The title beside the icon on macOS and Linux: the count, or nothing at 0.
pub fn title(n: usize) -> Option<String> {
    (n > 0).then(|| n.to_string())
}

/// Whether `End every standing approval` may run: core 0.23.0 or later has `standing off`, as the allow-list says.
pub fn standing_enabled(version: Option<&str>) -> bool {
    let needed = Call::StandingOff {}.needs();
    version.is_some_and(|version| needed.is_none_or(|needed| at_least(version, needed)))
}

/// How many approvals wait, from `approvals list --state pending`'s data: a list. None when the data is not one.
pub fn pending_count(data: &Value) -> Option<usize> {
    data.as_array().map(Vec::len)
}

/// The menu's one item that is not always enabled, kept to enable it when the CLI has `standing off`.
struct TrayMenu {
    standing_off: MenuItem<Wry>,
}

/// Builds the tray: the template icon, the tooltip `Agent Comms`, and the menu, opened by a left click. Then reads the
/// count, at once and every 60 seconds.
pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let item = |action: TrayAction, enabled: bool| {
        MenuItem::with_id(app, action.id(), action.label(), enabled, None::<&str>)
    };
    let open = item(TrayAction::Open, true)?;
    let pause = item(TrayAction::PauseDay, true)?;
    // Enabled once the count's first read finds core 0.23.0 or later.
    let standing_off = item(TrayAction::StandingOff, false)?;
    let check = item(TrayAction::CheckUpdates, true)?;
    let quit = item(TrayAction::Quit, true)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &PredefinedMenuItem::separator(app)?,
            &pause,
            &standing_off,
            &PredefinedMenuItem::separator(app)?,
            &check,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(ICON)?)
        .icon_as_template(true)
        .tooltip(tooltip(0))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(app)?;
    app.manage(TrayMenu { standing_off });
    let handle = app.clone();
    std::thread::spawn(move || loop {
        refresh(&handle);
        std::thread::sleep(COUNT_EVERY);
    });
    Ok(())
}

/// Shows `n` approvals waiting: the title on macOS and Linux, the tooltip everywhere.
pub fn set_count(app: &AppHandle, n: usize) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let _ = tray.set_title(title(n));
    let _ = tray.set_tooltip(Some(tooltip(n)));
}

/// Reads the count again, and whether core has `standing off`. Without `launch/core` nothing runs, and nothing waits.
pub fn refresh(app: &AppHandle) {
    let ctx = context(&app.state());
    let installation = discover(&ctx);
    if let Some(menu) = app.try_state::<TrayMenu>() {
        let _ = menu
            .standing_off
            .set_enabled(standing_enabled(installation.version.as_deref()));
    }
    if !installation.installed {
        set_count(app, 0);
        return;
    }
    if let CliResult::Ok { data, .. } = run(&Call::ApprovalsPending {}, &ctx) {
        if let Some(n) = pending_count(&data) {
            set_count(app, n);
        }
    }
}

/// Does what a menu item says. Each action but Quit tells the window to read again.
fn on_menu(app: &AppHandle, id: &str) {
    let Some(action) = TrayAction::from_id(id) else {
        return;
    };
    match action {
        TrayAction::Open => {
            window::show(app);
            let _ = app.emit(DATA_CHANGED, ());
        }
        TrayAction::PauseDay | TrayAction::StandingOff => {
            let Some(call) = action.call() else {
                return;
            };
            let app = app.clone();
            // Off the main thread: the call may take its 30 seconds. What it came to shows when the window reads again.
            std::thread::spawn(move || {
                let _ = run(&call, &context(&app.state()));
                let _ = app.emit(DATA_CHANGED, ());
            });
        }
        TrayAction::CheckUpdates => {
            window::show(app);
            let _ = app.emit(DATA_CHANGED, ());
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                updater::check(&app, false).await;
            });
        }
        TrayAction::Quit => {
            window::QUITTING.store(true, Ordering::SeqCst);
            app.exit(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tooltip_counts_approvals() {
        assert_eq!(tooltip(0), "Agent Comms");
        assert_eq!(tooltip(1), "Agent Comms — 1 approval waiting");
        assert_eq!(tooltip(2), "Agent Comms — 2 approvals waiting");
        assert_eq!(tooltip(120), "Agent Comms — 120 approvals waiting");
        assert_eq!(title(0), None);
        assert_eq!(title(1).as_deref(), Some("1"));
        assert_eq!(title(37).as_deref(), Some("37"));
    }

    #[test]
    fn the_count_is_the_number_of_pending_approvals() {
        assert_eq!(pending_count(&json!([])), Some(0));
        assert_eq!(
            pending_count(&json!([{ "approvalId": "a" }, { "approvalId": "b" }])),
            Some(2)
        );
        assert_eq!(pending_count(&json!({ "approvals": [] })), None);
        assert_eq!(pending_count(&json!(null)), None);
    }

    #[test]
    fn standing_off_needs_0_23() {
        assert!(!standing_enabled(None));
        assert!(!standing_enabled(Some("0.21.0")));
        assert!(!standing_enabled(Some("0.22.9")));
        assert!(standing_enabled(Some("0.23.0")));
        assert!(standing_enabled(Some("0.24.1")));
        // A pull request's build of 0.23.0 has it, as `version::at_least` reads it.
        assert!(standing_enabled(Some("0.23.0-feat-standing")));
        assert!(!standing_enabled(Some("not a version")));
    }

    #[test]
    fn the_menu_says_what_the_plan_says_and_its_two_calls_go_through_the_allow_list() {
        let menu: Vec<(&str, &str)> = TrayAction::ALL
            .iter()
            .map(|action| (action.id(), action.label()))
            .collect();
        assert_eq!(
            menu,
            [
                ("open", "Open"),
                ("pause-day", "Pause update notices for a day"),
                ("standing-off", "End every standing approval"),
                ("check-updates", "Check for Updates…"),
                ("quit", "Quit"),
            ]
        );
        for action in TrayAction::ALL {
            assert_eq!(TrayAction::from_id(action.id()), Some(action));
        }
        assert_eq!(TrayAction::from_id("approve"), None);
        assert_eq!(TrayAction::from_id(""), None);

        // The two that run something are allow-list calls, read as the UI sends them.
        assert_eq!(
            TrayAction::PauseDay.call(),
            Some(
                serde_json::from_value(json!({ "kind": "updatePause", "days": 1 }))
                    .expect("a call")
            )
        );
        assert_eq!(
            TrayAction::StandingOff.call(),
            Some(serde_json::from_value(json!({ "kind": "standingOff" })).expect("a call"))
        );
        assert_eq!(
            TrayAction::PauseDay
                .call()
                .and_then(|call| call.words().ok())
                .map(|words| words.words),
            Some(vec!["update".into(), "--pause".into(), "1".into()])
        );
        assert_eq!(
            TrayAction::StandingOff
                .call()
                .and_then(|call| call.words().ok())
                .map(|words| words.words),
            Some(vec!["standing".into(), "off".into()])
        );
        for action in [TrayAction::Open, TrayAction::CheckUpdates, TrayAction::Quit] {
            assert_eq!(action.call(), None);
        }
        assert_eq!(
            TrayAction::PauseDay.call(),
            Some(Call::UpdatePause {
                days: PauseDays::One
            })
        );
    }
}
