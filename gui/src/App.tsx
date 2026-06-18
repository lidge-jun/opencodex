import { useState } from "react";
import Dashboard from "./pages/Dashboard";
import Providers from "./pages/Providers";
import Logs from "./pages/Logs";

type Page = "dashboard" | "providers" | "logs";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:10100";

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");

  const navBtn = (target: Page, label: string) => (
    <button
      onClick={() => setPage(target)}
      style={{
        padding: "8px 16px", cursor: "pointer", background: "none", border: "none", fontSize: 14,
        borderBottom: page === target ? "2px solid #3b82f6" : "2px solid transparent",
        color: page === target ? "#3b82f6" : "#666",
        fontWeight: page === target ? 600 : 400,
      }}
    >{label}</button>
  );

  return (
    <div style={{ fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", maxWidth: 960, margin: "0 auto", padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>opencodex</h1>
        <span style={{ fontSize: 12, color: "#999", background: "#f3f4f6", padding: "2px 8px", borderRadius: 4 }}>v0.0.1</span>
      </div>
      <nav style={{ display: "flex", gap: 4, borderBottom: "1px solid #e5e7eb", marginBottom: 24 }}>
        {navBtn("dashboard", "Dashboard")}
        {navBtn("providers", "Providers")}
        {navBtn("logs", "Logs")}
      </nav>
      {page === "dashboard" && <Dashboard apiBase={API_BASE} />}
      {page === "providers" && <Providers apiBase={API_BASE} />}
      {page === "logs" && <Logs apiBase={API_BASE} />}
    </div>
  );
}
