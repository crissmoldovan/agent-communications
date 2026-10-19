//! This installation's stable launchers, `<data>/launch/<product>` (DA12), and what starts them.
//!
//! The app has agent-communications when `launch/core` is there, and each channel's section appears when its
//! launcher is. On macOS and Linux a launcher is a shell script the app runs directly; on Windows it is a script Node
//! runs, and the Node is the one the launcher names on its second line (plan, "Where the design is silent" 2), or
//! `node.exe` on PATH.

use crate::allowlist::Call;
use crate::ipc::{AppError, CliResult, Installation};
use crate::paths::{join, Folders, Platform};
use crate::runner::{run, RunContext};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// The six products a launcher starts, named as their launchers are.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Product {
    Core,
    Gmail,
    Slack,
    Resend,
    Whatsapp,
    EventsDaemon,
}

impl Product {
    /// Every product, in the order the app lists them.
    pub const ALL: [Product; 6] = [
        Product::Core,
        Product::Gmail,
        Product::Slack,
        Product::Resend,
        Product::Whatsapp,
        Product::EventsDaemon,
    ];

    /// The launcher's file name: the package's name without its scope.
    pub fn name(self) -> &'static str {
        match self {
            Product::Core => "core",
            Product::Gmail => "gmail",
            Product::Slack => "slack",
            Product::Resend => "resend",
            Product::Whatsapp => "whatsapp",
            Product::EventsDaemon => "events-daemon",
        }
    }
}

/// A launcher that is there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launcher {
    pub product: Product,
    pub path: String,
}

/// What a process is started as: on macOS and Linux the launcher itself, on Windows Node with the launcher as its
/// first word. No shell, ever.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Program {
    pub program: String,
    pub leading: Vec<String>,
}

/// `<data>/launch/<product>`, with the platform's separator.
pub fn launcher_path(folders: &Folders, platform: Platform, product: Product) -> String {
    join(platform, &[&folders.data_dir, "launch", product.name()])
}

/// The product's launcher, when it is a file — and, on macOS and Linux, one that can be run.
pub fn find_launcher(folders: &Folders, platform: Platform, product: Product) -> Option<Launcher> {
    let path = launcher_path(folders, platform, product);
    let metadata = std::fs::metadata(&path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    #[cfg(unix)]
    if platform != Platform::Windows {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return None;
        }
    }
    Some(Launcher { product, path })
}

/// Whether `path` is on a network share: it starts with two separators, of either kind — `\\server\share`,
/// `//server/share`, and Windows' `\\?\UNC\…` and `\\.\UNC\…` all do.
pub fn on_a_network_share(path: &str) -> bool {
    let mut start = path.chars();
    matches!(
        (start.next(), start.next()),
        (Some('\\' | '/'), Some('\\' | '/'))
    )
}

/// Whether the app may run `launcher` (DA12, after review): never one on a network share, whose owner decides what it
/// runs; and on macOS and Linux only one that is this user's, in a folder that is this user's, neither of which
/// another user may change (core writes both owner-only). Refused with `APP_UNSAFE_LAUNCHER`, saying why and what to do.
pub fn check_launcher(launcher: &Launcher, platform: Platform) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        // SAFETY: geteuid takes nothing, cannot fail, and touches no memory of this process.
        let uid = unsafe { libc::geteuid() };
        check_launcher_as(launcher, platform, uid)
    }
    #[cfg(not(unix))]
    {
        check_launcher_as(launcher, platform, 0)
    }
}

/// `check_launcher`, for the user `uid` (unused on Windows).
pub(crate) fn check_launcher_as(
    launcher: &Launcher,
    platform: Platform,
    uid: u32,
) -> Result<(), AppError> {
    let name = launcher.product.name();
    let path = &launcher.path;
    if on_a_network_share(path) {
        return Err(AppError::unsafe_launcher(format!(
            "the {name} launcher at {path} is on a network share, and the app runs launchers from this machine's own disks only: name a local data folder in Settings"
        )));
    }
    #[cfg(unix)]
    if platform != Platform::Windows {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let file = std::path::Path::new(path);
        let folder = file.parent().unwrap_or(file);
        for (what, at) in [("launcher", file), ("launcher's folder", folder)] {
            let metadata = std::fs::metadata(at).map_err(|error| {
                AppError::unsafe_launcher(format!(
                    "the {name} {what} at {} could not be read: {error}",
                    at.display()
                ))
            })?;
            if metadata.uid() != uid {
                return Err(AppError::unsafe_launcher(format!(
                    "the {name} {what} at {} belongs to another user, so the app will not run it: it runs only launchers that are yours",
                    at.display()
                )));
            }
            let mode = metadata.permissions().mode() & 0o777;
            if mode & 0o022 != 0 {
                return Err(AppError::unsafe_launcher(format!(
                    "the {name} {what} at {} can be changed by other users (its mode is {mode:o}), so the app will not run it: run chmod go-w '{}'",
                    at.display(),
                    at.display()
                )));
            }
        }
    }
    let _ = (platform, uid);
    Ok(())
}

