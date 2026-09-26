# ADR-0112 — decision recorded under "Stream-buffer accounting"

- Contract owner: [transports/byte-accounting.md](../transports/byte-accounting.md#stream-buffer-accounting)

## Decision record

- 목적과 의도: Keep buffered Chat collector retention equal to the UTF-8 size of its completed strings when a surrogate pair is split across streamed deltas.
- 기존 구현 및 제약 조건: Incremental accounting avoids re-encoding the growing prefix, but it subtracted a fixed two bytes when joining a pair. Bun versions differ in how `Buffer.byteLength` prices each isolated surrogate, so the constant was correct on one runtime and undercounted on another.
- 검토한 주요 대안: Re-encode every accumulated string; standardize on one Bun-specific constant; reject split pairs; or compute the local difference between separate and joined measurements.
- 선택한 방식: Add the runtime-measured joined size and subtract the runtime-measured size of the two isolated code units while retaining the existing prefix byte count.
- 다른 대안 대신 이 방식을 선택한 이유: The differential is constant work, preserves exact full-string semantics, and carries no runtime-version table. Prefix re-encoding would make fragmented streams quadratic.
- 장점, 단점 및 영향: Content, reasoning, and refusal budgets neither undercount nor overcount split Unicode across supported Bun versions. Each boundary performs three tiny byte-length measurements only when it actually joins a surrogate pair.
