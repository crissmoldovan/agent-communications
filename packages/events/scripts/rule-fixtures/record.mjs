/**
 * Loaded before a test module the harvester evaluates: it records, as JSON, each value a wrapped rule literal makes,
 * and writes them to `HARVEST_OUT` when the process exits.
 */
import { writeFileSync } from 'node:fs';

const out = process.env.HARVEST_OUT;
const seen = [];

globalThis.__harvest = (ordinal, value) => {
  try {
    seen.push({ ordinal, value: JSON.parse(JSON.stringify(value)) });
  } catch (error) {
    seen.push({ ordinal, error: String(error) });
  }
  return value;
};

globalThis.__harvestError = (ordinal, error) => {
  seen.push({ ordinal, error: String(error) });
};

/** Calls a helper the way the file does; a call that needs a test's locals is skipped. */
globalThis.__harvestTry = async (call) => {
  try {
    await call();
  } catch {
    // The call's arguments are a test's locals: the literal is evaluated with its locals instead.
  }
};

process.on('exit', () => {
  if (out !== undefined) writeFileSync(out, JSON.stringify(seen));
});
