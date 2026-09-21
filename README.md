# Layerdots

Status: Milestone 3 prototype bootstrap complete; transaction staging and publishing remain.

Layerdots composes dotfiles from an ordered stack of Git repositories. It safely applies a composed stack to an explicit target, preserves unmanaged files and local target edits, and isolates conflicts outside the live target.

Development and tests are intentionally sandboxed under the ignored `.layerdots-dev/` directory. Applying to the real home remains behind an explicit double opt-in.

## Development

```sh
corepack pnpm install
corepack pnpm verify
```

For a usable prototype, initialize from the top overlay remote and use an explicit sandbox target:

```sh
corepack pnpm dev -- init <private-overlay-url> --target ~/layerdots-sandbox
corepack pnpm dev -- inspect --target ~/layerdots-sandbox
corepack pnpm dev -- apply --target ~/layerdots-sandbox
```

`init` clones the overlay and each pinned parent under XDG data storage, verifies the parent commits, and records the active stack in XDG configuration. It never writes the target. `apply` stores its merge base in XDG state and writes only managed paths.

For development and explicit local repository testing, repositories can still be supplied directly:

```sh
corepack pnpm dev -- inspect --base ./base --overlay ./overlay --color never
```

An optional `--target` points to a sandbox directory containing a literal `home/` tree. Only composed managed paths are read.

Implementation progress and the next resume point are recorded in [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).

<https://stevenocchipinti.github.io/layerdots/>
