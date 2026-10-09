import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();

test('B2-T9: Phase-D production WhatsApp frame convergence is mandatory once the final fence exists', async (t) => {
  const finalD = await import(['..', 'src', 'sources', 'whatsapp-visibility.ts'].join('/')).catch(() => null);
  if (finalD === null) {
    t.skip('Phase D has not supplied its final WhatsApp visibility fixture and production composition seam');
    return;
  }
  throw new Error('Phase D is present: replace the guarded convergence fixture with its production-composition oracle');
});
