import { appendFileSync } from 'node:fs';
import { LISTENER_REGISTRY_ENV, LISTENER_TEST_FILE_ENV, LISTENER_TEST_NAME_ENV } from './detached-listeners.ts';

const command = process.argv.indexOf('oauth-listen');
if (command !== -1) {
  const registry = process.env[LISTENER_REGISTRY_ENV];
  const testFile = process.env[LISTENER_TEST_FILE_ENV];
  const testName = process.env[LISTENER_TEST_NAME_ENV];
  const flowId = process.argv[command + 1];
  if (!registry) throw new Error(`${LISTENER_REGISTRY_ENV} is missing from a Gmail test listener`);
  if (!testFile) throw new Error(`${LISTENER_TEST_FILE_ENV} is missing from a Gmail test listener`);
  if (!testName) throw new Error(`${LISTENER_TEST_NAME_ENV} is missing from a Gmail test listener`);
  if (!flowId) throw new Error('the Gmail test listener has no flow id');
  appendFileSync(registry, `${JSON.stringify({ pid: process.pid, flowId, testFile, testName })}\n`, {
    encoding: 'utf8',
  });
}
