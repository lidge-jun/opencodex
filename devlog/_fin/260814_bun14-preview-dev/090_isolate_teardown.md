# 090 — Prove Bun 1.4 isolate teardown without legacy job splits

## Files

### MODIFY: .github/workflows/ci.yml
Add a consolidated test job that runs storage policy + API usage families
in normal shard mode alongside the existing split/fresh-process jobs.
Both forms run; consolidated passing proves 1.4 teardown is clean.

