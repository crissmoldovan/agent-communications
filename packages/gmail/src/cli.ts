#!/usr/bin/env node
import { run } from './cli/program.ts';

const code = await run(process.argv.slice(2));
// An explicit exit code, but only after stdout has been flushed by the writes above.
process.exitCode = code;
