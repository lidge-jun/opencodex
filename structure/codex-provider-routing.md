# Custom Codex provider routing consent

`src/codex/provider-routing.ts` stores explicit, home-bound provider-ID approvals in
private OpenCodex-home recovery records. Default external-provider preservation remains
unchanged. The approved path manages only the provider table's URL assignment, preserving
provider identity, HTTP/WebSocket settings and history. It uses the shared config write
lock and destination guards; recovery evidence precedes URL publication and retains the
previous and candidate local URL across an interrupted write. Changed foreign URLs refuse
injection and survive restore. Native restore completes its existing preflight before
restoring approved URLs. Foreground signal/exit cleanup delegates to the same native restore, which restores approved URLs and preserves unapproved external configurations. Partial native outcomes remain partial, and recovery failures are reported in the config artifact. Consent survives stop/restore; explicit revocation removes it. Successful URL publication returns a committed configuration-change receipt through injection/sync; validation-only and unchanged URL operations report no change, so explicit config-change restarts retain the same authority.
Approval-record inspection, stale native-journal cleanup and URL publication share one Codex write section, so a cooperating concurrent sync cannot replace the record during its bounded read. The shared lock witnesses the config inode after acquisition, so a preceding writer’s completed publication does not invalidate the next holder. URL injection rechecks the current integration intent under both the Codex write lock and config mutation lock, after the client-write guard. Integration OFF skips URL and recovery-record publication without revoking provider consent. Validation-only inspection does not acquire the config mutation lock or create its persistent coordination metadata.
Only Responses/OpenAI-auth provider tables without separate credentials or headers are
eligible, and only ordinary loopback routing is admitted. Authless, client-compaction and
admission-token targets are refused rather than silently changing authentication policy.

`src/cli/codex-provider.ts` owns the default-No allow prompt, explicit `--yes` acknowledgment, status and revoke commands.

Startup routing observation credits a custom provider as OpenCodex-local only when its
actual loopback URL matches a URL recorded as published for that approved provider.
Consent alone, an unapproved provider, or an independently changed local URL does not
establish ownership. Existing service/shim availability still determines restart safety.