/// The products whose launchers are there, in `Product::ALL`'s order.
pub fn present(folders: &Folders, platform: Platform) -> Vec<Product> {
    Product::ALL
        .into_iter()
        .filter(|product| find_launcher(folders, platform, *product).is_some())
        .collect()
}

/// The second line of the Windows launcher core writes (`packages/core/src/launcher.ts`, `windowsSource`), which
/// names its Node as a JSON string. Core pins this line (plan, Task 2).
static HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^// updates; do not edit\. Started by ("(?:[^"\\]|\\.)*") with this file as its first word"#)
        .expect("a pattern")
});

/// The Node a Windows launcher names on its second line, or none.
pub fn windows_node_from_launcher(text: &str) -> Option<String> {
    let line = text.lines().nth(1)?.trim_end_matches('\r');
    let quoted = HEADER.captures(line)?.get(1)?.as_str();
    serde_json::from_str::<String>(quoted)
        .ok()
        .filter(|node| !node.is_empty())
}

/// `node.exe` in the first folder of a Windows `PATH` that has one. A folder that is not a full path is skipped, so no
/// Node is ever started from the app's working folder, or one named from it.
pub fn node_on_path(path_var: &str) -> Option<String> {
    path_var
        .split(';')
        .map(|folder| folder.trim().trim_matches('"'))
        .filter(|folder| !folder.is_empty() && std::path::Path::new(folder).is_absolute())
        .map(|folder| std::path::Path::new(folder).join("node.exe"))
        .find(|candidate| candidate.is_file())
        .map(|candidate| candidate.to_string_lossy().into_owned())
}

/// The Node to start Windows launchers with: the one core's launcher names, or `node.exe` on `PATH`.
pub fn windows_node(core_launcher_text: Option<&str>, path_var: &str) -> Option<String> {
    core_launcher_text
        .and_then(windows_node_from_launcher)
        .or_else(|| node_on_path(path_var))
}

/// How `launcher` is started on `platform`.
pub fn program_for(
    launcher: &Launcher,
    platform: Platform,
    node: Option<&str>,
) -> Result<Program, AppError> {
    match platform {
        Platform::Windows => {
            let node = node.ok_or_else(AppError::no_node)?;
            Ok(Program {
                program: node.to_string(),
                leading: vec![launcher.path.clone()],
            })
        }
        Platform::MacOs | Platform::Linux => Ok(Program {
            program: launcher.path.clone(),
            leading: vec![],
        }),
    }
}

