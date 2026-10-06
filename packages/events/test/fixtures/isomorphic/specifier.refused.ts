// Refused: a Node module, which no browser has.
import { readFileSync } from 'node:fs';

export const read = readFileSync;
