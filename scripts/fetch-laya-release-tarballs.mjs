#!/usr/bin/env node
import { request } from 'node:https';
import { fileURLToPath } from 'node:url';
import {
  assertCanonicalSRI,
  assertExactRegistryTarball,
  assertSRI,
  buildRuntimeLock,
  RuntimeLockError,
} from './laya-runtime-lock.mjs';

const releaseAcquisitionCapability = Symbol('releaseAcquisitionCapability');

function releaseMetadata(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  }
  const record = value;
  const keys = ['name', 'version', 'url', 'integrity'];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  }
  for (const key of keys) {
    if (typeof record[key] !== 'string' || record[key].length === 0) {
      throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
    }
  }
  assertExactRegistryTarball(record.name, record.version, record.url);
  assertCanonicalSRI(record.integrity);
  return record;
}

async function requestRegistryTarball(metadata) {
  const url = new URL(metadata.url);
  return new Promise((resolve, reject) => {
    const connection = request(
      url,
      {
        method: 'GET',
        headers: {
          accept: 'application/octet-stream',
          'user-agent': 'agent-communications-release-lock-builder',
        },
      },
      (response) => {
        if (response.statusCode !== 200 || response.headers.location !== undefined) {
          response.resume();
          reject(new RuntimeLockError('RUNTIME_ORIGIN'));
          return;
        }
        const chunks = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    connection.once('error', reject);
    connection.end();
  });
}

function requiredAcquirer(acquire) {
  if (typeof acquire !== 'function') throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  return acquire;
}

/** Returns the real registry acquirer only for Task 10's owner-controlled supply-chain gate. */
export function supplyChainGateAcquirer(env = process.env) {
  if (env?.AGENTCOMMS_LAYA_SUPPLY_CHAIN_GATE !== '1') throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  return requestRegistryTarball;
}

/** The only production path allowed to acquire a Laya runtime tarball. */
export async function fetchLayaReleaseTarball(metadata, acquire, capability) {
  const acquirer = requiredAcquirer(acquire);
  const record = releaseMetadata(metadata);
  if (capability !== releaseAcquisitionCapability) throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  const bytes = await acquirer(record);
  if (!Buffer.isBuffer(bytes)) throw new RuntimeLockError('RUNTIME_LOCK_INPUT');
  assertSRI(bytes, record.integrity);
  return bytes;
}

/** Acquires raw verified tarballs and hands those bytes directly to the deterministic lock builder. */
export async function buildLayaRuntimeLock(input, acquire) {
  const suppliedAcquirer = requiredAcquirer(acquire);
  const acquirer = (metadata) => fetchLayaReleaseTarball(metadata, suppliedAcquirer, releaseAcquisitionCapability);
  return buildRuntimeLock(input, acquirer);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  throw new Error('fetch-laya-release-tarballs.mjs is a release-only library, not an ordinary-CI command');
}
