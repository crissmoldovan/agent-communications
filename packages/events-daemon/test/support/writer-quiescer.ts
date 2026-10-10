import { WriterQuiescer } from '../../src/runtime/writer-quiescer.ts';

/** Gives every test composition a real shared writer lease, never a no-op stand-in. */
export function testWriterQuiescer(): WriterQuiescer {
  return new WriterQuiescer();
}
