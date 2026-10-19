import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs, { access, readdir } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { run } from '../src/cli/program.ts';
import { slackOk, TEST_CLIENT_ID } from './support/harness.ts';
import { fetchListener } from './support/listener.ts';
import { newOrganisationHarness } from './support/organisation.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let nextManifestPort = 50_000;

for (const account of ['profile', 'own-app'] as const) {
  for (const boundary of [
    'before secret',
    'after secret',
    'after mutator',
    'after rename',
    'lock release',
    'lock release failure',
    'withdrawal failure',
  ] as const) {
    test(`foreground ${account} interruption ${boundary} settles the accepted callback before exit`, {
      timeout: 10000,
    }, async (t) => {
      const port = nextManifestPort++;
      const harness = await newOrganisationHarness({ port });
      const before = await harness.core.config.load();
      const secrets = await harness.core.secrets('file');
      const host = new EventEmitter();
      const ready = deferred<string>();
      const interrupted = deferred();
      const redelivered = deferred();
      const releaseWrite = deferred();
      const completion = deferred();
      const events: string[] = [];
      let exchanges = 0;
      let writes = 0;
      let configWrites = 0;
      let locked = false;
      let armed = false;
      let heldWrite = false;
      let earlyDiscard = false;
      let deletions = 0;
      let secretRef = '';
      let diagnostic = '';
      let diagnosticAtExit = '';
      let diagnosticBeforeInterrupt = '';
      let lockReleaseInterrupted = false;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let output = '';
      stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      stderr.on('data', (chunk) => {
        diagnostic += String(chunk);
      });
      const interrupt = () => {
        diagnosticBeforeInterrupt = diagnostic;
        events.push('interrupt');
        host.emit('SIGINT');
        interrupted.resolve();
      };
      const rm = fs.rm;
      t.mock.method(fs, 'rm', async (...args: Parameters<typeof rm>) => {
        if (
          heldWrite &&
          String(args[0]).startsWith(join(harness.core.paths.stateDir, 'slack', 'flows')) &&
          String(args[0]).endsWith('.json')
        ) {
          earlyDiscard = true;
        }
        await rm(...args);
        if (
          boundary === 'lock release' &&
          !lockReleaseInterrupted &&
          configWrites === 1 &&
          String(args[0]) === join(harness.configDir, '.config.lock')
        ) {
          lockReleaseInterrupted = true;
          interrupt();
        }
        if (
          boundary === 'lock release failure' &&
          !lockReleaseInterrupted &&
          configWrites === 1 &&
          String(args[0]) === join(harness.configDir, '.config.lock')
        ) {
          lockReleaseInterrupted = true;
          interrupt();
          const error = new Error('lock removal completed but its acknowledgement failed');
          Object.assign(error, { code: 'EPERM' });
          throw error;
        }
      });
      const update = harness.core.config.update.bind(harness.core.config);
      t.mock.method(harness.core.config, 'update', (...[mutator, options]: Parameters<typeof update>) =>
        update(async (current) => {
          const next = await mutator(current);
          if (boundary === 'after mutator') queueMicrotask(interrupt);
          return next;
        }, options),
      );
      const rename = fs.rename;
      t.mock.method(fs, 'rename', async (...args: Parameters<typeof rename>) => {
        await rename(...args);
        if (String(args[1]) === harness.core.config.path) {
          configWrites++;
          if (configWrites === 1 && boundary === 'after rename') interrupt();
        }
      });
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      });
      const wrapped: SecretStore = {
        ...secrets,
        get: (ref) => secrets.get(ref),
        invalidate: (ref) => secrets.invalidate(ref),
        async set(ref, value) {
          secretRef = ref;
          writes++;
          // Both app paths must stage while holding the machine-wide credentials lock.
          locked = await access(join(harness.configDir, '.credentials.lock')).then(
            () => true,
            () => false,
          );
          await secrets.set(ref, value);
          if (boundary === 'after secret' || boundary === 'withdrawal failure') {
            heldWrite = true;
            interrupt();
            await releaseWrite.promise;
            heldWrite = false;
          }
        },
        async delete(ref) {
          deletions++;
          if (boundary === 'withdrawal failure') {
            if (deletions === 2) completion.resolve();
            // The backend's private detail must not leak through either the human or JSON CLI surface.
            throw new Error('synthetic withdrawal failure: fake-user-token-1 fake-refresh-token-1');
          }
          const result = await secrets.delete(ref);
          events.push('withdrawn');
          completion.resolve();
          return result;
        },
      };
      t.mock.method(harness.core, 'secrets', async () => {
        if (armed && boundary === 'before secret') {
          armed = false;
          interrupt();
        }
        return wrapped;
      });
      const action = run(
        [
          ...(['withdrawal failure', 'lock release', 'lock release failure'].includes(boundary) ? ['--json'] : []),
          'workspace',
          'add',
          'rgc/slack',
          ...(account === 'own-app' ? ['--client-id', TEST_CLIENT_ID, '--port', String(port)] : []),
        ],
        {
          core: harness.core,
          env: harness.env,
          platform: 'darwin',
          streams: { stdout, stderr, stdin: new PassThrough() },
          openBrowser: (url) => ready.resolve(url),
          exchange: async () => {
            exchanges++;
            armed = true;
            return slackOk({ team: { id: 'TRGC0001', name: 'RGC' }, app_id: 'A0READ' });
          },
          signals: {
            host: Object.assign(host, {
              pid: process.pid,
              kill() {
                diagnosticAtExit = diagnostic;
                events.push('exit');
                redelivered.resolve();
              },
            }),
            exit: () => undefined,
          },
        },
      );
      // The injected signal host records redelivery without killing the test process. The interrupted CLI
      // deliberately stays pending until that signal would end it; only real operation state is asserted below.
      void action.catch((error) => ready.reject(error));
      void action.then(
        () => completion.resolve(),
        () => completion.resolve(),
      );
      t.after(() => releaseWrite.resolve());
      const auth = new URL(await ready.promise);
      const redirectUri = auth.searchParams.get('redirect_uri');
      assert.ok(redirectUri, 'the Slack request must name the bound foreground listener');
      const callback = new URL(redirectUri);
      callback.searchParams.set('state', auth.searchParams.get('state') ?? '');
      callback.searchParams.set('code', 'fake-code');
      await fetchListener(callback);
      await interrupted.promise;
      if (boundary === 'after secret' || boundary === 'withdrawal failure') {
        // The signal's beforeExit microtask precedes this continuation. Observe its first filesystem action,
        // not elapsed time: without the exit wait it discards the flow while the secret write is still held.
        assert.equal(earlyDiscard, false, 'exit discarded the flow before the held secret write settled');
        releaseWrite.resolve();
        await completion.promise;
      }
      await redelivered.promise;
      await completion.promise;
      assert.equal(exchanges, 1, 'the callback must already have reached the exchange');
      assert.equal(writes, boundary === 'before secret' ? 0 : 1, 'interruption allowed a new secret write');
      if (boundary === 'after secret') {
        assert.equal(locked, true, 'the secret was staged outside the credentials lock');
        assert.ok(events.indexOf('withdrawn') < events.indexOf('exit'), 'exit raced staged-secret withdrawal');
      }
      const committed = ['after rename', 'lock release', 'lock release failure'].includes(boundary);
      if (committed) {
        assert.notDeepEqual(await harness.core.config.load(), before);
        assert.equal(deletions, 0, 'a committed credential was withdrawn');
        assert.ok(await secrets.get(secretRef), 'the committed credential was not retained');
      } else {
        assert.deepEqual(await harness.core.config.load(), before, 'interruption wrote account or learned app id');
      }
      if (boundary === 'withdrawal failure') {
        assert.equal(deletions, 2);
        assert.ok(await secrets.get(secretRef), 'the injected failed withdrawal must leave a credential');
        assert.ok(diagnosticAtExit.includes(secretRef), 'stranded secret reference was not reported before exit');
        assert.match(diagnosticAtExit, /could not be removed/);
      } else if (!committed) {
        assert.deepEqual(await readdir(join(harness.configDir, 'secrets')).catch(() => []), []);
      }
      assert.doesNotMatch(diagnosticAtExit, /xox[bapr]-|fake-user-token-1|fake-refresh-token-1/);
      if (boundary !== 'withdrawal failure') {
        assert.equal(diagnosticAtExit, diagnosticBeforeInterrupt, 'ordinary cancellation should be silent');
      }
      assert.deepEqual(await readdir(join(harness.core.paths.stateDir, 'slack', 'flows')), []);
      if (boundary === 'after rename') {
        assert.match(output, /saved before the interrupt took effect/i);
      } else if (boundary === 'lock release' || boundary === 'lock release failure') {
        assert.equal(JSON.parse(output).data.committedBeforeAbort, true);
      } else {
        assert.equal(output, '', 'an uncommitted sign-in printed a successful result');
      }
      await assert.rejects(fetchListener(callback));
    });
  }
}

