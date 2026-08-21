# ADR 0001: Use a Plain Base and Pinned Overlay Repositories

- Status: Accepted
- Date: 2026-08-21

## Context

The primary use case combines public personal dotfiles with private work-specific changes. Running two independent dotfile managers causes each repository to report the other repository's intended changes as drift.

The public repository must remain the only authority for public base content. A private repository may depend on it, but should not become a separately editable copy of the base.

## Decision

Model configuration as a linear stack of Git repositories:

- the first repository is a base with no parent;
- each overlay records one immediate parent URL, tracked branch, and exact commit;
- initializing from the top overlay recursively discovers the stack;
- all repositories use one manifest format, with role inferred from the presence of a parent.

The base stores a plain tree under `home/`. An overlay can store additions, full replacements, patches, and tombstones.

## Consequences

- The public repository remains the sole authority for base content.
- A private repository is self-describing and reproducible on another machine.
- A base update creates a metadata update in every dependent overlay, even when no overlay content changes.
- An overlay is tied to one parent composition rather than freely reusable over unrelated bases.
- The core can support more than two layers without changing the model.

## Alternatives Considered

### Private Git branch based on public history

This would reuse Git commits, rebases, and blame, but copies public content and history into the private remote and may require rewriting overlay branch history when the base advances.

### Machine-local stack only

This allows arbitrary local combinations, but an overlay commit is not reproducible without separate machine configuration and cloning the work repository is insufficient to bootstrap the system.

### Top repository lists every layer

This centralizes stack configuration, but intermediate patches lose standalone meaning because they do not identify the exact composition against which they were generated.
