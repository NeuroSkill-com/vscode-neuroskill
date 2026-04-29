import * as vscode from "vscode";
import { DaemonClient } from "./daemon-client";
import { notify } from "./notifier";
import { tr } from "./l10n";

interface StrugglePrediction {
  struggling: boolean;
  score: number;
  current_file: string;
  suggestion: string;
  factors: {
    undo_rate: number;
    edit_velocity_drop: number;
    focus_score: number | null;
    time_on_file_mins: number;
  };
}

/**
 * Feature 4: Struggle → AI Assist Bridge.
 *
 * When the developer is struggling on a file (detected via EEG + undo rate +
 * velocity drop), proactively offers to open AI assistance. Tracks whether
 * the AI help actually improved focus.
 */
export class StruggleBridge implements vscode.Disposable {
  private _lastSuggestion = new Map<string, number>(); // file → timestamp
  private _preSuggestionFocus = new Map<string, number>();
  private static readonly DEBOUNCE_MS = 600_000; // 10 min per file

  /** Called from BrainMonitor update loop. */
  async check(client: DaemonClient): Promise<void> {
    const result = await client.post<StrugglePrediction>("/brain/struggle-predict", {
      windowSecs: 600,
    });
    if (!result || !result.struggling) return;

    const file = result.current_file;
    if (!file) return;

    // Debounce per file.
    const lastTime = this._lastSuggestion.get(file) ?? 0;
    if (Date.now() - lastTime < StruggleBridge.DEBOUNCE_MS) return;

    this._lastSuggestion.set(file, Date.now());
    if (result.factors.focus_score !== null) {
      this._preSuggestionFocus.set(file, result.factors.focus_score);
    }

    const fileName = file.split("/").pop() ?? file;
    const score = result.score.toFixed(0);

    const openCopilot = tr("stuck.openCopilot");
    const openTerminal = tr("stuck.openTerminal");
    const stepBack = tr("stuck.stepBack");
    const dismiss = tr("stuck.dismiss");
    const message = tr("stuck.message", fileName, score, result.suggestion);

    const choice = await notify(message, {
      severity: "critical",
      kind: "info",
      actions: [openCopilot, openTerminal, stepBack, dismiss],
    });

    if (choice === openCopilot) {
      // Try Copilot Chat first, fall back to generic chat.
      try {
        await vscode.commands.executeCommand("github.copilot.interactiveSession.new");
      } catch {
        try {
          await vscode.commands.executeCommand("workbench.action.chat.open");
        } catch {
          await notify(tr("stuck.noChat"), { severity: "info" });
        }
      }
    } else if (choice === openTerminal) {
      await vscode.commands.executeCommand("workbench.action.terminal.toggleTerminal");
    }
  }

  dispose(): void {
    // Nothing to clean up.
  }
}
