# 060 — wp5: issue drawdown and consolidation

45 open issues. Classification mirrors the PR phase, with one addition: an issue
can be superseded by a *shipped feature* rather than by a specific PR, so the
evidence is a released capability plus the commit that introduced it.

## Consolidation

PARTIAL issues are the reason this phase exists. Where several issues describe
facets of one surviving need — account-pool routing, quota-window handling,
provider catalog capability gaps — they are closed individually and absorbed
into one consolidated issue per cluster. Each consolidated issue must:

- state the remaining scope in its own words, not by reference only;
- link every absorbed issue by number;
- name every original reporter so credit follows the scope;
- use the repository issue template.

A consolidated issue that merely lists links is not acceptable — the point is
that the surviving requirement stays legible after the sources are closed.

## Exit criteria

Every open issue has a verdict; consolidated issues exist for each PARTIAL
cluster; no issue is closed without its reporter being named.
