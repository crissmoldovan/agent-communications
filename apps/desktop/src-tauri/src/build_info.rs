//! Which build of the app this is (0.32.0, spec 2026-10-26-owner-feedback-0320 §3.7): a release, or the local test
//! build `scripts/local-test-release.sh` makes, whose identifier ends in `.test`. The test build marks itself in the
//! window (a band, the brand, the test profile's folder) and in the tray, so the owner can tell the two apart.
//!
//! The commit and the build time are compiled in from `AGENTCOMMS_BUILD_COMMIT` and `AGENTCOMMS_BUILD_TIME`, which the
//! script exports before it builds; any other build has neither.

use serde::Serialize;

/// What a test build's identifier ends in (`local-test-release.sh`: `com.cueplusplus.agentcomms.test`).
pub const TEST_SUFFIX: &str = ".test";

/// The commit the app was built from, as the script names it: the short commit, then the branch pointing at it, if
/// one does.
pub const COMMIT: Option<&str> = option_env!("AGENTCOMMS_BUILD_COMMIT");

/// When the app was built, as the script writes it: an ISO time in UTC.
pub const BUILT_AT: Option<&str> = option_env!("AGENTCOMMS_BUILD_TIME");

/// The most characters of a compiled-in word the window is given.
const MOST: usize = 120;

/// This build, as `app_build` answers it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBuild {
    pub identifier: String,
    /// Whether the identifier ends in `.test`.
    pub is_test: bool,
    pub commit: Option<String>,
    pub built_at: Option<String>,
}

/// Whether `identifier` is a test build's.
pub fn is_test(identifier: &str) -> bool {
    identifier.ends_with(TEST_SUFFIX)
}

/// A compiled-in word as the window may show it: its control characters dropped, trimmed, at most `MOST` characters,
/// and none when nothing is left.
fn shown(word: Option<&str>) -> Option<String> {
    let kept: String = word?
        .chars()
        .filter(|char| !char.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MOST)
        .collect();
    (!kept.is_empty()).then_some(kept)
}

/// The build `identifier` names, with `commit` and `built_at`.
pub fn describe(identifier: &str, commit: Option<&str>, built_at: Option<&str>) -> AppBuild {
    AppBuild {
        identifier: identifier.to_string(),
        is_test: is_test(identifier),
        commit: shown(commit),
        built_at: shown(built_at),
    }
}

/// This build: the identifier Tauri was configured with, and what was compiled in.
pub fn current(identifier: &str) -> AppBuild {
    describe(identifier, COMMIT, BUILT_AT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_test_build_is_one_whose_identifier_ends_in_dot_test() {
        assert!(is_test("com.cueplusplus.agentcomms.test"));
        for release in [
            "com.cueplusplus.agentcomms",
            "com.cueplusplus.agentcomms.testing",
            "com.cueplusplus.agentcomms.Test",
            "com.cueplusplus.test.agentcomms",
            "test",
            "",
        ] {
            assert!(!is_test(release), "{release}");
        }
        // The release's own identifier, as tauri.conf.json has it, is no test build's.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("the config");
        assert!(!is_test(
            config["identifier"].as_str().expect("an identifier")
        ));
    }

    #[test]
    fn the_build_says_its_identifier_test_commit_and_time_in_the_windows_names() {
        let build = describe(
            "com.cueplusplus.agentcomms.test",
            Some("a1b2c3d feat/0.32"),
            Some("2026-10-26T14:05:00Z"),
        );
        assert_eq!(
            serde_json::to_value(&build).expect("json"),
            json!({
                "identifier": "com.cueplusplus.agentcomms.test",
                "isTest": true,
                "commit": "a1b2c3d feat/0.32",
                "builtAt": "2026-10-26T14:05:00Z"
            })
        );
        // A release built without them: none of either.
        assert_eq!(
            serde_json::to_value(describe("com.cueplusplus.agentcomms", None, None)).expect("json"),
            json!({
                "identifier": "com.cueplusplus.agentcomms",
                "isTest": false,
                "commit": null,
                "builtAt": null
            })
        );
    }

    #[test]
    fn a_compiled_in_word_is_shown_trimmed_short_and_without_control_characters() {
        assert_eq!(shown(Some("  a1b2c3d  ")).as_deref(), Some("a1b2c3d"));
        assert_eq!(
            shown(Some("a1b2c3d\u{1b}[31m feat/x\n")).as_deref(),
            Some("a1b2c3d[31m feat/x")
        );
        assert_eq!(shown(Some("")), None);
        assert_eq!(shown(Some(" \t\n")), None);
        assert_eq!(shown(None), None);
        assert_eq!(
            shown(Some(&"x".repeat(500))).map(|word| word.chars().count()),
            Some(120)
        );
    }

    #[test]
    fn the_current_build_is_what_was_compiled_in() {
        let build = current("com.cueplusplus.agentcomms.test");
        assert!(build.is_test);
        assert_eq!(build.commit, shown(option_env!("AGENTCOMMS_BUILD_COMMIT")));
        assert_eq!(build.built_at, shown(option_env!("AGENTCOMMS_BUILD_TIME")));
    }
}
