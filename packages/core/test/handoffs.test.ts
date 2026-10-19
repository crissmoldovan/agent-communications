import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sendApprovesHint } from '../src/approvals.ts';
import { beginChangeApproval, claimChange } from '../src/changes.ts';
import type { NodeRuntime } from '../src/cli-command.ts';
import { commandText, inlineCommand, lineWithWordsToFill } from '../src/cli-runtime.ts';
import { externalCommand } from '../src/command-brands.ts';
import { quoteCommand } from '../src/command-line.ts';
import { parseConfig, secretsStoreFor } from '../src/config.ts';
import { openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import {
  type CliHandoffs,
  CORE_CALLER,
  cliHandoffs,
  type Handoff,
  handoffChoices,
  handoffSentence,
  handoffSentenceToFill,
  handoffText,
  handoffTextToFill,
  isCommand,
  remedy,
  requireHandoffs,
} from '../src/handoffs.ts';
import { checkAttachable } from '../src/jail.ts';
import { knownClientConfigs } from '../src/mcp-clients.ts';
import { profileSourcePath, resolveProfileSlackTarget } from '../src/organisations.ts';
import type { ResolvedPaths } from '../src/paths.ts';
import { FileSecretStore, KeychainSecretStore, type KeyringModule } from '../src/secrets.ts';
import { VERSION as CORE_VERSION } from '../src/version.ts';
import {
  moduleUrl,
  realTemp,
  registration,
  writeCheckout,
  writeGlobal,
  writeManaged,
} from './fixtures/cli-command/trees.ts';
import { assertNoBareCommand, coreHandoffs, coreInline } from './helpers/handoffs.ts';

/*
 * The API a package tells a person what to run with (CONTRIBUTING.md, "Telling a person what to run"): made once from
 * the package's caller, its folders and its shell; `own`, `core` and `of` for the CLI words; and the renderers that put
 * a command — or why there is none — in a line, a field or a sentence.
 */

const PATHS: ResolvedPaths = {
  configDir: resolve('/pins/config'),
  stateDir: resolve('/pins/state'),
  dataDir: resolve('/pins/data'),
  secretsDir: resolve('/pins/secrets'),
  downloadsDir: resolve('/pins/downloads'),
};
const FOUR = [
  '--config-dir',
  PATHS.configDir,
  '--state-dir',
  PATHS.stateDir,
  '--data-dir',
  PATHS.dataDir,
  '--secrets-dir',
  PATHS.secretsDir,
];
const NODE: NodeRuntime = { version: 'v22.18.0', execArgv: [] };
/** Core's own CLI here: its source, since the tests run core from source. */
const CORE_CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** A checkout with Gmail built, and Gmail's handoffs as its built CLI makes them. */
function gmailHandoffs(
  options: { registrations?: Parameters<typeof cliHandoffs>[0]['registrations']; env?: NodeJS.ProcessEnv } = {},
) {
  const checkout = writeCheckout(join(realTemp(), 'checkout'), ['gmail']);
  const gmail = checkout.packages.gmail as string;
  const handoffs = cliHandoffs({
    caller: { url: moduleUrl(gmail, 'dist', 'cli.mjs'), packageName: '@agentcomms/gmail' },
    paths: PATHS,
    platform: 'linux',
    runtime: NODE,
    ...options,
  });
  return { checkout, gmail, handoffs };
}

function words(handoff: Handoff): readonly string[] {
  assert.ok(isCommand(handoff), 'message' in handoff ? handoff.message : '');
  return handoff.words;
}

test("a package's handoffs: its own CLI, core's, and another product's from its registrations", () => {
  const { checkout, gmail, handoffs } = gmailHandoffs();
  assert.deepEqual(words(handoffs.own(['approve', 'ap_1'])), [
    process.execPath,
    join(gmail, 'dist', 'cli.mjs'),
    ...FOUR,
    'approve',
    'ap_1',
  ]);
  // Core, as Gmail's installed dependency finds it: a built caller runs core's manifest bin.
  assert.deepEqual(words(handoffs.core(['doctor'])), [
    process.execPath,
    join(checkout.core, 'dist', 'cli.mjs'),
    ...FOUR,
    'doctor',
  ]);
  assert.deepEqual(handoffs.of('gmail', ['doctor']), handoffs.own(['doctor']));
  // Another product, with nothing registered given: no command, and it says so.
  const slack = handoffs.of('slack', ['approve', 'ap_1']);
  assert.ok(!isCommand(slack) && slack.reason === 'no-registrations', JSON.stringify(slack));
  // With its registration: the managed runtime it names.
  const { entry } = writeManaged(join(realTemp(), 'data'), 'slack');
  const registered = gmailHandoffs({ registrations: [registration({ command: '/n', args: [entry, 'mcp'] })] });
  assert.deepEqual(words(registered.handoffs.of('slack', ['approve', 'ap_1'])), [
    process.execPath,
    entry,
    ...FOUR,
    'approve',
    'ap_1',
  ]);
  assert.throws(() => handoffs.of('telegram', ['x']), TypeError);
});

test('a command pins the four folders every command opens, the downloads folder only when asked, or what it names', () => {
  const { gmail, handoffs } = gmailHandoffs();
  const entry = join(gmail, 'dist', 'cli.mjs');
  assert.deepEqual(words(handoffs.own(['x'], { downloads: true })), [
    process.execPath,
    entry,
    ...FOUR,
    '--downloads-dir',
    PATHS.downloadsDir,
    'x',
  ]);
  assert.deepEqual(words(handoffs.own(['--help'], { uses: [] })), [process.execPath, entry, '--help']);
  assert.deepEqual(words(handoffs.own(['x'], { uses: ['secretsDir'] })), [
    process.execPath,
    entry,
    '--secrets-dir',
    PATHS.secretsDir,
    'x',
  ]);
  // Quoted for another shell: the same words, another line.
  const windows = handoffs.on('win32').own(['inbox', 'remove', 'old mail']);
  assert.ok(isCommand(windows));
  assert.equal(windows.platform, 'win32');
  assert.equal(windows.line, quoteCommand(windows.words, 'win32').line);
  assert.equal(handoffs.on('linux'), handoffs, 'the same shell is the same handoffs');
});

test("registered() reads this machine's registrations from the environment the handoffs were made with", async () => {
  const home = realTemp('home-');
  const env = { HOME: home, USERPROFILE: home, PATH: '' };
  const { entry } = writeManaged(join(home, 'data'), 'slack');
  const claude = knownClientConfigs(env, 'linux').find((file) => file.client === 'claude-code')?.path as string;
  writeFileSync(claude, JSON.stringify({ mcpServers: { slack: { command: '/n', args: [entry, 'mcp'] } } }));
  const { handoffs } = gmailHandoffs({ env });
  assert.ok(!isCommand(handoffs.of('slack', ['doctor'])), 'nothing read yet');
  const registered = await handoffs.registered();
  assert.deepEqual(words(registered.of('slack', ['doctor'])), [process.execPath, entry, ...FOUR, 'doctor']);
});

test('a command renders as a line, as words to type, or — with none — as the sentence saying why', () => {
  const { handoffs } = gmailHandoffs();
  const printed = handoffs.own(['approve', 'ap_1']);
  assert.ok(isCommand(printed));
  assert.equal(handoffText(printed), printed.line);
  assert.equal(
    handoffSentence(printed, (command) => `Run ${command}.`),
    `Run \`${printed.line}\`.`,
  );
  // On Windows, a word no line carries safely: its words as JSON, saying it has to be typed.
  const unprintable = handoffs.on('win32').own(['inbox', 'remove', '$x&whoami&']);
  assert.ok(isCommand(unprintable) && unprintable.line === null);
  assert.equal(handoffText(unprintable), commandText(unprintable));
  assert.equal(
    handoffSentence(unprintable, (command) => `Run ${command}.`),
    `Run ${inlineCommand(unprintable)}.`,
  );
  // No command: the sentence saying why, and nothing in the command's place.
  const missing = handoffs.of('slack', ['approve', 'ap_1']);
  assert.ok(!isCommand(missing));
  assert.equal(handoffText(missing), missing.message);
  assert.equal(
    handoffSentence(missing, (command) => `Run ${command}.`),
    missing.message,
  );
  // Words for the agent to fill in go before `--`, as written.
  const download = handoffs.own(['attachments', 'download', '--', '--odd']);
  assert.ok(isCommand(download));
  const filled = handoffSentenceToFill(download, ['--to', '<folder>'], (command) => `Run ${command}.`);
  assert.ok(filled.endsWith(` attachments download --to <folder> -- --odd\`.`), filled);
  assert.equal(
    handoffSentenceToFill(missing, ['<folder>'], (command) => command),
    missing.message,
  );
  // As a value of its own, with words to fill: as written before `--`, or among the words as JSON when there is no
  // line; with no command, why.
  assert.ok(handoffTextToFill(download, ['--to', '<folder>']).endsWith(' attachments download --to <folder> -- --odd'));
  const lineless = handoffs.on('win32').own(['attachments', 'download', '$x&whoami&', '--', '--odd']);
  assert.ok(isCommand(lineless) && lineless.line === null);
  const json = handoffTextToFill(lineless, ['--to', '<folder>']);
  assert.ok(json.startsWith('['), json);
  assert.ok(json.includes('"\\u0024x&whoami&"'), json);
  assert.ok(json.includes('"--to","<folder>","--","--odd"]'), json);
  assert.equal(handoffTextToFill(missing, ['<folder>']), missing.message);
  // Choices: the commands, then why the others have none.
  assert.equal(handoffChoices([printed], 'none:'), inlineCommand(printed));
  assert.equal(handoffChoices([printed, printed], 'none:'), `${inlineCommand(printed)} or ${inlineCommand(printed)}`);
  assert.equal(
    handoffChoices([missing], 'And none is locatable here:'),
    `And none is locatable here: ${missing.message}`,
  );
  assert.equal(
    handoffChoices([printed, missing], 'none:'),
    `${inlineCommand(printed)} (${missing.message.replace(/\.$/, '')})`,
  );
});

test('a command a result holds is written out as its text where it leaves, and is never interpolated', () => {
  const { handoffs } = gmailHandoffs();
  const located = handoffs.own(['approve', 'ap_1']);
  const lineless = handoffs.on('win32').own(['inbox', 'remove', '$x&whoami&']);
  const missing = handoffs.of('slack', ['approve', 'ap_1']);
  const external = externalCommand(['chmod', '700', '/tmp/x'], 'the system command that sets permissions', 'linux');
  assert.ok(isCommand(located) && isCommand(lineless) && !isCommand(missing));
  // As JSON — `--json`, or an MCP result — the text the field always carried: the line, the words to type, or why.
  const written = JSON.parse(JSON.stringify({ located, lineless, missing, external }));
  assert.deepEqual(written, {
    located: handoffText(located),
    lineless: handoffText(lineless),
    missing: missing.message,
    external: commandText(external),
  });
  // Its own fields are still all there is to compare: the rendering is not one of them.
  assert.deepEqual(Object.keys(missing).sort(), ['detail', 'message', 'ok', 'package', 'product', 'reason', 'version']);
  // Interpolated, each throws: a sentence gives a command through `handoffSentence`, a value through `handoffText`.
  for (const value of [located, missing, external]) {
    assert.throws(() => `Run ${value as unknown as string}.`, /never interpolated/);
    assert.throws(() => String(value), /never interpolated/);
  }
  // A remedy: the commands rendered as values of their own, a line per argument, words around them as written.
  assert.equal(
    remedy(located, [external, ' (then restart the client)'], 'by hand otherwise'),
    `${handoffText(located)}\n${commandText(external)} (then restart the client)\nby hand otherwise`,
  );
  assert.equal(remedy([missing, '.']), `${missing.message}.`);
});

test('without its caller there is no command at all: asking for one is a programming error, never a bare name', async () => {
  // Nothing in core prints a suite command by its bare name any more (CUE-403 task 15): the bridge that did, for a
  // package that had not given core its caller, is gone, and so is every input it served.
  assert.throws(
    () => requireHandoffs({}),
    (error: unknown) => {
      assert.ok(error instanceof TypeError && /opened without its caller/.test(error.message), String(error));
      return true;
    },
  );
  const home = realTemp('home-');
  const env = { HOME: home, USERPROFILE: home, AGENT_COMMS_CONFIG_DIR: join(home, 'config') };
  const bare = openCore({ env });
  // A store core made without a caller, asked for a refusal that names a command: the same programming error.
  mkdirSync(join(bare.paths.secretsDir, `${createHash('sha256').update('ref').digest('hex').slice(0, 32)}.json`), {
    recursive: true,
  });
  await assert.rejects((await bare.secrets('file')).get('ref'), /opened without its caller/);
  // And the public entry no longer has the bridge's pieces.
  const entry = await import('../src/index.ts');
  for (const gone of [
    'handoffsFor',
    'bareHandoffs',
    'asHandoffMaker',
    'platformOf',
    'registeredFor',
    'withRegistrationsFor',
    'channelApproveCommands',
    'shellCommand',
    'withWords',
    'UPDATE_WAYS',
  ]) {
    assert.equal(gone in entry, false, `${gone} is not exported`);
  }
  // With its caller, a package's own: located.
  const { handoffs } = gmailHandoffs();
  assert.equal(requireHandoffs({ handoffs }), handoffs);
  assert.deepEqual(requireHandoffs({ handoffs }, 'win32').own(['x']), handoffs.on('win32').own(['x']));
});

test('openCore gives core its handoffs from a caller, and core’s own CLI and server always give one', () => {
  const home = realTemp('home-');
  const env = { HOME: home, USERPROFILE: home, AGENT_COMMS_CONFIG_DIR: join(home, 'config') };
  const bare = openCore({ env });
  assert.equal(bare.handoffs, undefined);
  assert.throws(() => requireHandoffs(bare), /opened without its caller/);
  const own = openCore({ env, caller: CORE_CALLER });
  assert.equal(requireHandoffs(own), own.handoffs);
  const help = own.handoffs?.own(['--help'], { uses: [] });
  assert.ok(help !== undefined && isCommand(help));
  assert.equal(help.words.at(-2), fileURLToPath(new URL('../src/cli.ts', import.meta.url)));
  // The two places core opens itself, read from their source: neither may leave the caller out.
  const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  assert.match(source('../src/cli.ts'), /openCore\(\{ env, platform, pathOverrides, caller: CORE_CALLER \}\)/);
  assert.match(source('../src/mcp/server.ts'), /openCore\(\{ env, caller: CORE_CALLER \}\)/);
  assert.throws(
    () => cliHandoffs({ caller: { url: CORE_CALLER.url, packageName: '@someone/else' }, paths: PATHS }),
    TypeError,
  );
});

test('openCore hands its handoffs to the stores it makes: their refusals name core’s command, located', async () => {
  const home = realTemp('home-');
  const env = { HOME: home, USERPROFILE: home, AGENT_COMMS_CONFIG_DIR: join(home, 'config') };
  const core = openCore({ env, caller: CORE_CALLER });
  // A secret's file that cannot be read, in the store core opens.
  mkdirSync(join(core.paths.secretsDir, `${createHash('sha256').update('ref').digest('hex').slice(0, 32)}.json`), {
    recursive: true,
  });
  await assert.rejects((await core.secrets('file')).get('ref'), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(
      error.hint,
      `Run ${coreInline(core.paths, ['doctor'])}. Re-authorise the inbox if the file is damaged.`,
    );
    return true;
  });
  // The configuration store: its refusals are made where no `core` is in reach, so it is given the handoffs.
  const source = readFileSync(fileURLToPath(new URL('../src/core.ts', import.meta.url)), 'utf8');
  assert.match(source, /new ConfigStore\(paths\.configDir, \{ handoffs \}\)/);
});

