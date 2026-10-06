// Accepted: zod's types, and the package's own.
import type { z } from 'zod';

export declare const schema: z.ZodString;
export declare function local(): import('./local.mjs').Thing;
