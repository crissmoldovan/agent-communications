//! Which features the installed CLI has (DA12): a section that needs a later one says so, rather than failing.

/// True when `installed` is `needed` or later. A pre-release of a version counts as that version — the builds of a
/// pull request that brings a feature are named `<version>-<branch>` — and build metadata is ignored. False when
/// either version cannot be read: an unknown version has no feature.
pub fn at_least(installed: &str, needed: &str) -> bool {
    let (Ok(installed), Ok(needed)) = (
        semver::Version::parse(installed),
        semver::Version::parse(needed),
    ) else {
        return false;
    };
    (installed.major, installed.minor, installed.patch)
        >= (needed.major, needed.minor, needed.patch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_at_least_what_a_feature_needs() {
        assert!(at_least("0.24.0", "0.24.0"));
        assert!(at_least("0.24.1", "0.24.0"));
        assert!(at_least("1.0.0", "0.24.0"));
        assert!(!at_least("0.23.9", "0.24.0"));
        assert!(!at_least("0.21.0", "0.22.0"));
        // A pre-release of the release that brings a feature has it: the PR builds are named 0.24.0-<branch>.
        assert!(at_least("0.24.0-feat-desktop", "0.24.0"));
        assert!(!at_least("0.23.0-feat-x", "0.24.0"));
        assert!(at_least("0.24.0+build.7", "0.24.0"));
    }

    #[test]
    fn an_unreadable_version_is_never_enough() {
        for installed in ["", "0.24", "v0.24.0", "latest", "0.24.0 ", "x.y.z"] {
            assert!(!at_least(installed, "0.0.1"), "{installed:?}");
        }
        assert!(!at_least("0.24.0", "soon"));
    }
}
