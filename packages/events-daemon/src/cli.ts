#!/usr/bin/env node
import { run } from './cli/program.ts';

process.exitCode = await run(process.argv.slice(2));
