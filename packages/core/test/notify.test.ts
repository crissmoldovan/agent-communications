import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ackNotice, makeNotifier, type NoticeRunner, noticeCommand } from '../src/notify.ts';
import { truncateDisplay } from '../src/render.ts';
import type { Notice } from '../src/standing-use.ts';
import { notifierProgram } from '../src/system-programs.ts';

/*
 * The notification on the person's screen for each standing act (design 2026-10-19-standing-approvals, S10 and §8
 * item 6). Every test forces a platform and stands in for the runner and the lookup: nothing here starts a program, and
 * no notification is ever shown. The paths are fixed POSIX or Windows paths, never this machine's.
 */

const STANDING = 'ap_00000000000000000000000000';
const TITLE = 'agent-communications';
const BENIGN: Notice = { title: TITLE, body: `Your agent sent :eyes: in #general (standing approval ${STANDING})` };

/** The fixed AppleScript, line by line, each an `-e` of its own; the texts follow `--` as the run handler's argv. */
const DARWIN_SCRIPT = [
  '-e',
  'on run argv',
  '-e',
  'display notification (item 1 of argv) with title (item 2 of argv)',
  '-e',
  'end run',
  '--',
];

/** Text that would do something if it were ever read as AppleScript, a shell, cmd or PowerShell. */
const HOSTILE = [
  `"; rm -rf ~ ; '`,
  '"); do shell script "id" --',
  '" & (do shell script "id") & "',
  '$(whoami)',
  '`id`',
  '%COMSPEC% %PATH%',
  '$(Get-ChildItem env:)',
  '$env:USERPROFILE',
  '@(Start-Process calc)',
  "'; Start-Process calc; '",
  'line one\nline two\r\nend run',
];

