import * as vscode from "vscode";
import { tr } from "./l10n";

let _channel: vscode.OutputChannel | undefined;

/** Lazily create and return the shared NeuroSkill output channel. */
export function getOutputChannel(): vscode.OutputChannel {
  if (!_channel) {
    _channel = vscode.window.createOutputChannel(tr("output.channelName"));
  }
  return _channel;
}

/** Append a timestamped line at the given level. */
function logAt(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  getOutputChannel().appendLine(`[${ts}] ${level} ${msg}`);
}

export const log = {
  info: (msg: string) => logAt("INFO", msg),
  warn: (msg: string) => logAt("WARN", msg),
  error: (msg: string, err?: unknown) => {
    const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : err ? String(err) : "";
    logAt("ERROR", detail ? `${msg} :: ${detail}` : msg);
  },
};

export function disposeOutput(): void {
  _channel?.dispose();
  _channel = undefined;
}
