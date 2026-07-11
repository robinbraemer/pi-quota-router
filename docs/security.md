# Security model

Pi packages execute with the same local authority as Pi. Review the repository before installing it, particularly when using an unpinned Git ref.

## Credential boundary

The router stores each managed account's raw Codex account id, access token, refresh token, and expiry only in `accounts.json`. The containing directory is created as `0700`; credential, config, state, log, lock-target, temporary, and rotated files are created/chmodded as `0600`.

Credentials do not belong in `state.json`, `config.json`, `events.ndjson`, status text, notifications, thrown error messages, or Pi session transcripts. Tests scan the isolated profile to enforce this boundary. Diagnostic serialization additionally redacts bearer values, JWT-shaped values, API-key-shaped values, long hexadecimal values, and long opaque identifiers.

The router intentionally does not modify normal Pi's `auth.json`. Duplicate logins are deduplicated by a non-secret managed id derived from SHA-256 of the Codex account id.

## Local authorization handoff

The login selector only accepts the expected `https://auth.openai.com/oauth/authorize` origin and path with code response type, fixed client and callback ids, a valid PKCE challenge, and nonempty OAuth state. It rejects fragments, embedded URL credentials, missing parameters, and duplicate security-sensitive parameters, and never passes provider instructions to a process launcher. Browser and clipboard tools are started with fixed executable names, explicit argv, `shell: false`, and—in the clipboard case—the validated URL on stdin. The only value opened, copied, or shown by this handoff is that validated authorization URL; OAuth credentials and account tokens are not available to the launcher boundary.

The authorization URL contains short-lived OAuth flow state, so it is surfaced only during the interactive authorization handoff and is never written to router diagnostics. If selection, browser launch, or clipboard access is unavailable, the same validated URL remains available for manual opening or copying. An unexpected authorization URL aborts the flow before credentials can be persisted; otherwise login storage changes only after the normal OAuth exchange succeeds.

## Network destinations

- Usage requests go only to `https://chatgpt.com/backend-api/wham/usage`, with the access token in `Authorization` and the raw account id in `ChatGPT-Account-Id`.
- Routed prompts use normal Pi's exported `openai-codex-responses` implementation and the fixed `https://chatgpt.com/backend-api` provider base.
- Login and refresh use normal Pi's exported OpenAI Codex OAuth implementation.

The extension does not import cookies, execute provider CLIs, or accept an environment variable that changes the Codex backend base URL.

## Atomicity and locking

JSON stores write a same-directory `0600` temporary file, flush it, atomically rename it, chmod the result, and sync the directory where supported. Writers lock a private lock target, reload after acquiring the lock, validate with a strict schema, and time out visibly after bounded contention.

OAuth refresh has an in-process single-flight and an account-specific cross-process lock. After taking the lock, a controller reloads credentials so it can reuse a refresh already completed by another process. If a successful login replaces credentials while an older refresh, usage request, or routed request is in flight, the login wins: a stale result can neither overwrite the new credentials nor mark them invalid. Permanent invalidation is conditioned on the rejected access token still being current. Lease creation similarly shares the state-file critical section with selection. Each foreground request receives an independently renewed token, while account primer leases remain exclusive: a live account primer lease vetoes foreground selection and a live foreground lease for that account vetoes priming regardless of the recorded owner process.

The event log is bounded to 4 MiB and retains only one rotated predecessor. An `account_selected` event records the managed account id, selection reason, and only the aggregate number of foreground leases already active on that account; it does not record peer lease tokens or owner process, session, or request identifiers. Logging failures never expose credentials or break a routed request.

## Priming safety

Priming spends real quota. Two UI confirmations authorize both intentional spend and the assumed first-use rolling-window behavior for the current command only; that authorization is never persisted. Work is sequential, exclusively fenced from foreground work by live leases, idle-only, minimal, and abortable. Every non-aborted provider attempt is followed by fresh usage observation, including attempts that report an error; only an observed weekly reset timestamp confirms the account.

Never test synthetic priming with valuable production accounts until the provider behavior has been independently confirmed.

## Threat limits

- Tokens are protected by filesystem permissions, not encryption at rest. Malware or another process running as the same OS user can read them.
- A compromised Pi extension has Pi's full process authority and can bypass this package's controls.
- Root/administrator access, filesystem backups, swap, crash dumps, and host compromise are outside this boundary.
- Redaction is defense in depth, not proof that arbitrary future secret formats can never appear.
- Provider and OAuth endpoints can change behavior outside the extension's control.
- The pinned Pi 0.80.6 Codex provider partitions WebSocket connection, continuation, and transport-fallback state by session but not account identity. Production rollout is blocked until an actual Pi release or commit proves account-identity partitioning for all three.
- Reservations coordinate processes sharing one filesystem/profile; they do not coordinate separate machines.
- Manual routing intentionally bypasses automatic quota headroom and untouched-account checks.

To erase credentials, uninstall the Git package, close all Pi processes, and delete the exact directory printed by `/quota-router path`. See the README for the destructive command.
