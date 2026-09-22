# Development

This document covers working on Layerdots itself: setup, verification, and the sandboxed workflow used for manual testing. For usage documentation, see [`README.md`](README.md).

## Setup

```sh
corepack pnpm install
```

Requires Node.js 22+ and Corepack-pinned pnpm 11.24.0 (see `package.json`).

## Verification

```sh
corepack pnpm verify
```

This runs formatting, linting, type checking, the test suite, and a production build. Individual steps are also available:

```sh
corepack pnpm format:check   # prettier --check .
corepack pnpm lint           # eslint src tests vitest.config.ts
corepack pnpm typecheck      # tsc --noEmit
corepack pnpm test           # vitest run
corepack pnpm test:watch     # vitest, watch mode
corepack pnpm build          # tsc -p tsconfig.build.json
corepack pnpm format         # prettier --write .
```

## Sandbox

Development and tests are intentionally sandboxed under the ignored `.layerdots-dev/` directory. Layerdots never writes to the actual user home directory unless both `--apply-to-home` and `LAYERDOTS_ALLOW_HOME=1` are set, and development/test commands never set that guard.

The test suite clears `.layerdots-dev/` once at the start of every run, so its size is bounded by the run in progress. Run this at any time to remove it manually, along with build and coverage output:

```sh
corepack pnpm clean
```

### Manual smoke testing

Use `corepack pnpm dev --` to run the CLI from source (`tsx src/cli/main.ts`) against a sandbox target, mirroring the commands documented in the README:

```sh
corepack pnpm dev -- init <private-overlay-url> --target .layerdots-dev/sandbox
corepack pnpm dev -- inspect --target .layerdots-dev/sandbox
corepack pnpm dev -- apply --target .layerdots-dev/sandbox
```

For quick iteration on composition logic without cloning real remotes, repositories can be supplied directly from local fixture directories:

```sh
corepack pnpm dev -- inspect --base ./base --overlay ./overlay --color never
```

## Project state

- [`PLAN.md`](PLAN.md) records the phased implementation roadmap and open design decisions.
- [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) is the handoff ledger: current milestone, verification log, and resume checklist. Update it after each verified integration point.
- [`CONTEXT.md`](CONTEXT.md) defines the shared domain language and product invariants; consult it before introducing new terminology.
- [`docs/adr/`](docs/adr) records rationale for consequential architectural decisions.

## Resume checklist

1. Read `CONTEXT.md`, `PLAN.md`, and `IMPLEMENTATION_STATUS.md`.
2. Run `corepack pnpm verify`.
3. Inspect `git status --short` and recent commits.
4. Continue from the current position recorded in `IMPLEMENTATION_STATUS.md`.
