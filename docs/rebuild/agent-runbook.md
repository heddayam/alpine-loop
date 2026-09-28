# Multi-agent implementation runbook

Historical rebuild waves are complete and remain available in Git history.
This is the active execution protocol.

## Integrator contract

The primary agent reads the implementation plan, data policy, status, and this
runbook before changing the app. It owns shared contracts, root configuration,
lockfile, integration order, full verification, status evidence, and cleanup.

For algorithmic or design decisions, first look for relevant primary papers,
established practices, and maintained reference implementations. Record the
sources, their assumptions, and why the chosen approach fits this application's
weighted, directed trail graph and resource limits. Check corrections and known
counterexamples before adopting an optimization. Claims of optimal performance
require an applicable proof or representative measurements; a reference alone
does not establish them.

Use up to three bounded subagents when work has stable inputs and exclusive file
ownership. Every delegated task specifies its objective, allowed/forbidden
files, accepted contracts, focused tests, verification command, and a required
single commit. Subagents inspect freely but edit only their ownership set.

## Git and worktrees

- Keep one `codex/<feature>` integration branch and one purpose per commit.
- Run parallel edits in short-lived `codex/<task>` worktrees.
- Review each diff and focused suite before cherry-picking it.
- Remove completed worktrees and task branches immediately after integration.
- Preserve archive tags, user-owned changes, ignored packs, caches, secrets, and
  local databases.

## Active system boundaries

- `lib/contracts/**` and root configuration: integrator only.
- `lib/data/**` and `data/regions/**`: pack compiler, reviewed search regions,
  migrations, and audits.
- `lib/solver/**` and `lib/graph/**`: closed-route search and pack read surfaces.
- `lib/route-jobs/**` and `app/api/route-jobs/**`: persistent batch lifecycle.
- `components/**`, `app/globals.css`, and browser fixtures: unified builder and
  Jobs UI.

Never have parallel agents edit the same boundary or redesign an accepted API.
While a Docker data build is running, monitor its JSON status and Docker process
statistics. Never open its live WAL-mode SQLite files through the macOS host
mount, even with a read-only connection: WAL shared-memory coordination must stay
inside the same environment. Any necessary SQL inspection runs inside that build
container; inspect a closed, verified snapshot otherwise.

Automated tests remain deterministic and network-free. Runtime filter geometry
selects access points and never clips route geometry; exact pack coverage remains
the hard boundary. Unknown access follows the explicit request
snapshot. Constraint relaxation is never silent.

## Integration gate

For each feature:

1. Commit shared contracts and compatibility seams.
2. Run independent pack/backend/UI work in parallel when applicable.
3. Integrate data, backend, then UI; run focused tests after each commit.
4. Run `npm run verify` and `npm run test:browser` twice.
5. Rebuild/audit the real pack when its schema changes.
6. Audit generated data, secrets, branches, and worktrees; update status with
   exact evidence; remove all completed task worktrees and branches.
