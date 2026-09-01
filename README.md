# Layerdots

Status: Milestone 1 core vertical slice complete

Layerdots composes dotfiles from an ordered stack of Git repositories. The current implementation validates and inspects local base/overlay repositories, tracks provenance and target changes, assigns whole hunks in memory, and rebases overlays with isolated conflicts.

Development and tests are intentionally sandboxed under the ignored `.layerdots-dev/` directory. The current CLI never defaults to or writes the user's home directory.

## Development

```sh
corepack pnpm install
corepack pnpm verify
```

Inspect local repositories without writing them or a target:

```sh
corepack pnpm dev -- inspect --base ./base --overlay ./overlay --color never
```

An optional `--target` points to a sandbox directory containing a literal `home/` tree. Only composed managed paths are read.

Implementation progress and the next resume point are recorded in [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

<https://stevenocchipinti.github.io/layerdots/>
