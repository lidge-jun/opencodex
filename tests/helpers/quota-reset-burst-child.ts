/**
 * Child process for the burst-ordering regression.
 *
 * Runs in a FRESH module registry on purpose. Inside one test file the observer module is
 * already cached by earlier tests, so every dynamic import resolves from cache in call order
 * and the reordering cannot reproduce — an in-process version of this test passed against the
 * unfixed seam. Only a cold registry has the concurrent module loads that Bun resolves out of
 * call order.
 *
 * Writes monotonically RISING usage: no reset happens anywhere in this burst, so any event
 * printed here is false.
 */
import { setQuotaResetSink } from "../../src/quota/reset-observer";
import {
  flushQuotaObservationsForTests,
  setAccountQuotaFromParsed,
} from "../../src/codex/quota";

const events: string[] = [];
setQuotaResetSink(event => {
  events.push(`${event.kind}:${event.percentBefore}->${event.percentAfter}`);
});

const deadline = Date.now() + 4 * 60 * 60_000;
for (let percent = 10; percent <= 90; percent += 4) {
  setAccountQuotaFromParsed("acct-burst-child", {
    shortPercent: percent,
    shortResetAt: deadline,
    shortWindowSeconds: 5 * 3600,
  });
}

await flushQuotaObservationsForTests();
await new Promise(resolve => setTimeout(resolve, 50));
console.log(JSON.stringify(events));
