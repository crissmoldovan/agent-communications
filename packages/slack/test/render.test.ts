import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderWorkspace, renderWorkspaces } from '../src/cli/render.ts';
import type { WorkspaceView } from '../src/operations/workspaces.ts';

/**
 * What reaches a terminal.
 *
 * The operations already neutralise anything a workspace controls. This layer adds the one thing a terminal
 * needs on top, and it is not theoretical: a workspace named with a carriage return can overwrite the line above
 * it, so a list of two workspaces can be made to show one — or to show a line nobody wrote.
 */

function view(over: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    alias: 'acme',
    accountId: 'acc_0000000000000000',
    workspaceId: 'T0001',
    workspaceName: 'Acme',
    userId: 'U0001',
    mode: 'read',
    grantedScopes: ['channels:history', 'users:read'],
    createdAt: '2026-09-22T12:00:00.000Z',
    ...over,
  };
}

test('a newline in a workspace name cannot forge the row beneath it', () => {
  /*
   * This is what this layer adds, and the only thing it adds.
   *
   * `stripInvisible` removes escape sequences and lone carriage returns already, but keeps tab and newline on
   * purpose — they are legitimate in a message body, which is what it was written for. In a list whose job is to
   * say what each workspace may do, a name carrying a newline prints a second line that looks exactly like the
   * scopes row under it.
   */
  const printed = renderWorkspaces([view({ workspaceName: 'Acme\n  read · T0002 · 14 scopes' })], false);
  const lines = printed.split('\n');
  assert.equal(lines.length, 2, `a name added a line:\n${printed}`);
  // Flattened onto the alias row, not dropped: the name is still readable, it just cannot be a row of its own.
  assert.match(lines[0] ?? '', /Acme\s+read · T0002 · 14 scopes/, 'the text was dropped rather than flattened');
  assert.match(lines[1] ?? '', /read · T0001 · 2 scopes/, 'the real row is gone');
});

test('a tab in a workspace name cannot pad it into a neighbouring column', () => {
  const printed = renderWorkspaces([view({ workspaceName: 'Acme\t\tread' })], false);
  assert.doesNotMatch(printed, /\t/, 'a tab reached the terminal');
});

test('the escape sequences stripInvisible handles do not reach the terminal either', () => {
  // Not this layer's work, but it is what a reader of a workspace list would assume, so it is held here too.
  const nasty = `Acme${String.fromCharCode(27)}[2J${String.fromCharCode(13)}overwritten${String.fromCharCode(7)}`;
  for (const printed of [
    renderWorkspaces([view({ workspaceName: nasty })], false),
    renderWorkspace(view({ workspaceName: nasty }), false),
  ]) {
    for (const code of [27, 13, 7]) {
      assert.doesNotMatch(printed, new RegExp(String.fromCharCode(code)), `character ${code} reached the terminal`);
    }
  }
});

test('a very long workspace name is bounded rather than allowed to push the row apart', () => {
  const printed = renderWorkspaces([view({ workspaceName: 'A'.repeat(500) })], false);
  for (const line of printed.split('\n')) assert.ok(line.length < 120, `a line ran to ${line.length} characters`);
});

test('a workspace with no name shows its id rather than an empty gap', () => {
  const printed = renderWorkspaces([view({ workspaceName: undefined })], false);
  assert.match(printed, /T0001/);
  assert.doesNotMatch(printed, / — \n/);
});
