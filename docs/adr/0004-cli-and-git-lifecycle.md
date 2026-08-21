# ADR 0004: Build a TypeScript CLI Around System Git

- Status: Accepted
- Date: 2026-08-21

## Context

The product needs a scriptable core before a TUI or editor integration. It must work with public GitHub repositories and private GitHub Enterprise repositories while reusing existing credentials and Git policy.

Node.js is an acceptable runtime on target machines, and TypeScript is the most familiar implementation language for the initial maintainer.

## Decision

- Implement the core and CLI in TypeScript on Node.js.
- Invoke installed system Git for repository, network, patch, and merge plumbing.
- Use tool-managed clones under XDG data directories.
- Use versioned JSON for committed manifests and machine configuration.
- Require clean repository worktrees outside Layerdots transactions.
- Stage and review changes before coordinated commits.
- Commit from base upward, honoring hooks and signing configuration.
- Push only through an explicit command, in base-to-overlay order.
- Stop and require synchronization on remote divergence; never force-push.
- Provide human output by default and stable JSON for read-only commands.

## Consequences

- Git authentication, SSH agents, hooks, and signing continue to work normally.
- Git is a required external dependency.
- Managed clones make one-command bootstrap and transaction validation practical, but users edit through Layerdots rather than treating clone locations as their primary workspace.
- Push can be retried safely after a parent succeeds and a child fails.
- Commit failure needs a recovery choice: interactive users are prompted; non-interactive operation defaults to rollback.

## Alternatives Considered

### Go CLI

A Go implementation would produce a single binary, but Node.js is acceptable and TypeScript reduces the initial learning and delivery cost.

### JavaScript Git implementation

This avoids subprocesses but duplicates credential, transport, configuration, hook, and merge behavior already handled by system Git.

### User-managed clones

Visible clones are familiar, but require more bootstrap configuration and make clean-state and transaction assumptions harder to enforce.
