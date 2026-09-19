#!/usr/bin/env node
/**
 * The Gmail MCP server as its own command, so a client configuration can name it directly:
 *
 *     npx -y @agent-communications/gmail-mcp@<version>
 *
 * It is one call into `@agent-communications/gmail`; everything the server does lives there, and `agent-gmail mcp` starts the
 * same server. Options mirror that command: `--inbox <alias>` serves one mailbox, `--read-only` registers only the
 * tools that cannot change anything.
 */
import { createGmailMcpServer } from '@agent-communications/gmail';

const argv = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write(
    [
      'agent-gmail-mcp — the Gmail MCP server (stdio)',
      '',
      'Options:',
      '  --inbox <alias>   serve only this mailbox',
      '  --read-only       register only the tools that cannot change anything',
      '',
      'Set up mailboxes with the `agent-gmail` command from @agent-communications/gmail.',
      '',
    ].join('\n'),
  );
  process.exit(0);
}

const server = await createGmailMcpServer({
  inbox: flagValue('--inbox'),
  readOnly: argv.includes('--read-only'),
});

// Resolves when the client disconnects; nothing else keeps this process alive.
await server.connectStdio();
