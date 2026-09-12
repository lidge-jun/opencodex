# ADR-0050 — decision recorded under "Heartbeat and stall deadline"

- Contract owner: [transports/streaming-health.md](../transports/streaming-health.md#heartbeat-and-stall-deadline)

## Decision record

- 목적과 의도: Prevent Kiro progress from becoming a false final answer, reject invalid empty completion retries, and stop concurrent transient 429s from consuming independent retry budgets.
- 기존 구현 및 제약 조건: Kiro text has no trustworthy phase; stop metadata arrives only at stream end; the private completion tool is adapter-owned; normal parallel tool traffic must remain parallel; client cancellation must interrupt all waits.
- 검토한 주요 대안: Trust native `END_TURN`; infer completion from wording; serialize every Kiro request; leave throttling entirely to the client; manufacture empty assistant turns to preserve alternation.
- 선택한 방식: Require the private completion tool on tool-enabled turns, rebuild only valid replayable wire turns, validate the final conversation, and activate a shared cooldown plus single probe only after a transient throttle.
- 다른 대안 대신 이 방식을 선택한 이유: Native stop metadata has mislabeled progress, wording is language-dependent, global serialization harms healthy concurrency, client-only retries amplify bursts, and empty structural turns are rejected upstream.
- 장점, 단점 및 영향: Completion phase is deterministic and throttled concurrency recovers without a request storm; some clean Kiro stops pay one bounded validation call and an exactly repeated completion answer may be shown twice to preserve `final_answer` semantics.
