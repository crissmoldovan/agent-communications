#!/usr/bin/env node
import { parseArgs } from 'node:util';
/**
 * The Gmail MCP server as its own command, so a client configuration can name it directly:
 *
 *     npx -y @agentcomms/gmail-mcp@<version>
 *
 * It is one call into `@agentcomms/gmail`; everything the server does lives there, and the Gmail CLI's `mcp` starts the
 * same server. Options mirror that command: `--inbox <alias>` serves one mailbox, `--read-only` registers only the
 * tools that cannot change anything.
 */
import { createGmailMcpServer, type GmailCommandOptions, gmailCommand, markMcpServerProcess } from '@agentcomms/gmail';
import { serverHelp } from './help.ts';

const argv = process.argv.slice(2);

/**
 * The help, its `setup` located by the Gmail dependency for the folders this server would use — the pins it was given,
 * or none when they could not be read — so the mailboxes a person sets up are the ones this server reads (CUE-403).
 */
const help = (pathOverrides?: GmailCommandOptions['pathOverrides']): string =>
  serverHelp(gmailCommand(['setup'], { pathOverrides }));

let values:
  | {
      help?: boolean;
      inbox?: string;
      'read-only'?: boolean;
      'config-dir'?: string;
      'state-dir'?: string;
      'data-dir'?: string;
      'secrets-dir'?: string;
    }
  | undefined;
try {
  ({ values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      inbox: { type: 'string' },
      'read-only': { type: 'boolean' },
      'config-dir': { type: 'string' },
      'state-dir': { type: 'string' },
      'data-dir': { type: 'string' },
      'secrets-dir': { type: 'string' },
    },
  }));
  for (const name of ['config-dir', 'state-dir', 'data-dir', 'secrets-dir'] as const) {
    if (values[name] === '') throw new TypeError(`--${name} needs a non-empty directory`);
  }
} catch (error) {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n\n${help()}`);
  values = undefined;
  process.exitCode = 64;
}

const pathOverrides = values && {
  ...(values['config-dir'] === undefined ? {} : { configDir: values['config-dir'] }),
  ...(values['state-dir'] === undefined ? {} : { stateDir: values['state-dir'] }),
  ...(values['data-dir'] === undefined ? {} : { dataDir: values['data-dir'] }),
  ...(values['secrets-dir'] === undefined ? {} : { secretsDir: values['secrets-dir'] }),
};

if (values?.help) {
  process.stderr.write(help(pathOverrides));
} else if (values) {
  // Gmail's server, started without Gmail's CLI: marked here as that CLI's `mcp` marks it, so every program it starts
  // inherits the mark and none of them can make a person's read (§4).
  markMcpServerProcess(process.env, 'gmail');
  const server = await createGmailMcpServer({
    inbox: values.inbox,
    readOnly: values['read-only'],
    pathOverrides,
  });

  // Resolves when the client disconnects; nothing else keeps this process alive.
  await server.connectStdio();
}
