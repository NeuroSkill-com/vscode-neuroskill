import * as vscode from "vscode";
import { DaemonClient } from "./daemon-client";
import { getConfig } from "./config";
import type { AIActivityTracker } from "./ai-tracker";
import { tr } from "./l10n";

// ── Daemon response types ────────────────────────────────────────────────────

interface CodeBrainRow {
  key: string;
  avg_focus: number;
  total_mins: number;
  interactions: number;
  avg_undos: number;
}

interface CodeEegCorrelation {
  by_language: CodeBrainRow[];
  best_files: CodeBrainRow[];
  worst_files: CodeBrainRow[];
}

interface EegPoint {
  ts: number;
  metrics: string;
}

interface TimelineEvent {
  kind: string;
  title: string;
  detail: string;
  ts: number;
  eeg_focus: number | null;
}

interface FocusCommit {
  message: string;
  timestamp: number;
  focusScore: number;
  source: string; // "human" | "ai"
}

/**
 * Sidebar webview provider — shows live brain state, focus, and activity
 * in the NeuroSkill activity bar panel.
 */
export class SidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "neuroskill.sidebar";

  private _view?: vscode.WebviewView;
  private _refreshTimer?: NodeJS.Timeout;
  private _logoUri?: string;
  private _client?: DaemonClient;
  private _aiTracker?: AIActivityTracker;
  private _recentCommits: FocusCommit[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
  ) {}

  setClient(client: DaemonClient): void {
    this._client = client;
  }

  setAITracker(tracker: AIActivityTracker): void {
    this._aiTracker = tracker;
  }

  /** Called from extension.ts when a git commit is detected. */
  recordCommit(message: string, focusScore: number, source: string): void {
    this._recentCommits.unshift({
      message: message.slice(0, 80),
      timestamp: Date.now(),
      focusScore,
      source,
    });
    if (this._recentCommits.length > 15) this._recentCommits.length = 15;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _cancel: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    const logoOnDisk = vscode.Uri.joinPath(this._extensionUri, "icon.png");
    this._logoUri = webviewView.webview.asWebviewUri(logoOnDisk).toString();

    webviewView.webview.html = this._getLoadingHtml();

    this._refresh();
    this._refreshTimer = setInterval(() => this._refresh(), 10_000);

    webviewView.onDidDispose(() => {
      if (this._refreshTimer) clearInterval(this._refreshTimer);
      this._refreshTimer = undefined;
    });
  }

  dispose(): void {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = undefined;
    }
    this._view = undefined;
  }

  private async _refresh(): Promise<void> {
    if (!this._view || !this._client) return;
    const config = getConfig();

    try {
      // Core brain state (always fetched)
      const [flowResp, fatigueResp, streakResp, taskResp] = await Promise.allSettled([
        this._client.post<any>("/brain/flow-state", { windowSecs: 300 }),
        this._client.get<any>("/brain/fatigue"),
        this._client.post<any>("/brain/streak", { minDeepWorkMins: 60 }),
        this._client.post<any>("/brain/task-type", {}),
      ]);

      const flow = flowResp.status === "fulfilled" ? flowResp.value : null;
      const fatigue = fatigueResp.status === "fulfilled" ? fatigueResp.value : null;
      const streak = streakResp.status === "fulfilled" ? streakResp.value : null;
      const task = taskResp.status === "fulfilled" ? taskResp.value : null;

      // Feature-specific data (fetched in parallel, conditionally)
      const extras = await Promise.allSettled([
        config.eegHeatmap ? this._fetchHeatmap() : Promise.resolve(null),
        config.flowTriggers ? this._fetchFlowTriggers() : Promise.resolve(null),
        this._fetchAIInsights(),
      ]);

      const heatmap = extras[0].status === "fulfilled" ? extras[0].value : null;
      const triggers = extras[1].status === "fulfilled" ? extras[1].value : null;
      const aiInsights = extras[2].status === "fulfilled" ? extras[2].value : null;

      this._view.webview.html = this._getHtml(flow, fatigue, streak, task, heatmap, triggers, aiInsights, config);
    } catch {
      this._view.webview.html = this._getDisconnectedHtml();
    }
  }

  // ── Data fetchers ──────────────────────────────────────────────────────────

  private async _fetchHeatmap(): Promise<{ points: { ts: number; focus: number; file?: string }[] } | null> {
    if (!this._client) return null;
    const now = Math.floor(Date.now() / 1000);
    const dayStart = now - (now % 86400); // UTC midnight

    const [eegData, timeline] = await Promise.allSettled([
      this._client.post<EegPoint[]>("/brain/eeg-range", { from: dayStart, to: now, maxPoints: 120 }),
      this._client.post<TimelineEvent[]>("/activity/timeline", { since: dayStart, limit: 200 }),
    ]);

    const eeg = eegData.status === "fulfilled" ? eegData.value : null;
    const tl = timeline.status === "fulfilled" ? timeline.value : null;
    if (!eeg || eeg.length === 0) return null;

    const points = eeg.map((p) => {
      let focus = 0;
      try {
        const m = typeof p.metrics === "string" ? JSON.parse(p.metrics) : p.metrics;
        focus = m.bar ?? m.focus ?? 0;
      } catch { /* ignore */ }

      // Find closest timeline event for file label.
      let file: string | undefined;
      if (tl) {
        const closest = tl
          .filter((e) => e.kind === "file" && Math.abs(e.ts - p.ts) < 30)
          .sort((a, b) => Math.abs(a.ts - p.ts) - Math.abs(b.ts - p.ts))[0];
        if (closest) file = closest.title.split("/").pop();
      }
      return { ts: p.ts, focus, file };
    });

    return { points };
  }

  private async _fetchFlowTriggers(): Promise<{
    bestLanguages: { lang: string; focus: number }[];
    bestHours: number[];
    cycleMins: number;
    flowKillers: { app: string; drop: number }[];
  } | null> {
    if (!this._client) return null;

    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const [codeEeg, hours, breakT, context] = await Promise.allSettled([
      this._client.post<CodeEegCorrelation>("/brain/code-eeg", { since: weekAgo }),
      this._client.post<{ best_hours: number[] }>("/brain/optimal-hours", { since: weekAgo, topN: 3 }),
      this._client.post<{ natural_cycle_mins: number | null }>("/brain/break-timing", { since: weekAgo }),
      this._client.post<{ from_zone: string; to_zone: string; avg_focus_at_switch: number | null }[]>(
        "/brain/context-cost", { since: weekAgo }),
    ]);

    const ce = codeEeg.status === "fulfilled" ? codeEeg.value : null;
    const hr = hours.status === "fulfilled" ? hours.value : null;
    const br = breakT.status === "fulfilled" ? breakT.value : null;
    const cx = context.status === "fulfilled" ? context.value : null;

    const bestLanguages = (ce?.by_language ?? [])
      .filter((r) => r.avg_focus > 0 && r.total_mins > 5)
      .sort((a, b) => b.avg_focus - a.avg_focus)
      .slice(0, 4)
      .map((r) => ({ lang: r.key, focus: r.avg_focus }));

    const flowKillers = (cx ?? [])
      .filter((r): r is typeof r & { avg_focus_at_switch: number } =>
        r.avg_focus_at_switch !== null && r.avg_focus_at_switch > 0)
      .sort((a, b) => a.avg_focus_at_switch - b.avg_focus_at_switch)
      .slice(0, 3)
      .map((r) => ({ app: r.to_zone, drop: r.avg_focus_at_switch }));

    return {
      bestLanguages,
      bestHours: hr?.best_hours ?? [],
      cycleMins: br?.natural_cycle_mins ?? 0,
      flowKillers,
    };
  }

  // ── HTML renderers ─────────────────────────────────────────────────────────

  private _logoHeader(): string {
    return `<div class="logo-header">
      <img src="${this._logoUri}" alt="NeuroSkill" class="logo" />
      <span class="logo-text">NeuroSkill</span>
    </div>`;
  }

  private _disclaimerFooter(): string {
    return `<div class="disclaimer" role="note">
      <span class="disclaimer-icon">⚠️</span>
      <span class="disclaimer-text">${tr("sidebar.disclaimer")}</span>
    </div>`;
  }

  /** Convert daemon task_type identifiers like "deep_work" into human labels. */
  private _formatTaskType(t: string | undefined | null): string {
    if (!t) return tr("sidebar.mode.unknown");
    const key = `sidebar.mode.${t}`;
    const localized = tr(key);
    if (localized !== key) return localized;
    return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  private _getLoadingHtml(): string {
    return `<!DOCTYPE html>
<html><head>${this._styles()}</head>
<body><div class="container">${this._logoHeader()}<p class="muted">${tr("sidebar.connecting")}</p>${this._disclaimerFooter()}</div></body></html>`;
  }

  private _getDisconnectedHtml(): string {
    return `<!DOCTYPE html>
<html><head>${this._styles()}</head>
<body><div class="container">${this._logoHeader()}
  <p class="muted">${tr("sidebar.disconnected")}</p>
  <p class="hint">${tr("sidebar.disconnected.hint")}</p>
  ${this._disclaimerFooter()}
</div></body></html>`;
  }

  private _getHtml(flow: any, fatigue: any, streak: any, task: any,
    heatmap: any, triggers: any, aiInsights: any, config: any): string {

    const focusScore = flow?.score?.toFixed(0) ?? "—";
    const inFlow = flow?.in_flow ?? false;
    const flowMins = flow?.duration_secs ? Math.floor(flow.duration_secs / 60) : 0;
    const isFatigued = fatigue?.fatigued ?? false;
    const deepMins = streak?.today_deep_mins ?? 0;
    const streakDays = streak?.current_streak_days ?? 0;
    const taskType = this._formatTaskType(task?.task_type);
    const focusColor = inFlow ? "#22c55e" : (Number(focusScore) > 60 ? "#a78bfa" : "#f59e0b");
    const focusLabel = inFlow
      ? tr("sidebar.inFlow", flowMins)
      : tr("sidebar.focusScore", focusScore);
    const aiRatio = this._aiTracker ? this._aiTracker.getOverallAIRatio() : 0;

    return `<!DOCTYPE html>
<html><head>${this._styles()}</head>
<body><div class="container">
  ${this._logoHeader()}

  <div class="metric-card main">
    <div class="focus-ring" style="--color: ${focusColor}">
      <span class="focus-value">${focusScore}</span>
    </div>
    <span class="focus-label">${focusLabel}</span>
    ${aiRatio > 0.01 ? `<span class="ai-ratio">${tr("sidebar.humanAiRatio", ((1 - aiRatio) * 100).toFixed(0), (aiRatio * 100).toFixed(0))}</span>` : ""}
  </div>

  <div class="grid">
    <div class="metric-card">
      <span class="metric-icon">${isFatigued ? "🔴" : "🟢"}</span>
      <span class="metric-label">${tr("sidebar.energy")}</span>
      <span class="metric-value">${isFatigued ? tr("sidebar.energy.fatigued") : tr("sidebar.energy.good")}</span>
    </div>
    <div class="metric-card">
      <span class="metric-icon">🧠</span>
      <span class="metric-label">${tr("sidebar.mode")}</span>
      <span class="metric-value">${taskType}</span>
    </div>
    <div class="metric-card">
      <span class="metric-icon">⏱</span>
      <span class="metric-label">${tr("sidebar.deepWork")}</span>
      <span class="metric-value">${tr("sidebar.deepWork.today", deepMins)}</span>
    </div>
    <div class="metric-card">
      <span class="metric-icon">⚡</span>
      <span class="metric-label">${tr("sidebar.streak")}</span>
      <span class="metric-value">${streakDays > 0 ? tr("sidebar.streak.days", streakDays) : "—"}</span>
    </div>
  </div>

  ${fatigue?.suggestion ? `<div class="suggestion">${fatigue.suggestion}</div>` : ""}

  ${config.eegHeatmap ? this._renderHeatmap(heatmap) : ""}
  ${config.flowTriggers ? this._renderFlowTriggers(triggers) : ""}
  ${config.focusCommits ? this._renderCommits() : ""}
  ${this._renderAIInsights(aiInsights)}

  ${this._disclaimerFooter()}
</div></body></html>`;
  }

  // ── Feature 8: EEG Heatmap ─────────────────────────────────────────────────

  private _renderHeatmap(data: any): string {
    if (!data?.points?.length) return "";

    const points: { ts: number; focus: number; file?: string }[] = data.points;
    const width = 280;
    const height = 36;
    const padding = 2;

    const minTs = points[0].ts;
    const maxTs = points[points.length - 1].ts;
    const range = maxTs - minTs || 1;

    const pathParts = points.map((p, i) => {
      const x = padding + ((p.ts - minTs) / range) * (width - padding * 2);
      const y = height - padding - (p.focus / 100) * (height - padding * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    // Color stops for gradient.
    const gradStops = points.map((p) => {
      const pct = ((p.ts - minTs) / range * 100).toFixed(1);
      const color = p.focus > 70 ? "#22c55e" : p.focus > 40 ? "#f59e0b" : "#ef4444";
      return `<stop offset="${pct}%" stop-color="${color}"/>`;
    }).join("");

    // Hour labels.
    const hours: string[] = [];
    for (let h = 0; h < 24; h += 3) {
      const ts = minTs + (h / 24) * range;
      if (ts >= minTs && ts <= maxTs) {
        const x = padding + ((ts - minTs) / range) * (width - padding * 2);
        hours.push(`<text x="${x.toFixed(0)}" y="${height + 10}" class="hour-label">${h}:00</text>`);
      }
    }

    return `
    <details class="section" open>
      <summary class="section-title">${tr("sidebar.section.focusTimeline")}</summary>
      <svg width="100%" height="${height + 14}" class="heatmap" viewBox="0 0 ${width} ${height + 14}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="hg" x1="0%" y1="0%" x2="100%" y2="0%">${gradStops}</linearGradient>
        </defs>
        <path d="${pathParts}" fill="none" stroke="url(#hg)" stroke-width="2" stroke-linecap="round"/>
        ${hours.join("")}
      </svg>
    </details>`;
  }

  // ── Feature 5: Flow Triggers ───────────────────────────────────────────────

  private _renderFlowTriggers(data: any): string {
    if (!data) return "";

    const items: string[] = [];

    if (data.bestLanguages?.length > 0) {
      const top = data.bestLanguages[0];
      items.push(`<li>Focus best on <strong>${top.lang}</strong> (${top.focus.toFixed(0)})</li>`);
    }
    if (data.bestHours?.length > 0) {
      items.push(`<li>Peak hours: <strong>${data.bestHours.map((h: number) => `${h}:00`).join(", ")}</strong></li>`);
    }
    if (data.cycleMins > 0) {
      items.push(`<li>Natural cycle: <strong>${data.cycleMins}m</strong></li>`);
    }
    if (data.flowKillers?.length > 0) {
      const worst = data.flowKillers[0];
      items.push(`<li>Flow killer: <strong>${worst.app}</strong> (focus ${worst.drop.toFixed(0)} at switch)</li>`);
    }

    if (items.length === 0) return "";

    return `
    <details class="section">
      <summary class="section-title">${tr("sidebar.section.flowRecipe")}</summary>
      <ul class="trigger-list">${items.join("")}</ul>
    </details>`;
  }

  // ── Feature 6: Focus Commits ───────────────────────────────────────────────

  private _renderCommits(): string {
    if (this._recentCommits.length === 0) return "";

    const rows = this._recentCommits.slice(0, 8).map((c) => {
      const icon = c.source === "ai" ? "🤖" : "👤";
      const color = c.focusScore > 70 ? "#22c55e" : c.focusScore > 40 ? "#f59e0b" : "#ef4444";
      const badge = c.source === "ai"
        ? `<span class="commit-badge" style="color: var(--vscode-descriptionForeground)">AI</span>`
        : `<span class="commit-badge" style="color: ${color}">${c.focusScore.toFixed(0)}</span>`;
      return `<div class="commit-row">${icon} ${badge} <span class="commit-msg">${this._escapeHtml(c.message)}</span></div>`;
    }).join("");

    return `
    <details class="section">
      <summary class="section-title">${tr("sidebar.section.recentCommits")}</summary>
      ${rows}
    </details>`;
  }

  private _escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── AI Deep Analytics ──────────────────────────────────────────────────────

  private async _fetchAIInsights(): Promise<any> {
    if (!this._client) return null;
    const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    return this._client.post<any>("/brain/ai-deep-analytics", { since: weekAgo });
  }

  private _renderAIInsights(data: any): string {
    if (!data) return "";

    const lc = data.lifecycle ?? {};
    const dep = data.dependency ?? {};
    const eff = data.effectiveness ?? {};
    const cog = data.cognition ?? {};
    const qual = data.quality ?? {};

    const items: string[] = [];

    // Survival rate.
    const survival = lc.survival_rate ?? 0;
    const survivalPct = (survival * 100).toFixed(0);
    const survivalColor = survival > 0.8 ? "#22c55e" : survival > 0.5 ? "#f59e0b" : "#ef4444";
    items.push(`<div class="ai-metric">
      <span class="ai-metric-label">AI Code Survival</span>
      <div class="ai-bar"><div class="ai-bar-fill" style="width:${survivalPct}%;background:${survivalColor}"></div></div>
      <span class="ai-metric-value">${survivalPct}%</span>
    </div>`);

    // Refinement rate.
    if (lc.accepted > 0) {
      const refinePct = ((lc.refinement_rate ?? 0) * 100).toFixed(0);
      items.push(`<div class="ai-metric">
        <span class="ai-metric-label">Needed Refinement</span>
        <span class="ai-metric-value">${refinePct}% of ${lc.accepted} accepted</span>
      </div>`);
    }

    // Focus delta.
    if (cog.focus_delta !== null && cog.focus_delta !== undefined) {
      const delta = cog.focus_delta as number;
      const sign = delta >= 0 ? "+" : "";
      const color = delta >= 0 ? "#22c55e" : "#ef4444";
      items.push(`<div class="ai-metric">
        <span class="ai-metric-label">Focus with AI vs without</span>
        <span class="ai-metric-value" style="color:${color}">${sign}${delta.toFixed(1)} pts</span>
      </div>`);
    }

    // Best AI language.
    const langs = eff.by_language ?? [];
    if (langs.length > 0) {
      const best = langs[0];
      items.push(`<div class="ai-metric">
        <span class="ai-metric-label">Best AI language</span>
        <span class="ai-metric-value">${best.language} (${best.accepted} accepted)</span>
      </div>`);
    }

    // Dependency.
    const active = dep.active_invocations ?? 0;
    const passive = dep.passive_invocations ?? 0;
    if (active + passive > 0) {
      const activePct = Math.round((active / (active + passive)) * 100);
      items.push(`<div class="ai-metric">
        <span class="ai-metric-label">AI Invocations</span>
        <span class="ai-metric-value">${activePct}% active · ${100 - activePct}% passive</span>
      </div>`);
    }

    // Undo rate.
    if (qual.ai_undo_rate > 0) {
      items.push(`<div class="ai-metric">
        <span class="ai-metric-label">AI Code Undo Rate</span>
        <span class="ai-metric-value">${(qual.ai_undo_rate * 100).toFixed(1)}%</span>
      </div>`);
    }

    if (items.length === 0) return "";

    return `
    <details class="section">
      <summary class="section-title">${tr("sidebar.section.aiInsights")}</summary>
      ${items.join("")}
    </details>`;
  }

  // ── Styles ─────────────────────────────────────────────────────────────────

  private _styles(): string {
    return `<style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: transparent;
        padding: 12px 14px;
      }
      .container { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
      .logo-header {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 0 8px;
        border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.18));
      }
      .logo { width: 28px; height: 28px; border-radius: 50%; }
      .logo-text { font-size: 13px; font-weight: 600; letter-spacing: 0.3px; }
      /* Cards: pick a background that contrasts with the sidebar in both
         dark and light themes. editorWidget-background is the standard
         "raised surface" colour and falls through to a translucent layer
         when the active theme doesn't define it. */
      .metric-card {
        background: var(--vscode-editorWidget-background, var(--vscode-input-background, rgba(127,127,127,0.08)));
        border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
        border-radius: 6px; padding: 10px 8px;
        display: flex; flex-direction: column; align-items: center;
        justify-content: center; gap: 4px;
        min-height: 72px;
        text-align: center;
      }
      .metric-card.main { padding: 16px 12px; min-height: 0; }
      .focus-ring {
        width: 64px; height: 64px; border-radius: 50%;
        border: 3px solid var(--color, #a78bfa);
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 0 12px color-mix(in srgb, var(--color, #a78bfa) 35%, transparent);
      }
      .focus-value { font-size: 22px; font-weight: 700; color: var(--color, #a78bfa); line-height: 1; font-variant-numeric: tabular-nums; }
      .focus-label { margin-top: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.3; }
      .ai-ratio { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; line-height: 1.3; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .metric-icon { font-size: 16px; line-height: 1; }
      .metric-label {
        font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.2;
      }
      .metric-value {
        font-size: 12px; font-weight: 600;
        line-height: 1.3;
        word-break: break-word;
      }
      .suggestion {
        font-size: 11px; padding: 8px; border-radius: 4px;
        color: var(--vscode-editorWarning-foreground, #f59e0b);
        background: var(--vscode-inputValidation-warningBackground, rgba(245,158,11,0.1));
        border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(245,158,11,0.3));
      }
      .muted { color: var(--vscode-descriptionForeground); text-align: center; padding: 20px 0; }
      .hint { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; }

      /* Collapsible sections */
      .section { margin-top: 4px; }
      .section-title {
        font-size: 11px; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.5px; cursor: pointer; padding: 6px 0;
        color: var(--vscode-descriptionForeground);
        border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1));
        list-style: none;
      }
      .section-title::before { content: "▶ "; font-size: 8px; }
      details[open] > .section-title::before { content: "▼ "; }

      /* Heatmap */
      .heatmap { display: block; margin: 8px 0; max-width: 100%; }
      .hour-label {
        font-size: 9px; fill: var(--vscode-descriptionForeground);
        text-anchor: middle;
      }

      /* Flow triggers */
      .trigger-list {
        list-style: none; padding: 8px 4px 4px;
        font-size: 12px; line-height: 1.7;
      }
      .trigger-list li::before { content: "→ "; color: var(--vscode-descriptionForeground); }

      /* Commits */
      .commit-row {
        display: flex; align-items: center; gap: 6px;
        padding: 5px 4px; font-size: 11px;
        border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.18));
      }
      .commit-row:last-child { border-bottom: none; }
      .commit-badge {
        font-weight: 700; font-size: 10px; min-width: 20px; text-align: center;
      }
      .commit-msg {
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;
      }

      /* AI Insights */
      .ai-metric {
        display: flex; align-items: center; gap: 6px;
        padding: 6px 4px; font-size: 11px;
        border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,0.18));
      }
      .ai-metric:last-child { border-bottom: none; }
      .ai-metric-label {
        color: var(--vscode-descriptionForeground); min-width: 100px; flex-shrink: 0;
      }
      .ai-metric-value { font-weight: 600; margin-left: auto; text-align: right; }
      .ai-bar {
        flex: 1; height: 6px; border-radius: 3px;
        background: var(--vscode-progressBar-background, var(--vscode-scrollbarSlider-background, rgba(127,127,127,0.30)));
        overflow: hidden; min-width: 60px;
      }
      .ai-bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }

      /* Research-use disclaimer */
      .disclaimer {
        margin-top: 12px;
        padding: 8px 10px;
        display: flex; gap: 6px; align-items: flex-start;
        border-radius: 4px;
        font-size: 10px; line-height: 1.4;
        color: var(--vscode-editorWarning-foreground, #f59e0b);
        background: var(--vscode-inputValidation-warningBackground, rgba(245, 158, 11, 0.08));
        border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(245, 158, 11, 0.3));
      }
      .disclaimer-icon { flex-shrink: 0; }
      .disclaimer-text { opacity: 0.95; }
    </style>`;
  }
}
