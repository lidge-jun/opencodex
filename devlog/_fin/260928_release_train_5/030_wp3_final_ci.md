# 030 — wp3: final cross-platform CI

Plan: run workflow_dispatch lane=all once on the final dev head; classify every failure as a train regression (fix via PR, then rerun) or a timing flake (rerun failed jobs once); done when one run on the final head concludes success.
