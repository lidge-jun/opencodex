import { randomUUID } from "node:crypto";
import { ptr } from "bun:ffi";
import { securityAttributes, wide, WIN64_CHILD_ABI, WindowsChildNative } from "./windows-cli-child-native";

/** One overlapped operation and one retained buffer per pipe. Never PeekNamedPipe. */
export class WindowsChildPipe {
  readonly overlapped = Buffer.alloc(WIN64_CHILD_ABI.overlapped);
  readonly buffer = Buffer.alloc(64 * 1024);
  readonly count = Buffer.alloc(4);
  handle = 0n;
  child = 0n;
  event = 0n;
  pending = false;
  eof = false;
  error = false;
  private connecting = false;
  private disposed = false;
  constructor(readonly native: WindowsChildNative) {}
  open(): void {
    const n = this.native, k = n.k;
    const descriptor = n.privateDescriptor();
    try {
      const sa = securityAttributes(false, descriptor), childSa = securityAttributes(true, descriptor);
      const name = wide(`\\\\.\\pipe\\ocx-child-${randomUUID()}`);
      // Inbound, OVERLAPPED, FIRST_PIPE_INSTANCE; byte stream, REJECT_REMOTE_CLIENTS.
      this.handle = n.keep(k.CreateNamedPipeW!(ptr(name), 0x40080001, 8, 1, 0, this.buffer.length, 0, ptr(sa)));
      this.event = n.keep(k.CreateEventW!(null, 1, 0, null));
      this.overlapped.writeBigUInt64LE(this.event, 24);
      // A known local client connects before ConnectNamedPipe: ERROR_PIPE_CONNECTED is success.
      this.child = n.keep(k.CreateFileW!(ptr(name), 0x40000000, 0, ptr(childSa), 3, 0, 0n));
      if (!k.ConnectNamedPipe!(this.handle, ptr(this.overlapped))) {
        const error = Number(k.GetLastError!());
        if (error === 997) { this.pending = true; this.connecting = true; }
        else if (error !== 535) throw new Error(`windows_child_pipe_connect_${error}`);
      }
    } finally { k.LocalFree!(descriptor); }
  }
  closeChild(): void { if (this.child) { this.native.close(this.child); this.child = 0n; } }
  /** Bounded synchronous work; pending overlapped operations always return immediately. */
  pump(consume: (bytes: Buffer) => void): void {
    if (this.disposed) return;
    if (this.eof) return;
    const k = this.native.k;
    for (let i = 0; i < 4 && !this.eof; i++) {
      let done: number;
      if (this.pending) {
        if (!k.GetOverlappedResult!(this.handle, ptr(this.overlapped), ptr(this.count), 0)) {
          const error = Number(k.GetLastError!());
          if (error === 996) return; // ERROR_IO_INCOMPLETE: retain buffers and operation.
          if (this.overlapped.readBigUInt64LE(0) === 0x103n) { this.error = true; return; }
          this.pending = false; this.finish(error); return;
        }
        this.pending = false;
        if (this.connecting) { this.connecting = false; continue; }
        done = this.count.readUInt32LE();
      } else {
        this.overlapped.fill(0); this.overlapped.writeBigUInt64LE(this.event, 24);
        if (!k.ResetEvent!(this.event)) { this.finish(-1); return; }
        if (!k.ReadFile!(this.handle, ptr(this.buffer), this.buffer.length, ptr(this.count), ptr(this.overlapped))) {
          const error = Number(k.GetLastError!());
          if (error === 997) { this.pending = true; return; }
          this.finish(error); return;
        }
        done = this.count.readUInt32LE();
      }
      if (!done) { this.eof = true; return; }
      consume(this.buffer.subarray(0, done));
    }
  }
  private finish(error: number): void { this.eof = true; this.error = error !== 109; }
  /** Cancel is only a request. Keep the OVERLAPPED, event and bytes until settlement. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.closeChild();
    if (this.pending) {
      this.native.k.CancelIoEx!(this.handle, ptr(this.overlapped));
      while (this.pending) {
        if (this.native.k.GetOverlappedResult!(this.handle, ptr(this.overlapped), ptr(this.count), 0)
          || (Number(this.native.k.GetLastError!()) !== 996 && this.overlapped.readBigUInt64LE(0) !== 0x103n)) this.pending = false;
        else await Bun.sleep(5);
      }
    }
    if (this.handle) this.native.close(this.handle);
    if (this.event) this.native.close(this.event);
    this.disposed = true;
  }
}