// ── 7d (core): a misdirected approval is corrected with commands that run, or with why there is none ────────────────

/** A machine whose Claude Code has a managed Gmail of this release registered, and core opened as core. */
function machineWithGmail() {
  const home = realTemp('home-');
  const env = { HOME: home, USERPROFILE: home, AGENT_COMMS_CONFIG_DIR: join(home, 'config'), PATH: '' };
  const { entry } = writeManaged(join(home, 'data'), 'gmail', { version: CORE_VERSION });
  const claude = knownClientConfigs(env, process.platform).find((file) => file.client === 'claude-code')
    ?.path as string;
  writeFileSync(claude, JSON.stringify({ mcpServers: { gmail: { command: '/n', args: [entry, 'mcp'] } } }));
  return { env, entry, core: openCore({ env, caller: CORE_CALLER }) };
}

async function sendRecord(core: ReturnType<typeof openCore>) {
  return core.approvals.create({
    channel: 'gmail',
    inboxId: 'ibx_AAAAAAAAAAAAAAAA',
    draftId: 'r-1',
    draftMessageId: 'm-1',
    contentDigest: 'd'.repeat(64),
    sendEpoch: 0,
    policy: 'confirm',
    requiredPolicy: 'confirm',
    riskFlags: [],
    expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'hi' },
  });
}

