import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// desktop-mutation: desktop-approval-renderer
test('approval-renderer: only Rust safe preview and typed challenge enter the approval screen', async () => {
  const { Approvals } = await import('../src/screens/approvals.tsx');
  const html = renderToStaticMarkup(
    React.createElement(Approvals, {
      results: {
        approvalView: {
          operation: 'approvalView',
          segments: [{ path: 'preview', text: 'authoritative <b>preview</b>', trust: 'untrusted' }],
          code: null,
          truncated: false,
          approval: { approvalId: 'approval-1', digest: 'digest-1', challenge: 'challenge-1', expiresAt: 301000 },
        },
      },
      onOperation() {},
      onApproval() {},
      onSecrets() {},
    }),
  );
  assert.match(html, /authoritative &lt;b&gt;preview&lt;\/b&gt;/);
  assert.match(html, /challenge-1/);
  assert.match(html, /Typed challenge/);
  assert.doesNotMatch(html, /<b>preview<\/b>/);
});
