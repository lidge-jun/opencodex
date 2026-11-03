import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProxyControls } from "../src/components/ui-v2/proxy-controls";

/*
 * The sidebar proxy row's status dot is green only while the proxy answers and is not being
 * stopped; an unreachable proxy (failed health check) or a stop in flight shows the neutral dot.
 */
function dotClass(props: { online?: boolean; stopping?: boolean }): string {
  const html = renderToStaticMarkup(
    <ProxyControls label="Proxy" statusLabel={props.online === false ? "Offline" : "Online"}
      stopLabel="Stop" stoppingLabel="Stopping" restartLabel="Restart" restartingLabel="Restarting"
      stopping={props.stopping ?? false} restarting={false} onStop={() => {}} onRestart={() => {}}
      {...(props.online === undefined ? {} : { online: props.online })} />,
  );
  const dot = /<span class="([^"]*\bsize-2\b[^"]*)" aria-hidden="true"><\/span>/.exec(html);
  expect(dot).not.toBeNull();
  return dot![1]!;
}

test("online by default: the dot is green", () => {
  expect(dotClass({})).toContain("bg-success");
});

test("offline: the dot goes neutral", () => {
  expect(dotClass({ online: false })).toContain("bg-fg-subtle");
  expect(dotClass({ online: false })).not.toContain("bg-success");
});

test("stopping: the dot goes neutral even while online", () => {
  expect(dotClass({ online: true, stopping: true })).toContain("bg-fg-subtle");
  expect(dotClass({ online: true, stopping: true })).not.toContain("bg-success");
});
