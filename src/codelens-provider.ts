import * as vscode from "vscode";
import { DaemonClient } from "./daemon-client";
import { AIActivityTracker } from "./ai-tracker";

interface CognitiveLoadRow {
  key: string;
  avg_focus: number | null;
  avg_undos: number;
  interactions: number;
  load_score: number;
}

/**
 * Feature 1: Focus-Aware Code Review Flags.
 *
 * Shows CodeLens at the top of files that were edited during low focus
 * periods. Distinguishes human-authored code from AI-assisted code so
 * developers know which files genuinely need human review.
 */
export class FocusCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  private _cache = new Map<string, { focus: number; undos: number }>();
  private _refreshTimer: NodeJS.Timeout | undefined;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private _client: DaemonClient,
    private _aiTracker: AIActivityTracker,
  ) {
    // Refresh data every 30s.
    this._refreshTimer = setInterval(() => this._refreshData(), 30_000);
    this._refreshData();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== "file") return [];

    const path = document.uri.fsPath;
    const data = this._cache.get(path);
    if (!data) return [];

    const aiRatio = this._aiTracker.getAIRatioForFile(path);
    const lenses: vscode.CodeLens[] = [];
    const range = new vscode.Range(0, 0, 0, 0);

    if (aiRatio > 0.7) {
      // Mostly AI-generated — flag it differently.
      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(robot) AI-Assisted (${(aiRatio * 100).toFixed(0)}%) — focus score not applicable`,
          command: "",
        }),
      );
    } else if (data.focus < 50) {
      // Low focus, mostly human — needs review.
      const focusStr = data.focus.toFixed(0);
      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(warning) Low Focus (${focusStr}) — Review Recommended`,
          command: "neuroskill.showFilesNeedingReview",
        }),
      );
    } else if (data.focus < 70) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(info) Focus: ${data.focus.toFixed(0)}/100`,
          command: "",
        }),
      );
    }

    return lenses;
  }

  /** Command: show a QuickPick of files that need review (low focus, human-authored). */
  async showFilesNeedingReview(): Promise<void> {
    const items: vscode.QuickPickItem[] = [];
    for (const [path, data] of this._cache) {
      const aiRatio = this._aiTracker.getAIRatioForFile(path);
      if (data.focus < 50 && aiRatio < 0.5) {
        const fileName = path.split("/").pop() ?? path;
        items.push({
          label: `$(warning) ${fileName}`,
          description: `Focus: ${data.focus.toFixed(0)} | Undos: ${data.undos}`,
          detail: path,
        });
      }
    }

    if (items.length === 0) {
      vscode.window.showInformationMessage("No files need review — all human-authored code was written with good focus.");
      return;
    }

    items.sort((a, b) => {
      const fa = this._cache.get(a.detail!)?.focus ?? 100;
      const fb = this._cache.get(b.detail!)?.focus ?? 100;
      return fa - fb;
    });

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Files edited during low focus (human-authored)",
    });
    if (pick?.detail) {
      const doc = await vscode.workspace.openTextDocument(pick.detail);
      await vscode.window.showTextDocument(doc);
    }
  }

  private async _refreshData(): Promise<void> {
    const rows = await this._client.post<CognitiveLoadRow[]>("/brain/cognitive-load", {
      groupBy: "file",
    });
    if (!rows) return;

    this._cache.clear();
    for (const row of rows) {
      if (row.avg_focus !== null) {
        this._cache.set(row.key, { focus: row.avg_focus, undos: row.avg_undos });
      }
    }
    this._onDidChange.fire();
  }

  dispose(): void {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    this._onDidChange.dispose();
    this._disposables.forEach((d) => d.dispose());
  }
}
