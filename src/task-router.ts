import * as vscode from "vscode";

interface FlowState {
  in_flow: boolean;
  score: number;
  duration_secs: number;
  avg_focus: number | null;
}

interface TaskType {
  task_type: string;
  confidence: number;
}

/**
 * Feature 7: Optimal Task Router.
 *
 * When focus level changes significantly, suggests task types that
 * match the developer's current cognitive state.
 */
export class TaskRouter implements vscode.Disposable {
  private _lastSuggestionTime = 0;
  private _lastFocusScore = -1;
  private static readonly COOLDOWN_MS = 900_000; // 15 min

  /** Called every 30s from BrainMonitor. */
  check(flow: FlowState | null, task: TaskType | null): void {
    if (!flow) return;

    const score = flow.score ?? flow.avg_focus ?? -1;
    if (score < 0) return;

    const now = Date.now();
    if (now - this._lastSuggestionTime < TaskRouter.COOLDOWN_MS) {
      this._lastFocusScore = score;
      return;
    }

    // Only suggest when focus changes by >20 points.
    if (this._lastFocusScore >= 0 && Math.abs(score - this._lastFocusScore) < 20) {
      return;
    }

    const prevScore = this._lastFocusScore;
    this._lastFocusScore = score;

    // Don't fire on first reading.
    if (prevScore < 0) return;

    this._lastSuggestionTime = now;

    const currentTask = task?.task_type ?? "coding";
    let message: string;
    let icon: string;

    if (score > 75) {
      icon = "$(flame)";
      message = `Focus is high (${score.toFixed(0)}) — great time for complex work like refactoring or new features.`;
    } else if (score > 45) {
      icon = "$(eye)";
      message = `Focus moderate (${score.toFixed(0)}) — good for code review, testing, or incremental tasks.`;
    } else {
      icon = "$(coffee)";
      message = `Focus low (${score.toFixed(0)}) — consider documentation, routine tasks, or a break.`;
    }

    vscode.window.showInformationMessage(`${icon} ${message}`);
  }

  dispose(): void {
    // Nothing to clean up.
  }
}
