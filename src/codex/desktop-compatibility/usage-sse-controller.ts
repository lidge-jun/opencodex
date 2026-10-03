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
  let used = 0, lineHasBytes = false, pendingCR = false, first = true, passthrough = false;
  return new TransformStream({
    async transform(chunk, controller) {
      let rawStart = passthrough ? 0 : -1;
      const enterPassthrough = (start: number) => {
        controller.enqueue(Buffer.from(buffer.subarray(0, used)));
        used = 0; passthrough = true; rawStart = start;
      };
      const endRecord = async (rawEnd: number) => {
        if (passthrough) {
          if (rawEnd > rawStart) controller.enqueue(chunk.subarray(rawStart, rawEnd));
          passthrough = false; rawStart = -1;
        } else {
          controller.enqueue(await rewriteRecord(buffer.subarray(0, used), first, rewrite));
        }
        first = false; used = 0; lineHasBytes = false;
      };
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i]!;
        if (pendingCR) {
          pendingCR = false;
          if (byte !== 10) {
            if (!lineHasBytes) await endRecord(i);
            lineHasBytes = false;
          }
          else {
            if (!passthrough && used === cap) enterPassthrough(i);
            if (!passthrough) buffer[used++] = byte;
            const blankLine = !lineHasBytes;
            lineHasBytes = false;
            if (blankLine) await endRecord(i + 1);
            continue;
          }
        }
        if (!passthrough && used === cap) enterPassthrough(i);
        if (!passthrough) buffer[used++] = byte;
        if (byte === 13) pendingCR = true;
        else if (byte === 10) {
          const blankLine = !lineHasBytes;
          lineHasBytes = false;
          if (blankLine) await endRecord(i + 1);
        } else lineHasBytes = true;
      }
      if (passthrough && rawStart < chunk.length) controller.enqueue(chunk.subarray(rawStart));
    },
    async flush(controller) {
      if (passthrough) return;
      if (pendingCR && !lineHasBytes) { controller.enqueue(await rewriteRecord(buffer.subarray(0, used), first, rewrite)); used = 0; }
      if (used > 0) controller.enqueue(Buffer.from(buffer.subarray(0, used)));
    },
  });
}