test("a send's approval offered as a change is the one NOT_FOUND, at the terminal too, naming no command (7d-core)", async () => {
  // It named every sending channel's approve; another kind's id is now the one NOT_FOUND wherever it is offered
  // (design 2026-10-05 §D2) — the claim's store and the terminal's look alike — as an id that names nothing is, so it
  // says nothing of the record, not even the command that would approve it.
  const { core } = machineWithGmail();
  const send = await sendRecord(core);
  const config = await core.config.load();
  const unknown = `ap_${'7'.repeat(26)}`;
  const envelope = async (attempt: (id: string) => Promise<unknown>, id: string) => {
    const error = await attempt(id).then(
      () => assert.fail('refused'),
      (refused: unknown) => refused as CommsError,
    );
    assert.ok(error instanceof CommsError && error.code === 'NOT_FOUND', String(error));
    assert.doesNotMatch(`${error.message} ${error.hint}`, /approve/);
    return JSON.stringify({ message: error.message, hint: error.hint, details: error.details }).replaceAll(id, 'ID');
  };
  for (const attempt of [
    (id: string) => claimChange(core, id, { before: config, after: config, effects: ['x'] }, { surface: 'mcp' }),
    (id: string) => beginChangeApproval(core, id, { surface: 'cli' }),
  ]) {
    assert.equal(await envelope(attempt, send.approvalId), await envelope(attempt, unknown));
  }
});

