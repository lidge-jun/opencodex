---
title: Windows File Permission Timeouts
description: How atomic file writes recover after a temporary icacls stall.
---

On Windows, opencodex uses `icacls` to protect temporary files before writing
configuration, credentials, or cached state. If permission hardening fails, the
write fails and the previous destination stays in place.

A temporary `icacls` timeout does not require a proxy restart to recover. A later
atomic write to the same destination may make one recovery attempt. If that
attempt also times out, further writes to that destination are refused until
five minutes after the recovery attempt started. The next write can then try
hardening again; recovery happens when a write is requested, without a timer.

If an earlier `icacls` process has outlived its caller's timeout belt and has not
yet been reaped, writes to the same destination are refused, including after
the five-minute window. These refusals return promptly and preserve the next
recovery attempt. Healthy overlapping writes can proceed, including while an
earlier write is hardening its temporary file or waiting to rename it.

Every recovery attempt must complete permission hardening before publishing the
file. Permission-denied errors remain failures and do not trigger an automatic
retry. Cleanup of a failed write does not consume the next write's recovery
attempt. Other file destinations have independent timeout tracking.
