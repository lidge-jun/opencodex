# 039 — wp3 done (PR C #6807)

**Conclusion.** The package launcher no longer hard-fails when the bundled Bun is missing and a valid Bun is on PATH;
lifecycle commands warn once on CLI/proxy version skew. PR #6807 (head 73f166f08a, from dev fd2032050a).

**Evidence.** 318 focused tests pass (receipt); real Node reproduction of the report succeeds on PATH Bun 1.4.0; review
PASS first round.

**Did not improve / risks.** Node 18 and native Windows are left to CI. The PATH check is policy, not authentication.
The npm/pnpm/mise update path (handled in Node before Bun) has no skew notice. The plan unit is duplicated in #6802 and
#6807 with identical content (merges cleanly in either order).

**Next.** wp5 command guards on `codex/desktop-sidecar-command-guards` (stacked on #6802), then wp4 closeout.