test("a change's approval offered as a send is the one NOT_FOUND, naming no command (7d-core)", async () => {
  // It named this installation's own approve; another kind's id is now the one NOT_FOUND (design 2026-10-05 §D2), as
  // an id that names nothing is, so it says nothing of the record — not even the command that would approve it.
  const { core } = machineWithGmail();
  const change = await core.approvals.createChange({
    channel: 'core',
    change: { summary: 'x', target: { kind: 'account', name: 'acme/slack' }, loosened: [], effects: ['x'] },
    policy: 'chat',
  });
  await assert.rejects(core.approvals.issueChallenge(change.approvalId), (error: unknown) => {
    assert.ok(error instanceof CommsError && error.code === 'NOT_FOUND', String(error));
    assert.doesNotMatch(`${error.message} ${error.hint}`, / approve /);
    assert.deepEqual(error.details, { approval: null });
    return true;
  });
});

/*
 * The deep refusals — the attachment jail, the secret stores, the configuration's one store, a profile's guards — are
 * made where no `core` is in reach, so each is handed the printing package's handoffs (a parameter, or an option).
 * Given core's own, they name its command located; given handoffs with no command, the other way and why; given none,
 * where they are optional, it is the programming error `requiredHandoffs` throws — never a bare name.
 */
test("core's deep refusals name core's command from the handoffs they are given, or why there is none (7d-core)", async () => {
  const located = coreHandoffs(PATHS, 'linux');
  const { handoffs: gmail } = gmailHandoffs();
  const why = gmail.of('slack', ['doctor']);
  assert.ok(!isCommand(why));
  const nowhere: CliHandoffs = {
    caller: gmail.caller,
    platform: 'linux',
    own: () => why,
    core: () => why,
    of: () => why,
    on: () => nowhere,
    registered: async () => nowhere,
    withRegistrations: () => nowhere,
  };
  const unlocated = /opened without its caller/;
  const command = (words: readonly string[]) => coreInline(PATHS, words, 'linux');
  const hintOf = async (attempt: () => unknown): Promise<string> => {
    try {
      await attempt();
    } catch (error) {
      assert.ok(error instanceof CommsError, String(error));
      return error.hint ?? '';
    }
    assert.fail('it was not refused');
  };

  // The jail: a file from outside every allowed folder.
  const home = realTemp('jail-');
  const allowed = join(home, 'allowed');
  mkdirSync(allowed);
  const outside = join(home, 'outside.txt');
  writeFileSync(outside, 'x');
  const policy = { roots: [allowed], deny: [], home };
  const copy =
    'Copy the file under your home folder — not into one of its hidden folders — and name the copy instead, or';
  const attachRootsAdd = located.core(['attach', 'roots', 'add']);
  assert.ok(isCommand(attachRootsAdd));
  assert.equal(
    await hintOf(() => checkAttachable(outside, { ...policy, handoffs: located })),
    `${copy} allow its folder with \`${lineWithWordsToFill(attachRootsAdd, '<folder>')}\` (needs your approval).`,
  );
  assert.equal(
    await hintOf(() => checkAttachable(outside, { ...policy, handoffs: nowhere })),
    `${copy} allow its folder with comms_attach from a chat (needs your approval). ${why.message}`,
  );
  await assert.rejects(checkAttachable(outside, policy), unlocated);

  // The file store: a secret's file that cannot be read.
  const secrets = realTemp('secrets-');
  mkdirSync(join(secrets, `${createHash('sha256').update('ref').digest('hex').slice(0, 32)}.json`));
  assert.equal(
    await hintOf(() => new FileSecretStore(secrets, { handoffs: located }).get('ref')),
    `Run ${command(['doctor'])}. Re-authorise the inbox if the file is damaged.`,
  );
  assert.equal(
    await hintOf(() => new FileSecretStore(secrets, { handoffs: nowhere }).get('ref')),
    `Call comms_doctor from a chat. ${why.message} Re-authorise the inbox if the file is damaged.`,
  );
  await assert.rejects(new FileSecretStore(secrets).get('ref'), unlocated);

  // The keychain, refusing.
  const refusing: KeyringModule = {
    AsyncEntry: class {
      getPassword(): Promise<string | undefined> {
        return Promise.reject(new Error('locked'));
      }
      setPassword(): Promise<void> {
        return Promise.reject(new Error('locked'));
      }
      deletePassword(): Promise<boolean> {
        return Promise.reject(new Error('locked'));
      }
    },
  };
  assert.equal(
    await hintOf(() => new KeychainSecretStore(refusing, 'ns', 1000, { handoffs: located }).get('ref')),
    `Unlock the keychain and retry. Run ${command(['doctor'])} for details. On macOS a Node upgrade can require allowing access again.`,
  );

  // The one store the configuration keeps its secrets in, asked for another.
  const keychain = parseConfig(JSON.stringify({ version: 2, secrets: { store: 'keychain' } }), 'config.json');
  const oneStore = 'Everything here uses one store, and changing it moves what is already stored.';
  assert.equal(
    await hintOf(() => secretsStoreFor(keychain, 'file', located)),
    `${oneStore} To change it, run ${command(['secrets', 'migrate', '--to', 'file'])}, then run this again.`,
  );
  assert.equal(
    await hintOf(() => secretsStoreFor(keychain, 'file', nowhere)),
    `${oneStore} To change it, call comms_secrets_migrate from a chat, then run this again. ${why.message}`,
  );

  // A profile's guards: no file named, and a Slack sign-in for a profile that is not there.
  assert.equal(
    await hintOf(() => profileSourcePath('', {}, '/work', located)),
    `For example: ${command(['org', 'add', './rgc.agentcomms.json'])}.`,
  );
  assert.equal(
    await hintOf(() => resolveProfileSlackTarget(keychain, 'acme', 'read', located)),
    `Run ${command(['org', 'update', 'acme'])} to reconcile the profile, then start the sign-in again.`,
  );
  assert.equal(
    await hintOf(() => resolveProfileSlackTarget(keychain, 'acme', 'read', nowhere)),
    `Call comms_org_update from a chat to reconcile the profile, then start the sign-in again. ${why.message}`,
  );
});

