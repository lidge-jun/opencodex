# Recovery wording alignment

C1 documentation follow-up to public PR3754 threads PRRT_kwDOS-0Gi86fqklW and PRRT_kwDOS-0Gi86fqklX. Parent3762 at63282e49c; runtime3754 at8de126998 passedCI34025899357. No runtime behavior changes.

Modify guides/sub-agent-surface.md and fr/zh-cn/zh-tw reference/configuration/agents.md only: native absence/exhaustion may activate explicitly enabled recovery toward an eligible routed target; unreadable ciphertext is not sent if recovery cannot provide a usable task. Clarify pre-dispatch unreadable400 versus preservation of a concrete failed native attempt; cancellation499 remains as implemented. Existing recovery auth, quota and no-persistence boundaries stay intact.

Verifier: source-bound semantic comparison with existing helpers/fixtures, exact-head docsCI submission and outcome; no local test, typecheck or docsbuild under user limits. No external new permission, dependency or release rule changes. Close the public wording finding after published corrected pages; late runtime-status suggestion is rebutted with preserved native-failure contract and passing stored-Pool regression.
