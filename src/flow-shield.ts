import * as vscode from "vscode";

interface FlowState {
  in_flow: boolean;
  score: number;
  duration_secs: number;
}

/**
 * Feature 2: Smart Interruption Shield.
 *
 * When the developer enters flow state, automatically suppresses
 * notifications and shows a subtle "In Flow" indicator.
 */
export class FlowShield implements vscode.Disposable {
  private _active = false;
  private _statusItem: vscode.StatusBarItem;
  private _manualOverride: boolean | null = null; // null = auto

  constructor() {
    this._statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this._statusItem.command = "neuroskill.toggleFlowShield";
  }

  /** Called every 30s from BrainMonitor with the latest flow state. */
  update(flow: FlowState | null): void {
    if (!flow) return;

    // Manual override takes precedence.
    const shouldBeActive =
      this._manualOverride !== null ? this._manualOverride : flow.in_flow;

    if (shouldBeActive && !this._active) {
      this._activate(flow);
    } else if (!shouldBeActive && this._active) {
      this._deactivate();
    } else if (this._active) {
      // Update duration display.
      const mins = Math.floor(flow.duration_secs / 60);
      this._statusItem.text = `$(shield) In Flow ${mins}m`;
    }
  }

  toggle(): void {
    if (this._manualOverride === null) {
      // Auto mode → force on.
      this._manualOverride = true;
    } else if (this._manualOverride) {
      // Forced on → force off.
      this._manualOverride = false;
    } else {
      // Forced off → back to auto.
      this._manualOverride = null;
    }
  }

  private _activate(flow: FlowState): void {
    this._active = true;
    const mins = Math.floor(flow.duration_secs / 60);
    this._statusItem.text = `$(shield) In Flow ${mins}m`;
    this._statusItem.tooltip = "Flow Shield active — notifications suppressed. Click to toggle.";
    this._statusItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.prominentBackground",
    );
    this._statusItem.show();

    // Try to enable VSCode DND (1.88+).
    try {
      vscode.workspace
        .getConfiguration("notifications")
        .update("doNotDisturbMode", true, vscode.ConfigurationTarget.Global);
    } catch {
      // Older VSCode — just show the indicator.
    }
  }

  private _deactivate(): void {
    this._active = false;
    this._statusItem.hide();

    // Restore notifications.
    try {
      vscode.workspace
        .getConfiguration("notifications")
        .update("doNotDisturbMode", false, vscode.ConfigurationTarget.Global);
    } catch {
      // Older VSCode.
    }
  }

  dispose(): void {
    if (this._active) this._deactivate();
    this._statusItem.dispose();
  }
}
