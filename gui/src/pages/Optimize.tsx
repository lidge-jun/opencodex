import { useEffect, useState } from "react";
import { useT } from "../i18n/shared";
import { IconRefresh, IconPlay } from "../icons";
import { Notice, Switch } from "../ui";
import { readJsonOrThrow, readJsonIfOk } from "../fetch-json";
import "../styles-optimize-workspace.css";

interface OptimizeSettings {
  rtkEnabled: boolean;
  headroomEnabled: boolean;
  headroomUrl: string;
  headroomTimeoutMs: number;
  ponytailEnabled: boolean;
  ponytailLevel: "lite" | "full" | "ultra";
}

const DEFAULT_SETTINGS: OptimizeSettings = {
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: "http://localhost:8787",
  headroomTimeoutMs: 30000,
  ponytailEnabled: false,
  ponytailLevel: "full",
};

interface TestResult {
  filter: string | null;
  originalLength: number;
  compressedLength: number;
  saved: number;
  compressed: string;
}

export default function Optimize({ apiBase }: { apiBase: string }) {
  const t = useT();
  const [settings, setSettings] = useState<OptimizeSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  // Headroom status state
  const [headroomStatus, setHeadroomStatus] = useState<{
    checking: boolean;
    reachable: boolean | null;
    error?: string;
  }>({ checking: false, reachable: null });
  const [startingHeadroom, setStartingHeadroom] = useState(false);

  // RTK live test sandbox state
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // Load settings on mount
  useEffect(() => {
    let cancelled = false;
    async function init() {
      try {
        const res = await fetch(`${apiBase}/api/optimize`);
        const data = await readJsonOrThrow<OptimizeSettings>(res);
        if (!cancelled && data) {
          setSettings(data);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorNotice(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  // Save settings
  const handleSave = async () => {
    setSaving(true);
    setSavedNotice(false);
    setErrorNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/optimize`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await readJsonOrThrow<{ ok: boolean; settings: OptimizeSettings }>(res);
      if (data?.settings) {
        setSettings(data.settings);
      }
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 3000);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Check Headroom connection
  const checkHeadroom = async () => {
    setHeadroomStatus({ checking: true, reachable: null });
    try {
      const q = settings.headroomUrl ? `?url=${encodeURIComponent(settings.headroomUrl)}` : "";
      const res = await fetch(`${apiBase}/api/optimize/headroom/status${q}`);
      const data = await readJsonIfOk<{ reachable: boolean; error?: string }>(res);
      setHeadroomStatus({
        checking: false,
        reachable: data?.reachable ?? false,
        error: data?.error,
      });
    } catch (err) {
      setHeadroomStatus({
        checking: false,
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Start Headroom service
  const startHeadroomService = async () => {
    setStartingHeadroom(true);
    setErrorNotice(null);
    try {
      const res = await fetch(`${apiBase}/api/optimize/headroom/start`, {
        method: "POST",
      });
      const data = await readJsonIfOk<{ ok: boolean; message?: string }>(res);
      if (data?.ok) {
        await checkHeadroom();
      } else {
        setErrorNotice(data?.message || t("optimize.headroom.startFailed"));
        await checkHeadroom();
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : String(err));
      await checkHeadroom();
    } finally {
      setStartingHeadroom(false);
    }
  };

  // Run RTK live test
  const runTest = async (text: string) => {
    setTestInput(text);
    if (!text.trim()) {
      setTestResult(null);
      return;
    }
    setTesting(true);
    try {
      const res = await fetch(`${apiBase}/api/optimize/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await readJsonIfOk<TestResult>(res);
      if (data) {
        setTestResult(data);
      }
    } catch {
      // test fail-open
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="opt-root">
      <div className="page-head">
        <h2>
          {t("optimize.title")}
        </h2>
      </div>
      <p className="page-sub">{t("optimize.subtitle")}</p>

      {savedNotice && (
        <Notice tone="ok">{t("optimize.saved")}</Notice>
      )}
      {errorNotice && (
        <Notice tone="warn">{errorNotice}</Notice>
      )}

      {/* RTK Section */}
      <div className="panel opt-card">
        <div className="opt-card-header">
          <div className="opt-card-title-group">
            <h3 className="opt-card-title">
              {t("optimize.rtk.title")}
            </h3>
            <p className="opt-card-subtitle">{t("optimize.rtk.desc")}</p>
          </div>
          <Switch
            on={settings.rtkEnabled}
            disabled={loading || saving}
            onClick={() => setSettings(s => ({ ...s, rtkEnabled: !s.rtkEnabled }))}
            label={t("optimize.rtk.enabled")}
          />
        </div>

        <div className="opt-row">
          <div className="opt-row-info">
            <span className="opt-row-label">{t("optimize.rtk.status")}</span>
            <span className="opt-row-desc">
              {settings.rtkEnabled ? (
                <span className="opt-badge opt-badge-success">{t("optimize.status.active")}</span>
              ) : (
                <span className="opt-badge opt-badge-neutral">{t("optimize.status.disabled")}</span>
              )}
            </span>
          </div>
        </div>

        {/* RTK Live Sandbox */}
        <div className="opt-test-area">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-primary)" }}>
              {t("optimize.test.title")}
            </span>
            {testing && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>{t("optimize.test.analyzing")}</span>}
          </div>
          <textarea
            className="input opt-test-textarea"
            aria-label={t("optimize.test.title")}
            placeholder={t("optimize.test.inputPlaceholder")}
            value={testInput}
            onChange={e => void runTest(e.target.value)}
          />
          {testResult && (
            <div className="opt-test-result">
              <span>
                {testResult.filter
                  ? t("optimize.test.filterMatched", { filter: testResult.filter })
                  : t("optimize.test.noMatch")}
              </span>
              {testResult.saved > 0 && (
                <span style={{ color: "rgb(16, 185, 129)", fontWeight: 600 }}>
                  {t("optimize.test.saved", {
                    saved: testResult.saved,
                    pct: Math.round((testResult.saved / (testResult.originalLength || 1)) * 100),
                  })}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Headroom Section */}
      <div className="panel opt-card">
        <div className="opt-card-header">
          <div className="opt-card-title-group">
            <h3 className="opt-card-title">
              {t("optimize.headroom.title")}
            </h3>
            <p className="opt-card-subtitle">{t("optimize.headroom.desc")}</p>
          </div>
          <Switch
            on={settings.headroomEnabled}
            disabled={loading || saving}
            onClick={() => setSettings(s => ({ ...s, headroomEnabled: !s.headroomEnabled }))}
            label={t("optimize.headroom.enabled")}
          />
        </div>

        <div className="opt-row">
          <div className="opt-row-info">
            <span className="opt-row-label">{t("optimize.headroom.url")}</span>
            <input
              type="text"
              className="input"
              aria-label={t("optimize.headroom.url")}
              style={{ width: "100%", maxWidth: 360, marginTop: 4, fontFamily: "monospace", fontSize: 12 }}
              placeholder={t("optimize.headroom.urlPlaceholder")}
              value={settings.headroomUrl}
              onChange={e => setSettings(s => ({ ...s, headroomUrl: e.target.value }))}
              disabled={loading || saving}
            />
          </div>
        </div>

        <div className="opt-row">
          <div className="opt-row-info">
            <span className="opt-row-label">{t("optimize.headroom.timeout")}</span>
            <span className="opt-row-desc">{t("optimize.headroom.timeoutHelp")}</span>
            <input
              type="number"
              className="input"
              aria-label={t("optimize.headroom.timeout")}
              style={{ width: 140, marginTop: 4, fontFamily: "monospace", fontSize: 12 }}
              value={settings.headroomTimeoutMs}
              onChange={e => setSettings(s => ({ ...s, headroomTimeoutMs: Number(e.target.value) || 30000 }))}
              disabled={loading || saving}
            />
          </div>
        </div>

        <div className="opt-row" style={{ alignItems: "center" }}>
          <div className="opt-row-info">
            <span className="opt-row-label">{t("optimize.headroom.status")}</span>
            <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 8 }}>
              {headroomStatus.checking ? (
                <span className="opt-badge opt-badge-warning">{t("optimize.headroom.checking")}</span>
              ) : headroomStatus.reachable === true ? (
                <span className="opt-badge opt-badge-success">{t("optimize.headroom.running")}</span>
              ) : headroomStatus.reachable === false ? (
                <span className="opt-badge opt-badge-warning" title={headroomStatus.error || undefined}>
                  {t("optimize.headroom.stopped")}
                </span>
              ) : (
                <span className="opt-badge opt-badge-neutral">{t("optimize.headroom.unknown")}</span>
              )}
             <button
               type="button"
               className="btn btn-ghost btn-sm"
               onClick={() => void checkHeadroom()}
               disabled={headroomStatus.checking || loading || saving}
             >
               <IconRefresh style={{ width: 12, height: 12, marginRight: 4 }} />
               {t("optimize.headroom.check")}
             </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void startHeadroomService()}
                disabled={startingHeadroom || headroomStatus.checking || loading || saving}
              >
                <IconPlay style={{ width: 12, height: 12, marginRight: 4 }} />
                {startingHeadroom ? t("optimize.headroom.starting") : t("optimize.headroom.start")}
              </button>
           </div>
           <span className="opt-row-desc" style={{ marginTop: 4 }}>
              {t("optimize.headroom.installHint")}
            </span>
          </div>
        </div>
      </div>

      {/* Ponytail Section */}
      <div className="panel opt-card">
        <div className="opt-card-header">
          <div className="opt-card-title-group">
            <h3 className="opt-card-title">
              {t("optimize.ponytail.title")}
            </h3>
            <p className="opt-card-subtitle">{t("optimize.ponytail.desc")}</p>
          </div>
          <Switch
            on={settings.ponytailEnabled}
            disabled={loading || saving}
            onClick={() => setSettings(s => ({ ...s, ponytailEnabled: !s.ponytailEnabled }))}
            label={t("optimize.ponytail.enabled")}
          />
        </div>

        <div className="opt-row">
          <div className="opt-row-info">
            <span className="opt-row-label">{t("optimize.ponytail.level")}</span>
            <div className="opt-level-group" role="group" aria-label={t("optimize.ponytail.level")}>
              {(["lite", "full", "ultra"] as const).map(lvl => (
                <button
                  key={lvl}
                  aria-pressed={settings.ponytailLevel === lvl}
                  type="button"
                  className={`opt-level-btn${settings.ponytailLevel === lvl ? " active" : ""}`}
                  onClick={() => setSettings(s => ({ ...s, ponytailLevel: lvl }))}
                  disabled={loading || saving}
                >
                  {lvl === "lite"
                    ? t("optimize.ponytail.levelLite")
                    : lvl === "full"
                      ? t("optimize.ponytail.levelFull")
                      : t("optimize.ponytail.levelUltra")}
                </button>
              ))}
            </div>
            <span className="opt-row-desc" style={{ marginTop: 8 }}>
              {settings.ponytailLevel === "lite" && t("optimize.ponytail.levelLiteDesc")}
              {settings.ponytailLevel === "full" && t("optimize.ponytail.levelFullDesc")}
              {settings.ponytailLevel === "ultra" && t("optimize.ponytail.levelUltraDesc")}
            </span>
          </div>
        </div>
      </div>

      {/* Save Button */}
      <div className="opt-save-bar">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleSave()}
          disabled={loading || saving}
        >
          {saving ? t("optimize.saving") : t("optimize.save")}
        </button>
      </div>
    </div>
  );
}
