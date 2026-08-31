import { spawn } from 'node:child_process';

import { LayerdotsError } from '../domain/errors.js';

export interface GitOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type GitCommandError = LayerdotsError & GitResult;

export async function runGit(
  args: readonly string[],
  options: GitOptions = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (cause: Error) => {
      reject(
        new LayerdotsError(
          `Unable to start git ${formatArgs(args)}: ${cause.message}`,
          'git_spawn_failed',
          { cause },
        ),
      );
    });
    child.once('close', (exitCode, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: exitCode ?? -1,
      };

      if (result.exitCode !== 0) {
        const signalText = signal === null ? '' : ` (${signal})`;
        const error = Object.assign(
          new LayerdotsError(
            `Git command failed (${String(result.exitCode)}${signalText}): git ${formatArgs(args)}${
              result.stderr.trim() === '' ? '' : `\n${result.stderr.trim()}`
            }`,
            'git_command_failed',
            { cause: result },
          ),
          result,
        );
        reject(error);
        return;
      }

      resolve(result);
    });
  });
}

function formatArgs(args: readonly string[]): string {
  return args
    .map((arg) => (/^[a-zA-Z0-9_./:-]+$/.test(arg) ? arg : JSON.stringify(arg)))
    .join(' ');
}
