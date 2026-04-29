import * as vscode from "vscode";
import { DaemonClient } from "./daemon-client";

interface BreakTiming {
  natural_cycle_mins: number | null;
  suggested_break_interval_mins: number;
  confidence: number;
  focus_curve: { bucket_mins: number; avg_focus: number }[];
}

/**
 * Feature 3: Adaptive Break Coach.
 *
 * NOT Pomodoro — uses the developer's actual EEG-measured focus cycle.
 * Shows a countdown to the predicted focus drop and suggests breaks
 * based on their personal pattern.
 */
export class BreakCoach implements vscode.Disposable {
  private _statusItem: vscode.StatusBarItem;
  private _cycleMins = 0;
  private _sessionStartTime = Date.now();
  private _lastNotification = 0;
  private _breakTaken = false;

  constructor() {
    this._statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1);
    this._statusItem.command = "neuroskill.takeBreak";
  }

  /** Called periodically from BrainMonitor. */
  async refresh(client: DaemonClient): Promise<void> {
    const data = await client.post<BreakTiming>("/brain/break-timing", {});
    if (!data || !data.natural_cycle_mins) return;

    this._cycleMins = data.suggested_break_interval_mins || data.natural_cycle_mins;

    const elapsedMs = Date.now() - this._sessionStartTime;
    const elapsedMins = Math.floor(elapsedMs / 60_000);
    const remaining = Math.max(0, this._cycleMins - (elapsedMins % this._cycleMins));

    if (remaining <= 0) {
      this._statusItem.text = `$(clock) Break time`;
      this._statusItem.tooltip = `You've been focused for ${elapsedMins}m. Your natural cycle is ${this._cycleMins}m.`;
      this._statusItem.color = new vscode.ThemeColor("editorWarning.foreground");
      this._statusItem.show();
      this._maybeNotify(elapsedMins);
    } else if (remaining <= 5) {
      this._statusItem.text = `$(clock) Break in ${remaining}m`;
      this._statusItem.tooltip = `Focus typically drops after ${this._cycleMins}m. ${remaining}m remaining.`;
      this._statusItem.color = undefined;
      this._statusItem.show();
    } else {
      this._statusItem.text = `$(clock) ${remaining}m`;
      this._statusItem.tooltip = `Next break in ${remaining}m (cycle: ${this._cycleMins}m)`;
      this._statusItem.color = undefined;
      this._statusItem.show();
    }
  }

  /** Reset the session timer on significant context change (e.g. idle period). */
  resetSessionIfIdle(continuousWorkMins: number): void {
    // If fatigue data says the user has been idle (continuous_work_mins reset),
    // align the break coach timer.
    if (continuousWorkMins < 5) {
      this._sessionStartTime = Date.now();
    }
  }

  /** User acknowledged a break (resets the timer). */
  takeBreak(): void {
    this._sessionStartTime = Date.now();
    this._breakTaken = true;
    this._statusItem.text = `$(clock) Break taken`;
    this._statusItem.color = undefined;
    setTimeout(() => {
      this._breakTaken = false;
    }, 5000);
    vscode.window.showInformationMessage("Break logged. Timer reset.");
  }

  private _maybeNotify(elapsedMins: number): void {
    const now = Date.now();
    // Max one notification per cycle.
    if (now - this._lastNotification < this._cycleMins * 60_000) return;
    this._lastNotification = now;

    vscode.window
      .showInformationMessage(
        `$(clock) You've been focused for ${elapsedMins}m. Your natural cycle is ${this._cycleMins}m — take a break?`,
        "Take Break",
        "Dismiss",
      )
      .then((choice) => {
        if (choice === "Take Break") this.takeBreak();
      });
  }

  dispose(): void {
    this._statusItem.dispose();
  }
}
