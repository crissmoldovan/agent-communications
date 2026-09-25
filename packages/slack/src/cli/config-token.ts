import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { CommsError, canPrompt, type Streams } from '@agentcomms/core';

/**
 * Getting a Slack app configuration token from a person, for one command.
 *
 * Two ways in, and deliberately no third. A hidden prompt at a terminal, or `SLACK_APP_CONFIG_TOKEN` in that
 * command's environment. Never a command-line option — it would land in the shell's history and in the process list
 * — and never anything an MCP tool can pass, because a token typed into a chat stays in the transcript.
 *
 * Nothing here keeps the token. It is returned to the one caller that asked for it and used for that command's calls.
 */

/** The environment variable a person may set instead of typing the token. */
export const CONFIG_TOKEN_ENV = 'SLACK_APP_CONFIG_TOKEN';

/**
 * Reads one line from the terminal without showing it.
 *
 * readline in terminal mode puts a TTY into raw mode, so the terminal itself echoes nothing, and then echoes each
 * keystroke to its `output` — which here is a stream that throws everything away. The question is written to stderr
 * directly, before readline sees it. `historySize: 0` keeps the line out of readline's own history for the moment the
 * interface is open.
 *
 * Ctrl-C in raw mode is a keystroke, not a signal, and readline with no listener for it only pauses — which would
 * leave this waiting on a stream nothing will resume. So it cancels the question instead.
 */
export async function askHidden(streams: Streams, question: string): Promise<string> {
  streams.stderr.write(question);
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const rl = createInterface({
    input: streams.stdin as NodeJS.ReadableStream,
    output: muted,
    terminal: true,
    historySize: 0,
  });
  const cancel = new AbortController();
  rl.on('SIGINT', () => cancel.abort());
  try {
    return await rl.question('', { signal: cancel.signal });
  } catch {
    throw new CommsError('USAGE', 'cancelled, so nothing was changed');
  } finally {
    rl.close();
    streams.stderr.write('\n');
  }
}

/**
 * The configuration token: from the environment when it is set there, otherwise from a hidden prompt.
 *
 * Without a terminal and without the variable this refuses rather than reading stdin as it is. A pipe is where an
 * agent's shell would feed it from, and an agent that has the token has it because somebody pasted it into a chat.
 * The refusal says so, addressed to whoever reads it, and names the command to run.
 */
export async function readConfigurationToken(
  env: NodeJS.ProcessEnv,
  streams: Streams,
  options: { json: boolean; command: string },
): Promise<string> {
  const fromEnv = env[CONFIG_TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  if (!canPrompt(env, streams, { json: options.json })) {
    throw new CommsError(
      'AUTH_REQUIRED',
      'an app configuration token is needed, and there is no terminal to ask for it',
      {
        hint: `A person runs \`${options.command}\` in a terminal, which asks for the token without showing it, or sets ${CONFIG_TOKEN_ENV} for that one command. Never paste the token into a chat: the transcript keeps it.`,
      },
    );
  }
  const typed = await askHidden(
    streams,
    'App configuration token (https://api.slack.com/apps → "Your App Configuration Tokens"; it is not shown as you type): ',
  );
  return typed.trim();
}
