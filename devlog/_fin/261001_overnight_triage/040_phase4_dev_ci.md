# Phase 4 (wp5): duplicates and final dev CI

1. Close clear duplicates found during wp2-wp4 (none known at P besides the already-closed #6337).
2. Dispatch Cross-platform CI once on the final `dev` tip. A failure is diagnosed, fixed forward in a
   PR, and the run is dispatched again on the new tip. Green is required before wp6.
