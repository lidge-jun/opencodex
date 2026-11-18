// Open /tests/switch-geometry.html through the GUI Vite server. The result is
// measured in a real browser with the same stylesheet and Switch as the app.
import { createRoot } from "react-dom/client";
import { Switch } from "../src/ui";
import "../src/design/theme.css";

createRoot(document.getElementById("root")!).render(
  <main style={{ padding: 24 }}>
    <h1>Switch geometry regression</h1>
    <div id="labeled-row" className="row models-provider-actions">
      <Switch on={false} onClick={() => {}} label="Use default aliases" showLabel />
      <button type="button" className="btn" id="neighbor">Add custom model</button>
    </div>
    <div id="bare-row"><Switch on={false} onClick={() => {}} label="Model visibility" /></div>
    <output id="result">Measuring…</output>
  </main>,
);

await document.fonts.ready;
await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const labeled = document.querySelector<HTMLElement>("#labeled-row .switch-labeled")!;
const text = labeled.querySelector<HTMLElement>(".switch-labeled-text")!;
const neighbor = document.getElementById("neighbor")!;
const bare = document.querySelector<HTMLElement>("#bare-row .switch")!;
const a = labeled.getBoundingClientRect(), b = text.getBoundingClientRect();
const c = neighbor.getBoundingClientRect(), d = bare.getBoundingClientRect();
const metrics = { labeledWidth: a.width, textRight: b.right, buttonRight: a.right,
  neighborLeft: c.left, bareWidth: d.width, bareHeight: d.height };
const pass = a.width > 34 && b.right <= a.right + 1 && b.right <= c.left + 1
  && Math.abs(d.width - 34) < 1 && Math.abs(d.height - 20) < 1;
document.getElementById("result")!.textContent = `${pass ? "PASS" : "FAIL"} ${JSON.stringify(metrics)}`;
