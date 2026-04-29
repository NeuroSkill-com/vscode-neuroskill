import * as vscode from "vscode";
import { tr } from "./l10n";

const STATE_KEY = "neuroskill.pauseUntil";

/**
 * Global pause state — checked by every event emitter, notification, and
 * polling timer. Persists across reloads via globalState.
 */
export class PauseState {
  private _statusItem: vscode.StatusBarItem;
  private _onChange = new vscode.EventEmitter<boolean>();
  private _refreshTimer: NodeJS.Timeout | undefined;

  /** Fired whenever paused→active or active→paused. */
  readonly onChange = this._onChange.event;

  constructor(private _context: vscode.ExtensionContext) {
    this._statusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      1,
    );
    this._statusItem.command = "neuroskill.togglePause";
    this._statusItem.show();
    this._render();
    // Re-render every minute so the countdown stays current.
    this._refreshTimer = setInterval(() => this._render(), 60_000);
  }

  /** True if tracking is currently suppressed. */
  isPaused(): boolean {
    const until = this._context.globalState.get<number>(STATE_KEY, 0);
    return until > Date.now();
  }

  /** Pause for `durationMs`. Default: 1 hour. */
  async pause(durationMs = 60 * 60 * 1000): Promise<void> {
    const wasPaused = this.isPaused();
    await this._context.globalState.update(STATE_KEY, Date.now() + durationMs);
    this._render();
    if (!wasPaused) this._onChange.fire(true);
  }

  /** Resume tracking immediately. */
  async resume(): Promise<void> {
    const wasPaused = this.isPaused();
    await this._context.globalState.update(STATE_KEY, 0);
    this._render();
    if (wasPaused) this._onChange.fire(false);
  }

  /** Toggle: paused → active, active → paused 1h. */
  async toggle(): Promise<void> {
    if (this.isPaused()) await this.resume();
    else await this.pause();
  }

  private _render(): void {
    const until = this._context.globalState.get<number>(STATE_KEY, 0);
    const remainingMs = until - Date.now();
    if (remainingMs > 0) {
      const mins = Math.ceil(remainingMs / 60_000);
      const label = mins >= 60 ? `${Math.ceil(mins / 60)}h` : `${mins}m`;
      this._statusItem.text = `$(debug-pause) ${tr("tracking.paused", label)}`;
      this._statusItem.tooltip = tr("tracking.tooltip.paused");
      this._statusItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
    } else {
      this._statusItem.text = `$(eye) ${tr("tracking.active")}`;
      this._statusItem.tooltip = tr("tracking.tooltip.active");
      this._statusItem.backgroundColor = undefined;
      // Auto-fire resume event when timer naturally expires.
      if (until > 0) {
        this._context.globalState.update(STATE_KEY, 0);
        this._onChange.fire(false);
      }
    }
  }

  dispose(): void {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._statusItem.dispose();
    this._onChange.dispose();
  }
}
