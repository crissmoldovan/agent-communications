import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import {
  type CliHandoffs,
  CommsError,
  type Config,
  handoffSentence,
  organisationsOf,
  wholeNumber,
} from '@agentcomms/core';
import type { SlackContext } from '../context.ts';
import {
  appManifestUrl,
  buildManifest,
  chosenPortSentence,
  INSTALL_MODES,
  type InstallMode,
  type SlackManifest,
} from '../manifest.ts';
import { requireWorkspace } from './workspaces.ts';

/**
 * The Slack app to create or update, for `agent-slack manifest` and `slack_manifest` alike.
 *
 * Changing what a workspace's app may ask for is a person's act on api.slack.com, and stays one: it needs either that
 * page or an app configuration token that can rewrite every app its owner has. What an agent can do is make that act
 * one paste — hand over the manifest, and for a workspace already connected, the link to that app's own manifest page
 * rather than to the list of apps, where the one to edit has to be found by name and a new one is one click away.
 */

export interface ManifestResult {
  readonly mode: InstallMode;
  readonly port: number;
  readonly redirectUrl: string;
  readonly manifest: SlackManifest;
  /** The workspace whose app this is for, when one was named. */
  readonly workspace: string | null;
  /** That workspace's app, as recorded at sign-in. Null for a workspace connected before it was kept. */
  readonly appId: string | null;
  /** Where that app's manifest is edited. Null unless both of the above are known. */
  readonly manifestUrl: string | null;
  /**
   * Where `port` came from: `given` by the caller, `recorded` when the named workspace signed in, or `chosen` by this
   * call for a new app — free when asked, and no port another workspace here records.
   */
  readonly portFrom: 'given' | 'recorded' | 'chosen';
  /**
   * What to do with this manifest, in order, each step a sentence — the same words from the command and from the tool.
   * A command in them is this installation's own, located, with this port; or, where there is none, what to use instead.
   */
  readonly steps: readonly string[];
  /** Said beside the steps: why the app has to be a new one when PKCE is off, and whose a chosen port now is. */
  readonly notes: readonly string[];
}

/**
 * A loopback port, checked rather than coerced: the one given, else the one recorded, else a refusal.
 *
 * Slack matches redirect URLs exactly, so a port nobody chose is worse than none — the sign-in would complete at
 * Slack and fail on the way back. Never guessed.
 */
export function checkedPort(raw: unknown, recorded?: number): number {
  const value = raw ?? recorded;
  if (value === undefined) {
    throw new CommsError('USAGE', 'the loopback port is needed, and must match the one in the manifest', {
      hint: 'Slack matches redirect URLs exactly. Pass the same `--port` you built the manifest with.',
    });
  }
  // Named as the tool spells it, which the command's `--port` reads as too: both surfaces refuse it in the same words.
  return wholeNumber(value, { name: 'port', min: 1, max: 65535 }) as number;
}

/**
 * A mode asked for, checked rather than trusted: `read`, `send`, or left out.
 *
 * Here, in the operations, so the command and the tool refuse the same word the same way — with `USAGE` and these
 * words. A tool's schema listing the two was the only check it had, and a word outside them came back as the SDK's
 * "Input validation error", with no code for a caller to act on. The CLI's `--mode` has choices too; they refuse first
 * there, and this is the check every caller reaches.
 */
export function modeWanted(value: unknown): InstallMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (INSTALL_MODES as readonly string[]).includes(value)) return value as InstallMode;
  throw new CommsError('USAGE', `"${String(value)}" is not a mode`, { hint: `One of: ${INSTALL_MODES.join(', ')}.` });
}

/** How many ports the system is asked for before giving up: each offer is a fresh one, so a few are plenty. */
const PORT_TRIES = 20;

