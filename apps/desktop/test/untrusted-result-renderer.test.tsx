import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// desktop-mutation: desktop-preview-links
test('untrusted-result-renderer: desktop-preview-links keeps tags and URLs inert', async () => {
  const { SafeResult, OperationResults } = await import('../src/screens/shared.tsx');
  const html = renderToStaticMarkup(
    React.createElement(SafeResult, {
      result: {
        operation: 'dryrun-show',
        segments: [
          { path: 'record', text: 'https://example.test <img src="https://example.test">', trust: 'untrusted' },
        ],
        code: null,
        truncated: false,
        approval: null,
      },
    }),
  );
  assert.match(html, /Untrusted data/);
  assert.match(html, /https:\/\/example.test/);
  assert.doesNotMatch(html, /<a\b|href=|<img\b|<script\b/);
  const feedback = renderToStaticMarkup(
    React.createElement(OperationResults, {
      results: {
        addJudge: { operation: 'addJudge', segments: [], code: 'E_REQUIRED', truncated: false, approval: null },
        judgeModelStatus: {
          operation: 'judgeModelStatus',
          segments: [],
          code: 'E2_REQUIRED',
          truncated: false,
          approval: null,
        },
        'enable-all': {
          operation: 'enable-all',
          segments: [{ path: '/approvalId', text: 'approval-from-daemon', trust: 'untrusted' }],
          code: null,
          truncated: false,
          approval: null,
        },
      },
    }),
  );
  assert.match(feedback, /E_REQUIRED/);
  assert.match(feedback, /E2_REQUIRED/);
  assert.match(feedback, /approval-from-daemon/);
});
