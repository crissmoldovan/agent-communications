// Accepted: zod, and the library's own modules.
import { z } from 'zod';
import { canonicalJson } from './json.ts';

export const schema = z.string();
export const write = canonicalJson;
