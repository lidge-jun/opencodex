import { describe, expect, test } from "bun:test";
import { projectInitialMuseHistory } from "../../src/adapters/muse-msp/initial-history";

describe("Muse initial conversation projection", () => {
  test("accepts the interleaved developer and user messages emitted by Codex Desktop", () => {
    const context:any={messages:[{role:"developer",content:"dev one"},{role:"user",content:"env one"},
      {role:"developer",content:"dev two"},{role:"user",content:"the question"}]};
    const result=projectInitialMuseHistory(context,true);
    expect(result.developer).toBe("dev one\n\ndev two");
    expect(result.user).toBe("env one\n\nthe question");
  });
  test("retains parsed compaction instructions alongside developer messages", () => {
    const context:any={systemPrompt:["compaction continuation"],messages:[{role:"developer",content:"developer instructions"},{role:"user",content:"continue"}]};
    const result=projectInitialMuseHistory(context,true);
    expect(result.developer).toBe("compaction continuation\n\ndeveloper instructions");
    expect(result.user).toBe("continue");
  });
  test("passes previous visible assistant and tool history into a new session", () => {
    const context:any={messages:[{role:"developer",content:"instructions"},{role:"user",content:"prior"},
      {role:"assistant",content:[{type:"text",text:"answer"},{type:"toolCall",id:"call-1",name:"read",arguments:{path:"file"}}]},
      {role:"toolResult",toolCallId:"call-1",toolName:"read",content:"result",isError:false},
      {role:"user",content:"current question"}]};
    const result=projectInitialMuseHistory(context,true);
    for(const text of ["prior","answer","call-1","read","file","result","current question"])expect(result.user).toContain(text);
    expect(result.developer).toBe("instructions");
  });
  test("preserves image-bearing tool results as Muse image inputs", () => {
    const context:any={messages:[{role:"user",content:"before"},
      {role:"assistant",content:[{type:"toolCall",id:"call-1",name:"exec",arguments:{}}]},
      {role:"toolResult",toolCallId:"call-1",toolName:"exec",content:[{type:"text",text:"screenshot"},
        {type:"image",imageUrl:"data:image/png;base64,iVBORw0KGgo="}]},
      {role:"user",content:"continue"}]};
    const result=projectInitialMuseHistory(context,true);
    expect(result.user).toContain("screenshot[Image 1 attached to this request]");
    expect(result.images).toEqual([{type:"image",mediaType:"image/png",base64Data:"iVBORw0KGgo="}]);
  });
  test("refuses unsupported media and opt-out instead of silently dropping them", () => {
    const media:any={messages:[{role:"user",content:[{type:"image",imageUrl:"https://example.test/a"}]}]};
    expect(()=>projectInitialMuseHistory(media,true)).toThrow();
    const history:any={messages:[{role:"user",content:"old"},{role:"assistant",content:[{type:"text",text:"ok"}]},{role:"user",content:"new"}]};
    expect(()=>projectInitialMuseHistory(history,false)).toThrow();
  });
});
