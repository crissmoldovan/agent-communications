//! `agentcomms://approvals/<id>` (desktop design DA2): a link opens the app on that approval.
//!
//! The link that launched the app waits for the window to ask for it (`take_deep_link`); a later one shows the window
//! and arrives as the `deep-link` event. On Windows and Linux a later link starts a second copy of the app, which the
//! single-instance plugin stops and hands its arguments to this one; on macOS the system hands it over itself.

use crate::allowlist::ApprovalId;
use crate::ipc::DeepLinkTarget;
use crate::window;
use std::sync::{Mutex, MutexGuard, PoisonError};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// The only links taken: this scheme, this host, then the id.
const PREFIX: &str = "agentcomms://approvals/";

/// The event a link that arrives while the app runs is sent as.
pub const EVENT: &str = "deep-link";

/// The approval a link names, or none. Only `agentcomms://approvals/<id>` is taken, with at most one trailing `/`, and
/// the id must be core's (`grammar::approval_id`). Anything else — another scheme or host, a second segment, a query,
/// a fragment, `..`, percent encoding — is refused, so nothing a link carries reaches the UI unchecked.
pub fn parse(url: &str) -> Option<DeepLinkTarget> {
    let rest = url.strip_prefix(PREFIX)?;
    let id = rest.strip_suffix('/').unwrap_or(rest);
    let id = ApprovalId::try_from(id.to_string()).ok()?;
    Some(DeepLinkTarget {
        approval_id: id.into(),
    })
}

/// The links that arrive before the window asks for them.
#[derive(Debug, Default)]
pub struct Inbox {
    pending: Option<DeepLinkTarget>,
    taken: bool,
}

impl Inbox {
    /// A link arrived: it waits for `take` until the window has asked once. On macOS even the link that launched the
    /// app arrives this way, after the window is built, so it must not be lost before the window listens.
    pub fn arrive(&mut self, target: DeepLinkTarget) {
        if !self.taken {
            self.pending = Some(target);
        }
    }

    /// The link that launched the app, once.
    pub fn take(&mut self) -> Option<DeepLinkTarget> {
        self.taken = true;
        self.pending.take()
    }
}

/// The app's inbox, shared by the deep-link plugin's handler and `take_deep_link`.
#[derive(Default)]
pub struct DeepLinks(Mutex<Inbox>);

fn inbox(links: &DeepLinks) -> MutexGuard<'_, Inbox> {
    links.0.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The last link among `urls` that names an approval.
fn last_target<'a>(urls: impl IntoIterator<Item = &'a tauri::Url>) -> Option<DeepLinkTarget> {
    urls.into_iter()
        .filter_map(|url| parse(url.as_str()))
        .last()
}

/// Listens for links: the one that launched the app (Windows and Linux read it from the arguments), then each later
/// one. On Linux, and in a Windows debug build, the scheme is registered here too, as the plugin's documentation says:
/// an AppImage, or a build run in place, has no installer to do it.
pub fn listen(app: &AppHandle) {
    #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
    {
        let _ = app.deep_link().register_all();
    }
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        if let Some(target) = last_target(&urls) {
            inbox(&app.state::<DeepLinks>()).arrive(target);
        }
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        let Some(target) = last_target(&event.urls()) else {
            return;
        };
        inbox(&handle.state::<DeepLinks>()).arrive(target.clone());
        window::show(&handle);
        let _ = handle.emit(EVENT, target);
    });
}

/// The link that launched the app, if the window has not asked before.
pub fn take(app: &AppHandle) -> Option<DeepLinkTarget> {
    app.try_state::<DeepLinks>()
        .and_then(|links| inbox(&links).take())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allowlist::ID;

    fn target() -> Option<DeepLinkTarget> {
        Some(DeepLinkTarget {
            approval_id: ID.into(),
        })
    }

    #[test]
    fn parses_an_approval_link() {
        assert_eq!(parse(&format!("agentcomms://approvals/{ID}")), target());
        assert_eq!(parse(&format!("agentcomms://approvals/{ID}/")), target());
    }

    #[test]
    fn refuses_every_other_link() {
        let refused = [
            // Another scheme, or the scheme written differently.
            format!("https://approvals/{ID}"),
            format!("agentcomm://approvals/{ID}"),
            format!("AGENTCOMMS://approvals/{ID}"),
            format!("agentcomms:approvals/{ID}"),
            format!("agentcomms:///approvals/{ID}"),
            // Another host, or more than a host.
            format!("agentcomms://approval/{ID}"),
            format!("agentcomms://settings/{ID}"),
            format!("agentcomms://Approvals/{ID}"),
            format!("agentcomms://user@approvals/{ID}"),
            format!("agentcomms://approvals:80/{ID}"),
            // Two segments, or none.
            format!("agentcomms://approvals/{ID}/more"),
            format!("agentcomms://approvals/{ID}//"),
            format!("agentcomms://approvals//{ID}"),
            format!("agentcomms://approvals/x/{ID}"),
            "agentcomms://approvals/".into(),
            "agentcomms://approvals".into(),
            // A query or a fragment.
            format!("agentcomms://approvals/{ID}?code=ABCD"),
            format!("agentcomms://approvals/{ID}/?"),
            format!("agentcomms://approvals/{ID}#top"),
            // A bad id.
            "agentcomms://approvals/ap_bad".into(),
            format!("agentcomms://approvals/{}", ID.to_lowercase()),
            format!("agentcomms://approvals/{ID}0"),
            "agentcomms://approvals/ap_0123456789ABCDEFGHJKMNPQRI".into(),
            format!("agentcomms://approvals/-{ID}"),
            // `..`.
            format!("agentcomms://approvals/../{ID}"),
            format!("agentcomms://approvals/{ID}/.."),
            "agentcomms://approvals/..".into(),
            // Percent encoding, of the id or of a slash.
            "agentcomms://approvals/%61p_0123456789ABCDEFGHJKMNPQRS".into(),
            format!("agentcomms://approvals/{ID}%2F"),
            format!("agentcomms://approvals%2F{ID}"),
            // Whitespace and control characters around it.
            format!(" agentcomms://approvals/{ID}"),
            format!("agentcomms://approvals/{ID}\n"),
            format!("agentcomms://approvals/{ID}\u{202e}"),
            String::new(),
        ];
        for url in refused {
            assert_eq!(parse(&url), None, "{url:?} was taken");
        }
    }

    #[test]
    fn a_launch_link_waits_until_taken_and_later_ones_do_not() {
        let mut inbox = Inbox::default();
        assert_eq!(inbox.take(), None);
        // Once the window has asked, a link is delivered as an event only: none waits.
        inbox.arrive(target().expect("a target"));
        assert_eq!(inbox.take(), None);

        // A link that arrives before the window asks waits for it, once; the latest wins.
        let mut inbox = Inbox::default();
        inbox.arrive(DeepLinkTarget {
            approval_id: "ap_ZZZZZZZZZZZZZZZZZZZZZZZZZZ".into(),
        });
        inbox.arrive(target().expect("a target"));
        assert_eq!(inbox.take(), target());
        assert_eq!(inbox.take(), None);
    }
}
