# Native Responses first exec output

The shell succeeds, but a bare awaited helper call is not an output operation in the code-mode host. Three observed first-round scripts discarded their returned values; each host result contained only an empty completion wrapper. The retry emitted the result with `text(...)` and was usable. Request-level HTTP 200 and one upstream send do not prove that tool code emitted output.

Competing explanations: shell failure was contradicted by populated nested execution records; proxy truncation was contradicted by already-empty original host results; missing explicit emission matched the failing scripts and the successful retry.

The translated adapters already share a first-call echo instruction and empty-result explanation. Native Responses custom-tool lowering instead advertised a bare `await tools.exec_command(...)` example and omitted the shared first-call guidance. Restore that guidance and the paired empty-result explanation on the native routed path. Keep valid JavaScript unchanged: the proxy cannot safely infer arbitrary program intent or reconstruct a result the host never emitted.

Regression evidence must include outbound guidance on the first native call, an executable echo example that emits exactly once, untouched populated/multimodal results and native OpenAI traffic, and a synthetic live Grok first-result roundtrip. Never commit the private task payload or user command output.
