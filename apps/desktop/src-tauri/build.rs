fn main() {
    let root =
        std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../..");
    for path in [
        "apps/desktop/scripts/b3-contract.mjs",
        "packages/events-daemon/src/operations/contracts",
        "packages/events-daemon/src/runtime/control-operation-registry.ts",
        "packages/events-daemon/test/fixtures/b3-control-contract-v1",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }
    let generated = std::process::Command::new("node")
        .args([
            "--experimental-strip-types",
            "--disable-warning=ExperimentalWarning",
        ])
        .arg(root.join("apps/desktop/scripts/b3-contract.mjs"))
        .output()
        .expect("desktop-b3-wire-contract: Node build tool is required");
    assert!(
        generated.status.success(),
        "desktop-b3-wire-contract: schema/vector generation failed: {}",
        String::from_utf8_lossy(&generated.stderr)
    );
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("b3_generated.rs"),
        generated.stdout,
    )
    .expect("desktop-b3-wire-contract: cannot save generated DTOs");
    let commands = &[
        "desktop_control",
        "desktop_approve",
        "desktop_preferences",
        "desktop_supervision_status",
        "desktop_start_daemon",
        "desktop_quit_daemon",
        "desktop_open_secrets",
        "desktop_target_secret_create",
        "desktop_target_secret_rotate",
        "desktop_target_url_set",
        "desktop_subscriber_token_create",
        "desktop_subscriber_token_rotate",
        "desktop_judge_key_set",
        "desktop_judge_key_rotate",
        "desktop_secrets_migrate",
    ];
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("app_commands.rs"),
        format!("pub const APP_COMMANDS: &[&str] = &{commands:?};\n"),
    )
    .expect("command declaration inventory");
    // The no-egress probe's own commands are not app commands: a release build must not grant them. Only a build with
    // the `no-egress-probe` feature compiles in their permission (permissions/probe) and the capability that grants it
    // to both windows (capabilities/probe); every other build reads the top-level capabilities alone.
    let probe = std::env::var_os("CARGO_FEATURE_NO_EGRESS_PROBE").is_some();
    println!("cargo:rerun-if-changed=capabilities");
    println!("cargo:rerun-if-changed=permissions/probe");
    let mut app_manifest = tauri_build::AppManifest::new().commands(commands);
    if probe {
        app_manifest = app_manifest.permissions_path_pattern("./permissions/probe/*.toml");
    }
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(app_manifest)
        .capabilities_path_pattern(if probe {
            "./capabilities/**/*.json"
        } else {
            "./capabilities/*.json"
        });
    // Tauri embeds its Windows application manifest (Common Controls v6) in the app binary only, but the mock-runtime
    // tests link the same controls: without it a test executable cannot start (STATUS_ENTRYPOINT_NOT_FOUND). The same
    // manifest (windows-app-manifest.xml, tauri-build's own) is embedded in every binary of the package instead.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::try_build(attributes).expect("desktop command manifest is valid");
}
