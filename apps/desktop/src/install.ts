/**
 * The documented install command (README.md, line 100). The app shows it when agent-communications is not installed
 * and never runs it: the one install path is the verified one (desktop design DA4). `repo-rules.test.ts` pins it to
 * the README, and it is the only line that test lets name a package after `npx`.
 */
export const INSTALL_COMMAND = 'npx -y @agentcomms/core mcp install --client claude-code';
