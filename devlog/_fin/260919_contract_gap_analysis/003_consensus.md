# Unanimous publication review

Seven independent source-analysis lanes informed the candidate set. Three fresh-context reviewers then audited every proposed issue and both existing-issue comments. The coordinating reviewer also inspected the critical source spans and duplicate records. Publication requires all four judgments to agree; majority approval is insufficient.

## Review lenses

- Code correctness: source reachability, exact owners, conditional behavior and focused verification paths.
- Product and scope: usefulness for a local coding proxy, overlap with existing issues/PRs and authority preservation.
- Adversarial publication: evidence strength, misleading claims, public-content constraints and fresh-reader comprehension.
- Coordinator: accept/rebut decisions, exact source snapshot, synchronization of approved drafts and published bodies.

## Amendments before approval

- T3 preserves explicit Accept-Encoding preferences and checks the actual response coding; it does not reject a preference list just because one alternative is unsupported.
- S1 preserves safe progressive input and explicitly acknowledges duplicate-key/late-invalid-wrapper limits instead of claiming a universal equality guarantee.
- D1 identifies all four contradictory English reference pages, requires the locale scan, narrows SOCKS selection wording, and coordinates with open #3901.
- R1 lists the complete source paths and five exact existing test files; first-send accounting must not be duplicated.
- R2 requires every process that initializes/appends/compacts the shared journal to participate, including observe-only writers and enforcement transitions.
- R3 explicitly rejects all scope mismatches, including apparently full input, and requires retry-without-ID coverage. Its fixture description now matches continuation storage rather than transport configuration.
- Candidate bodies were split into individual files and staged for review. The plan artifact map and all links were corrected.
- Public prose was narrowed to relevant source facts and implementation decisions, with no review-model attribution or unrelated project comparisons.

## Decision matrix

| Candidate | Code | Product | Adversarial | Coordinator |
| --- | --- | --- | --- | --- |
| T1 | APPROVE | APPROVE | APPROVE | APPROVE |
| T2 | APPROVE | APPROVE | APPROVE | APPROVE |
| T3 | APPROVE | APPROVE | APPROVE | APPROVE |
| S1 | APPROVE | APPROVE | APPROVE | APPROVE |
| G1 | APPROVE | APPROVE | APPROVE | APPROVE |
| P1 | APPROVE | APPROVE | APPROVE | APPROVE |
| P2 | APPROVE | APPROVE | APPROVE | APPROVE |
| V1 | APPROVE | APPROVE | APPROVE | APPROVE |
| O1 | APPROVE | APPROVE | APPROVE | APPROVE |
| O2 | APPROVE | APPROVE | APPROVE | APPROVE |
| D1 | APPROVE | APPROVE | APPROVE | APPROVE |
| D2 | APPROVE | APPROVE | APPROVE | APPROVE |
| D3 | APPROVE | APPROVE | APPROVE | APPROVE |
| R1 | APPROVE | APPROVE | APPROVE | APPROVE |
| R2 | APPROVE | APPROVE | APPROVE | APPROVE |
| R3 | APPROVE | APPROVE | APPROVE | APPROVE |
| Existing #2358 comment | APPROVE | APPROVE | APPROVE | APPROVE |
| Existing #5049 comment | APPROVE | APPROVE | APPROVE | APPROVE |

The reviewers checked the fixed source `7864869c31c41cca9830d93540238f17df8faafb`, staged candidate bodies, exact template sections, source anchors and relevant current issue/PR bodies. Every candidate remains labeled as source analysis with proposed runtime reproduction, not an executed test. The fresh-reader check found the product gap, authority, implementation boundary and negative cases understandable after the amendments above.
