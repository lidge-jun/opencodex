type Rewrite = (text: string) => Promise<string | null>;

async function rewriteRecord(bytes: Buffer, first: boolean, rewrite: Rewrite): Promise<Buffer> {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return Buffer.from(bytes); }
  const lines = [...text.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].filter(m => m[0].length > 0);
  const data: string[] = [], indexes = new Set<number>(); let event = '';
  lines.forEach((line, i) => {
    const content = first && i === 0 ? line[1]!.replace(/^\uFEFF/, '') : line[1]!;
    if (content.startsWith(':')) return;
    const colon = content.indexOf(':');
    const key = colon < 0 ? content : content.slice(0, colon);
    const value = colon < 0 ? '' : content.slice(colon + 1).replace(/^ /, '');
    if (key === 'event') event = value;
    if (key === 'data') { data.push(value); indexes.add(i); }
  });
  if (event !== 'usage.snapshot' || !data.length) return Buffer.from(bytes);
  const changed = await rewrite(data.join('\n'));
  if (changed === null) return Buffer.from(bytes);
  let written = false;
  return Buffer.from(lines.map((line, i) => {
    if (!indexes.has(i)) return line[0];
    if (written) return '';
    written = true;
    const bom = first && i === 0 && line[1]!.startsWith('\uFEFF') ? '\uFEFF' : '';
    return `${bom}data: ${changed}${line[2]}`;
  }).join(''));
}

/** Byte-bounded SSE framing; never fabricates events or changes stream sequence numbers. */
export function controlledUsageSse(rewrite: Rewrite, cap = 262144): TransformStream<Uint8Array, Uint8Array> {
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 1048576) throw new Error('Invalid record limit');
  const buffer = Buffer.alloc(cap);
  let used = 0, lineBytes = 0, pendingCR = false, first = true;
  return new TransformStream({
    async transform(chunk, controller) {
      const endLine = async () => {
        if (lineBytes === 0) {
          controller.enqueue(await rewriteRecord(buffer.subarray(0, used), first, rewrite));
          first = false; used = 0;
        }
        lineBytes = 0;
      };
      for (const byte of chunk) {
        if (pendingCR) {
          pendingCR = false;
          if (byte !== 10) await endLine();
          else {
            if (used === cap) throw new Error('Usage SSE record exceeds limit');
            buffer[used++] = byte; await endLine(); continue;
          }
        }
        if (used === cap) throw new Error('Usage SSE record exceeds limit');
        buffer[used++] = byte;
        if (byte === 13) pendingCR = true;
        else if (byte === 10) await endLine();
        else lineBytes++;
      }
    },
    async flush(controller) {
      if (pendingCR && lineBytes === 0) { controller.enqueue(await rewriteRecord(buffer.subarray(0, used), first, rewrite)); used = 0; }
      if (used > 0) controller.enqueue(Buffer.from(buffer.subarray(0, used)));
    },
  });
}
