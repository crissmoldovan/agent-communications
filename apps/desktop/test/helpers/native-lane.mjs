// Cargo builds and compiled Rust proofs need the Rust toolchain, the locked crates and, on Linux, Tauri's system
// libraries. Root `pnpm verify` keeps them out (Phase C plan: Cargo and bundle checks run in the desktop workflow), so a
// machine without that toolchain still verifies the repository. `pnpm --filter @agentcomms/desktop test:native` runs
// every desktop test with them, and the desktop workflow does so on each operating system after its Rust gates.
export const NATIVE_SKIP =
  process.env.AGENTCOMMS_DESKTOP_NATIVE === '1'
    ? undefined
    : 'Cargo proof: runs in the desktop workflow (pnpm --filter @agentcomms/desktop test:native)';
