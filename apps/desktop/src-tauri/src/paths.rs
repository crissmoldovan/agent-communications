//! Where agent-communications keeps its folders: a port of core's `resolvePaths` (`packages/core/src/paths.ts`).
//!
//! An app started from the Dock or the Start menu sees none of the shell's variables, so Settings can name the
//! folders `AGENT_COMMS_*` would (desktop design DA12), and every call carries all four as pins, so the app and the
//! CLI always agree. Paths are strings built with the target platform's separator, so a forced platform resolves the
//! same on any host, and they are normalised lexically, as Node's `resolve` normalises an absolute path.

use serde::{Deserialize, Serialize};

/// The folder every default ends in.
pub const APP_DIR_NAME: &str = "agent-communications";

/// The three platforms the app is built for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    MacOs,
    Linux,
    Windows,
}

impl Platform {
    /// The platform this build runs on.
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::MacOs
        } else {
            Platform::Linux
        }
    }

    /// The platform's path separator.
    pub fn separator(self) -> char {
        match self {
            Platform::Windows => '\\',
            Platform::MacOs | Platform::Linux => '/',
        }
    }
}

/// What the folders are resolved from: the home, the platform's variables, and the three `AGENT_COMMS_*` ones.
/// An empty string counts as unset, as it does in core (`||`, not `??`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PathEnv {
    pub platform: Platform,
    pub home: String,
    pub appdata: Option<String>,
    pub localappdata: Option<String>,
    pub xdg_config_home: Option<String>,
    pub xdg_data_home: Option<String>,
    /// `AGENT_COMMS_CONFIG_DIR`.
    pub config_dir: Option<String>,
    /// `AGENT_COMMS_STATE_DIR`.
    pub state_dir: Option<String>,
    /// `AGENT_COMMS_DATA_DIR`.
    pub data_dir: Option<String>,
}

impl PathEnv {
    /// This process's environment, on this platform.
    pub fn from_process() -> Self {
        Self::from_lookup(Platform::current(), |name| std::env::var(name).ok())
    }

    /// An environment read through `lookup`: the home from `USERPROFILE` on Windows and `HOME` elsewhere, as Node's
    /// `homedir()` reads it, or the account's own when the variable is unset.
    pub fn from_lookup(platform: Platform, lookup: impl Fn(&str) -> Option<String>) -> Self {
        let read = |name: &str| lookup(name).filter(|value| !value.is_empty());
        let home = read(if platform == Platform::Windows {
            "USERPROFILE"
        } else {
            "HOME"
        })
        .or_else(|| std::env::home_dir().map(|home| home.to_string_lossy().into_owned()))
        .unwrap_or_default();
        PathEnv {
            platform,
            home,
            appdata: read("APPDATA"),
            localappdata: read("LOCALAPPDATA"),
            xdg_config_home: read("XDG_CONFIG_HOME"),
            xdg_data_home: read("XDG_DATA_HOME"),
            config_dir: read("AGENT_COMMS_CONFIG_DIR"),
            state_dir: read("AGENT_COMMS_STATE_DIR"),
            data_dir: read("AGENT_COMMS_DATA_DIR"),
        }
    }

    /// The folders Settings name, acting exactly as the `AGENT_COMMS_*` variables would: each replaces its variable,
    /// so a config folder alone still takes state and secrets with it. An empty override is no override.
    pub fn with_overrides(self, overrides: &FolderOverrides) -> Self {
        let pick = |set: &Option<String>, otherwise: Option<String>| {
            set.clone().filter(|value| !value.is_empty()).or(otherwise)
        };
        PathEnv {
            config_dir: pick(&overrides.config_dir, self.config_dir.clone()),
            state_dir: pick(&overrides.state_dir, self.state_dir.clone()),
            data_dir: pick(&overrides.data_dir, self.data_dir.clone()),
            ..self
        }
    }
}

/// The folders Settings may name; each unset one is left to the environment and the defaults.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct FolderOverrides {
    pub config_dir: Option<String>,
    pub state_dir: Option<String>,
    pub data_dir: Option<String>,
}

/// The four folders every call pins (DA12). Downloads is left to its default: it comes from the home folder, which the
/// app and the CLI share (plan, "Where the design is silent" 3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folders {
    pub config_dir: String,
    pub state_dir: String,
    pub data_dir: String,
    pub secrets_dir: String,
}

impl Folders {
    /// The pins every call but `--version` ends with, in this order.
    pub fn pins(&self) -> [String; 8] {
        [
            "--config-dir".into(),
            self.config_dir.clone(),
            "--state-dir".into(),
            self.state_dir.clone(),
            "--data-dir".into(),
            self.data_dir.clone(),
            "--secrets-dir".into(),
            self.secrets_dir.clone(),
        ]
    }
}

