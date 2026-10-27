export class Clock {
  now = 0;
  next = 1;
  jobs = new Map<number, { due: number; fn(): void }>();
  later = (fn: () => void, delay: number) => { const id = this.next++; this.jobs.set(id, { due: this.now + delay, fn }); return id; };
  clear = (id: unknown) => { this.jobs.delete(Number(id)); };
  async flush() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
  async advance(to: number) {
    for (let n = 0; n < 10000; n++) {
      await this.flush();
      const job = [...this.jobs].filter(([, v]) => v.due <= to).sort((a, b) => a[1].due - b[1].due)[0];
      if (!job) { this.now = to; await this.flush(); return; }
      this.now = job[1].due; this.jobs.delete(job[0]); job[1].fn();
    }
    throw new Error("offline-timer-loop");
  }
}
