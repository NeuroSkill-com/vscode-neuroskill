import * as vscode from "vscode";
import { type Config } from "./config";
import { DaemonClient } from "./daemon-client";
import { FlowShield } from "./flow-shield";
import { BreakCoach } from "./break-coach";
import { StruggleBridge } from "./struggle-bridge";
import { TaskRouter } from "./task-router";
import type { PauseState } from "./pause-state";
import { notify } from "./notifier";
import { tr } from "./l10n";

interface FlowState {
  in_flow: boolean;
  score: number;
  duration_secs: number;
  avg_focus: number | null;
  file_switches: number;
  edit_velocity: number;
}

interface FatigueAlert {
  fatigued: boolean;
  focus_decline_pct: number;
  continuous_work_mins: number;
  suggestion: string;
}

interface DeepWorkStreak {
  current_streak_days: number;
  today_deep_mins: number;
  today_qualifies: boolean;
}

/** Poll brain state and update the StatusBarItem + drive all brain-loop features. */
export class BrainMonitor implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private statusItem: vscode.StatusBarItem;
  private lastFatigueAlert = 0;

  // Brain-loop features
  private flowShield: FlowShield | undefined;
  private breakCoach: BreakCoach | undefined;
  private struggleBridge: StruggleBridge | undefined;
  private taskRouter: TaskRouter | undefined;
  private pauseState: PauseState | undefined;

  constructor(
    private config: Config,
    private client: DaemonClient,
    pauseState?: PauseState,
  ) {
    this.pauseState = pauseState;
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusItem.show();

    // Initialize brain-loop features based on config.
    if (config.flowShield) this.flowShield = new FlowShield();
    if (config.breakCoach) this.breakCoach = new BreakCoach();
    if (config.struggleBridge) this.struggleBridge = new StruggleBridge();
    if (config.taskRouter) this.taskRouter = new TaskRouter();

    this.update(); // immediate first poll
  }

  start(): void {
    this.timer = setInterval(() => this.update(), 30_000);
  }

  /** Trigger an immediate update — called when pause state toggles. */
  refresh(): void {
    this.update().catch(() => {});
  }

  getFlowShield(): FlowShield | undefined {
    return this.flowShield;
  }

  getBreakCoach(): BreakCoach | undefined {
    return this.breakCoach;
  }

  private async update(): Promise<void> {
    // Skip while paused — no polling, no status bar churn, no notifications.
    if (this.pauseState?.isPaused()) {
      this.statusItem.text = tr("brain.paused");
      this.statusItem.tooltip = tr("brain.tooltip.paused");
      this.statusItem.color = undefined;
      return;
    }
    const [flow, fatigue, streak, taskType] = await Promise.allSettled([
      this.client.post<FlowState>("/brain/flow-state", { windowSecs: 300 }),
      this.client.get<FatigueAlert>("/brain/fatigue"),
      this.client.post<DeepWorkStreak>("/brain/streak", { minDeepWorkMins: 60 }),
      this.client.post<{ task_type: string; confidence: number }>("/brain/task-type", { windowSecs: 300 }),
    ]);

    const f = flow.status === "fulfilled" ? flow.value : null;
    const a = fatigue.status === "fulfilled" ? fatigue.value : null;
    const s = streak.status === "fulfilled" ? streak.value : null;
    const t = taskType.status === "fulfilled" ? taskType.value : null;

    // Build status text — compact, hacker-friendly
    const parts: string[] = [];

    // Task type icon
    if (t?.task_type) {
      const icons: Record<string, string> = {
        coding: "$(code)", debugging: "$(debug)", reviewing: "$(eye)",
        refactoring: "$(wrench)", testing: "$(beaker)", reading_docs: "$(book)",
      };
      parts.push(icons[t.task_type] ?? `$(question) ${t.task_type}`);
    }

    if (f?.in_flow) {
      const mins = Math.floor(f.duration_secs / 60);
      parts.push(`$(flame) flow ${mins}m`);
    } else if (f && f.score > 0) {
      parts.push(`$(pulse) ${f.score.toFixed(0)}`);
    }

    if (a?.fatigued) {
      parts.push("$(warning) tired");
    }

    if (s && s.current_streak_days > 0) {
      parts.push(`$(zap) ${s.current_streak_days}d`);
    }

    if (parts.length === 0) {
      this.statusItem.text = "$(brain) idle";
      this.statusItem.color = undefined;
    } else {
      this.statusItem.text = parts.join("  ");
      this.statusItem.color = f?.in_flow
        ? new vscode.ThemeColor("charts.green")
        : a?.fatigued
          ? new vscode.ThemeColor("charts.yellow")
          : undefined;
    }

    // Tooltip with full details
    const tipLines: string[] = ["NeuroSkill Brain"];
    if (f) {
      tipLines.push(`Flow: ${f.in_flow ? "YES" : "no"} (score ${f.score.toFixed(0)})`);
      if (f.avg_focus != null) tipLines.push(`Focus: ${f.avg_focus.toFixed(0)}/100`);
      tipLines.push(`Velocity: ${f.edit_velocity.toFixed(1)} lines/min`);
      tipLines.push(`Switches: ${f.file_switches}`);
    }
    if (a) {
      tipLines.push(`Fatigue: ${a.fatigued ? "DECLINING" : "stable"} (${a.focus_decline_pct.toFixed(0)}%)`);
      tipLines.push(`Continuous work: ${a.continuous_work_mins}m`);
    }
    if (s) {
      tipLines.push(`Streak: ${s.current_streak_days}d | Today: ${s.today_deep_mins}m`);
    }
    this.statusItem.tooltip = tipLines.join("\n");

    // Fatigue notification (max once per 30 min) — routed through the
    // notifier so it honors the user's notifications/systemNotifications
    // settings. Severity is "critical" because fatigue suggests user action.
    if (a?.fatigued) {
      const now = Date.now();
      if (now - this.lastFatigueAlert > 30 * 60 * 1000) {
        this.lastFatigueAlert = now;
        notify(`$(warning) ${a.suggestion}`, {
          severity: "critical",
          kind: "warning",
          actions: [
            tr("fatigue.suggestionAction"),
            tr("fatigue.dismiss"),
          ],
        }).catch(() => {});
      }
    }

    // ── Brain-loop features ──────────────────────────────────────────────
    // Feature 2: Flow Shield
    this.flowShield?.update(f);

    // Feature 3: Break Coach
    if (this.breakCoach) {
      // Sync break coach timer with actual continuous work from fatigue data.
      if (a) this.breakCoach.resetSessionIfIdle(a.continuous_work_mins);
      this.breakCoach.refresh(this.client).catch(() => {});
    }

    // Feature 4: Struggle → AI Bridge (replaces old inline struggle notification)
    if (this.struggleBridge) {
      this.struggleBridge.check(this.client).catch(() => {});
    }

    // Feature 7: Task Router
    this.taskRouter?.check(f, t);
  }

  dispose(): void {
    // Stop polling first to prevent updates during cleanup.
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    // Dispose features before UI.
    this.flowShield?.dispose();
    this.breakCoach?.dispose();
    this.struggleBridge?.dispose();
    this.taskRouter?.dispose();
    this.statusItem.dispose();
  }
}
