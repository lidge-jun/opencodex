# ADR-0035 — Responses HTTP/SSE

- Contract owner: [transports/responses.md](../transports/responses.md#responses-httpsse)

## Decision record

- 목적과 의도: Stop wasting a turn when a routed model submits one complete patch envelope as the entire code-mode `exec` body.
- 기존 구현 및 제약 조건: The decision above rejected "wrap a raw `exec` patch body as a helper call" because a text rewrite could reinterpret data as code. Rollout evidence then showed about 55 such bodies across four models, each a guaranteed isolate throw. Measurement added the missing fact: a complete envelope is never valid JavaScript, since `*** Begin Patch` fails to parse at the leading `**`.
- 검토한 주요 대안: Keep failing closed; rewrite decorated delimiters inside `exec` JavaScript; parse `exec` bodies as JavaScript; or retarget only a body that is itself one complete operation-bearing envelope.
- 선택한 방식: Retarget only that complete-envelope shape to the existing apply_patch helper, through one shared resolver used by all four restore paths. Delimiter-repair functions stay unchanged and every other `exec` body, including JavaScript that mentions an envelope, stays byte-identical. Streaming holds a buffer that could still become an envelope so the live preview is never rewound.
- 다른 대안 대신 이 방식을 선택한 이유: This narrows the earlier rejection rather than reversing it. The rejection protected bodies with a competing executable reading; a complete envelope has none, so it is the same one-faithful-reading rule the delimiter repair already follows. Rewriting inside JavaScript remains rejected: there the marker is a delimiter or a string or a comment, and no lexical or parse-based rule separates them safely.
- 장점, 단점 및 영향: A previously wasted turn now performs the edit the model intended. This does convert a hard failure into a real filesystem write, so the predicate stays anchored and operation-bearing; prefixed, suffixed, incomplete, namespaced, and JavaScript bodies still fail closed. The write itself is the same `apply_patch` capability code mode already grants, reached by payload shape instead of tool name.
