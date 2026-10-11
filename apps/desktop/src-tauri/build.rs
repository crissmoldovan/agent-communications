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
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_control",
            "desktop_approve",
            "desktop_preferences",
            "desktop_supervision_status",
            "desktop_start_daemon",
            "desktop_quit_daemon",
            "desktop_open_secrets",
        ]),
    ))
    .expect("desktop command manifest is valid");
}
