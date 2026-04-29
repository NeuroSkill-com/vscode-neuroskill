import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";
import { getConfig, getDaemonUrl, discoverDaemonPort, resetDiscoveredPort, type Config } from "./config";
import { EventCollector, type VscodeEvent } from "./events";
import { BrainMonitor } from "./brain";
import { DaemonClient } from "./daemon-client";
import { AIActivityTracker } from "./ai-tracker";
import { SidebarProvider } from "./sidebar";
import { FocusCodeLensProvider } from "./codelens-provider";
import { PauseState } from "./pause-state";
import { getOutputChannel, log, disposeOutput } from "./output";
import { notify } from "./notifier";
import { ValidationManager } from "./validation";
import { loadBundle, tr } from "./l10n";

let collector: EventCollector | undefined;
let flushTimer: NodeJS.Timeout | undefined;
let connectionItem: vscode.StatusBarItem | undefined;
let brainMonitor: BrainMonitor | undefined;
let cachedToken: string | undefined;
let connected = false;
let eventsSent = 0;

// Feature instances
let daemonClient: DaemonClient | undefined;
let aiTracker: AIActivityTracker | undefined;
let sidebarProvider: SidebarProvider | undefined;
let codeLensProvider: FocusCodeLensProvider | undefined;
let pauseState: PauseState | undefined;
let validation: ValidationManager | undefined;