fn set(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.is_empty())
}

/// `resolvePaths`' rules, folder by folder:
/// - config: `AGENT_COMMS_CONFIG_DIR`, else `XDG_CONFIG_HOME` (on every platform), else `%APPDATA%` on Windows and
///   `~/.config` elsewhere;
/// - state and secrets: beside the config, except on Windows with no explicit config folder, where they go under
///   `%LOCALAPPDATA%` (the roaming profile is no place for tokens); `AGENT_COMMS_STATE_DIR` moves the state alone;
/// - data: `AGENT_COMMS_DATA_DIR`, else `%LOCALAPPDATA%` on Windows, `XDG_DATA_HOME` elsewhere, else `~/.local/share`.
pub fn resolve_folders(env: &PathEnv) -> Folders {
    let platform = env.platform;
    let home = env.home.as_str();
    let windows = platform == Platform::Windows;
    let roaming = set(&env.appdata)
        .map(str::to_string)
        .unwrap_or_else(|| join(platform, &[home, "AppData", "Roaming"]));
    let local = set(&env.localappdata)
        .map(str::to_string)
        .unwrap_or_else(|| join(platform, &[home, "AppData", "Local"]));

    let config_dir = normalise(
        &match (set(&env.config_dir), set(&env.xdg_config_home)) {
            (Some(explicit), _) => explicit.to_string(),
            (None, Some(xdg)) => join(platform, &[xdg, APP_DIR_NAME]),
            (None, None) if windows => join(platform, &[&roaming, APP_DIR_NAME]),
            (None, None) => join(platform, &[home, ".config", APP_DIR_NAME]),
        },
        platform,
    );
    let local_root = if windows && set(&env.config_dir).is_none() {
        join(platform, &[&local, APP_DIR_NAME])
    } else {
        config_dir.clone()
    };
    let state_dir = normalise(
        &set(&env.state_dir)
            .map(str::to_string)
            .unwrap_or_else(|| join(platform, &[&local_root, "state"])),
        platform,
    );
    let secrets_dir = normalise(&join(platform, &[&local_root, "secrets"]), platform);
    let data_dir = normalise(
        &match (set(&env.data_dir), set(&env.xdg_data_home)) {
            (Some(explicit), _) => explicit.to_string(),
            (None, _) if windows => join(platform, &[&local, APP_DIR_NAME]),
            (None, Some(xdg)) => join(platform, &[xdg, APP_DIR_NAME]),
            (None, None) => join(platform, &[home, ".local", "share", APP_DIR_NAME]),
        },
        platform,
    );
    Folders {
        config_dir,
        state_dir,
        data_dir,
        secrets_dir,
    }
}

/// `parts` joined with the platform's separator, then normalised.
pub fn join(platform: Platform, parts: &[&str]) -> String {
    let separator = platform.separator().to_string();
    normalise(&parts.join(&separator), platform)
}

