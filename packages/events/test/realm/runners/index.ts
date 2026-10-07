/**
 * Every vector family's runner, by the `family` its vector files declare. One line per family: a vector file whose
 * family is missing here fails `test/conformance.test.ts`, so no file is silently skipped.
 */
import { canonicalJsonRunner } from './canonical-json.ts';
import { catalogueRunner } from './catalogue.ts';
import { eventIdRunner } from './event-id.ts';
import { formatsRunner } from './formats.ts';
import { idnaRunner } from './idna.ts';
import { pointersRunner } from './pointers.ts';
import { resendBodyRunner } from './resend-body.ts';
import type { Runner } from './types.ts';
import { unicodeRunner } from './unicode.ts';

export type { EventsLibrary, Runner, RunnerResult, VectorFile } from './types.ts';

export const RUNNERS: Readonly<Record<string, Runner>> = {
  'canonical-json': canonicalJsonRunner,
  catalogue: catalogueRunner,
  'event-id': eventIdRunner,
  pointers: pointersRunner,
  'resend-body': resendBodyRunner,
  formats: formatsRunner,
  idna: idnaRunner,
  unicode: unicodeRunner,
};