/** Read the daemon auth token from the standard config location. */
function readAuthToken(): string | undefined {
  try {
    const configDir =
      process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support")
        : process.platform === "win32"
          ? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
          : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
    const tokenPath = path.join(configDir, "skill", "daemon", "auth.token");
    return fs.readFileSync(tokenPath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

function updateConnectionStatus(): void {
  if (!connectionItem) return;
  if (connected) {
    connectionItem.text = tr("connect.connected");
    connectionItem.tooltip = tr("connect.connectedTooltip", eventsSent);
    connectionItem.color = undefined;
    connectionItem.backgroundColor = undefined;
  } else {
    connectionItem.text = tr("connect.disconnected");
    connectionItem.tooltip = tr("connect.disconnectedTooltip");
    connectionItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
    connectionItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const config = getConfig();
  if (!config.enabled) return;

  // Load i18n bundle for the current locale before any t() call below.
  loadBundle(context.extensionUri.fsPath);

  // Output channel — first thing so all subsequent code can log.
  const channel = getOutputChannel();
  context.subscriptions.push(channel);
  log.info(tr("output.startupBanner", config.daemonHost, config.daemonPort || "auto"));

  cachedToken = readAuthToken();

  // ── Commands (registered FIRST so any status bar item or external
  //     trigger always finds a handler, even if a later init step throws.
  //     Handlers safely guard their dependencies with `?.`) ───────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("neuroskill.reconnect", async () => {
      resetDiscoveredPort();
      cachedToken = readAuthToken();
      daemonClient?.setToken(cachedToken);
      connected = false;
      updateConnectionStatus();
      const port = await discoverDaemonPort(config);
      try {
        const headers: Record<string, string> = {};
        if (cachedToken) headers["Authorization"] = `Bearer ${cachedToken}`;
        const resp = await fetch(`http://${config.daemonHost}:${port}/v1/activity/current-window`, {
          headers, signal: AbortSignal.timeout(3000),
        });
        connected = resp.ok || resp.status === 401;
      } catch { connected = false; }
      updateConnectionStatus();
      if (connected) {
        vscode.window.showInformationMessage(tr("connect.success", port));
      } else {
        vscode.window.showWarningMessage(tr("connect.failure"));
      }
    }),

    vscode.commands.registerCommand("neuroskill.showBrainStatus", async () => {
      if (!daemonClient) return;
      try {
        const [flow, fatigue, streak] = await Promise.allSettled([
          daemonClient.post<any>("/brain/flow-state", { windowSecs: 300 }),
          daemonClient.get<any>("/brain/fatigue"),
          daemonClient.post<any>("/brain/streak", { minDeepWorkMins: 60 }),
        ]);
        const f = flow.status === "fulfilled" ? flow.value : null;
        const a = fatigue.status === "fulfilled" ? fatigue.value : null;
        const s = streak.status === "fulfilled" ? streak.value : null;
        const lines: string[] = [];
        if (f?.in_flow) lines.push(`$(flame) IN FLOW for ${Math.floor(f.duration_secs / 60)}m`);
        else if (f) lines.push(`Focus score: ${f.score?.toFixed(0) ?? "?"}/100`);
        if (a?.fatigued) lines.push(`$(warning) Fatigued — ${a.suggestion}`);
        else lines.push("Energy: stable");
        if (s?.current_streak_days > 0) lines.push(`$(zap) ${s.current_streak_days}-day deep work streak`);
        lines.push(`Today: ${s?.today_deep_mins ?? 0}m deep work`);
        const aiRatio = aiTracker?.getOverallAIRatio() ?? 0;
        if (aiRatio > 0.01) lines.push(`Human: ${((1 - aiRatio) * 100).toFixed(0)}% | AI: ${(aiRatio * 100).toFixed(0)}%`);
        vscode.window.showInformationMessage(lines.join("  |  "));
      } catch (err) {
        log.error("brain status fetch failed", err);
        vscode.window.showWarningMessage(tr("report.statusFailed"));
      }
    }),

    vscode.commands.registerCommand("neuroskill.showReport", async () => {
      if (!daemonClient) return;
      const _d = new Date(); _d.setHours(0, 0, 0, 0);
      const todayStart = Math.floor(_d.getTime() / 1000);
      try {
        const report = await daemonClient.post<any>("/brain/daily-report", { dayStart: todayStart });
        if (!report?.periods?.length) {
          vscode.window.showInformationMessage(tr("report.empty"));
          return;
        }
        const lines = report.periods.map((p: any) =>
          `${p.period}: focus ${p.avg_focus?.toFixed(0) ?? "?"}  |  ${p.files_touched} files  |  ${p.churn} lines`
        );
        lines.push(
          `\n${tr("report.bestPeriod", report.best_period, report.productivity_score?.toFixed(0))}`,
        );
        vscode.window.showInformationMessage(`${tr("report.title")}\n${lines.join("\n")}`);
      } catch (err) {
        log.error("daily report fetch failed", err);
        vscode.window.showWarningMessage(tr("report.fetchFailed"));
      }
    }),

    vscode.commands.registerCommand("neuroskill.amIStuck", async () => {
      if (!daemonClient) return;
      try {
        const result = await daemonClient.post<any>("/brain/struggle-predict", { windowSecs: 600 });
        if (result?.struggling) {
          vscode.window.showWarningMessage(
            tr("stuck.warning", result.score?.toFixed(0), result.suggestion),
          );
        } else {
          vscode.window.showInformationMessage(
            tr("stuck.fine", result?.score?.toFixed(0) ?? 0),
          );
        }
      } catch (err) {
        log.error("struggle check failed", err);
        vscode.window.showWarningMessage(tr("stuck.checkFailed"));
      }
    }),

    vscode.commands.registerCommand("neuroskill.bestTimeToCode", async () => {
      if (!daemonClient) return;
      const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
      try {
        const result = await daemonClient.post<any>("/brain/optimal-hours", { since: weekAgo, topN: 3 });
        const best = (result?.best_hours ?? []).map((h: number) => `${h}:00`).join(", ");
        const worst = (result?.worst_hours ?? []).map((h: number) => `${h}:00`).join(", ");
        const noData = tr("best.notEnoughData");
        vscode.window.showInformationMessage(
          tr("best.message", best || noData, worst || "n/a"),
        );
      } catch (err) {
        log.error("optimal hours fetch failed", err);
        vscode.window.showWarningMessage(tr("best.fetchFailed"));
      }
    }),

    vscode.commands.registerCommand("neuroskill.showFilesNeedingReview", () => {
      codeLensProvider?.showFilesNeedingReview();
    }),

    vscode.commands.registerCommand("neuroskill.toggleFlowShield", () => {
      brainMonitor?.getFlowShield()?.toggle();
    }),

    vscode.commands.registerCommand("neuroskill.takeBreak", () => {
      brainMonitor?.getBreakCoach()?.takeBreak();
    }),

    vscode.commands.registerCommand("neuroskill.togglePause", async () => {
      await pauseState?.toggle();
    }),

    vscode.commands.registerCommand("neuroskill.pauseTracking", async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: tr("pause.30m"), durationMs: 30 * 60_000 },
          { label: tr("pause.1h"), durationMs: 60 * 60_000 },
          { label: tr("pause.4h"), durationMs: 4 * 60 * 60_000 },
          { label: tr("pause.untilTomorrow"), durationMs: 24 * 60 * 60_000 },
        ],
        { placeHolder: tr("pause.placeholder") },
      );
      if (choice) await pauseState?.pause(choice.durationMs);
    }),

    vscode.commands.registerCommand("neuroskill.resumeTracking", async () => {
      await pauseState?.resume();
    }),

    vscode.commands.registerCommand("neuroskill.showOutput", () => {
      getOutputChannel().show(true);
    }),

    vscode.commands.registerCommand("neuroskill.openValidationSettings", async () => {
      await validation?.openSettings();
    }),

    vscode.commands.registerCommand("neuroskill.checkValidationPrompt", async () => {
      await validation?.tick();
    }),
  );

  // ── Pause state (must come before things that check it) ──────────────
  pauseState = new PauseState(context);
  context.subscriptions.push(pauseState);
  // Trigger an immediate brain monitor refresh on pause/resume so the status
  // bar reflects state without waiting for the next 30s tick.
  context.subscriptions.push(
    pauseState.onChange(() => brainMonitor?.refresh()),
  );

  // ── Shared daemon client ──────────────────────────────────────────────
  daemonClient = new DaemonClient(config, cachedToken);

  // ── Human vs AI tracker ───────────────────────────────────────────────
  aiTracker = new AIActivityTracker();
  context.subscriptions.push(aiTracker);

  // ── Connection status indicator (right side) ──────────────────────────
  connectionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
  connectionItem.command = "neuroskill.reconnect";
  connectionItem.show();
  context.subscriptions.push(connectionItem);
  updateConnectionStatus();

  // ── Sidebar brain panel ────────────────────────────────────────────────
  sidebarProvider = new SidebarProvider(context.extensionUri);
  sidebarProvider.setClient(daemonClient);
  sidebarProvider.setAITracker(aiTracker);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider),
  );

  // ── Event collector ───────────────────────────────────────────────────
  collector = new EventCollector(config);
  collector.setAITracker(aiTracker);
  collector.setPauseState(pauseState);
  collector.setExcludePatterns(config.excludePaths);
  collector.setOnCommit((message) => {
    // When a commit is detected, record it with focus score for the sidebar.
    if (sidebarProvider && daemonClient) {
      const isAI = aiTracker?.isCommitAIAssisted() ?? false;
      daemonClient.post<any>("/brain/flow-state", { windowSecs: 60 }).then((flow) => {
        const score = flow?.score ?? 0;
        sidebarProvider!.recordCommit(message, score, isAI ? "ai" : "human");
      }).catch(() => {
        sidebarProvider!.recordCommit(message, 0, isAI ? "ai" : "human");
      });
    }
  });
  collector.start();
  context.subscriptions.push(collector);

  // ── Brain state monitor (left side status bar + features 2,3,4,7) ────
  brainMonitor = new BrainMonitor(config, daemonClient, pauseState);
  brainMonitor.start();
  context.subscriptions.push(brainMonitor);

  // ── CodeLens provider (Feature 1) ─────────────────────────────────────
  if (config.focusCodeLens) {
    codeLensProvider = new FocusCodeLensProvider(daemonClient, aiTracker);
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLensProvider),
      codeLensProvider,
    );
  }

  // ── Flush timer ───────────────────────────────────────────────────────
  flushTimer = setInterval(() => flush(config), config.batchIntervalMs);
  context.subscriptions.push({ dispose: () => clearInterval(flushTimer) });

  // ── Validation prompt scheduler (KSS / TLX-fallback / PVT-nudge) ──────
  validation = new ValidationManager(daemonClient);
  validation.start();
  context.subscriptions.push(validation);

  // ── Config watcher ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("neuroskill")) {
        const newConfig = getConfig();
        if (!newConfig.enabled) deactivate();
        if (e.affectsConfiguration("neuroskill.excludePaths")) {
          collector?.setExcludePatterns(newConfig.excludePaths);
        }
      }
    }),
  );

  // ── Initial connection check ──────────────────────────────────────────
  vscode.commands.executeCommand("neuroskill.reconnect");

  // Send initial file_focus
  if (vscode.window.activeTextEditor) {
    const doc = vscode.window.activeTextEditor.document;
    collector.drain();
    sendBatch(config, [{ type: "file_focus", path: doc.uri.fsPath, language: doc.languageId }]);
  }
}

