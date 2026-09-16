# Roadmap review disposition

Inherited design verification accepted the narrow sidecar reuse, bounded transport and call-lifetime decisions. Reflection found an ambiguous Location contract; 020 now requires a proxy-relative join path for external callers and independently trusted upstream destinations. Follow-up reflection: ALIGNED.

Independent A round 1 returned FAIL on three concrete contract omissions. All accepted: 010 now specifies explicit-key resolution before loopback shortcut and stored-main Direct materialization under a lease; 020 specifies tagged key/native ownership on both listeners; HTTP-only AUTH_MATRIX gets protocol-correct multipart fixtures in api-key-attribution.test.ts, while WebSocket auth is separately advertised and tested with upgrades.

Baseline command: bun test tests/server/server-live.test.ts tests/server/api-access-endpoints.test.ts. Result: 46 pass, 0 fail, 351 assertions at ec065aa0c6fb46b376a2f01873bd677327b99150 before production changes. This is baseline evidence, not feature verification.