/** A loopback port nothing holds now, from the system: bind 127.0.0.1 on port 0, read the port, and let it go. */
async function askTheSystem(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    return (server.address() as AddressInfo).port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * Every loopback port this configuration already gives a Slack app's redirect: each workspace's recorded one, and each
 * organisation profile's. Any account's, whatever its platform, since only a Slack account keeps one.
 */
function portsRecorded(config: Config): Set<number> {
  const ports = new Set<number>();
  for (const account of Object.values(config.accounts ?? {})) {
    if (typeof account.redirectPort === 'number') ports.add(account.redirectPort);
  }
  for (const record of Object.values(organisationsOf(config))) {
    if (typeof record.slack?.redirectPort === 'number') ports.add(record.slack.redirectPort);
  }
  return ports;
}

/**
 * A new app's port, chosen rather than asked for: one the system says is free, and never one another workspace here
 * already redirects to — two apps on one port would each find the other's listener when both sign in at once.
 */
async function chooseLoopbackPort(taken: ReadonlySet<number>, probe: () => Promise<number>): Promise<number> {
  const hint = 'Choose one with `--port` (`port` from a chat): it goes in the manifest, and the app keeps it.';
  for (let tries = 0; tries < PORT_TRIES; tries++) {
    let port: number;
    try {
      port = await probe();
    } catch (error) {
      throw new CommsError('UNEXPECTED', `no free loopback port could be found: ${(error as Error).message}`, {
        hint,
        cause: error,
      });
    }
    if (!taken.has(port)) return port;
  }
  throw new CommsError('TRANSIENT', `no free loopback port could be found in ${PORT_TRIES} tries`, { hint });
}

export async function manifestFor(
  context: SlackContext,
  options: {
    mode?: unknown;
    port?: unknown;
    workspace?: string | undefined;
    /**
     * `false` for the manifest of a new app that signs in with its client secret at a person's terminal, rather than
     * PKCE (design 2026-10-15 S1, revised). Left out, PKCE is on, as for every app this package has made.
     */
    pkce?: unknown;
    /**
     * How a free port is asked of the system, for a new app given none: bind 127.0.0.1 on port 0, read it, close.
     * A test hands in its own, to offer ports already taken; the command and the tool never pass it.
     */
    probePort?: (() => Promise<number>) | undefined;
  },
): Promise<ManifestResult> {
  const mode = modeWanted(options.mode) ?? 'read';
  if (options.pkce !== undefined && typeof options.pkce !== 'boolean') {
    throw new CommsError('USAGE', '`pkce` is true or false', {
      hint: 'Pass false for the manifest of a new app that signs in with its client secret.',
    });
  }
  const config = await context.config();
  const found =
    options.workspace === undefined ? undefined : requireWorkspace(config, options.workspace, context.handoffs);
  /*
   * The port is decided here, before any sign-in exists.
   *
   * Slack stores redirect URLs on the app and matches them exactly, so it cannot be whichever port the OS hands out at
   * sign-in time — which is what the Gmail side does, and why the two differ. A port given wins. For a workspace
   * already connected the one it signed in with is the one its app names, and one that never recorded it is refused:
   * its app already names a port, and a new one would be a redirect Slack does not know. For a new app it is chosen
   * now, once — a free one, nobody else's here — and from then on it is that app's: the manifest carries it, the
   * command printed with it carries it, and the sign-in records it, so `workspace add --port` is the same number by
   * construction rather than by luck, and nobody has to pick one.
   */
  const given = options.port !== undefined && options.port !== null;
  const portFrom: ManifestResult['portFrom'] = given ? 'given' : found ? 'recorded' : 'chosen';
  const port =
    portFrom === 'chosen'
      ? await chooseLoopbackPort(portsRecorded(config), options.probePort ?? askTheSystem)
      : checkedPort(options.port, found?.account.redirectPort);
  const redirectUrl = `http://localhost:${port}/slack/callback`;
  // Never guessed: without the recorded id there is no telling which of the person's apps this workspace uses.
  const appId = found?.account.appId ?? null;
  const manifestUrl = appId === null ? null : appManifestUrl(appId);
  const pkce = options.pkce !== false;
  const workspace = found?.alias ?? null;
  return {
    mode,
    port,
    redirectUrl,
    manifest: buildManifest(mode, redirectUrl, { pkce }),
    workspace,
    appId,
    manifestUrl,
    portFrom,
    steps:
      workspace === null ? newAppSteps(mode, port, pkce, context.handoffs) : existingAppSteps(workspace, manifestUrl),
    notes: [
      ...(pkce
        ? []
        : workspace === null
          ? [
              'It has to be a new app: this manifest has PKCE off, and that cannot be undone on an existing app — once an app has turned PKCE on, Slack never turns it off.',
            ]
          : [
              'This manifest has PKCE off: it fits only an app that never turned PKCE on, since Slack never turns it off once it is on.',
            ]),
      ...(portFrom === 'chosen' ? [chosenPortSentence(port)] : []),
    ],
  };
}

/**
 * A new app's steps: create it from the manifest, take what the sign-in needs from its page, connect it.
 *
 * Two apps, two procedures. The PKCE app's sign-in needs only the Client ID, which is not a secret, so it connects from
 * a terminal or a chat alike. The client-secret app's needs its Client Secret too, typed once at a hidden prompt — so
 * its connect command carries `--with-client-secret`, and runs at the person's own terminal: no tool takes a secret,
 * because a chat's transcript keeps whatever is pasted into it.
 */
function newAppSteps(mode: InstallMode, port: number, pkce: boolean, handoffs: CliHandoffs): string[] {
  const create =
    'open https://api.slack.com/apps, choose "Create New App" → "From a manifest", pick your workspace, paste it, and create the app';
  if (pkce) {
    return [
      `Create the app from this manifest: ${create}. (Changing the mode of a workspace already connected? Edit its existing app's "App Manifest" instead — the same app, not a new one.)`,
      'On "Basic Information", copy the Client ID. It is not a secret, and there is no client secret to copy: this signs in with PKCE, which replaces one.',
      handoffSentence(
        handoffs.own(['workspace', 'add', '<name>', '--client-id', '<the Client ID>', '--port', String(port)]),
        (command) => `Connect it: ${command}, or slack_workspace_add from a chat, with the Client ID and port ${port}.`,
        { instead: `Connect it with slack_workspace_add from a chat, with the Client ID and port ${port}.` },
      ),
    ];
  }
  return [
    `Create a new app from this manifest: ${create}.`,
    'On "Basic Information", copy the Client ID, and keep the Client Secret (under "App Credentials") to hand: it is typed once, at a hidden prompt, and never pasted into chat.',
    handoffSentence(
      handoffs.own([
        'workspace',
        'add',
        '<name>',
        ...(mode === 'send' ? ['--mode', 'send'] : []),
        '--client-id',
        '<the Client ID>',
        '--port',
        String(port),
        '--with-client-secret',
      ]),
      (command) =>
        `Connect it, in your own terminal: ${command}. It asks for the Client Secret there, without showing it; no tool takes it.`,
      {
        instead:
          'Connect it in your own terminal, with `workspace add` and `--with-client-secret`, which asks for the Client Secret without showing it; no tool takes it.',
      },
    ),
  ];
}

/** A connected workspace's: edit the app it signed in through — never a new one, which would change no installation. */
function existingAppSteps(workspace: string, manifestUrl: string | null): string[] {
  return [
    manifestUrl === null
      ? `Open https://api.slack.com/apps and the app "${workspace}" was connected through → "App Manifest". (It signed in before its app was recorded, so there is no direct link.)`
      : `Open ${manifestUrl} — the manifest of the app "${workspace}" was connected through.`,
    'Replace the manifest there with this one, and save — the same app, not a new one.',
  ];
}
