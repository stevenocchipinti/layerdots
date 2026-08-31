#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export function main(args: readonly string[]): number {
  if (args.includes('--version')) {
    process.stdout.write('layerdots 0.0.0\n');
    return 0;
  }

  process.stdout.write('Layerdots core vertical slice\n');
  return 0;
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  process.exitCode = main(process.argv.slice(2));
}