test('a correction found from a Windows registration in another case names the located command, never that name (7d-core)', () => {
  const temp = realTemp();
  // Gmail installed globally on Windows, registered by its command as Windows wrote it: another case, `.CMD`.
  const mixed = writeGlobal(join(temp, 'prefix'), 'gmail', { windows: true, command: 'Agent-Gmail.CMD' });
  const handoffs = cliHandoffs({
    caller: CORE_CALLER,
    paths: PATHS,
    platform: 'win32',
    runtime: NODE,
  }).withRegistrations([registration({ command: mixed.command, args: ['mcp'] })]);
  const gmail = handoffs.of('gmail', ['approve', 'ap_1']);
  assert.ok(isCommand(gmail), 'message' in gmail ? gmail.message : '');
  assert.deepEqual(gmail.words.slice(2), [...FOUR, 'approve', 'ap_1']);
  assert.ok(gmail.words[1]?.endsWith(join('dist', 'cli.mjs')), gmail.words[1]);
  const hint = sendApprovesHint(handoffs, 'ap_1');
  assert.ok(hint.startsWith(`It is approved with the command that prepared it — ${inlineCommand(gmail)} (`), hint);
  assert.doesNotMatch(hint, /Agent-Gmail\.CMD/i);
  assertNoBareCommand(hint);
});

