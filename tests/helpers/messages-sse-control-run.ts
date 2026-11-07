import { runMessagesSseCase } from "./messages-sse-run";
import { messagesSseControlLanes, messagesSseControlFields, messagesSseControlVariants, messagesSseControlCase, messagesSseControlRename } from "./messages-sse-control-cases";
const lane = process.argv[2] as typeof messagesSseControlLanes[number];
if (!messagesSseControlLanes.includes(lane)) throw new Error("Unknown control-field fixture lane");
const outcomes: Record<string, unknown> = {};
for (const field of messagesSseControlFields) for (const variant of messagesSseControlVariants) {
  const input = messagesSseControlCase(field, variant);
  const { bytes, ...outcome } = await runMessagesSseCase(lane, input);
  outcomes[input.id] = { ...outcome, body: bytes.toString("base64") };
}
const { bytes, ...outcome } = await runMessagesSseCase(lane, messagesSseControlRename);
outcomes[messagesSseControlRename.id] = { ...outcome, body: bytes.toString("base64") };
await Bun.write(process.argv[3]!, JSON.stringify(outcomes) + "\n");
