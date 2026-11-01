# AGENTS.md

Kotomimi is a fork of Sokuji. Project guidance is in [CLAUDE.md](CLAUDE.md), the fork in [FORK.md](FORK.md) and `docs/fork/`.

## Docs are not a work log

- A feature or fix does not earn a paragraph. Commit messages and Git history hold what happened; docs hold what is true now and why.
- Touch a doc only when a fact in it became false, and change that fact in place. No dated sections, measurement logs, review narrative or "what changed" notes. Measured numbers go in `docs/fork/measurements.md`, one row per subject, updated in place.
- Working notes go to `.dev/` or a scratchpad. A new `.md` needs the user asking for it.
- `scripts/check-docs.mjs` enforces this at commit and at release: `scripts/docs-ledger.json` holds each doc's byte cap and dated-line count, and a cap only goes down. Do not raise one, and do not use `--no-verify`, unless the user asked in words.
