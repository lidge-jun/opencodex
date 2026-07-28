# 011 — WP8 verification evidence

## Local verification

Commands:

```bash
bun test tests/memory-watchdog.test.ts tests/doctor.test.ts
cd gui && bun test tests/memory-observability-card.test.tsx
bun x tsc --noEmit
cd gui && bun run lint
cd gui && bun run build
bun run privacy:scan
git diff --check
```

Results:

- `bun test tests/memory-watchdog.test.ts tests/doctor.test.ts`
  - 36 pass, 0 fail, 143 assertions.
- `cd gui && bun test tests/memory-observability-card.test.tsx`
  - 3 pass, 0 fail, 12 assertions.
- `bun x tsc --noEmit`
  - exit 0.
- `cd gui && bun run lint`
  - exit 0.
- `cd gui && bun run build`
  - exit 0; Vite emitted the existing large chunk warning only.
- `bun run privacy:scan`
  - Privacy scan passed.
- `git diff --check`
  - exit 0.

## C-gate review

Independent reviewer verdict: `PASS`.

Review confirmed:

- `/api/system/memory` exposes `external`, `arrayBuffers`, `observedBytes`, and
  `observedMetric`.
- Observed memory is `max(rss, external, arrayBuffers)`, not a sum.
- Watchdog warning uses observed memory and names the triggering metric.
- `ocx doctor` no longer treats low RSS as normal when external/ArrayBuffers are
  high.
- Dashboard Memory observability uses observed drift and renders
  observed/external/ArrayBuffers while keeping older-proxy compatibility.
- Docs and SOT use the observed-memory contract.
