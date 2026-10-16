/** Exact usage-stream refresh registry. No timers, sockets or core-path imports. */
export class UsageRefreshRegistry {
  private entries = new Set<{ binding: string | null; tainted: boolean; close: () => Promise<void> }>();
  register(method: string, pathname: string, close: () => Promise<void>) {
    if (method !== 'GET' || pathname !== '/backend-api/wham/usage/stream') return null;
    const entry = { binding: null as string | null, tainted: false, close };
    this.entries.add(entry);
    return {
      // Caller must invoke only after validating a complete upstream snapshot's identity.
      // A connection that changes account identity never becomes a refresh target again.
      bind: (verifiedBinding: string) => {
        if (!verifiedBinding || entry.tainted || !this.entries.has(entry)) return false;
        if (entry.binding !== null && entry.binding !== verifiedBinding) {
          entry.tainted = true; entry.binding = null; return false;
        }
        entry.binding = verifiedBinding; return true;
      },
      exclude: () => { entry.tainted = true; entry.binding = null; },
      release: () => { this.entries.delete(entry); },
    };
  }
  async refresh(binding: string) {
    if (!binding) throw new Error('Verified account binding is required');
    const selected = [...this.entries].filter(e => !e.tainted && e.binding === binding);
    // Detach before awaiting; concurrent refreshes cannot close the same stream twice.
    for (const entry of selected) this.entries.delete(entry);
    const results = await Promise.allSettled(selected.map(entry => Promise.resolve().then(entry.close)));
    return { requested: selected.length, closed: results.filter(r => r.status === 'fulfilled').length,
      failed: results.filter(r => r.status === 'rejected').length };
  }
  get size() { return this.entries.size; }
  get boundSize() { return [...this.entries].filter(entry => !entry.tainted && entry.binding !== null).length; }
}
