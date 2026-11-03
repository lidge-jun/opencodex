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
      stopLabel="Stop" stoppingLabel="Stopping" restartLabel="Restart" restartingLabel="Restarting" leverHint=""
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

test("one lever carries reload and stop, and it locks at the bottom while stopping", () => {
  const render = (stopping: boolean) => renderToStaticMarkup(
    <ProxyControls label="Proxy" statusLabel="Online" stopLabel="Stop" stoppingLabel="Stopping"
      restartLabel="Reload" restartingLabel="Reloading" leverHint="Pull halfway: Reload. Pull all the way down: Stop."
      stopping={stopping} restarting={false} onStop={() => {}} onRestart={() => {}} />,
  );
  const idle = render(false);
  expect(idle).toMatch(/<button type="button" aria-label="Reload · Stop" aria-description="Pull halfway[^"]*"/);
  expect(idle).toContain("translateY(0px)");
  expect(idle.match(/<button /g)?.length).toBe(1);
  const stoppingHtml = render(true);
  expect(stoppingHtml).toMatch(/<button type="button" aria-label="Reload · Stopping"[^>]*disabled=""/);
  expect(stoppingHtml).toContain("translateY(14px)");
});
