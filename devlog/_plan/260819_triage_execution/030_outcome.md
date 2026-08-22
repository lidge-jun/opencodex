# 030 — Campaign outcome (260819 triage execution)

## Merged (12 PRs, all --squash --admin after sol-medium review lanes)

| PR | SHA | scope |
|---|---|---|
| #2055 | 2648ffa87 | detail.code workspace denial classification (partial #2046) |
| #2061 | 82b882903 | provider sub-table strip crash fix (scratch 84/0+tsc) |
| #2066 | 963699845 | Claude-on-Antigravity continue nudge (closes #2065) |
| #2045 | 0161a66d9 | NO_PROXY fake-IP boundary (follow-up note posted) |
| #2042 | c472ad0f3 | structured-output opt-out exact-ID |
| #2059 | bd3aa3192 | Lab gate reporting = adapter matching (follow-up note) |
| #2044 | bca251c16 | Cursor text-part tool results (blocker disproved) |
| #1903 | fd85c8238 | Cursor HTTP/1.1 transport (Ingwannu-approved head) |
| #2057 | abaa75a60 | OpenCode Go quota probe docs |
| #2076 | 59964ad77 | OUR #2073 fix: env_key injector contract |
| #2078 | 11e03eb44 | OUR #1926 fix: tsig credential scope + barrier (C4 sec review) |
| #2079 | 1ad131acb | OUR #1942/#1849 fix: transactional update (adversarial review) |

## Downgraded to needs-work (BLOCK verdicts honored, evidence comments)

- #2056 (fail-open shortPercent routing, 5335838673), #2053 (missing reauth
  regression test, 5335919807), #2075 (modelInList vs #2042 + FastWire parity,
  5335950781), #2072 (assumed-tier billing, 5335998291), #2068 (quota->catalog
  peer fail-open, 5335998403).

## Closed

- PRs: #1498 (stale/dont-merge); #1885 already closed upstream of us.
- Issues: #2065 #2073 #1926 #1942 #1849 (by merges), #2064 (fixed-on-dev RCA,
  020 doc), #2046 partial-status comment (thread-switch half open).

## Gates

- Push CI: intermediate merge runs cancelled by supersession (concurrency);
  full success 59964ad77 mid-train; decisive run on final head 1ad131acb
  (32204396229). Windows dispatch leg remains known-red pre-campaign (not a
  gate).
- lidge: tsc + isolate suite + privacy on 1ad131acb in ~/.wp9-final
  (/tmp/wp9-{tsc,suite,privacy}.log).

