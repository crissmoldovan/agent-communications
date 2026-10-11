import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { renderApprovalViewForTerminal } from '../../../packages/events-daemon/src/cli/program.ts';

// desktop-mutation: desktop-b3-terminal-fixture
test('b3-terminal-fixture: B3 production terminal bytes match every shared disclosure preview', async () => {
  const folders = [
    new URL('../../../packages/events-daemon/test/fixtures/b3-approval-preview-v1/', import.meta.url),
    new URL('../../../test/fixtures/disclosure-preview/', import.meta.url),
  ];
  for (const folder of folders) {
    for (const name of (await readdir(folder)).filter((name) => name.endsWith('.json'))) {
      const fixture = JSON.parse(await readFile(new URL(name, folder), 'utf8'));
      assert.equal(renderApprovalViewForTerminal(fixture.result), fixture.expected.terminal, name);
    }
  }
});
