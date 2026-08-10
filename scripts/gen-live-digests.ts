import { fixtureDigest } from "../src/lab/conformance/digest";

const fixtures: Record<string, string> = {
  "rsp-live-basic-request":
    '{"model":"fixture-model","input":"PING","stream":false}',
  "rsp-live-basic-upstream":
    '{"id":"resp_fixture","status":"completed","output":[{"id":"msg_fixture","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"OK"}]}]}',
  "chat-live-basic-request":
    '{"model":"fixture-model","input":"PING","stream":true}',
  "chat-live-basic-upstream":
    'data: {"choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  "anthropic-live-basic-request":
    '{"model":"fixture-model","messages":[{"role":"user","content":"PING"}],"max_tokens":32,"stream":true}',
  "anthropic-live-basic-upstream":
    'data:{"type":"response.output_text.delta","delta":"OK"}\n\ndata:{"type":"response.completed","response":{"id":"resp_fixture","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
  "tools-live-fn-request":
    '{"model":"fixture-model","input":"PING","stream":false,"tools":[{"type":"function","name":"lookup","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}],"tool_choice":{"type":"function","name":"lookup"}}',
  "tools-live-fn-upstream":
    '{"id":"resp_fixture","status":"completed","output":[{"id":"call_fixture","type":"function_call","call_id":"call_fixture","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}]}',
  "tools-live-fn-result-request":
    '{"model":"fixture-model","input":[{"type":"function_call_output","call_id":"call_fixture","output":"RESULT"}],"stream":false}',
  "tools-live-fn-result-upstream":
    '{"id":"resp_fixture","status":"completed","output":[{"id":"msg_fixture","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"DONE"}]}]}',
  "tools-live-custom-request":
    '{"model":"fixture-model","input":"PING","stream":false,"tools":[{"type":"custom","name":"apply_patch","description":"patch"}],"tool_choice":{"type":"custom","name":"apply_patch"}}',
  "tools-live-custom-upstream":
    '{"id":"resp_fixture","status":"completed","output":[{"id":"call_fixture","type":"custom_tool_call","call_id":"call_fixture","name":"apply_patch","input":"*** Begin Patch\\n*** End Patch"}]}',
  "tools-live-custom-result-request":
    '{"model":"fixture-model","input":[{"type":"custom_tool_call_output","call_id":"call_fixture","output":"PATCHED"}],"stream":false}',
  "tools-live-custom-result-upstream":
    '{"id":"resp_fixture","status":"completed","output":[{"id":"msg_fixture","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"DONE"}]}]}',
  "codex-live-tool-request":
    '{"model":"fixture-model","input":"PING","stream":true}',
  "codex-live-tool-upstream":
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_fixture","function":{"name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n',
  "codex-live-custom-request":
    '{"model":"fixture-model","input":"PING","stream":false,"tools":[{"type":"custom","name":"apply_patch"}],"tool_choice":{"type":"custom","name":"apply_patch"}}',
  "codex-live-custom-upstream":
    '{"id":"resp_fixture","status":"completed","output":[{"id":"call_fixture","type":"custom_tool_call","call_id":"call_fixture","name":"apply_patch","input":"PATCH"}]}',
  "vision-live-ocr-request":
    '{"model":"fixture-model","input":[{"role":"user","content":[{"type":"input_text","text":"OCR-NONCE-42"},{"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgo=","detail":"high"}]}],"stream":false}',
  "vision-live-ocr-upstream":
    '{"id":"resp_fixture","status":"completed","output":[{"id":"msg_fixture","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"{\\"nonce\\":\\"OCR-NONCE-42\\"}"}]}]}',
  "reasoning-live-replay-vector":
    '{"turn1":{"reasoning":{"id":"rs_fixture","text":"PLAN","signature":"sig_fixture"},"toolCall":{"callId":"call_fixture"}},"turn2":{"toolResult":{"callId":"call_fixture","output":"RESULT"}}}',
  "mcp-live-stub":
    '{"namespace":"mcp__fixture","name":"lookup","arguments":{"q":"x"},"result":{"content":[{"type":"text","text":"ECHO"}],"isError":false}}',
};

for (const [id, bytes] of Object.entries(fixtures)) {
  console.log(id, fixtureDigest(new TextEncoder().encode(bytes)));
}
