import * as vscode from "vscode";
import * as cp from "child_process";
import { getConfig } from "./config";
import { log } from "./output";
import { tr } from "./l10n";

/**
 * Severity drives whether a notification fires under each user setting.
 *
 * - `critical`: user action recommended (fatigue, struggle, errors). Shows under
 *   `notifications: "critical"` and above. Escalates to OS under `systemNotifications: "critical"|"always"`.
 * - `info`: coaching and tips (best time, daily report, ack messages). Shows
 *   only under `notifications: "all"`. Escalates only under `systemNotifications: "always"`.
 */
export type Severity = "critical" | "info";

export type NotifyKind = "info" | "warning";

interface NotifyOptions {
  severity: Severity;
  kind?: NotifyKind;
  /** Action button labels. Returned promise resolves to the chosen label, or undefined. */
  actions?: string[];
}

/**
 * Show a notification respecting the user's `notifications` and
 * `systemNotifications` settings. Always logs to the output channel.
 */
export async function notify(message: string, opts: NotifyOptions): Promise<string | undefined> {
  const cfg = getConfig();

  // Always record in the output channel.
  log.info(`notify[${opts.severity}]: ${message}`);

  // Decide whether to show the in-VSCode toast.
  let showToast = false;
  if (cfg.notifications === "all") showToast = true;
  else if (cfg.notifications === "critical" && opts.severity === "critical") showToast = true;
  // "off" → no toast

  // Decide whether to escalate to OS notification.
  let showSystem = false;
  if (cfg.systemNotifications === "always") showSystem = true;
  else if (cfg.systemNotifications === "critical" && opts.severity === "critical") showSystem = true;

  // Fire the OS notification (best-effort, fully async).
  if (showSystem) {
    fireSystemNotification(message).catch((err) => {
      log.error("system notification failed", err);
    });
  }

  // Fire the VSCode toast (returns the user's button choice).
  if (!showToast) return undefined;
  const fn = opts.kind === "warning"
    ? vscode.window.showWarningMessage
    : vscode.window.showInformationMessage;
  return fn(message, ...(opts.actions ?? []));
}

/**
 * Best-effort OS-native notification using platform built-ins:
 * - macOS: `osascript -e 'display notification ... with title ...'`
 * - Linux: `notify-send`
 * - Windows: PowerShell BurntToast fallback to msg
 *
 * Strings are passed via argv (not interpolated into shell), so user-provided
 * text cannot inject commands.
 */
async function fireSystemNotification(message: string): Promise<void> {
  const title = tr("notify.brainAlert");
  return new Promise((resolve, reject) => {
    let cmd: string;
    let args: string[];
    if (process.platform === "darwin") {
      cmd = "osascript";
      const escapedMsg = message.replace(/"/g, '\\"');
      const escapedTitle = title.replace(/"/g, '\\"');
      args = ["-e", `display notification "${escapedMsg}" with title "${escapedTitle}"`];
    } else if (process.platform === "linux") {
      cmd = "notify-send";
      args = [title, message];
    } else if (process.platform === "win32") {
      cmd = "powershell.exe";
      const psMsg = message.replace(/'/g, "''");
      const psTitle = title.replace(/'/g, "''");
      args = [
        "-NoProfile",
        "-Command",
        `[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime] | Out-Null; ` +
          `Add-Type -AssemblyName System.Windows.Forms; ` +
          `[System.Windows.Forms.MessageBox]::Show('${psMsg}','${psTitle}') | Out-Null`,
      ];
    } else {
      return reject(new Error(`unsupported platform: ${process.platform}`));
    }
    const child = cp.execFile(cmd, args, { timeout: 5000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
    child.on("error", reject);
  });
}
