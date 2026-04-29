import * as vscode from "vscode";
import { DaemonClient } from "./daemon-client";
import { log } from "./output";
import { tr } from "./l10n";

/**
 * Validation channel — opt-in research-instrument prompts (KSS / NASA-TLX /
 * PVT) that calibrate the Break Coach and Focus Score against external
 * measures.  Documented in extensions/vscode/README.md "Validation roadmap".
 *
 * The daemon owns the scheduler.  This module is a dumb client: it polls
 * `/validation/should-prompt`, renders the appropriate UI, and posts answers
 * back.  No timing, gating, or rate-limiting logic lives here.
 */

interface PromptDecision {
  kind: "kss" | "tlx" | "pvt" | "none";
  triggered_by?: string;
  reason?: string;
  prompt_id?: number;
  task_kind?: string;
}

interface SnoozeChoice {
  outcome: "answered" | "snoozed" | "dismissed" | "disabled_today" | "disabled_perm";
  snoozeSecs?: number;
}

const KSS_LABELS: Record<number, string> = {
  1: "1 — Extremely alert",
  2: "2 — Very alert",
  3: "3 — Alert",
  4: "4 — Rather alert",
  5: "5 — Neither alert nor sleepy",
  6: "6 — Some signs of sleepiness",
  7: "7 — Sleepy, no effort to stay awake",
  8: "8 — Sleepy, some effort to stay awake",
  9: "9 — Very sleepy, fighting sleep",
};

