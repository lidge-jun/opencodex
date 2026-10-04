# Decision recorded under "Dashboard serving"

[Decision Log]
- Purpose and intent: keep management-only ingress ports out of generated inference clients (#6598).
- Prior implementation and constraints: routes used the request URL port as the public data-plane port; a hub dashboard on 10101 consequently exported 10101/v1 even though that listener rejects inference. Config alone can be stale or contain an ephemeral port.
- Alternatives considered: substitute config.port at each site; read runtime-port.json on every request; rewrite the request URL; pass the lifecycle-owned public port.
- Selected approach: supply liveListenPort from the shared server composition and resolve it in managementInferencePort, with config.port only for direct-dispatch fixtures.
- Why: lifecycle already knows the actual public bind and CLI override. This keeps request identity/authentication intact, avoids additional private-state I/O, and gives every affected route one rule.
- Consequences: standalone and hub management requests select the same inference endpoint. Explicit companion ports retain precedence through the existing inference resolver. Direct-dispatch tests requiring a bound override must inject it. Required independent boundary review remains separate from correctness fixtures.
