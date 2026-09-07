#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { LayerdotsError } from '../domain/errors.js';
import { applyCommand } from './apply.js';
import { inspect } from './inspect.js';

export function main(args: readonly string[]): number {
  if (args.length === 1 && args[0] === '--version') {
    process.stdout.write('layerdots 0.0.0\n');
    return 0;
  }
  return 2;
}

export interface CliIo {
  readonly stdout?: (value: string) => void;
  readonly stderr?: (value: string) => void;
  readonly cwd?: string;
}

export async function runCli(
  args: readonly string[],
  io: CliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? ((value: string) => process.stdout.write(value));
  const stderr = io.stderr ?? ((value: string) => process.stderr.write(value));
  try {
    if (args.length === 1 && args[0] === '--version') {
      stdout('layerdots 0.0.0\n');
      return 0;
    }
    let output: string;
    if (args[0] === 'apply') {
      const options = parseApply(args);
      const withCwd =
        io.cwd === undefined ? options : { ...options, cwd: io.cwd };
      output = await applyCommand(withCwd);
    } else {
      const options = parseInspect(args);
      output = await inspect(
        io.cwd === undefined ? options : { ...options, cwd: io.cwd },
      );
    }
    stdout(output);
    return 0;
  } catch (error) {
    if (error instanceof LayerdotsError) {
      stderr(`${error.code}: ${error.message}\n`);
    } else {
      stderr(
        `error: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return 1;
  }
}

interface ParsedInspect {
  readonly base: string;
  readonly overlays: string[];
  readonly target?: string;
  readonly color: 'always' | 'never';
}

function parseInspect(args: readonly string[]): ParsedInspect {
  if (args[0] !== 'inspect')
    throw new LayerdotsError('Expected inspect command.', 'CLI_USAGE');
  let base: string | undefined;
  let target: string | undefined;
  let color: 'always' | 'never' = 'never';
  const overlays: string[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--overlay') {
      const value = args[++index];
      if (!value)
        throw new LayerdotsError('Missing value for --overlay.', 'CLI_USAGE');
      overlays.push(value);
      continue;
    }
    if (flag !== '--base' && flag !== '--target' && flag !== '--color') {
      throw new LayerdotsError(`Unknown argument: ${flag ?? ''}.`, 'CLI_USAGE');
    }
    if (seen.has(flag))
      throw new LayerdotsError(`Duplicate argument: ${flag}.`, 'CLI_USAGE');
    seen.add(flag);
    const value = args[++index];
    if (!value)
      throw new LayerdotsError(`Missing value for ${flag}.`, 'CLI_USAGE');
    if (flag === '--base') base = value;
    else if (flag === '--target') target = value;
    else if (value === 'always' || value === 'never') color = value;
    else throw new LayerdotsError(`Invalid color: ${value}.`, 'CLI_USAGE');
  }
  if (!base) throw new LayerdotsError('Missing required --base.', 'CLI_USAGE');
  return { base, overlays, ...(target ? { target } : {}), color };
}

interface ParsedApply {
  readonly base: string;
  readonly overlays: string[];
  readonly target: string;
  readonly stateDir?: string;
  readonly approve: string[];
}

function parseApply(args: readonly string[]): ParsedApply {
  if (args[0] !== 'apply')
    throw new LayerdotsError('Expected apply command.', 'CLI_USAGE');
  let base: string | undefined;
  let target: string | undefined;
  let stateDir: string | undefined;
  const overlays: string[] = [];
  const approve: string[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--overlay' || flag === '--approve') {
      const value = args[++index];
      if (!value)
        throw new LayerdotsError(`Missing value for ${flag}.`, 'CLI_USAGE');
      if (flag === '--overlay') overlays.push(value);
      else approve.push(value);
      continue;
    }
    if (flag !== '--base' && flag !== '--target' && flag !== '--state-dir') {
      throw new LayerdotsError(`Unknown argument: ${flag ?? ''}.`, 'CLI_USAGE');
    }
    if (seen.has(flag))
      throw new LayerdotsError(`Duplicate argument: ${flag}.`, 'CLI_USAGE');
    seen.add(flag);
    const value = args[++index];
    if (!value)
      throw new LayerdotsError(`Missing value for ${flag}.`, 'CLI_USAGE');
    if (flag === '--base') base = value;
    else if (flag === '--target') target = value;
    else stateDir = value;
  }
  if (!base) throw new LayerdotsError('Missing required --base.', 'CLI_USAGE');
  if (!target)
    throw new LayerdotsError('Missing required --target.', 'CLI_USAGE');
  return {
    base,
    overlays,
    target,
    ...(stateDir ? { stateDir } : {}),
    approve,
  };
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(entryPoint).href
) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
