//! An AI provider's key on its way from Settings → AI providers to the event service (0.32.0, owner decision
//! 2026-10-26): the one secret the app holds, and only for one call. It arrives in the `provider_key_set` invoke, is
//! checked, and is handed to `provider key set <provider>` on stdin — never argv, an environment variable, a log, a
//! setting or a file. Its bytes are overwritten when the call ends, and its `Debug` shows none of them. What the
//! webview and Tauri's own IPC buffers did with the text before it arrived is theirs: the window clears its field.

use crate::allowlist::{provider_key_set, AiProvider};
use crate::ipc::CliResult;
use crate::runner::{run_with_input, RunContext};
use serde::{Deserialize, Deserializer};

/// The longest key the app passes on, in bytes: the event service's own limit.
pub const KEY_LIMIT: usize = 4096;

/// A provider key, checked: 1 to 4096 bytes, no whitespace and no control or format character (so one line, with
/// nothing a terminal would act on).
pub struct ProviderKey(Vec<u8>);

impl ProviderKey {
    /// Checks `value`, which it takes: refused, its bytes are overwritten before the refusal returns.
    pub fn new(value: String) -> Result<Self, &'static str> {
        let fits = !value.is_empty()
            && value.len() <= KEY_LIMIT
            && !value.chars().any(|character| {
                character.is_whitespace() || character.is_control() || is_format(character)
            });
        let key = ProviderKey(value.into_bytes());
        if fits {
            Ok(key)
        } else {
            // `key` drops here, and overwrites what it held.
            Err("that is not an API key: one line of 1 to 4096 characters, with no spaces")
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

/// Unicode's format characters (Cf) the app refuses everywhere: bidi controls, zero-width text, the BOM.
fn is_format(character: char) -> bool {
    matches!(
        character,
        '\u{00AD}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

impl Drop for ProviderKey {
    fn drop(&mut self) {
        for byte in self.0.iter_mut() {
            // A volatile write, so the overwrite is not optimised away as a store nobody reads.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

impl std::fmt::Debug for ProviderKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ProviderKey(hidden)")
    }
}

impl<'de> Deserialize<'de> for ProviderKey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        ProviderKey::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// `provider key set <provider>`, with `key` on its stdin; the key is overwritten when this returns.
pub fn set(provider: AiProvider, key: ProviderKey, ctx: &RunContext) -> CliResult {
    let result = run_with_input(&provider_key_set(provider), ctx, key.as_bytes());
    drop(key);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::launchers::Program;
    use crate::paths::Folders;
    #[cfg(unix)]
    use crate::paths::Platform;
    use crate::runner::{argv, command_for};

    /// A synthetic key, never a real one.
    const KEY: &str = "fake-key";

    fn folders(data: &str) -> Folders {
        Folders {
            config_dir: format!("{data}/config"),
            state_dir: format!("{data}/state"),
            data_dir: data.to_string(),
            secrets_dir: format!("{data}/secrets"),
        }
    }

    /// The command the app builds for a key carries the provider and the pins, and no byte of the key: not in argv, not
    /// in its environment.
    #[test]
    fn the_built_command_never_carries_the_key() {
        for provider in AiProvider::ALL {
            let words = provider_key_set(provider);
            assert_eq!(words.words, ["provider", "key", "set", provider.word()]);
            let program = Program {
                program: "/example/launch/events-daemon".into(),
                leading: vec![],
            };
            let folders = folders("/example");
            let line = argv(&words, &program, &folders, true);
            assert!(line.iter().all(|word| !word.contains(KEY)), "{line:?}");
            let command = command_for(&words, &program, &folders, true);
            assert!(command
                .get_args()
                .all(|arg| !arg.to_string_lossy().contains(KEY)));
            assert!(command.get_envs().all(|(name, value)| {
                !name.to_string_lossy().contains(KEY)
                    && value.is_none_or(|value| !value.to_string_lossy().contains(KEY))
            }));
        }
    }

    /// A key is one line of 1 to 4096 characters with no spaces; anything else is refused, and the refusal never
    /// repeats it. Its `Debug` hides it.
    #[test]
    fn a_key_is_checked_and_never_shown() {
        let key = ProviderKey::new(KEY.into()).expect("a key");
        assert_eq!(key.as_bytes(), KEY.as_bytes());
        assert_eq!(format!("{key:?}"), "ProviderKey(hidden)");
        for bad in [
            String::new(),
            "fake key".into(),
            "fake-key\n".into(),
            "fake-key\r".into(),
            "\tfake-key".into(),
            "fake-\u{202e}key".into(),
            "fake-\u{200b}key".into(),
            "k".repeat(KEY_LIMIT + 1),
        ] {
            let refusal = ProviderKey::new(bad.clone()).expect_err("refused");
            assert!(!refusal.contains("fake"), "{refusal}");
        }
        assert!(ProviderKey::new("k".repeat(KEY_LIMIT)).is_ok());
        let parsed: Result<ProviderKey, _> = serde_json::from_value(serde_json::json!("fake key"));
        let message = parsed.expect_err("refused").to_string();
        assert!(!message.contains("fake"), "{message}");
    }

    /// End to end, through a launcher of its own: the key reaches the events CLI on stdin, ended by one newline, and
    /// its argv is the provider, `--json` and the pins.
    #[cfg(unix)]
    #[test]
    fn the_launcher_gets_the_key_on_stdin_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("a folder");
        let launch = dir.path().join("launch");
        std::fs::create_dir_all(&launch).expect("launch");
        let launcher = launch.join("events-daemon");
        std::fs::write(
            &launcher,
            "#!/bin/sh\nhere=$(dirname \"$0\")\nprintf '%s\\n' \"$@\" > \"$here/argv\"\nenv > \"$here/env\"\ncat > \"$here/stdin\"\nprintf '{\"provider\":\"openrouter\",\"hasKey\":true,\"judges\":0}\\n'\n",
        )
        .expect("a launcher");
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755))
            .expect("executable");
        let data = dir.path().to_string_lossy().into_owned();
        let ctx = RunContext {
            folders: folders(&data),
            platform: Platform::current(),
            node: None,
        };
        let result = set(
            AiProvider::Openrouter,
            ProviderKey::new(KEY.into()).expect("a key"),
            &ctx,
        );
        assert_eq!(
            result,
            CliResult::Ok {
                exit: 0,
                data: serde_json::json!({ "provider": "openrouter", "hasKey": true, "judges": 0 })
            }
        );
        let stdin = std::fs::read_to_string(launch.join("stdin")).expect("stdin");
        assert_eq!(stdin, format!("{KEY}\n"));
        let argv = std::fs::read_to_string(launch.join("argv")).expect("argv");
        let mut expected = vec![
            "provider".to_string(),
            "key".into(),
            "set".into(),
            "openrouter".into(),
            "--json".into(),
        ];
        expected.extend(ctx.folders.pins());
        assert_eq!(argv.lines().collect::<Vec<_>>(), expected);
        assert!(!argv.contains(KEY));
        let env = std::fs::read_to_string(launch.join("env")).expect("env");
        assert!(!env.contains(KEY));
    }
}
