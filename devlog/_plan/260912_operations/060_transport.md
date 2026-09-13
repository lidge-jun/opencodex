# Local management catalog read

Class C4; dependency roadmap. Scope #4315 and the current CHANGES_REQUESTED review on #4317. Public source starting points: src/cli/opencode.ts fetchOpencodeProxyModels/cmdOpencode, src/lib/admin-secrets.ts, src/lib/local-destinations.ts, associated providers/opencode-cli tests. Reuse existing transport owner after caller search; avoid an opencode-only ad hoc credential client.

The executable security design and negative-case audit live only in ignored .tmp/operations/060_transport_private.md. That file must be completed and independently reviewed before B; no pre-disclosure reasoning is copied into public planning history. Public deliverable is the implementation, regression tests and shipped contract text only. Required review dimensions: local destination selection, redirect and proxy-environment behavior, credential separation and all current callers. Original contributor credit: Cortes Ventures <admin@cortesventures.com>. No fallback that substitutes a data credential for admin authentication.

Hosted regression execution plus independent security source audit bind the final patch SHA. Review state is refreshed before handoff; this work cannot approve or merge the original PR. Local suites/build/typecheck/install NOT RUN.
