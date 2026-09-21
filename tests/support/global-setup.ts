import { rm } from 'node:fs/promises';
import { SANDBOX_ROOT } from './sandbox.js';

/**
 * Vitest global setup. Every sandbox fixture lives under the ignored
 * `.layerdots-dev/` directory and no individual test removes its own
 * sandbox (fixtures are occasionally useful to inspect after a failure).
 * Without a global sweep, `.layerdots-dev/` grows without bound across
 * repeated test runs. Clearing it once per run bounds growth to at most
 * one run's worth of fixtures.
 */
export default async function setup(): Promise<void> {
  await rm(SANDBOX_ROOT, { recursive: true, force: true });
}
