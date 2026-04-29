import * as vscode from "vscode";

export interface Config {
  enabled: boolean;
  daemonHost: string;
  daemonPort: number;
  trackUndos: boolean;
  trackDiagnostics: boolean;
  batchIntervalMs: number;
  // Feature toggles
  focusCodeLens: boolean;
  flowShield: boolean;
  breakCoach: boolean;
  struggleBridge: boolean;
  flowTriggers: boolean;
  focusCommits: boolean;
  taskRouter: boolean;
  eegHeatmap: boolean;
  excludePaths: string[];
  notifications: "all" | "critical" | "off";
  systemNotifications: "never" | "critical" | "always";
}

export function getConfig(): Config {
  const cfg = vscode.workspace.getConfiguration("neuroskill");
  return {
    enabled: cfg.get<boolean>("enabled", true),
    daemonHost: cfg.get<string>("daemonHost", "127.0.0.1"),
    daemonPort: cfg.get<number>("daemonPort", 0), // 0 = autodiscover
    trackUndos: cfg.get<boolean>("trackUndos", true),
    trackDiagnostics: cfg.get<boolean>("trackDiagnostics", true),
    batchIntervalMs: cfg.get<number>("batchIntervalMs", 2000),
    focusCodeLens: cfg.get<boolean>("focusCodeLens", true),
    flowShield: cfg.get<boolean>("flowShield", true),
    breakCoach: cfg.get<boolean>("breakCoach", true),
    struggleBridge: cfg.get<boolean>("struggleBridge", true),
    flowTriggers: cfg.get<boolean>("flowTriggers", true),
    focusCommits: cfg.get<boolean>("focusCommits", true),
    taskRouter: cfg.get<boolean>("taskRouter", true),
    eegHeatmap: cfg.get<boolean>("eegHeatmap", true),
    excludePaths: cfg.get<string[]>("excludePaths", [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/build/**",
      "**/target/**",
      "**/.venv/**",
      "**/__pycache__/**",
    ]),
    notifications: cfg.get<"all" | "critical" | "off">("notifications", "critical"),
    systemNotifications: cfg.get<"never" | "critical" | "always">("systemNotifications", "never"),
  };
}

/** Try production port (18444), then dev port (18445). Cache the result. */
let discoveredPort: number | null = null;

export async function discoverDaemonPort(config: Config): Promise<number> {
  // User explicitly set a port — use it.
  if (config.daemonPort > 0) return config.daemonPort;
  // Already discovered.
  if (discoveredPort) return discoveredPort;

  const candidates = [18444, 18445];
  for (const port of candidates) {
    try {
      const resp = await fetch(`http://${config.daemonHost}:${port}/v1/activity/current-window`, {
        signal: AbortSignal.timeout(1500),
      });
      // Even 401 (unauthorized) means the daemon is there.
      if (resp.status < 500) {
        discoveredPort = port;
        return port;
      }
    } catch {
      // not listening
    }
  }
  // Fallback to production port.
  discoveredPort = 18444;
  return 18444;
}

/** Reset discovered port — called when connection fails to trigger re-discovery. */
export function resetDiscoveredPort(): void {
  discoveredPort = null;
}

export function getDaemonUrl(config: Config, port: number): string {
  return `http://${config.daemonHost}:${port}/v1/activity/vscode-events`;
}