for (const configOutcome of ['resolved', 'recovered'] as const)
  test(configOutcome === 'recovered'
    ? 'a recovered config commit interrupted during profile revocation reports the saved app switch'
    : 'an interrupt during postcommit profile revocation finishes cleanup without rolling back the saved app switch', {
    timeout: 10000,
  }, async (t) => {
    const port = nextManifestPort++;
    const harness = await newOrganisationHarness({ port, readAppId: 'A0READ' });
    const source = await harness.addWorkspace({
      alias: 'rgc/slack',
      workspaceId: 'TRGC0001',
      oauthClientId: TEST_CLIENT_ID,
      appId: 'A0OLD',
      redirectPort: port,
    });
    await harness.updateConfig((config) => {
      const account = config.accounts['rgc/slack'];
      assert.ok(account);
      Object.assign(account, { organisation: 'rgc', profileApp: 'read' });
    });
    const update = harness.core.config.update.bind(harness.core.config);
    let lockReleaseFailed = false;
    if (configOutcome === 'recovered') {
      t.mock.method(harness.core.config, 'update', async (...args: Parameters<typeof update>) => {
        const written = await update(...args);
        if (!lockReleaseFailed && written.accounts['rgc/slack']?.secretRef !== source.secretRef) {
          lockReleaseFailed = true;
          throw new Error('EPERM: the committed config lock could not be released');
        }
        return written;
      });
    }
    const secrets = await harness.core.secrets('file');
    const host = new EventEmitter();
    const ready = deferred<string>();
    const revoking = deferred();
    const release = deferred();
    const exited = deferred();
    t.after(() => release.resolve());
    const stdout = new PassThrough();
    let output = '';
    let outputAtExit = '';
    let revokes = 0;
    let revokesAtExit = 0;
    stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    const action = run(['--json', 'workspace', 'reauth', 'rgc/slack'], {
      core: harness.core,
      env: harness.env,
      platform: 'darwin',
      streams: { stdout, stderr: new PassThrough(), stdin: new PassThrough() },
      openBrowser: (url) => ready.resolve(url),
      exchange: async () => slackOk({ team: { id: 'TRGC0001', name: 'RGC' }, app_id: 'A0READ' }),
      fetch: async () => {
        revokes++;
        if (revokes === 1) {
          assert.notEqual((await harness.core.config.load()).accounts['rgc/slack']?.secretRef, source.secretRef);
          host.emit('SIGINT');
          revoking.resolve();
          await release.promise;
        }
        return new Response(JSON.stringify({ ok: true, revoked: true }));
      },
      signals: {
        host: Object.assign(host, {
          pid: process.pid,
          kill() {
            outputAtExit = output;
            revokesAtExit = revokes;
            exited.resolve();
          },
        }),
        exit: () => undefined,
      },
    });
    void action.catch((error) => ready.reject(error));
    const auth = new URL(await ready.promise);
    const redirectUri = auth.searchParams.get('redirect_uri');
    assert.ok(redirectUri, 'the Slack request must name the bound foreground listener');
    const callback = new URL(redirectUri);
    callback.searchParams.set('state', auth.searchParams.get('state') ?? '');
    callback.searchParams.set('code', 'fake-code');
    await fetchListener(callback);
    await revoking.promise;
    release.resolve();
    await exited.promise;
    const config = await harness.core.config.load();
    const saved = config.accounts['rgc/slack'];
    assert.ok(saved);
    assert.equal(saved?.appId, 'A0READ');
    assert.equal(
      lockReleaseFailed,
      configOutcome === 'recovered',
      'the postcommit recovery path was not exercised exactly when requested',
    );
    assert.notEqual(saved?.secretRef, source.secretRef);
    assert.ok(await secrets.get(saved.secretRef));
    assert.equal(await secrets.get(source.secretRef), null);
    assert.deepEqual(config.pendingRevocations ?? [], []);
    assert.equal(revokesAtExit, 2, 'exit preceded postcommit cleanup');
    assert.equal(
      JSON.parse(outputAtExit).data.cleanup.cleaned,
      true,
      'the completed cleanup was not reported before exit',
    );
    // The interrupt arrived after the switch was saved, during its cleanup: the result says it was saved before.
    assert.equal(
      JSON.parse(outputAtExit).data.committedBeforeAbort,
      true,
      'a sign-in saved before an interrupt during cleanup was reported as an ordinary success',
    );
  });
