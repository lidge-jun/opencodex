import { describe, expect, test } from "bun:test";
import { endsWithMuseToolResult, museDeveloperContinuation } from "../../src/adapters/muse-msp/developer-continuation";
import { MusePendingRegistry } from "../../src/adapters/muse-msp/pending-registry";

describe("Muse tool continuation with developer instructions", () => {
  test("keeps the original history and separates later developer instructions", () => {
    const parsed:any={context:{messages:[{role:"user",content:"question"},
      {role:"assistant",content:[]},{role:"toolResult",content:"result"},
      {role:"developer",content:"follow-up instructions"}]}};
    const result=museDeveloperContinuation(parsed,true)!;
    expect(endsWithMuseToolResult(parsed)).toBe(true);
    expect(result.steering).toBe("follow-up instructions");
    expect(result.toolRequest.context.messages.at(-1)?.role).toBe("toolResult");
    expect(parsed.context.messages.at(-1)?.role).toBe("developer");
    expect(()=>museDeveloperContinuation(parsed,false)).toThrow();
  });
  test("preflight rejects another owner's tool result before any steering", async () => {
    const registry=new MusePendingRegistry();const owner="a".repeat(64),digest="d".repeat(64);
    const entry=registry.register(owner,"upstream",digest,{timeoutMs:1000});
    expect(()=>registry.validate("b".repeat(64),entry.clientCallId,digest,"result")).toThrow();
    registry.validate(owner,entry.clientCallId,digest,"result");
    registry.submit(owner,entry.clientCallId,digest,"result");
    expect((await entry.result).output).toBe("result");registry.close();
  });
});