/// What is installed here. Without `launch/core` nothing is run, and the app shows only the install screen; with it,
/// core's version is read with `--version`.
pub fn discover(ctx: &RunContext) -> Installation {
    if find_launcher(&ctx.folders, ctx.platform, Product::Core).is_none() {
        return Installation {
            installed: false,
            version: None,
            present: vec![],
            folders: ctx.folders.clone(),
            problem: None,
        };
    }
    let (version, problem) = match run(
        &Call::Version {
            product: Product::Core,
        },
        ctx,
    ) {
        CliResult::Version { version } => (Some(version), None),
        CliResult::Failed { message, .. } => (None, Some(message)),
        other => (
            None,
            Some(format!("core's --version gave no version: {other:?}")),
        ),
    };
    Installation {
        installed: true,
        version,
        present: present(&ctx.folders, ctx.platform),
        folders: ctx.folders.clone(),
        problem,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the Unix-only tests start a launcher with a call.
    #[cfg_attr(windows, allow(unused_imports))]
    use crate::allowlist::Call;
    use crate::paths::{Folders, Platform};
    use std::fs;
    use std::path::Path;

    /// Folders whose data folder is a fresh temporary one, named as this host names it.
    fn temp_folders() -> (tempfile::TempDir, Folders) {
        let dir = tempfile::tempdir().expect("a temporary folder");
        let data = dir.path().to_string_lossy().into_owned();
        let folders = Folders {
            config_dir: format!("{data}-config"),
            state_dir: format!("{data}-state"),
            data_dir: data.clone(),
            secrets_dir: format!("{data}-secrets"),
        };
        (dir, folders)
    }

    /// Writes `<data>/launch/<name>` with `text`, executable on POSIX.
    fn write_launcher(data: &Path, name: &str, text: &str) {
        let launch = data.join("launch");
        fs::create_dir_all(&launch).expect("the launch folder");
        let path = launch.join(name);
        fs::write(&path, text).expect("a launcher");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("executable");
        }
    }

    const HEADER: &str = "// The stable launcher of agent-communications for core, format 1, for Windows. Written by managed installs and\n// updates; do not edit. Started by \"C:\\\\Program Files\\\\nodejs\\\\node.exe\" with this file as its first word: it starts the runtime the pointer\n// beside it names, in this process.\n'use strict';\n";

    #[test]
    fn discover_reports_not_installed_without_launch_core() {
        let (dir, folders) = temp_folders();
        // A channel's launcher alone is not an installation; if it ran, it would leave a mark.
        let mark = dir.path().join("ran");
        write_launcher(
            dir.path(),
            "gmail",
            &format!("#!/bin/sh\ntouch '{}'\n", mark.display()),
        );
        let ctx = RunContext {
            folders: folders.clone(),
            platform: Platform::current(),
            node: None,
        };
        let installation = discover(&ctx);
        assert!(!installation.installed);
        assert_eq!(installation.version, None);
        assert!(installation.present.is_empty());
        assert_eq!(installation.problem, None);
        assert_eq!(installation.folders, folders);
        assert!(
            !mark.exists(),
            "nothing runs when there is no core launcher"
        );
    }

    #[test]
    fn each_product_is_present_when_its_launcher_is_a_file() {
        let (dir, folders) = temp_folders();
        for name in ["core", "slack", "events-daemon"] {
            write_launcher(dir.path(), name, "#!/bin/sh\n");
        }
        let platform = Platform::current();
        assert_eq!(
            present(&folders, platform),
            vec![Product::Core, Product::Slack, Product::EventsDaemon]
        );
        assert_eq!(find_launcher(&folders, platform, Product::Gmail), None);
        let core = find_launcher(&folders, platform, Product::Core).expect("core's launcher");
        assert_eq!(core.product, Product::Core);
        assert_eq!(
            core.path,
            dir.path().join("launch").join("core").to_string_lossy()
        );
        // The path is built with the platform's separator, whatever the host.
        let windows = Folders {
            data_dir: r"C:\Users\example\AppData\Local\agent-communications".into(),
            ..folders.clone()
        };
        assert_eq!(
            launcher_path(&windows, Platform::Windows, Product::EventsDaemon),
            r"C:\Users\example\AppData\Local\agent-communications\launch\events-daemon"
        );
        let linux = Folders {
            data_dir: "/home/example/.local/share/agent-communications".into(),
            ..folders.clone()
        };
        assert_eq!(
            launcher_path(&linux, Platform::Linux, Product::Whatsapp),
            "/home/example/.local/share/agent-communications/launch/whatsapp"
        );
        // On POSIX a launcher is a file that can be run: one without its executable bit is not one.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let resend = dir.path().join("launch").join("resend");
            fs::write(&resend, "#!/bin/sh\n").expect("a file");
            fs::set_permissions(&resend, fs::Permissions::from_mode(0o644))
                .expect("not executable");
            assert_eq!(find_launcher(&folders, platform, Product::Resend), None);
        }
    }

    #[test]
    fn a_directory_named_like_a_launcher_is_not_one() {
        let (dir, folders) = temp_folders();
        fs::create_dir_all(dir.path().join("launch").join("core")).expect("a folder");
        assert_eq!(
            find_launcher(&folders, Platform::current(), Product::Core),
            None
        );
        assert!(
            !discover(&RunContext {
                folders,
                platform: Platform::current(),
                node: None
            })
            .installed
        );
    }

    #[test]
    fn windows_node_comes_from_the_launcher_header() {
        assert_eq!(
            windows_node_from_launcher(HEADER).as_deref(),
            Some(r"C:\Program Files\nodejs\node.exe")
        );
        assert_eq!(
            windows_node_from_launcher(&HEADER.replace('\n', "\r\n")).as_deref(),
            Some(r"C:\Program Files\nodejs\node.exe")
        );
        // Only the second line, only in that sentence, only as a JSON string, and never an empty one.
        let first_line_only = HEADER.lines().nth(1).expect("line 2").to_string();
        assert_eq!(windows_node_from_launcher(&first_line_only), None);
        assert_eq!(
            windows_node_from_launcher(&format!("// another first line\n\n{HEADER}")),
            None
        );
        assert_eq!(
            windows_node_from_launcher(&HEADER.replace("\"C:\\\\Program", "C:\\\\Program")),
            None
        );
        assert_eq!(
            windows_node_from_launcher(
                "// x\n// updates; do not edit. Started by \"\" with this file as its first word\n"
            ),
            None
        );
        assert_eq!(
            windows_node_from_launcher(
                "// x\n// updates; do not edit. Started by \"bad \\q\" with this file as its first word\n"
            ),
            None
        );
    }

    #[test]
    fn windows_falls_back_to_node_on_path() {
        let first = tempfile::tempdir().expect("a folder");
        let second = tempfile::tempdir().expect("a folder");
        fs::write(second.path().join("node.exe"), "").expect("a node");
        let path_var = format!(
            "{};\"{}\";",
            first.path().display(),
            second.path().display()
        );
        let found = second
            .path()
            .join("node.exe")
            .to_string_lossy()
            .into_owned();
        assert_eq!(node_on_path(&path_var), Some(found.clone()));
        assert_eq!(node_on_path(""), None);
        assert_eq!(node_on_path(&first.path().to_string_lossy()), None);
        // The launcher's header wins; a launcher without one, or none at all, falls back to PATH.
        assert_eq!(
            windows_node(Some(HEADER), &path_var).as_deref(),
            Some(r"C:\Program Files\nodejs\node.exe")
        );
        assert_eq!(
            windows_node(Some("'use strict';\n"), &path_var),
            Some(found.clone())
        );
        assert_eq!(windows_node(None, &path_var), Some(found));
        assert_eq!(windows_node(None, ""), None);
    }

    #[test]
    fn a_relative_path_folder_is_never_searched_for_node() {
        // A folder named relative to the working folder, which really holds a node.exe from where the test runs: on
        // Windows a launch from Explorer or the Start menu can have such a PATH entry, and it is never searched.
        let target = Path::new(env!("CARGO_MANIFEST_DIR")).join("target");
        fs::create_dir_all(&target).expect("target");
        let planted = tempfile::Builder::new()
            .prefix("relative-node-")
            .tempdir_in(&target)
            .expect("a folder");
        fs::write(planted.path().join("node.exe"), "").expect("a planted node");
        let name = planted
            .path()
            .file_name()
            .expect("a name")
            .to_string_lossy()
            .into_owned();
        let relative = format!("target{}{name}", std::path::MAIN_SEPARATOR);
        let cwd = std::env::current_dir().expect("a working folder");
        assert!(
            cwd.join(&relative).join("node.exe").is_file(),
            "the planted node is found from {cwd:?} as {relative}"
        );
        assert_eq!(node_on_path(&relative), None);
        assert_eq!(node_on_path(&format!(".;{relative};\"{relative}\"")), None);
        // An absolute folder after it is still found.
        let absolute = tempfile::tempdir().expect("a folder");
        fs::write(absolute.path().join("node.exe"), "").expect("a node");
        assert_eq!(
            node_on_path(&format!("{relative};{}", absolute.path().display())),
            Some(
                absolute
                    .path()
                    .join("node.exe")
                    .to_string_lossy()
                    .into_owned()
            )
        );
    }

    #[test]
    fn a_launcher_on_a_network_share_is_never_run() {
        for (platform, path) in [
            (
                Platform::Windows,
                r"\\server\share\agent-communications\launch\core",
            ),
            (Platform::Windows, r"\\?\UNC\server\share\launch\core"),
            (Platform::Windows, "//server/share/launch/core"),
            (Platform::Linux, "//server/share/launch/core"),
            (Platform::MacOs, "//server/share/launch/core"),
        ] {
            let launcher = Launcher {
                product: Product::Core,
                path: path.into(),
            };
            let refused = check_launcher(&launcher, platform).expect_err(path);
            assert_eq!(refused.code, "APP_UNSAFE_LAUNCHER", "{path}");
            assert!(
                refused.message.contains("network share"),
                "{}",
                refused.message
            );
        }
        assert!(on_a_network_share(r"\\server\share"));
        assert!(!on_a_network_share(r"C:\Users\example"));
        assert!(!on_a_network_share("/Volumes/Share/agent-communications"));
    }

    /// POSIX: a launcher, or its folder, that another user owns or may change is not one the app runs.
    #[cfg(unix)]
    #[test]
    fn a_launcher_someone_else_may_change_is_never_run() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, folders) = temp_folders();
        let mark = dir.path().join("ran");
        write_launcher(
            dir.path(),
            "core",
            &format!(
                "#!/bin/sh\ntouch '{}'\nprintf '{{\"ok\":true,\"data\":[]}}\\n'\n",
                mark.display()
            ),
        );
        let launch = dir.path().join("launch");
        let file = launch.join("core");
        fs::set_permissions(&launch, fs::Permissions::from_mode(0o700)).expect("private");
        let platform = Platform::current();
        let core = find_launcher(&folders, platform, Product::Core).expect("there");
        assert_eq!(check_launcher(&core, platform), Ok(()));
        let ctx = RunContext {
            folders: folders.clone(),
            platform,
            node: None,
        };
        let run_refused = |why: &str| {
            let result = crate::runner::run(&Call::Label {}, &ctx);
            assert!(
                matches!(&result, CliResult::Failed { code, message, .. }
                    if code == "APP_UNSAFE_LAUNCHER" && message.contains(why)),
                "{result:?}"
            );
            assert!(!mark.exists(), "the launcher ran");
        };
        // Writable by its group, or by anyone: refused, saying how to make it the user's alone.
        for mode in [0o775, 0o757, 0o777] {
            fs::set_permissions(&file, fs::Permissions::from_mode(mode)).expect("mode");
            let refused = check_launcher(&core, platform).expect_err("writable");
            assert_eq!(refused.code, "APP_UNSAFE_LAUNCHER");
            assert!(
                refused.message.contains("chmod go-w"),
                "{}",
                refused.message
            );
            run_refused("other users");
        }
        fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).expect("mode");
        // Its folder too.
        for mode in [0o770, 0o707, 0o777] {
            fs::set_permissions(&launch, fs::Permissions::from_mode(mode)).expect("mode");
            assert!(check_launcher(&core, platform).is_err(), "{mode:o}");
            run_refused("other users");
        }
        fs::set_permissions(&launch, fs::Permissions::from_mode(0o755)).expect("mode");
        assert_eq!(check_launcher(&core, platform), Ok(()));
        // Owned by another user: refused (the user is stood in for, since a test cannot give a file away).
        let mine = std::os::unix::fs::MetadataExt::uid(&fs::metadata(&file).expect("there"));
        let refused = check_launcher_as(&core, platform, mine + 1).expect_err("not yours");
        assert!(
            refused.message.contains("another user"),
            "{}",
            refused.message
        );
        // And the terminal never builds a line for one either.
        fs::set_permissions(&file, fs::Permissions::from_mode(0o777)).expect("mode");
        let line = crate::terminal::argv_for(
            &crate::ipc::TerminalCommand::Approve {
                product: Product::Core,
                approval_id: crate::allowlist::ID.to_string().try_into().expect("an id"),
            },
            &ctx,
        )
        .expect_err("refused");
        assert_eq!(line.code, "APP_UNSAFE_LAUNCHER");
    }

    #[test]
    fn windows_without_node_cannot_run() {
        let launcher = Launcher {
            product: Product::Core,
            path: r"C:\Users\example\AppData\Local\agent-communications\launch\core".into(),
        };
        let refused = program_for(&launcher, Platform::Windows, None).expect_err("no node");
        assert_eq!(refused.code, "APP_NO_NODE");
        assert_eq!(
            program_for(&launcher, Platform::Windows, Some(r"C:\node\node.exe")).expect("a node"),
            Program {
                program: r"C:\node\node.exe".into(),
                leading: vec![launcher.path.clone()],
            }
        );
        // On macOS and Linux the launcher is the program itself, and needs no node.
        let posix = Launcher {
            product: Product::Core,
            path: "/home/example/.local/share/agent-communications/launch/core".into(),
        };
        assert_eq!(
            program_for(&posix, Platform::Linux, None).expect("the launcher"),
            Program {
                program: posix.path.clone(),
                leading: vec![],
            }
        );
        // And a run on Windows without node reports it before it looks for anything, on any host.
        let (dir, folders) = temp_folders();
        write_launcher(dir.path(), "core", "'use strict';\n");
        let ctx = RunContext {
            folders,
            platform: Platform::Windows,
            node: None,
        };
        let result = crate::runner::run(&crate::allowlist::Call::Label {}, &ctx);
        assert!(
            matches!(result, CliResult::Failed { ref code, .. } if code == "APP_NO_NODE"),
            "{result:?}"
        );
    }

    #[test]
    fn products_are_named_as_their_launchers() {
        let names: Vec<&str> = Product::ALL.iter().map(|product| product.name()).collect();
        assert_eq!(
            names,
            [
                "core",
                "gmail",
                "slack",
                "resend",
                "whatsapp",
                "events-daemon"
            ]
        );
        assert_eq!(
            serde_json::to_string(&Product::EventsDaemon).expect("json"),
            "\"events-daemon\""
        );
        assert!(serde_json::from_str::<Product>("\"events\"").is_err());
    }
}