/** A runner that records what it was asked to start, and starts nothing. */
function recorder() {
  const calls: { program: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: NoticeRunner = async (program, args, env) => {
    calls.push({ program, args: [...args], env: { ...env } });
  };
  return { calls, run };
}

/** A lookup that finds only `present`, and records every path it is asked about. */
function lookup(present: readonly string[]) {
  const asked: string[] = [];
  const exists = async (candidate: string) => {
    asked.push(candidate);
    return present.includes(candidate);
  };
  return { asked, exists };
}

test("each platform's program and arguments", async () => {
  // macOS: osascript by its full path, with a fixed script and the texts as its run handler's arguments.
  {
    const { calls, run } = recorder();
    const { asked, exists } = lookup([]);
    const env = { PATH: '/usr/local/bin:/usr/bin', LANG: 'en_GB.UTF-8' };
    const raised = await makeNotifier({ platform: 'darwin', env, run, exists })(BENIGN);
    assert.deepEqual(raised, { raised: true });
    assert.deepEqual(calls, [{ program: '/usr/bin/osascript', args: [...DARWIN_SCRIPT, BENIGN.body, TITLE], env }]);
    assert.deepEqual(asked, [], 'osascript is named, never looked up');
  }
  // Linux: the first notify-send in an absolute PATH entry; an empty or relative entry is never looked in.
  {
    const { calls, run } = recorder();
    const { asked, exists } = lookup(['relative/bin/notify-send', '/usr/bin/notify-send', '/bin/notify-send']);
    const env = { PATH: ':relative/bin:/opt/none:/usr/bin:/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus' };
    const raised = await makeNotifier({ platform: 'linux', env, run, exists })(BENIGN);
    assert.deepEqual(raised, { raised: true });
    assert.deepEqual(asked, ['/opt/none/notify-send', '/usr/bin/notify-send']);
    assert.deepEqual(calls, [{ program: '/usr/bin/notify-send', args: ['--', TITLE, BENIGN.body], env }]);
  }
  // Windows: PowerShell under the given SystemRoot, a fixed script, and the texts in two environment values.
  {
    const { calls, run } = recorder();
    const { asked, exists } = lookup([]);
    const env = { SystemRoot: 'D:\\Windows', Path: 'D:\\Windows\\System32' };
    const raised = await makeNotifier({ platform: 'win32', env, run, exists })(BENIGN);
    assert.deepEqual(raised, { raised: true });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call?.program, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.deepEqual(call?.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
    assert.equal(call?.args.length, 4, 'nothing follows the script: -Command would join it in');
    assert.deepEqual(call?.env, {
      SystemRoot: 'D:\\Windows',
      Path: 'D:\\Windows\\System32',
      NoDefaultCurrentDirectoryInExePath: '1',
      AGENTCOMMS_NOTICE_TITLE: TITLE,
      AGENTCOMMS_NOTICE_BODY: BENIGN.body,
    });
    assert.deepEqual(asked, [], 'PowerShell is named, never looked up');
    const script = String(call?.args[3]);
    assert.match(script, /\$env:AGENTCOMMS_NOTICE_TITLE/);
    assert.match(script, /\$env:AGENTCOMMS_NOTICE_BODY/);
    // The texts go in as text nodes, never parsed as XML; the script has no double quote and no line break, so the
    // command line Windows builds around it is a plain pair of quotes.
    assert.match(script, /CreateTextNode/);
    assert.doesNotMatch(script, /LoadXml|"|\n|\r/);
  }
  // With no SystemRoot, the Windows folder is the default one, never a name looked up.
  assert.equal(
    await notifierProgram('win32', {}, async () => false),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(await notifierProgram('darwin', {}, async () => false), '/usr/bin/osascript');
  // A system this names no notifier for gives none, and starts nothing.
  {
    const { calls, run } = recorder();
    const raised = await makeNotifier({ platform: 'aix', env: { PATH: '/usr/bin' }, run, exists: async () => true })(
      BENIGN,
    );
    assert.deepEqual(raised, { raised: false, reason: 'no notifier on aix' });
    assert.deepEqual(calls, []);
  }
});

test('the text is an argument on darwin and linux, and an environment value on win32, never in the script', async () => {
  const hostile: Notice = { title: `-e ${HOSTILE[1]}`, body: `-e ${HOSTILE.join(' ')}` };
  for (const fragment of HOSTILE) assert.ok(hostile.body.includes(fragment));

  // macOS: the script is the same fixed lines whatever the text; the texts follow `--`, so even one starting with
  // `-e` is an argument and never another line of script (osascript reads options until `--`).
  const darwin = noticeCommand(hostile, 'darwin', { LANG: 'C' }, '/usr/bin/osascript');
  assert.deepEqual(darwin.args, [...DARWIN_SCRIPT, hostile.body, hostile.title]);
  assert.deepEqual(
    noticeCommand(BENIGN, 'darwin', { LANG: 'C' }, '/usr/bin/osascript').args.slice(0, 7),
    DARWIN_SCRIPT,
  );
  const script = darwin.args.slice(0, darwin.args.indexOf('--'));
  for (const fragment of [...HOSTILE, hostile.body, hostile.title]) {
    assert.ok(
      !script.some((line) => line.includes(fragment)),
      `the AppleScript never holds ${JSON.stringify(fragment)}`,
    );
  }
  assert.deepEqual(darwin.env, { LANG: 'C' });

  // Linux: there is no script; the texts are notify-send's arguments, after `--`, verbatim.
  const linux = noticeCommand(hostile, 'linux', { PATH: '/usr/bin' }, '/usr/bin/notify-send');
  assert.deepEqual(linux, {
    program: '/usr/bin/notify-send',
    args: ['--', hostile.title, hostile.body],
    env: { PATH: '/usr/bin' },
  });

  // Windows: the command line is the same, byte for byte, whatever the text; the texts are only environment values.
  // A value already set under another case is replaced, never left beside it for Windows to choose between.
  const env = { SystemRoot: 'C:\\Windows', agentcomms_notice_body: 'stale', Agentcomms_Notice_Title: 'stale' };
  const program = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const win32 = noticeCommand(hostile, 'win32', env, program);
  assert.equal(win32.program, program);
  assert.deepEqual(win32.args, noticeCommand(BENIGN, 'win32', {}, program).args);
  for (const fragment of [...HOSTILE, hostile.body, hostile.title]) {
    assert.ok(
      !win32.args.some((arg) => arg.includes(fragment)),
      `the command line never holds ${JSON.stringify(fragment)}`,
    );
  }
  assert.deepEqual(win32.env, {
    SystemRoot: 'C:\\Windows',
    NoDefaultCurrentDirectoryInExePath: '1',
    AGENTCOMMS_NOTICE_TITLE: hostile.title,
    AGENTCOMMS_NOTICE_BODY: hostile.body,
  });
  // The caller's environment is never changed.
  assert.deepEqual(env, {
    SystemRoot: 'C:\\Windows',
    agentcomms_notice_body: 'stale',
    Agentcomms_Notice_Title: 'stale',
  });

  // Through the notifier, the runner is handed exactly these.
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const { calls, run } = recorder();
    const given = { PATH: '/usr/bin', SystemRoot: 'C:\\Windows' };
    const exists = async (candidate: string) => candidate === '/usr/bin/notify-send';
    assert.deepEqual(await makeNotifier({ platform, env: given, run, exists })(hostile), { raised: true });
    const expected = noticeCommand(hostile, platform, given, calls[0]?.program ?? '');
    assert.deepEqual(calls, [{ program: expected.program, args: expected.args, env: expected.env }]);
  }
});

test('no notify-send gives raised false', async () => {
  for (const env of [{ PATH: '/usr/local/bin:/usr/bin:/bin' }, { PATH: '' }, {}]) {
    const { calls, run } = recorder();
    const raised = await makeNotifier({ platform: 'linux', env, run, exists: async () => false })(BENIGN);
    assert.deepEqual(raised, { raised: false, reason: 'no notify-send on PATH' });
    assert.deepEqual(calls, []);
  }
  // Only relative entries: none is looked in, so none is found.
  {
    const { calls, run } = recorder();
    const { asked, exists } = lookup(['bin/notify-send', './notify-send']);
    const raised = await makeNotifier({ platform: 'linux', env: { PATH: 'bin:.:' }, run, exists })(BENIGN);
    assert.deepEqual(raised, { raised: false, reason: 'no notify-send on PATH' });
    assert.deepEqual(asked, []);
    assert.deepEqual(calls, []);
  }
  // A lookup that fails is a place it is not found, never a throw.
  {
    const { calls, run } = recorder();
    const exists = async (candidate: string) => {
      if (candidate.startsWith('/opt/')) throw new Error('EACCES');
      return candidate === '/usr/bin/notify-send';
    };
    const raised = await makeNotifier({ platform: 'linux', env: { PATH: '/opt/locked:/usr/bin' }, run, exists })(
      BENIGN,
    );
    assert.deepEqual(raised, { raised: true });
    assert.equal(calls[0]?.program, '/usr/bin/notify-send');
  }
});

test('a runner that throws gives raised false', async () => {
  const exists = async (candidate: string) => candidate === '/usr/bin/notify-send';
  const env = { PATH: '/usr/bin', SystemRoot: 'C:\\Windows' };
  /** What a failed `execFile` hands back: its message holds the whole command line, the notice's text with it. */
  const failure = (fields: Record<string, unknown>) =>
    Object.assign(new Error(`Command failed: osascript ${BENIGN.body}`), fields);
  const cases: { thrown: () => unknown; reason: (name: string) => string }[] = [
    { thrown: () => failure({ code: 1 }), reason: (name) => `${name} ended with status 1` },
    { thrown: () => failure({ code: 'ENOENT' }), reason: (name) => `${name} failed (ENOENT)` },
    {
      thrown: () => failure({ code: null, killed: true, signal: 'SIGKILL' }),
      reason: (name) => `${name} took longer than 5 seconds and was stopped`,
    },
    { thrown: () => failure({ code: null, signal: 'SIGTERM' }), reason: (name) => `${name} was stopped (SIGTERM)` },
    // A code or signal that is not one is never repeated: it could be anything.
    { thrown: () => failure({ code: `x ${BENIGN.body}`, signal: BENIGN.body }), reason: (name) => `${name} failed` },
    { thrown: () => BENIGN.body, reason: (name) => `${name} failed` },
  ];
  const names = { darwin: 'osascript', linux: 'notify-send', win32: 'PowerShell' } as const;
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    for (const { thrown, reason } of cases) {
      // Rejected, and thrown before any promise: both are the same failure, and neither escapes.
      const rejects: NoticeRunner = async () => {
        throw thrown();
      };
      const throws: NoticeRunner = () => {
        throw thrown();
      };
      for (const run of [rejects, throws]) {
        const raised = await makeNotifier({ platform, env, run, exists })(BENIGN);
        assert.deepEqual(raised, { raised: false, reason: reason(names[platform]) });
        assert.doesNotMatch(raised.raised ? '' : raised.reason, /Your agent|general|ap_/);
      }
    }
  }
  // A lookup, a platform or an environment that throws is said too, never thrown.
  const exploding = new Proxy(
    {},
    {
      get() {
        throw new Error(BENIGN.body);
      },
      ownKeys() {
        throw new Error(BENIGN.body);
      },
    },
  ) as NodeJS.ProcessEnv;
  const { calls, run } = recorder();
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    const raised = await makeNotifier({ platform, env: exploding, run, exists })(BENIGN);
    assert.equal(raised.raised, false);
    assert.doesNotMatch(raised.raised ? '' : raised.reason, /Your agent/);
  }
  assert.deepEqual(calls, []);
});

test('the body names what, where and which standing approval', () => {
  assert.deepEqual(ackNotice({ act: 'reaction', text: 'eyes', place: '#general', standingId: STANDING }), {
    title: 'agent-communications',
    body: `Your agent sent :eyes: in #general (standing approval ${STANDING})`,
  });
  assert.deepEqual(ackNotice({ act: 'reply', text: 'Got it, looking now', place: '#ops', standingId: STANDING }), {
    title: 'agent-communications',
    body: `Your agent sent "Got it, looking now" in #ops (standing approval ${STANDING})`,
  });
  // The place is flattened to one line, its invisible and control characters made visible, and cut to 80 characters.
  const place = `#ops\nroom\u202e\u0007${'z'.repeat(100)}`;
  const shown = truncateDisplay(place, 80);
  assert.equal([...shown].length, 80);
  assert.ok(shown.startsWith('#ops room<U+202E><U+0007>zz'));
  assert.ok(shown.endsWith('z…'));
  assert.equal(
    ackNotice({ act: 'reaction', text: '+1', place, standingId: STANDING }).body,
    `Your agent sent :+1: in ${shown} (standing approval ${STANDING})`,
  );
  // A text is shown the same way, though a standing text can never hold a line break or a control character.
  assert.equal(
    ackNotice({ act: 'reply', text: 'On it\n\u001b[2Jnow', place: '#ops', standingId: STANDING }).body,
    `Your agent sent "On it <U+001B>[2Jnow" in #ops (standing approval ${STANDING})`,
  );
});
