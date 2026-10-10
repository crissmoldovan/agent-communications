# Agent Communications desktop

This private workspace app is the Phase C Tauri v2 shell. It currently shows inert Settings and Secrets windows, with no daemon or provider connection and no custom commands. The two entry documents are separate. Later Phase C tasks add their capabilities and security policy.

Run `pnpm --filter @agentcomms/desktop build`, `typecheck`, and `test` after installing the workspace dependencies. Native Tauri builds require the platform toolchain and a generated Cargo lockfile.
