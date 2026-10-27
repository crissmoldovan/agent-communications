import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A stand-in for Claude Code's own `claude` command, as a POSIX script: `mcp add-json <name> <json> --scope user|local`
 * and `mcp remove <name> --scope user|local`, kept in `config` as Claude Code keeps them — user scope at the top, local
 * scope under `projects[<the folder it ran in>]` — and every command it was given written to `log`. No real client
 * configuration is read or written, and no real client runs.
 */
export function fakeClaude(bin: string, config: string, log: string): void {
  const script = [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `const config = ${JSON.stringify(config)};`,
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");`,
    'const args = process.argv.slice(2);',
    'const [, sub, name, json] = args;',
    'const scope = args[args.indexOf("--scope") + 1] || "local";',
    'let current = {};',
    'try { current = JSON.parse(fs.readFileSync(config, "utf8")); } catch {}',
    'const holder = () => {',
    '  if (scope === "user") return (current.mcpServers ??= {});',
    '  current.projects ??= {};',
    '  const project = (current.projects[process.cwd()] ??= {});',
    '  return (project.mcpServers ??= {});',
    '};',
    'if (sub === "add-json") {',
    '  const servers = holder();',
    '  if (servers[name]) { process.stderr.write("MCP server " + name + " already exists"); process.exit(1); }',
    '  servers[name] = JSON.parse(json);',
    '}',
    'if (sub === "remove") {',
    '  const servers = holder();',
    '  if (!servers[name]) { process.stderr.write("No MCP server found with name: " + name); process.exit(1); }',
    '  delete servers[name];',
    '}',
    'fs.writeFileSync(config, JSON.stringify(current, null, 2));',
  ].join('\n');
  writeFileSync(join(bin, 'claude'), script, { mode: 0o755 });
}
