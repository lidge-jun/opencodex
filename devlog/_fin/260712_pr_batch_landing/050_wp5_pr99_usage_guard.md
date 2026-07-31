# WP5 — Land #99 with Usage.tsx cancellation guard restored

Base: fork branch `codex/gui-lint-remediation` (tip `e8794d22`). Reviewer blockers: stale
response can overwrite newer state after the refactor dropped the `cancelled` guard.

ALSO at this WP (audit blocker 2): `git merge origin/main` into the branch and resolve the
known `gui/src/pages/Debug.tsx` conflict ONCE — combine #99's lint refactor with #103's
injection-stream wiring (keep both: injection stream entries + lint-clean patterns). This
resolution reaches main with #99's merge; #100–#102 then merge cleanly (verified 3-way logic:
their own commits don't touch Debug.tsx).

## Fix — AbortController (MODIFY `gui/src/pages/Usage.tsx`)

Current (branch, ~:196):

```tsx
const fetchUsage = useCallback(async (nextRange: Range) => {
  setLoading(true);
  try {
    const res = await fetch(`${apiBase}/api/usage?range=${nextRange}`);
    if (!res.ok) throw new Error("fetch failed");
    setData(await res.json() as UsageResponse);
  } catch {
    setData(null);
  } finally {
    setLoading(false);
  }
}, [apiBase]);

useEffect(() => {
  const timeout = window.setTimeout(() => { void fetchUsage(range); }, 0);
  return () => window.clearTimeout(timeout);
}, [fetchUsage, range]);
```

Replace with:

```tsx
const fetchUsage = useCallback(async (nextRange: Range, signal: AbortSignal) => {
  setLoading(true);
  try {
    const res = await fetch(`${apiBase}/api/usage?range=${nextRange}`, { signal });
    if (!res.ok) throw new Error("fetch failed");
    const json = await res.json() as UsageResponse;
    if (signal.aborted) return;
    setData(json);
  } catch {
    if (signal.aborted) return; // stale request: a newer effect owns state now
    setData(null);
  } finally {
    if (!signal.aborted) setLoading(false);
  }
}, [apiBase]);

useEffect(() => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => { void fetchUsage(range, controller.signal); }, 0);
  return () => { window.clearTimeout(timeout); controller.abort(); };
}, [fetchUsage, range]);
```

Covers: range/apiBase change mid-flight AND unmount (abort → no setState).

## Verification

- `cd gui && bun run lint && bun run build` (repo's GUI gates; #99 is the lint PR, lint must stay clean).
- No existing GUI unit-test harness expected — verify at build/lint level + reviewer-cited
  behavior reasoning; if a gui test runner exists (check gui/package.json at B), add a
  hook-level test; otherwise record C evidence as lint+build plus manual reasoning
  (activation = abort path exercised by unmount in dev-mode double-effect, noted in commit msg).
- Reviewer's Low finding (hash-sync via effect) — accepted as-is (observable but harmless),
  recorded in 000 §Rebutted-adjacent; no change.

## Steps

1. Branch from fork tip; `git merge origin/main`; resolve Debug.tsx (see above); apply Usage.tsx
   fix; `cd gui && bun run lint && bun run build`; full `bun test`.
2. Push, checks green, `gh pr ready 99`, `gh pr merge 99 --merge`.

## Accept criteria

- c6: guard present on main (file:line) + gui lint/build output clean; #99 MERGED.
