# Campaign integration fixture repairs

Hosted CI exposed incomplete Cline registration follow-through and restore fixtures that no longer exercise the documented atomic refusal contract. This change repairs those contracts without changing credential or restore behavior.

- Trigger/evidence: Cross-platform CI run 34676570087, head 954b1da7804110e440acc9d244e70f32f2aa9aae. Linux, macOS and dashboard gate failures are retained as the failing baseline evidence; no local reproduction is claimed.
- Cline: correct the lightweight CLI count to fifteen, preserve exact registry equality, recognize only the Cline product-name keys as intentional English, document reuse of its existing mark, and align client/writer test seeds with their committed domain.
- Restore: assert unsuccessful all-skipped results and unchanged artifacts after refusal; retain exact pre-operation config/profile/journal snapshots when damaged defaults prevent restoration. Canonicalize temporary homes and target the production profile path so macOS fault injection and manifest lookup actually reach the intended boundary. Assert a matching injected read and default manifest visibility.
- Non-goals: no runtime restore/auth changes, test skips, weaker error/preservation assertions, new dependencies, local tests/build/typecheck/install, release or deployment.
- Verification: git diff --check for text; independent source review of Cline and restore slices; final-head hosted CI must execute the unchanged failure paths and pass before completion. Local product execution remains NOT RUN.
- Stop: the original named failures pass at the published final head and no new blocking finding remains. An unrelated CI failure is investigated separately, not waived here.

The shared baseline also includes the independently reviewed Combo reactivation correction from #4385. It explicitly runs the actual activation callback and preserves the cached quota evidence, dirty draft and Save-state assertions. This known scheduling defect must not remain in the baseline supplied to other campaign PRs. The #4385 source commit is preserved by merge; close that duplicate delivery only after this combined baseline lands.
