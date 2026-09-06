# Tool-call alias cycle P refresh

Historical refresh: its non-numeric-index policy is superseded by the explicit null/missing boundary in 022_index_type_repair.md.

Current parent: 22da7a4bc80040f66b819239c5028e578f9a1ede, after TOML delivery. Original source c8240c51d664f7cfb790b6d60679adfe0490b5c9 remains open and authored by Hako. Relevant baseline comparison is retained in scratch; implementation uses the current tree and preserves adjacent changes.

Apply the original commit, then the independently reviewed 020 numeric-index amendment. Missing/non-numeric placeholders keep existing tolerance; negative/fractional numeric indexes terminate before matching. Preserve the immutable reservation key and first observed valid index alias. Add direct malformed-index activation coverage alongside all original positive/collision/UTF-8 budget cases. Update the transport structure contract as planned.

Main owns cherry-pick/commits/PR/CI/merge. An inherited worker may edit only src/adapters/openai-chat.ts, tests/adapters/openai/openai-chat-parallel-stream.test.ts, and structure/04_transports-and-sidecars.md after A passes. Main owns this document and all other files. Independent reviewer checks resulting code; all tests/typechecks execute remotely or in GitHub Actions. Full-suite readiness remains remote; no local application checks. macmini shared test lock is respected.
