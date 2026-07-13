# Troubleshooting

Start with:

```text
/quota-router verify
/quota-router list
/quota-router path
```

`Quota router is healthy` means the vault, config, and state schemas loaded successfully. `invalid` means at least one persisted file is missing or fails strict validation. The command also reports the number of managed accounts and the required `0600` file mode.

## Verify and operational results

| Result or symptom | Recovery |
| --- | --- |
| `healthy; 0 account(s)` or `No managed Codex accounts` | Run `/quota-router login <label>`. |
| `invalid` | Close peer Pi processes, use `/quota-router path`, preserve a copy of the directory, and inspect JSON syntax/schema. Do not overwrite `accounts.json` unless you are prepared to reauthenticate. |
| Footer ends in `login` | No account has completed login; run `/quota-router login`. |
| Footer contains `?` | Run `/quota-router refresh all`; the weekly clock may genuinely be absent on an untouched account. |
| Footer contains `5h n/a` | The provider reported a duration-tagged weekly limit but no five-hour limit. This is valid; automatic routing uses weekly urgency and skips only the short-window floor. |
| Account says `reauth required` | Run `/quota-router login <label>` and sign in with that Codex identity. A successful duplicate login replaces the saved credentials and label, then clears its authentication block. |
| Browser or clipboard authorization action fails | Use the authorization URL shown in the warning as a manual fallback. |
| `Unexpected Codex authorization URL` | Update normal Pi and retry. The router rejected an OAuth URL that did not match the fixed OpenAI client, callback, state, and PKCE contract, and saved no credentials. |
| `Codex login failed. Please try again.` | Retry the login and check connectivity. Upstream OAuth details are intentionally hidden because they may contain credentials. |
| Footer still shows `none · login` after successful login | Run `/quota-router list` to confirm the account, then `/quota-router status`. Current versions rerender immediately; update the Git package if the stale footer persists. |
| `Ambiguous Codex account label` | Run `/quota-router list` and repeat `use`, `refresh`, or `prime` with the intended managed account id. Duplicate labels are never resolved arbitrarily. |
| `No Codex account is currently eligible...` (`no_eligible_accounts`) | The foreground turn has ended; it is not waiting in the background. Refresh usage, inspect policy/headroom, prime confirmed untouched accounts, or wait for cooldowns and retry. A fresh non-exhausted result clears an estimated quota block, but not an authentication or transient block. A deliberate `/quota-router use <account>` can bypass automatic headroom. |
| `The selected Codex account is currently unavailable` (`manual_account_unavailable`) | The foreground turn has ended. Reauthenticate/clear the account's block, wait for its reservation, or run `/quota-router use auto`, then retry. |
| `not_authorized` from prime | Invoke `/quota-router prime ...` interactively and accept both confirmations. Authorization applies only to that invocation. |
| `not_candidate` from prime | The account is already confirmed, is not untouched, or is inside the one-hour primer retry cooldown. |
| `reserved` from prime | Another foreground/primer request owns the account or another process owns the singleton sweep. Wait for active work to finish; a crashed owner's lease expires within two minutes. |
| `busy` from prime | Foreground agent work is active. Wait until Pi settles. |
| `Codex model ... is unavailable for priming` | Select a registered `openai-codex` model and invoke prime again. The rejected command made no usage/provider request and did not start the retry cooldown. |
| `inconclusive` from prime | No weekly reset appeared after the minimal request. Wait one hour; do not assume the rolling-window behavior. |
| `failed` from prime | The minimal provider request failed, but the router still force-refreshed usage. If that refresh exposed a weekly reset, the account was recorded as confirmed while the provider failure remained visible; otherwise check connectivity/authentication and retry after one hour. |

`/quota-router prime all` is still one-shot: it sends at most one minimal request and stops after the forced quota refresh. It never enables later background priming.

## Typed errors

| Error | Meaning | Recovery |
| --- | --- | --- |
| `InvalidCodexTokenError` | OAuth returned a token without the expected namespaced Codex account claim. | Retry login; if it repeats, update normal Pi because the provider token contract may have changed. |
| `AccountNeedsReauthError` | Credentials were revoked, returned `invalid_grant`, changed identity, or were already invalidated. | Login that account again. It remains excluded until then. |
| `TokenRefreshTransientError` | Refresh had a network/shape failure or could not obtain the refresh lock within five seconds. | Check networking and peer Pi processes, then retry. Do not delete the account. |
| `AccountNotFoundError` | A command referenced a removed/unknown managed id. | Run `/quota-router list` and use the current id or label. |
| `StoreValidationError` | Persisted JSON is malformed or violates its versioned schema. | Back up the router directory, repair the file using the documented schema, or move only non-credential config/state aside for recreation. Runtime state v1 migrates to v2; credentials/config remain v1. |
| `StoreLockTimeoutError` | A JSON state lock remained contended for five seconds. | Wait for peer work; check for a stuck Pi process. Reset reservations only after confirming no peer is active. |
| `ReservationLostError` | An active request's persisted lease disappeared or could not be renewed. | Retry the turn after checking peer processes. Do not reset reservations while any Pi process is active. |
| `StreamSilenceTimeoutError` | The provider produced no events within the active request's silence deadline. | Retry the turn and check provider connectivity if it repeats. Pre-output silence may rotate accounts; post-output silence is never replayed. See the exact deadline behavior in [Routing policy](policy.md#failure-and-recovery-policy). |
| `CodexUsageParseError` | The usage endpoint returned an unsupported body, duplicate semantic window, or explicit duration other than five hours/seven days. | Update Pi Quota Router; preserve a redacted response shape and duration fields if filing an issue. Never post headers/tokens. |
| `CodexUsageHttpError` | Usage returned HTTP failure, timed out, or did not complete. | Check connectivity/authentication, run `refresh all`, and retry. Last-good data can be used conservatively for up to 24 hours. |
| `RouteUnavailableError` | Fresh selection found no eligible automatic account or the manual account was unavailable. The stream closes immediately with one of the actionable messages above. | Resolve quota, usage-data, health, block, or reservation state and start a new turn. |
| `CommandParseError` | Unknown command, too many args, invalid reset/log option, or unsafe selector. | Use the command table in the README and quote labels containing spaces. |

## Stream behavior

A quota/auth failure before text, thinking, or tool-call output may rotate transparently up to five attempts. A lone transport `start` is not visible output. If no eligible account remains, the stream returns an error immediately instead of holding the turn open. Once any visible/model-action output begins, the router forwards the error and never replays; retry the turn manually after resolving the account.

Ctrl-C/Escape aborts active usage and provider work. Active reservations renew only while a request remains active and release on completion, error, cancellation, or a silence timeout. If a process is killed ungracefully, renewal stops and its reservations expire within two minutes.

## Installation problems

Follow the public HTTPS Git install instructions in the [README](../README.md#install-from-github). `pi list` should show the Git source. If model listing fails, run:

```bash
pi --list-models openai-codex
```

All normal Codex model ids should appear. The [CI release gate](../.github/workflows/ci.yml)
verifies both local and credential-free public HTTPS Git installation in isolated Pi profiles.

## Safe resets

- `reset cooldowns` removes error blocks; use it only after the underlying quota/auth condition changed.
- `reset reservations` removes leases; ensure no other Pi process is using the profile.
- `reset priming` forgets observed primer results and retry clocks. One-shot command confirmations are ephemeral and are never stored.
- `reset all` combines those non-credential resets. It never removes `accounts.json`.

Diagnostic events are redacted and bounded, but still avoid sharing the log without review. Toggle them for the current Pi session with `/quota-router log off` and find them with `/quota-router path`.
