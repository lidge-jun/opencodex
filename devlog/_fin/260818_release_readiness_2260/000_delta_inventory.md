# 000 — Delta inventory since v2.25.0 (main e97fb2621)

Snapshot 2026-08-18. Audited range: origin/main (e97fb2621, v2.25.0) ..
origin/dev. Audit began at tip `b04cd26e7`; the audit itself produced one
more merge (#2010, fixes), making the certified tip `fe3bbad97`.

## Landed since the v2.25.0 cut

| Train | PRs | Area |
|---|---|---|
| Cursor prompt-injection fix | #1997 | assistant-role tool-result replay, hide-from-user prose removed |
| Codex pool plan | #1998 | JWT chatgpt_plan_type re-derivation between WHAM refreshes |
| Windows stack | #1944 #1945 #1946 #1947 #1949 | argv fix, wrapper-killer scoping, shared atomic-replace, retry counters, program unit |
| FastWire | #1893 (A1) #1965 (B1, absorbs B0 #1956) #1904 | capability/policy resolution, per-attempt observability, chat tier forwarding |
| Singles | #2005 #1941 #1928 | string-coercion repair (#1938), Grok Responses backend, codex_work_desktop recovery |
| Docs | #2004 #2006 #2008 | release record, devlog _fin moves, merge-campaign ledger |
| Audit fixes | #2010 | three blocking regressions found by this campaign (see 010) |

Issue closures riding this delta: #1992 #1989 #1938 (+ triage-campaign
closures recorded in the merge-campaign unit).

Held: #1885 (xAI Priority) behind the #1875 B2 pricing gate.

