let input = "";
for await (const chunk of Bun.stdin.stream()) input += new TextDecoder().decode(chunk);
const text = input.trim() ? `Hub answer: ${input.trim()}` : "Hub answer";
process.stdout.write(`${JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
})}\n`);
process.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: text })}\n`);