export class ValidationManager implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly client: DaemonClient) {}

  /** Begin the polling loop.  Idempotent — repeated calls are no-ops. */
  start(): void {
    if (this.timer) return;
    // 90 s cadence is conservative; the daemon's own rate limiter is the
    // ground truth.  We just need to give it a chance to fire when the
    // user's flow state changes.
    this.timer = setInterval(() => {
      void this.tick();
    }, 90_000);
    // Fire one tick on startup so users opting in see prompts within seconds.
    setTimeout(() => void this.tick(), 5_000);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One polling iteration.  Public for testability + manual command. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const decision = await this.client.get<PromptDecision>(
        "/validation/should-prompt?surface=vscode",
      );
      if (!decision || decision.kind === "none") return;
      switch (decision.kind) {
        case "kss":
          await this.handleKss(decision);
          break;
        case "tlx":
          // VS Code is the fallback surface for TLX; main UI is Tauri.
          await this.handleTlxFallback(decision);
          break;
        case "pvt":
          // PVT must run in Tauri (timing accuracy).  We only nudge.
          await this.handlePvtNudge(decision);
          break;
      }
    } catch (e) {
      log.error("validation tick failed", e);
    } finally {
      this.busy = false;
    }
  }

  // ── KSS ─────────────────────────────────────────────────────────────────

  private async handleKss(decision: PromptDecision): Promise<void> {
    const items: (vscode.QuickPickItem & { _value: number | "snooze" | "off_today" | "off_perm" })[] = [];
    for (const score of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      items.push({
        label: tr(`validation.kss.${score}`),
        description: KSS_LABELS[score],
        _value: score,
      });
    }
    items.push(
      {
        label: tr("validation.action.snooze30m"),
        description: tr("validation.action.snoozeDesc"),
        _value: "snooze",
        kind: vscode.QuickPickItemKind.Separator as any,
      } as any,
      { label: tr("validation.action.snooze30m"), _value: "snooze" },
      { label: tr("validation.action.disableToday"), _value: "off_today" },
      { label: tr("validation.action.disablePerm"), _value: "off_perm" },
    );

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: tr("validation.kss.prompt"),
      ignoreFocusOut: false,
    });
    if (!pick) {
      // user pressed Esc — dismiss without answering
      if (decision.prompt_id !== undefined) {
        await this.client.post("/validation/close-prompt", {
          prompt_id: decision.prompt_id,
          outcome: "dismissed",
        });
      }
      return;
    }

    if (typeof pick._value === "number") {
      await this.client.post("/validation/kss", {
        score: pick._value,
        triggered_by: decision.triggered_by ?? "unknown",
        surface: "vscode",
        in_flow: false, // daemon already gated; prompt would not have fired in flow
        focus_score: null,
        fatigue_idx: null,
        prompt_id: decision.prompt_id,
      });
    } else {
      await this.applyEscape(pick._value, "kss", decision.prompt_id);
    }
  }

  // ── TLX (VS Code fallback — minimal webview) ────────────────────────────

  private async handleTlxFallback(decision: PromptDecision): Promise<void> {
    // Primary TLX UI lives in the Tauri preferences pane; here we offer to
    // open it, plus the same escape hatches the KSS prompt has.
    const open = tr("validation.tlx.openInApp");
    const snooze = tr("validation.action.snooze30m");
    const disableToday = tr("validation.action.disableToday");
    const disablePerm = tr("validation.action.disablePerm");
    const choice = await vscode.window.showInformationMessage(
      tr("validation.tlx.prompt"),
      open,
      snooze,
      disableToday,
      disablePerm,
    );
    if (!choice) {
      if (decision.prompt_id !== undefined) {
        await this.client.post("/validation/close-prompt", {
          prompt_id: decision.prompt_id,
          outcome: "dismissed",
        });
      }
      return;
    }
    if (choice === open) {
      // Best-effort deep link; if Tauri isn't running the user just gets a no-op.
      await vscode.env.openExternal(vscode.Uri.parse("neuroskill://validation/tlx"));
      return;
    }
    if (choice === snooze) {
      await this.applyEscape("snooze", "tlx", decision.prompt_id);
    } else if (choice === disableToday) {
      await this.applyEscape("off_today", "tlx", decision.prompt_id);
    } else if (choice === disablePerm) {
      await this.applyEscape("off_perm", "tlx", decision.prompt_id);
    }
  }

  // ── PVT (one-line nudge — task itself runs in Tauri) ────────────────────

  private async handlePvtNudge(decision: PromptDecision): Promise<void> {
    const open = tr("validation.pvt.openInApp");
    const skipWeek = tr("validation.pvt.skipWeek");
    const disablePerm = tr("validation.action.disablePerm");
    const choice = await vscode.window.showInformationMessage(
      tr("validation.pvt.prompt"),
      open,
      skipWeek,
      disablePerm,
    );
    if (!choice) {
      if (decision.prompt_id !== undefined) {
        await this.client.post("/validation/close-prompt", {
          prompt_id: decision.prompt_id,
          outcome: "dismissed",
        });
      }
      return;
    }
    if (choice === open) {
      await vscode.env.openExternal(vscode.Uri.parse("neuroskill://validation/pvt"));
      return;
    }
    if (choice === skipWeek) {
      // Snooze for 6 days so the next weekly reminder fires on schedule.
      await this.client.post("/validation/snooze", {
        channel: "pvt",
        duration_secs: 6 * 86_400,
      });
      if (decision.prompt_id !== undefined) {
        await this.client.post("/validation/close-prompt", {
          prompt_id: decision.prompt_id,
          outcome: "snoozed",
        });
      }
    } else if (choice === disablePerm) {
      await this.applyEscape("off_perm", "pvt", decision.prompt_id);
    }
  }

  // ── Common escape-hatch handling ────────────────────────────────────────

  private async applyEscape(
    action: SnoozeChoice["outcome"] | "snooze" | "off_today" | "off_perm",
    channel: "kss" | "tlx" | "pvt",
    promptId?: number,
  ): Promise<void> {
    if (action === "snooze") {
      await this.client.post("/validation/snooze", {
        channel,
        duration_secs: 30 * 60,
      });
      if (promptId !== undefined) {
        await this.client.post("/validation/close-prompt", {
          prompt_id: promptId,
          outcome: "snoozed",
        });
      }
    } else if (action === "off_today") {
      await this.client.post("/validation/disable-today", { channel });
      if (promptId !== undefined) {
        await this.client.post("/validation/close-prompt", {
          prompt_id: promptId,
          outcome: "disabled_today",
        });
      }
    } else if (action === "off_perm") {
      // Permanent: flip the channel's `enabled = false` in persistent config.
      const patch: Record<string, unknown> = {};
      patch[channel] = { enabled: false };
      await this.client.patch("/validation/config", patch);
      if (promptId !== undefined) {
        await this.client.post("/validation/close-prompt", {
          prompt_id: promptId,
          outcome: "disabled_perm",
        });
      }
      vscode.window.showInformationMessage(
        tr("validation.action.disabledPermAck", channel.toUpperCase()),
      );
    }
  }

  // ── Manual commands ─────────────────────────────────────────────────────

  /** Open the Tauri Validation settings pane.  No-op if Tauri isn't running. */
  async openSettings(): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse("neuroskill://validation/settings"));
  }
}
