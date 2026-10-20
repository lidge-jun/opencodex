# ADR-7260 — decision recorded under "Standalone bare-call recovery"

- Contract owner: [providers/mimo-bare-calls.md](../providers/mimo-bare-calls.md#standalone-bare-call-recovery)
- Intent: Carry shirruy's standalone MiMo bare-block recovery without replacing #7293's identified-wrapper reconciliation.
- Prior constraint: ADR-5724 requires a matching structured call before removing echoed markup. Identified wrappers keep that requirement.
- Choice: With no structured call, eligible MiMo IDs can synthesize declared freeform calls from complete bare blocks. Markdown-aware scanning, nested-header rejection and parameter checks guard eligibility. Only the accepted bare ranges are removed; structured-call duplication and ambiguity rules do not authorize that removal.
- Retention: Before bounded streaming release, save only detached, budgeted candidate inputs. Terminal recovery consumes them once, unless a structured call appeared. Limits disable an oversized synthetic batch; errors and cancellation never dispatch it. Already delivered markup remains visible.
- Alternatives excluded: Unconditional no-tools stripping, error-path suppression, ordinary-function raw argument repair, alternate closers and speculative `<const …>` unwrapping are unrelated to standalone recovery.
- Consequences: Buffered and streamed calls share eligibility; mid-line bare recovery uses the existing Markdown scanner. Literal examples remain byte-exact, and identified wrappers alone never become synthetic calls.
