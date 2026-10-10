# Agent Communications desktop — unsigned version 1 prerelease

This file is the exact checked-in source for the GitHub prerelease notes.

## Before installing

This unsigned prerelease is for the owner and a few named colleagues. It requires a separate daemon installation
and a running, compatible local event daemon; the desktop does not bundle, install or start that daemon.
The event library and daemon remain held from npm release. Obtain the checked daemon build from the maintainer;
do not interpret a desktop tag as lifting those holds. The current shell has inert Settings and Secrets windows;
daemon attachment arrives in the later Phase C tasks.

Download the artifact and `SHA256SUMS` from the same `desktop-v<version>` prerelease. Before opening or installing,
compute its SHA-256 and compare the complete hexadecimal result with the line for that exact filename in
`SHA256SUMS`. Stop if they differ. The checksum detects mismatched or corrupted downloads; it is not publisher
code signing.

On macOS:

```sh
shasum -a 256 desktop-macos-universal.app.zip
```

On Windows (PowerShell):

```powershell
Get-FileHash .\desktop-windows-x64-setup.exe -Algorithm SHA256
```

## macOS first launch

Extract the universal app ZIP, move Agent Communications.app to Applications, open the app once and dismiss the
warning. In **System Settings**, **Privacy & Security**, under Security, choose **Open Anyway** (offered for
about an hour after that attempt) and enter the login password. A new version may need the same step again.
The app is signed ad hoc, as Apple silicon requires, and is not notarised.

## Windows first launch

Run the x64 NSIS installer. At **Windows protected your PC**, choose **More info**, then **Run anyway**.
Each new unsigned version starts with no SmartScreen reputation, so this step can recur. Enterprise policy can
remove the choice. Windows 11's Smart App Control blocks unsigned files with no reputation: a machine with it on
cannot run version 1. Do not disable organizational or operating-system protections to install it.

## Version 1 distribution limits

There is no in-app updater; download and install each new version by hand and compare its checksum again.
There is no Linux version-1 artifact, although Linux must pass the same CI build and webview gates.

Any wider release beyond the owner and named colleagues, including a non-prerelease, a link outside that group,
a store listing or an auto-update, first requires an Apple Developer ID signature: notarise and staple the macOS
bundle, and sign Windows with a code-signing certificate. Those future credentials belong only in a protected
release environment. The current workflows contain no signing credentials and can publish only a prerelease,
never mark it latest.

