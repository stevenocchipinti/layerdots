#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { LayerdotsError } from '../domain/errors.js';
import { applyCommand } from './apply.js';
import { assignCommand, captureDiff, captureStatus } from './capture.js';
import { inspect } from './inspect.js';
import { resolveTargetPath } from './target.js';
import {
  assertTargetOutsideLayerdotsPaths,
  initializeStack,
} from '../lifecycle/initialize.js';
import { resolveLayerdotsPaths } from '../lifecycle/paths.js';
import { readActiveStack } from '../lifecycle/stack.js';
import { writeActiveStack } from '../lifecycle/stack.js';
import { commitTransaction, pushStack } from '../transaction/transaction.js';
import {
  recoverSynchronization,
  synchronizeStack,
} from '../synchronization/lifecycle.js';

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
  readonly env?: NodeJS.ProcessEnv;
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
    const cwd = io.cwd ?? process.cwd();
    const env = io.env ?? process.env;
    const paths = resolveLayerdotsPaths(env);
    if (args[0] === 'init') {
      const parsed = parseInit(args);
      const stack = await initializeStack({
        overlayUrl: parsed.overlayUrl,
        target: resolveTargetPath({
          cwd,
          explicitTarget: parsed.target,
          useHome: false,
        }),
        paths,
        env,
      });
      output = [
        `INITIALIZED TARGET ${stack.target}`,
        ...stack.layers.map(
          (layer) => `LAYER ${layer.root} COMMIT ${layer.commit}`,
        ),
      ].join('\n');
      output = `${output}\n`;
    } else if (args[0] === 'apply') {
      const parsed = parseApply(args);
      const usesActiveStack = parsed.base === undefined;
      const target: string = resolveTargetPath({
        cwd,
        ...(parsed.target !== undefined
          ? { explicitTarget: parsed.target }
          : {}),
        useHome: parsed.applyToHome,
      });
      assertTargetOutsideLayerdotsPaths(target, paths);
      const layers = await resolveLayers(parsed, target, paths);
      const options = {
        ...parsed,
        ...layers,
        target,
        cwd,
        ...(parsed.stateDir === undefined && usesActiveStack
          ? { stateDir: paths.state }
          : {}),
      };
      output = await applyCommand(options);
    } else if (args[0] === 'status') {
      const target = parseTargetCommand(args, 'status');
      const stack = await readActiveStack(
        paths,
        resolveTargetPath({ cwd, explicitTarget: target, useHome: false }),
      );
      output = await captureStatus({ stack, paths });
    } else if (args[0] === 'diff') {
      const target = parseTargetCommand(args, 'diff');
      const stack = await readActiveStack(
        paths,
        resolveTargetPath({ cwd, explicitTarget: target, useHome: false }),
      );
      output = await captureDiff({ stack, color: 'never' });
    } else if (args[0] === 'assign') {
      const parsed = parseAssign(args);
      const stack = await readActiveStack(
        paths,
        resolveTargetPath({
          cwd,
          explicitTarget: parsed.target,
          useHome: false,
        }),
      );
      output = await assignCommand({
        stack,
        paths,
        path: parsed.path,
        layer: parsed.layer,
      });
    } else if (args[0] === 'commit') {
      const parsed = parseCommit(args);
      const stack = await readActiveStack(
        paths,
        resolveTargetPath({
          cwd,
          explicitTarget: parsed.target,
          useHome: false,
        }),
      );
      const next = await commitTransaction({
        paths,
        stack,
        env,
        message: parsed.message,
      });
      await writeActiveStack(paths, next);
      output = 'COMMITTED\n';
    } else if (args[0] === 'push') {
      const target = parseTargetCommand(args, 'push');
      const stack = await readActiveStack(
        paths,
        resolveTargetPath({ cwd, explicitTarget: target, useHome: false }),
      );
      await pushStack({ stack, env });
      output = 'PUSHED\n';
    } else if (args[0] === 'sync') {
      const parsed = parseSync(args);
      const stack = await readActiveStack(
        paths,
        resolveTargetPath({
          cwd,
          explicitTarget: parsed.target,
          useHome: false,
        }),
      );
      if (parsed.recover) {
        output = (await recoverSynchronization(paths, stack, env))
          ? 'SYNC RECOVERED\n'
          : 'SYNC CLEAN\n';
        stdout(output);
        return 0;
      }
      const result = await synchronizeStack({ paths, stack, env });
      if (result.kind === 'conflict') {
        stdout(`SYNC CONFLICT WORKSPACE ${result.workspace}\n`);
        return 1;
      }
      output = result.kind === 'clean' ? 'SYNC CLEAN\n' : 'SYNC STAGED\n';
    } else {
      const options = parseInspect(args);
      const layers = await resolveLayers(options, options.target, paths);
      output = await inspect({ ...options, ...layers, cwd });
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

function parseSync(args: readonly string[]): {
  readonly target: string;
  readonly recover: boolean;
} {
  if (args[1] === 'recover') {
    if (args[2] !== '--target' || !args[3] || args.length !== 4)
      throw new LayerdotsError(
        'Expected sync recover --target <directory>.',
        'CLI_USAGE',
      );
    return { target: args[3], recover: true };
  }
  return { target: parseTargetCommand(args, 'sync'), recover: false };
}

function parseTargetCommand(args: readonly string[], command: string): string {
  if (
    args[0] !== command ||
    args[1] !== '--target' ||
    !args[2] ||
    args.length !== 3
  ) {
    throw new LayerdotsError(
      `Expected ${command} --target <directory>.`,
      'CLI_USAGE',
    );
  }
  return args[2];
}

interface ParsedAssign {
  readonly path: string;
  readonly layer: 'base' | 'overlay';
  readonly target: string;
}
function parseAssign(args: readonly string[]): ParsedAssign {
  const path = args[1];
  if (
    !path ||
    args[2] !== '--layer' ||
    (args[3] !== 'base' && args[3] !== 'overlay') ||
    args[4] !== '--all-hunks' ||
    args[5] !== '--target' ||
    !args[6] ||
    args.length !== 7
  ) {
    throw new LayerdotsError(
      'Expected assign <path> --layer base|overlay --all-hunks --target <directory>.',
      'CLI_USAGE',
    );
  }
  return { path, layer: args[3], target: args[6] };
}

interface ParsedCommit {
  readonly message: string;
  readonly target: string;
}
function parseCommit(args: readonly string[]): ParsedCommit {
  if (
    args[1] !== '--message' ||
    !args[2] ||
    args[3] !== '--target' ||
    !args[4] ||
    args.length !== 5
  ) {
    throw new LayerdotsError(
      'Expected commit --message <message> --target <directory>.',
      'CLI_USAGE',
    );
  }
  return { message: args[2], target: args[4] };
}

interface ParsedInspect {
  readonly base?: string;
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
  if (base === undefined && target === undefined) {
    throw new LayerdotsError(
      'Active-stack inspection requires --target when --base is omitted.',
      'CLI_USAGE',
    );
  }
  return {
    ...(base ? { base } : {}),
    overlays,
    ...(target ? { target } : {}),
    color,
  };
}

interface ParsedApply {
  readonly base?: string;
  readonly overlays: string[];
  readonly target?: string;
  readonly applyToHome: boolean;
  readonly stateDir?: string;
  readonly approve: string[];
}

function parseApply(args: readonly string[]): ParsedApply {
  if (args[0] !== 'apply')
    throw new LayerdotsError('Expected apply command.', 'CLI_USAGE');
  let base: string | undefined;
  let target: string | undefined;
  let applyToHome = false;
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
    if (flag === '--apply-to-home') {
      if (seen.has(flag))
        throw new LayerdotsError(`Duplicate argument: ${flag}.`, 'CLI_USAGE');
      seen.add(flag);
      applyToHome = true;
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
  if (base === undefined && target === undefined && !applyToHome) {
    throw new LayerdotsError(
      'Active-stack application requires --target or --apply-to-home when --base is omitted.',
      'CLI_USAGE',
    );
  }
  if (target !== undefined && applyToHome) {
    throw new LayerdotsError(
      'Cannot use both --target and --apply-to-home.',
      'CLI_USAGE',
    );
  }
  return {
    ...(base ? { base } : {}),
    overlays,
    ...(target !== undefined ? { target } : {}),
    applyToHome,
    ...(stateDir !== undefined ? { stateDir } : {}),
    approve,
  };
}

interface ParsedInit {
  readonly overlayUrl: string;
  readonly target: string;
}

function parseInit(args: readonly string[]): ParsedInit {
  if (args[0] !== 'init')
    throw new LayerdotsError('Expected init command.', 'CLI_USAGE');
  const overlayUrl = args[1];
  if (!overlayUrl || overlayUrl.startsWith('--')) {
    throw new LayerdotsError('Missing required overlay URL.', 'CLI_USAGE');
  }
  if (args[2] !== '--target' || !args[3] || args.length !== 4) {
    throw new LayerdotsError(
      'Expected init <overlay-url> --target <directory>.',
      'CLI_USAGE',
    );
  }
  return { overlayUrl, target: args[3] };
}

async function resolveLayers(
  options: { readonly base?: string; readonly overlays: readonly string[] },
  target: string | undefined,
  paths: ReturnType<typeof resolveLayerdotsPaths>,
): Promise<{ readonly base: string; readonly overlays: string[] }> {
  if (options.base !== undefined) {
    return { base: options.base, overlays: [...options.overlays] };
  }
  if (target === undefined) {
    throw new LayerdotsError('Missing target for active stack.', 'CLI_USAGE');
  }
  if (options.overlays.length > 0) {
    throw new LayerdotsError(
      'Cannot supply --overlay without --base.',
      'CLI_USAGE',
    );
  }
  const stack = await readActiveStack(paths, target);
  const [base, ...overlays] = stack.layers;
  if (base === undefined) {
    throw new LayerdotsError('Active stack has no layers.', 'STACK_INVALID');
  }
  return {
    base: base.root,
    overlays: overlays.map((layer) => layer.root),
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
