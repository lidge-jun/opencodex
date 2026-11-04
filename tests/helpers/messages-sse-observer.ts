/** Independent observer of SDK 4f27519 streaming.ts/error.ts and Claude Code 2.1.288.
 * Source SHA-256s are recorded in the golden. No runtime normalization helpers are imported.
 */
export function pinnedMessagesObservation(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  const events: { event: string; data: string; diagnostic?: string; recognizes: boolean }[] = [];
  let name = "", data: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/).slice(0, -1)) {
    if (line === "") {
      if (name || data.length) {
        const joined = data.join("\n");
        let diagnostic: string | undefined;
        if (name === "error") {
          let value: any;
          try { value = JSON.parse(joined); } catch { value = undefined; }
          value ??= joined;
          diagnostic = (value?.message ? typeof value.message === "string" ? value.message : JSON.stringify(value.message)
            : value ? JSON.stringify(value) : undefined) || "(no status code or body)";
        }
        events.push({ event: name, data: joined, diagnostic, recognizes: diagnostic !== undefined
          && /prompt is too long|input is too long for requested model/i.test(diagnostic) });
      }
      name = ""; data = [];
    } else if (!line.startsWith(":")) {
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") name = value;
      if (field === "data") data.push(value);
    }
  }
  return { events, clientRecognizes: events.find(row => row.event === "error")?.recognizes ?? false,
    wirePhrase: /prompt is too long|input is too long for requested model/i.test(text) };
}