/// A path normalised lexically, as Node's `path.resolve` normalises an absolute one: separators made the platform's
/// own and never doubled, `.` dropped, `..` taking the folder before it (and stopping at the root), and no trailing
/// separator but the root's. Nothing is read from disk, and a relative path stays relative: nothing is joined to a
/// working folder the app does not have.
pub fn normalise(path: &str, platform: Platform) -> String {
    let separator = platform.separator();
    let (prefix, rest) = if platform == Platform::Windows {
        windows_prefix(&path.replace('/', "\\"))
    } else if let Some(rest) = path.strip_prefix('/') {
        ("/".to_string(), rest.to_string())
    } else {
        (String::new(), path.to_string())
    };
    let rooted = prefix.ends_with(separator);
    // A drive with no root after it (`C:x`) is followed directly by what comes next, as Node writes it.
    let glued = rooted || prefix.ends_with(':');
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split(separator) {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !rooted {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let body = parts.join(&separator.to_string());
    match (prefix.is_empty(), body.is_empty()) {
        (true, true) => ".".to_string(),
        (true, false) => body,
        (false, _) if glued => format!("{prefix}{body}"),
        (false, true) => prefix,
        (false, false) => format!("{prefix}{separator}{body}"),
    }
}

/// A Windows path's root, with its separator when it has one: `\\server\share\`, `C:\`, `C:` or `\`; and the rest.
fn windows_prefix(path: &str) -> (String, String) {
    if let Some(unc) = path.strip_prefix("\\\\") {
        let mut pieces = unc.splitn(3, '\\');
        let server = pieces.next().unwrap_or_default();
        let share = pieces.next().unwrap_or_default();
        let rest = pieces.next().unwrap_or_default();
        return (format!("\\\\{server}\\{share}\\"), rest.to_string());
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let drive = &path[..2];
        return match path[2..].strip_prefix('\\') {
            Some(rest) => (format!("{drive}\\"), rest.to_string()),
            None => (drive.to_string(), path[2..].to_string()),
        };
    }
    match path.strip_prefix('\\') {
        Some(rest) => ("\\".to_string(), rest.to_string()),
        None => (String::new(), path.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allowlist::{samples, Shape};
    use crate::launchers::Program;
    use crate::runner::argv;

    fn linux(home: &str) -> PathEnv {
        PathEnv {
            platform: Platform::Linux,
            home: home.into(),
            appdata: None,
            localappdata: None,
            xdg_config_home: None,
            xdg_data_home: None,
            config_dir: None,
            state_dir: None,
            data_dir: None,
        }
    }

    fn windows() -> PathEnv {
        PathEnv {
            platform: Platform::Windows,
            home: r"C:\Users\example".into(),
            appdata: Some(r"C:\Users\example\AppData\Roaming".into()),
            localappdata: Some(r"C:\Users\example\AppData\Local".into()),
            ..linux("")
        }
    }

    fn folders(config: &str, state: &str, data: &str, secrets: &str) -> Folders {
        Folders {
            config_dir: config.into(),
            state_dir: state.into(),
            data_dir: data.into(),
            secrets_dir: secrets.into(),
        }
    }

    #[test]
    fn an_explicit_config_dir_takes_state_and_secrets_with_it() {
        let env = PathEnv {
            config_dir: Some("/srv/comms".into()),
            ..linux("/home/example")
        };
        assert_eq!(
            resolve_folders(&env),
            folders(
                "/srv/comms",
                "/srv/comms/state",
                "/home/example/.local/share/agent-communications",
                "/srv/comms/secrets"
            )
        );
        // On Windows too: someone who names a folder means that folder, so nothing goes to %LOCALAPPDATA% but data.
        let env = PathEnv {
            config_dir: Some(r"D:\comms".into()),
            ..windows()
        };
        assert_eq!(
            resolve_folders(&env),
            folders(
                r"D:\comms",
                r"D:\comms\state",
                r"C:\Users\example\AppData\Local\agent-communications",
                r"D:\comms\secrets"
            )
        );
    }

    #[test]
    fn windows_keeps_state_and_secrets_under_localappdata() {
        assert_eq!(
            resolve_folders(&windows()),
            folders(
                r"C:\Users\example\AppData\Roaming\agent-communications",
                r"C:\Users\example\AppData\Local\agent-communications\state",
                r"C:\Users\example\AppData\Local\agent-communications",
                r"C:\Users\example\AppData\Local\agent-communications\secrets"
            )
        );
        // With neither variable, both come from the home folder, as core's `resolvePaths` takes them.
        let bare = PathEnv {
            appdata: None,
            localappdata: None,
            ..windows()
        };
        assert_eq!(resolve_folders(&bare), resolve_folders(&windows()));
        // XDG_CONFIG_HOME moves the config on Windows too; XDG_DATA_HOME does not move the data there.
        let xdg = PathEnv {
            xdg_config_home: Some(r"C:\xdg\config".into()),
            xdg_data_home: Some(r"C:\xdg\data".into()),
            ..windows()
        };
        let resolved = resolve_folders(&xdg);
        assert_eq!(resolved.config_dir, r"C:\xdg\config\agent-communications");
        assert_eq!(
            resolved.state_dir,
            r"C:\Users\example\AppData\Local\agent-communications\state"
        );
        assert_eq!(
            resolved.data_dir,
            r"C:\Users\example\AppData\Local\agent-communications"
        );
        // Forward slashes are a Windows path's separators too, and come back as its own.
        let slashed = PathEnv {
            config_dir: Some("C:/comms//here/./x/..".into()),
            ..windows()
        };
        assert_eq!(resolve_folders(&slashed).config_dir, r"C:\comms\here");
    }

    #[test]
    fn empty_variables_count_as_unset() {
        let empty = Some(String::new());
        let env = PathEnv {
            appdata: empty.clone(),
            localappdata: empty.clone(),
            xdg_config_home: empty.clone(),
            xdg_data_home: empty.clone(),
            config_dir: empty.clone(),
            state_dir: empty.clone(),
            data_dir: empty,
            ..linux("/home/example")
        };
        assert_eq!(
            resolve_folders(&env),
            resolve_folders(&linux("/home/example"))
        );
        // Read from a process environment, an empty variable is no variable at all.
        let read = PathEnv::from_lookup(Platform::Linux, |name| match name {
            "HOME" => Some("/home/example".into()),
            _ => Some(String::new()),
        });
        assert_eq!(read, linux("/home/example"));
        // Windows reads its home from USERPROFILE, not HOME.
        let read = PathEnv::from_lookup(Platform::Windows, |name| match name {
            "USERPROFILE" => Some(r"C:\Users\example".into()),
            "HOME" => Some("/srv/elsewhere".into()),
            _ => None,
        });
        assert_eq!(read.home, r"C:\Users\example");
    }

    #[test]
    fn settings_overrides_act_as_the_environment_variables() {
        // A config folder set in Settings takes state and secrets with it, exactly as AGENT_COMMS_CONFIG_DIR does.
        let overrides = FolderOverrides {
            config_dir: Some("/srv/comms".into()),
            state_dir: None,
            data_dir: None,
        };
        let from_settings = resolve_folders(&linux("/home/example").with_overrides(&overrides));
        let from_environment = resolve_folders(&PathEnv {
            config_dir: Some("/srv/comms".into()),
            ..linux("/home/example")
        });
        assert_eq!(from_settings, from_environment);
        // Settings win over the environment, folder by folder; what Settings leave unset, the environment still says.
        let env = PathEnv {
            config_dir: Some("/env/config".into()),
            state_dir: Some("/env/state".into()),
            ..linux("/home/example")
        };
        let overrides = FolderOverrides {
            config_dir: Some("/settings/config".into()),
            state_dir: None,
            data_dir: Some("/settings/data".into()),
        };
        assert_eq!(
            resolve_folders(&env.with_overrides(&overrides)),
            folders(
                "/settings/config",
                "/env/state",
                "/settings/data",
                "/settings/config/secrets"
            )
        );
        // An empty override is no override.
        let blank = FolderOverrides {
            config_dir: Some(String::new()),
            state_dir: Some(String::new()),
            data_dir: Some(String::new()),
        };
        assert_eq!(
            resolve_folders(&linux("/home/example").with_overrides(&blank)),
            resolve_folders(&linux("/home/example"))
        );
        // On Windows a config override keeps state and secrets beside it, off %LOCALAPPDATA%.
        let overrides = FolderOverrides {
            config_dir: Some(r"D:\comms".into()),
            state_dir: None,
            data_dir: None,
        };
        let resolved = resolve_folders(&windows().with_overrides(&overrides));
        assert_eq!(resolved.state_dir, r"D:\comms\state");
        assert_eq!(resolved.secrets_dir, r"D:\comms\secrets");
    }

    #[test]
    fn every_call_ends_with_the_four_pins() {
        let resolved = resolve_folders(&linux("/home/example"));
        let pins = resolved.pins();
        assert_eq!(
            pins,
            [
                "--config-dir".to_string(),
                resolved.config_dir.clone(),
                "--state-dir".into(),
                resolved.state_dir.clone(),
                "--data-dir".into(),
                resolved.data_dir.clone(),
                "--secrets-dir".into(),
                resolved.secrets_dir.clone(),
            ]
        );
        let program = Program {
            program: "/home/example/.local/share/agent-communications/launch/core".into(),
            leading: vec![],
        };
        for (call, _) in samples() {
            let Ok(words) = call.words() else { continue };
            let json = words.shape != Shape::VersionLine;
            let line = argv(&words, &program, &resolved, json);
            if words.shape == Shape::VersionLine {
                assert!(!words.pins, "{call:?} takes no pins");
                assert!(!line
                    .iter()
                    .any(|word| word.starts_with("--") && word.ends_with("-dir")));
            } else {
                assert!(words.pins, "{call:?} carries the pins");
                // The pins end the options: the line, or what comes before a `--` and the free text after it (0.35.0).
                let options = line
                    .iter()
                    .position(|word| word == "--")
                    .unwrap_or(line.len());
                assert!(line[..options].ends_with(&pins), "{call:?} ends {line:?}");
                assert!(line.len() - options <= 2, "{call:?} ends {line:?}");
            }
        }
    }

    #[test]
    fn paths_are_normalised_lexically_for_each_platform() {
        assert_eq!(normalise("/a//b/./c/../d/", Platform::Linux), "/a/b/d");
        assert_eq!(normalise("/../..", Platform::MacOs), "/");
        assert_eq!(normalise("/", Platform::Linux), "/");
        assert_eq!(normalise(r"C:\a\\b\.\c\..\", Platform::Windows), r"C:\a\b");
        assert_eq!(normalise(r"C:\..", Platform::Windows), r"C:\");
        assert_eq!(
            normalise(r"\\server\share\x\..\y", Platform::Windows),
            r"\\server\share\y"
        );
        assert_eq!(join(Platform::Windows, &[r"C:\x", "y", "z"]), r"C:\x\y\z");
        assert_eq!(join(Platform::Linux, &["/x/", "y"]), "/x/y");
    }
}
