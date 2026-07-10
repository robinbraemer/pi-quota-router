# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The authoritative release gate is `.github/workflows/ci.yml`; reproduce it locally with the matching `bun run` commands before handoff.
- Treat `docs/security.md` as the authority for credential, OAuth handoff, launcher, logging, and persistence boundaries.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
