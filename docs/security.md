# Security model

Pi packages execute with the same local authority as Pi. Review the repository before installing it, particularly when using an unpinned Git ref.

## Credential boundary

The router stores each managed account's raw Codex account id, access token, refresh token, and expiry only in `accounts.json`. The containing directory is created as `0700`; credential, config, state, log, lock-target, temporary, and rotated files are created/chmodded as `0600`.

Credentials do not belong in `state.json`, `config.json`, `events.ndjson`, status text, notifications, thrown error messages, or Pi session transcripts. Tests scan the isolated profile to enforce this boundary. Diagnostic serialization additionally redacts bearer values, JWT-shaped values, API-key-shaped values, long hexadecimal values, and long opaque identifiers.

The router intentionally does not modify normal Pi's `auth.json`. Duplicate logins are deduplicated by a non-secret managed id derived from SHA-256 of the Codex account id.

## Network destinations

- Usage requests go only to `https://chatgpt.com/backend-api/wham/usage`, with the access token in `Authorization` and the raw account id in `ChatGPT-Account-Id`.
- Routed prompts use normal Pi's exported `openai-codex-responses` implementation and the fixed `https://chatgpt.com/backend-api` provider base.
- Login and refresh use normal Pi's exported OpenAI Codex OAuth implementation.

The extension does not import cookies, execute provider CLIs, or accept an environment variable that changes the Codex backend base URL.

## Atomicity and locking

JSON stores write a same-directory `0600` temporary file, flush it, atomically rename it, chmod the result, and sync the directory where supported. Writers lock a private lock target, reload after acquiring the lock, validate with a strict schema, and time out visibly after bounded contention.

OAuth refresh has an in-process single-flight and an account-specific cross-process lock. After taking the lock, a controller reloads credentials so it can reuse a refresh already completed by another process. Reservations similarly combine selection and lease acquisition in one state-file critical section.

The event log is bounded to 4 MiB and retains only one rotated predecessor. Logging failures never expose credentials or break a routed request.

## Priming safety

Priming spends real quota. It is disabled until two UI confirmations authorize both intentional spend and the assumed first-use rolling-window behavior. Work is sequential, account-reserved, idle-only, minimal, and abortable. Confirmation is persisted only after fresh usage exposes a weekly reset timestamp.

Never test synthetic priming with valuable production accounts until the provider behavior has been independently confirmed.

## Threat limits

- Tokens are protected by filesystem permissions, not encryption at rest. Malware or another process running as the same OS user can read them.
- A compromised Pi extension has Pi's full process authority and can bypass this package's controls.
- Root/administrator access, filesystem backups, swap, crash dumps, and host compromise are outside this boundary.
- Redaction is defense in depth, not proof that arbitrary future secret formats can never appear.
- Provider and OAuth endpoints can change behavior outside the extension's control.
- Reservations coordinate processes sharing one filesystem/profile; they do not coordinate separate machines.
- Manual routing intentionally bypasses automatic quota headroom and untouched-account checks.

To erase credentials, uninstall the Git package, close all Pi processes, and delete the exact directory printed by `/quota-router path`. See the README for the destructive command.