async function flush(config: Config): Promise<void> {
  if (!collector) return;
  if (pauseState?.isPaused()) {
    collector.drain(); // discard while paused
    return;
  }
  const events = collector.drain();
  if (events.length === 0) return;
  await sendBatch(config, events);
}

async function sendBatch(config: Config, events: VscodeEvent[]): Promise<void> {
  const port = await discoverDaemonPort(config);
  const url = getDaemonUrl(config, port);
  if (!cachedToken) cachedToken = readAuthToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cachedToken) headers["Authorization"] = `Bearer ${cachedToken}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(events),
      signal: AbortSignal.timeout(3000),
    });
    if (resp.ok) {
      if (!connected) { connected = true; updateConnectionStatus(); }
      eventsSent += events.length;
      updateConnectionStatus();
    } else if (resp.status === 401) {
      cachedToken = undefined;
      if (!connected) { connected = true; updateConnectionStatus(); }
    }
  } catch {
    if (connected) { connected = false; resetDiscoveredPort(); updateConnectionStatus(); }
  }
}

export function deactivate(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = undefined; }
  if (collector) {
    const events = collector.drain();
    if (events.length > 0) sendBatch(getConfig(), events);
    collector.dispose();
    collector = undefined;
  }
  if (brainMonitor) { brainMonitor.dispose(); brainMonitor = undefined; }
  if (sidebarProvider) { sidebarProvider.dispose(); sidebarProvider = undefined; }
  if (connectionItem) { connectionItem.dispose(); connectionItem = undefined; }
  if (aiTracker) { aiTracker.dispose(); aiTracker = undefined; }
  if (codeLensProvider) { codeLensProvider.dispose(); codeLensProvider = undefined; }
  if (pauseState) { pauseState.dispose(); pauseState = undefined; }
  if (validation) { validation.dispose(); validation = undefined; }
  disposeOutput();
}
