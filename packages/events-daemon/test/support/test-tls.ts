import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LoopbackTestTls {
  readonly cert: string;
  readonly dispose: () => Promise<void>;
  readonly key: string;
}

/** Creates one-use loopback TLS material at test time; no key material is checked into the repository. */
export async function createLoopbackTestTls(): Promise<LoopbackTestTls> {
  const directory = await mkdtemp(join(tmpdir(), 'agentcomms-events-tls-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');
  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1,IP:::1',
  ]);
  return {
    key: await readFile(keyPath, 'utf8'),
    cert: await readFile(certPath, 'utf8'),
    dispose: () => rm(directory, { force: true, recursive: true }),
  };
}