const POSIX_LINKED_NODE =
  process.platform === 'win32' ? { skip: 'WINDOWS_SKIP: a `node` on PATH that is a symlink is a POSIX layout' } : {};

test(
  'a printed command names this Node by the link PATH finds, never the file it resolves to (CUE-492)',
  POSIX_LINKED_NODE,
  () => {
    // `~/.local/bin/node` a symlink into another tool's own Node: the command a person reads names the link, as the
    // registration does, and never reads as though this suite depended on that tool.
    const home = realTemp('home-');
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const node = join(bin, 'node');
    symlinkSync(process.execPath, node);
    const real = realpathSync(process.execPath);
    const env = { HOME: home, PATH: bin, AGENT_COMMS_CONFIG_DIR: join(home, 'config') };

    // As core's server and CLI open core: from their environment.
    const handoff = requireHandoffs(openCore({ env, caller: CORE_CALLER, platform: 'linux' })).own(['approve', 'ab12']);
    assert.ok(isCommand(handoff), 'message' in handoff ? handoff.message : '');
    assert.equal(handoff.words[0], node, 'the program is the link, as PATH has it');
    const sentence = handoffSentence(handoff, (command) => `Run ${command} to approve it.`);
    assert.ok(sentence.includes(` ${node} `) || sentence.includes(`\`${node} `), sentence);
    assert.ok(!sentence.includes(real), `the sentence never names the file the link resolves to: ${sentence}`);

    // And from core's own CLI, started by this process's own path: its usage error's command is located the same way.
    const ran = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CORE_CLI, '--no-such-option'],
      { env: { ...env, NO_COLOR: '1', AGENT_COMMS_UPDATE_CHECK: 'off' }, encoding: 'utf8' },
    );
    assert.equal(ran.status, 64, ran.stderr);
    assert.ok(ran.stderr.includes(`\`${node} --experimental-strip-types ${CORE_CLI} --help\``), ran.stderr);
    assert.ok(!ran.stderr.includes(real), `the CLI never names the file the link resolves to: ${ran.stderr}`);
  },
);
