# 050 outcome — wp5 (#3008): what the implementation added beyond this plan

The plan described one defect: `ocx update` aborting because `ocx stop` could not tell a
history-only failure from a real stop failure. That fix is in the first commit of the
branch. The other twenty-five came from adversarial review, and they are not incidental —
each one is the same defect wearing different clothes: **a teardown that reports success
while half of it did not happen.**

## The shape that kept recurring

Something cannot be determined, and the code treats "could not determine" as "determined
to be fine". Every instance authorized taking shared client config down while a proxy
might still be serving, which leaves Codex or Grok pointed at a process that is gone.

| Where | What was read as proof | Round |
| --- | --- | --- |
| `POST /api/stop` | `stopServiceIfInstalled` false — collapsed "not installed" with "refused to stop" | 17 |
| `POST /api/stop` | Success decided from the native restore alone, Grok failure appended as text | 17 |
| `ocx service stop` / `uninstall` | Restore and strip failures logged, exit code still 0 | 17 |
| Route pre-check | Scheduler stopped first, refused second — mutate-then-refuse | 18 |
| Daemon exit | Drain success alone, ignoring the teardown result | 18 |
| Respawn predicate | `status === "present"`, so an unreadable probe passed as absent | 19 |
| `ocx restore` | Early return on the Codex no-op path, never reaching the Grok strip | 15 |
| `ocx restore --json` | Same, on the ordinary forward path | 16 |
| Receipt scan | Every `readdir` error read as "no obligations" | 16 |
| `ocx uninstall` | `stopServiceIfInstalled` false read as "not installed" | 22 |
| `ocx uninstall` | Missing pid file read as "no proxy serving" | 23 |
| `ocx uninstall` | `uninstallServiceIfInstalled` false — absence and removal failure | 24 |
| `ocx uninstall` | Registration removed, running wrapper assumed dead | 24 |
| `ocx uninstall` | `findLiveProxy` null read as proof of absence | 24 |
| `ocx uninstall` | One endpoint probed while two were candidates | 25 |
| `ocx uninstall` | `proxyStillLiveAfterStop` null read as a verified window | 25 |

## The deferral, and why it needed four attempts

`ocx stop` has to defer shared teardown to itself, because the proxy exits before anyone
can verify a Task Scheduler wrapper did not respawn it. Expressing that obligation took
four tries:

1. A query flag. Any authenticated caller could set it and exit, and a parent that died
   mid-stop left nothing on disk saying a restore was owed.
2. A receipt file. Presence is not ownership — another caller could ride on it.
3. A nonce inside one shared file. Read-compare-unlink is three syscalls, so a concurrent
   stop replacing the file between the compare and the unlink got its obligation deleted.
4. **The nonce as the filename.** `unlink` names one specific obligation and cannot reach
   another. Two concurrent stops hold two receipts, which is the truth of the situation.

The receipt also carries the endpoint being stopped and how it was obtained. A configured
address is recorded as `guessed` and never authorizes automatic recovery: a proxy on an
explicit `--port` can be respawned there while the configured port refuses.

## Tests that passed for the wrong reason

Five times a regression was written as a source-text assertion, and five times reverting
the defect left it green. The reviewer caught each one. Where a rule mattered it was
extracted into something callable — `performStopTeardown`, `classifyWindowsServiceStop`,
`sharedTeardownAuthorized`, `endpointsToProve`, `everyEndpointProvenDown` — and the test
now executes the permutations. Source assertions remain only for wiring: that a route
delegates to the extracted rule rather than growing a second copy.

Every fix on this branch was driven RED against the specific defect and restored.

## Docs

Sixteen files across eight locales carry the new refusal contract: `respawnable_service`
and `service_state_unknown`, and the fact that the dashboard Stop button refuses on the
Windows Task Scheduler backend rather than half-performing a stop it cannot verify.

