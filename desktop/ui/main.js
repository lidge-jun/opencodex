const params = new URLSearchParams(window.location.search);
const port = Number(params.get("port") || "10100");
const origin = `http://127.0.0.1:${port}`;
const dashboardUrl = `${origin}/#/usage`;
const status = document.querySelector("#status");
const retry = document.querySelector("#retry");
let checking = false;

async function check() {
  if (checking) return;
  checking = true;
  status.textContent = `Connecting to OpenCodex proxy at 127.0.0.1:${port}…`;
  retry.disabled = true;
  try {
    const response = await fetch(`${origin}/healthz`, {
      cache: "no-store",
    });
    if (response.ok) {
      status.textContent = "Proxy is ready. Loading dashboard…";
      window.location.replace(dashboardUrl);
      return;
    }
    throw new Error(`HTTP ${response.status}`);
  } catch {
    status.textContent = "The proxy is not reachable yet.";
  } finally {
    checking = false;
    retry.disabled = false;
  }
}

retry.addEventListener("click", check);
check();
setInterval(check, 1500);
