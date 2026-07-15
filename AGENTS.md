# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The authoritative release gate is `.github/workflows/ci.yml`; reproduce it locally with the matching `bun run` commands before handoff.
- Treat `docs/security.md` as the authority for credential, OAuth handoff, launcher, logging, and persistence boundaries.
- Temporary Codex WS mitigation: keep the original Pi session ID and close its public cached socket only on a coordinator-gated routed account switch. Remove it only after a published Pi release is source-verified to contain the owner/retirement fix from earendil-works/pi#6539, the synthetic affinity regression passes against that exact package, and the peer minimum is raised to that release; do not emit runtime update notices.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
