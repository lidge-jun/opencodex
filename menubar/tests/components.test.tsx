import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBar } from "../src/components/StatusBar";
import { StatsRow } from "../src/components/StatsRow";
import { QuotaBars } from "../src/components/QuotaBars";
import { ComboList } from "../src/components/ComboList";

describe("StatusBar", () => {
  it("shows online status with version and uptime", () => {
    render(<StatusBar online={true} version="2.3.1" uptime={259200} />);
    expect(screen.getByText("OpenCodex")).toBeInTheDocument();
    expect(screen.getByText("v2.3.1")).toBeInTheDocument();
    expect(screen.getByText("3d 0h")).toBeInTheDocument();
  });

  it("shows offline status", () => {
    render(<StatusBar online={false} version={null} uptime={null} />);
    expect(screen.getByText("Offline")).toBeInTheDocument();
  });
});

describe("StatsRow", () => {
  it("renders request count, tokens, and cost", () => {
    render(<StatsRow requests={1234} totalTokens={2100000} estimatedCost={4.2} stale={false} />);
    expect(screen.getByText("1,234")).toBeInTheDocument();
    expect(screen.getByText("2.1M")).toBeInTheDocument();
    expect(screen.getByText("$4.20")).toBeInTheDocument();
  });

  it("shows stale badge when data is stale", () => {
    render(<StatsRow requests={0} totalTokens={0} estimatedCost={0} stale={true} />);
    expect(screen.getByText("stale")).toBeInTheDocument();
  });
});

describe("QuotaBars", () => {
  it("renders quota bars for providers", () => {
    const reports = [
      { provider: "anthropic", label: "Anthropic", quota: { fiveHourPercent: 78 } },
      { provider: "openai", label: "OpenAI", quota: { fiveHourPercent: 45 } },
    ];
    render(<QuotaBars reports={reports} onRefresh={() => {}} refreshing={false} stale={false} />);
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("78% (5h)")).toBeInTheDocument();
    expect(screen.getByText("45% (5h)")).toBeInTheDocument();
  });

  it("shows empty state when no reports", () => {
    render(<QuotaBars reports={[]} onRefresh={() => {}} refreshing={false} stale={false} />);
    expect(screen.getByText("No quota data")).toBeInTheDocument();
  });
});

describe("ComboList", () => {
  it("renders combo list", () => {
    const combos = [
      { id: "claude-sonnet", model: "claude-sonnet-4-20250514" },
      { id: "gpt5-codex", model: "gpt-5.6-terra" },
    ];
    render(<ComboList combos={combos} onSwitch={() => {}} stale={false} />);
    // combo names appear both in the list and the select dropdown
    expect(screen.getAllByText("claude-sonnet").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("gpt5-codex").length).toBeGreaterThanOrEqual(1);
    // model targets appear only in the list
    expect(screen.getByText("claude-sonnet-4-20250514")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.6-terra")).toBeInTheDocument();
  });

  it("shows empty state when no combos", () => {
    render(<ComboList combos={[]} onSwitch={() => {}} stale={false} />);
    expect(screen.getByText("No combos configured")).toBeInTheDocument();
  });
});
