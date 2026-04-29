import * as vscode from "vscode";
import type { Config } from "./config";
import type { AIActivityTracker } from "./ai-tracker";
import type { PauseState } from "./pause-state";

/**
 * Compile a minimal glob pattern (`**`, `*`, `?`) to a matcher.
 * Matches against the full file path; case-insensitive.
 */
function globToMatcher(glob: string): (path: string) => boolean {
  // Escape regex metacharacters except glob ones
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 2;
      // Eat trailing slash on `**/`
      if (glob[i] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+^$|()[]{}\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  const compiled = new RegExp("(^|/)" + re + "($|/)", "i");
  return (path: string) => compiled.test(path);
}

/** A single event to send to the daemon. */
export interface VscodeEvent {
  type: string;
  path?: string;
  language?: string;
  lines_added?: number;
  lines_removed?: number;
  undo?: boolean;
  errors?: number;
  warnings?: number;
  hints?: number;
  line?: number;
  selections?: number;
  command?: string;
  exit_code?: number;
  breakpoint_count?: number;
  /** "human" or "ai" — classifies whether this event was human-authored or AI-assisted. */
  source?: string;
  // Extended fields for deep analytics
  fix_latency_secs?: number;
  severity?: string;
  dwell_secs?: number;
  read_secs?: number;
  write_secs?: number;
  chars_per_min?: number;
  backspace_rate?: number;
  framework?: string;
  cycle_detected?: boolean;
  start_line?: number;
  end_line?: number;
}

/** Callback fired when a git commit is detected. */
export type OnCommitCallback = (message: string) => void;

/** Manages VS Code event listeners and produces VscodeEvent objects. */
export class EventCollector implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private queue: VscodeEvent[] = [];
  private editDebounce: NodeJS.Timeout | undefined;
  private pendingEdits = new Map<string, { added: number; removed: number; undo: boolean }>();
  private _aiTracker?: AIActivityTracker;
  private _onCommit?: OnCommitCallback;
  private _pauseState?: PauseState;
  private _excludeMatchers: ((path: string) => boolean)[] = [];

  // ── Signal state ──────────────────────────────────────────────────────
  // Error recovery: diagnostic snapshots per file.
  private _diagSnapshots = new Map<string, { errors: number; firstSeen: number }>();
  // File dwell: track focus time.
  private _currentFocus: { path: string; ts: number; editCount: number } | null = null;
  // Typing velocity: character accumulator.
  private _recentChars: { ts: number; chars: number }[] = [];
  private _recentBackspaces = 0;
  private _velocityTimer?: NodeJS.Timeout;
  // Test TDD cycle detection.
  private _lastTestTs = 0;
  private _editAfterTest = false;

  constructor(private config: Config) {}

  /** Set the AI activity tracker for human/AI edit classification. */
  setAITracker(tracker: AIActivityTracker): void {
    this._aiTracker = tracker;
  }

  /** Set a callback for when git commits are detected. */
  setOnCommit(cb: OnCommitCallback): void {
    this._onCommit = cb;
  }

  /** Set the pause state — events are dropped while paused. */
  setPauseState(p: PauseState): void {
    this._pauseState = p;
  }

  /** Set glob patterns to exclude from tracking. */
  setExcludePatterns(patterns: string[]): void {
    this._excludeMatchers = patterns.map((p) => globToMatcher(p));
  }

  /** Check whether a file path is excluded from tracking. */
  private isExcluded(path: string | undefined): boolean {
    if (!path) return false;
    return this._excludeMatchers.some((m) => m(path));
  }

  /** Push an event unless tracking is paused or the path is excluded. */
  private push(event: VscodeEvent): void {
    if (this._pauseState?.isPaused()) return;
    if (this.isExcluded(event.path)) return;
    this.push(event);
  }

  /** Start listening to VS Code events. */
  start(): void {
    // File focus changes + dwell time tracking (Signal 2)
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // Emit dwell time for the previous file.
        if (this._currentFocus) {
          const dwell = Math.floor((Date.now() - this._currentFocus.ts) / 1000);
          if (dwell > 5) {
            const editTime = Math.min(dwell, this._currentFocus.editCount * 3); // rough estimate
            this.push({
              type: "file_dwell",
              path: this._currentFocus.path,
              dwell_secs: dwell,
              write_secs: editTime,
              read_secs: Math.max(0, dwell - editTime),
            });
          }
        }
        if (!editor) {
          this._currentFocus = null;
          return;
        }
        const doc = editor.document;
        this._currentFocus = { path: doc.uri.fsPath, ts: Date.now(), editCount: 0 };
        this.push({
          type: "file_focus",
          path: doc.uri.fsPath,
          language: doc.languageId,
        });
      })
    );

    // Text document changes (debounced per file) + AI lifecycle + typing velocity
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== "file") return;
        const path = e.document.uri.fsPath;
        const pending = this.pendingEdits.get(path) ?? { added: 0, removed: 0, undo: false };
        const isUndo = this.config.trackUndos && (
          e.reason === vscode.TextDocumentChangeReason.Undo ||
          e.reason === vscode.TextDocumentChangeReason.Redo
        );

        for (const change of e.contentChanges) {
          const linesRemoved = change.range.end.line - change.range.start.line;
          const linesAdded = change.text.split("\n").length - 1;
          pending.added += linesAdded;
          pending.removed += linesRemoved;
        }

        // Detect undo: VS Code fires document changes with reason
        if (isUndo) {
          pending.undo = true;
        }

        this.pendingEdits.set(path, pending);
        this.scheduleEditFlush();

        // Track edit count for dwell time ratio.
        if (this._currentFocus?.path === path) this._currentFocus.editCount++;

        // Typing velocity accumulator (Signal 3).
        let totalChars = 0;
        for (const change of e.contentChanges) {
          totalChars += change.text.length;
          if (change.rangeLength > 0 && change.text.length === 0) this._recentBackspaces++;
        }
        if (totalChars > 0) {
          this._recentChars.push({ ts: Date.now(), chars: totalChars });
          this._editAfterTest = true; // TDD tracking
        }

        // AI lifecycle check: did this edit modify recent AI-generated code?
        if (this._aiTracker) {
          for (const change of e.contentChanges) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            const linesAdded = change.text.split("\n").length - 1;
            const linesRemoved = endLine - startLine;
            const lifecycle = this._aiTracker.checkPostAIEdit(
              path, startLine, endLine, isUndo, linesAdded, linesRemoved,
            );
            if (lifecycle) {
              this.push({
                type: lifecycle,
                path,
                language: e.document.languageId,
                source: "ai",
              });
              break; // One lifecycle event per document change.
            }
          }
        }
      })
    );

    // File save
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.scheme !== "file") return;
        this.push({ type: "save", path: doc.uri.fsPath });
      })
    );

    // Diagnostics changes
    if (this.config.trackDiagnostics) {
      this.disposables.push(
        vscode.languages.onDidChangeDiagnostics((e) => {
          for (const uri of e.uris) {
            if (uri.scheme !== "file") continue;
            const diags = vscode.languages.getDiagnostics(uri);
            let errors = 0, warnings = 0, hints = 0;
            for (const d of diags) {
              if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
              else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
              else hints++;
            }
            this.push({
              type: "diagnostics",
              path: uri.fsPath,
              errors,
              warnings,
              hints,
            });
          }
        })
      );
    }

    // Debug sessions
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((s) => {
        this.push({ type: "debug_start", language: s.type });
      }),
      vscode.debug.onDidTerminateDebugSession(() => {
        this.push({ type: "debug_stop" });
      }),
    );

    // Breakpoint changes
    this.disposables.push(
      vscode.debug.onDidChangeBreakpoints(() => {
        const total = vscode.debug.breakpoints.length;
        this.push({ type: "breakpoint_change", breakpoint_count: total });
      }),
    );

    // Task execution
    this.disposables.push(
      vscode.tasks.onDidStartTask((e) => {
        this.push({ type: "task_start", command: e.execution.task.name });
      }),
      vscode.tasks.onDidEndTaskProcess((e) => {
        this.push({ type: "task_end", command: e.execution.task.name, exit_code: e.exitCode });
      }),
    );

    // File open/close
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.uri.scheme === "file") this.push({ type: "file_open", path: doc.uri.fsPath, language: doc.languageId });
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        if (doc.uri.scheme === "file") this.push({ type: "file_close", path: doc.uri.fsPath });
      }),
    );

    // Scroll / visible range changes (debounced 2s — tracks reading vs editing)
    let scrollDebounce: NodeJS.Timeout | undefined;
    this.disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (scrollDebounce) clearTimeout(scrollDebounce);
        scrollDebounce = setTimeout(() => {
          const doc = e.textEditor.document;
          if (doc.uri.scheme !== "file") return;
          const ranges = e.visibleRanges;
          if (ranges.length > 0) {
            this.push({
              type: "scroll",
              path: doc.uri.fsPath,
              line: ranges[0].start.line,
              selections: ranges.length,
            });
          }
        }, 2000);
      }),
    );

    // ── Command-based events (high value for brain correlation) ──────────

    // Track specific VS Code commands that indicate developer intent/state.
    // ── Inferred command tracking ────────────────────────────────────────
    // VS Code doesn't expose a generic command execution event, so we detect
    // by monitoring editor state changes that result from these commands.
    // We can't intercept commands directly without overriding them, so we
    // use a keybinding-based approach in package.json contributes.keybindings
    // OR we simply detect the effects (selection changes, file changes, etc.)
    //
    // For now, we track these via a periodic command history check.
    // The most reliable approach: use `vscode.commands.registerCommand` with
    // a wrapper that calls the original — but only for commands we "own".
    // For built-in commands, we infer from state changes.

    // Git commands — detect via SCM state changes (reliable)
    const scm = vscode.scm;
    if (scm.inputBox) {
      // Detect commit by watching input box value clear
      let lastInput = "";
      const scmTimer = setInterval(() => {
        // Skip when paused or window unfocused — saves polling churn.
        if (this._pauseState?.isPaused()) return;
        if (!vscode.window.state.focused) return;
        const current = scm.inputBox?.value ?? "";
        if (lastInput.length > 0 && current.length === 0) {
          const isAI = this._aiTracker?.isCommitAIAssisted() ?? false;
          this.push({
            type: "git_commit",
            command: lastInput,
            source: isAI ? "ai" : "human",
          });
          this._aiTracker?.clearCommitAIFlag();
          this._onCommit?.(lastInput);
        }
        lastInput = current;
      }, 5000);
      this.disposables.push({ dispose: () => clearInterval(scmTimer) });
    }

    // Track go-to-definition/references via selection jump detection
    let lastLine = -1;
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.scheme !== "file") return;
        const line = e.selections[0]?.active.line ?? 0;
        // Large jump (>20 lines) = likely go-to-definition or find result
        if (lastLine >= 0 && Math.abs(line - lastLine) > 20) {
          this.push({
            type: "code_jump",
            path: e.textEditor.document.uri.fsPath,
            line,
            selections: e.selections.length,
          });
        }
        lastLine = line;
        // Multi-cursor detection
        if (e.selections.length > 1) {
          this.push({
            type: "multi_cursor",
            path: e.textEditor.document.uri.fsPath,
            selections: e.selections.length,
          });
        }
      }),
    );

    // Tab group changes — micro context switches
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        // Already tracked as file_focus in the main listener above,
        // but also count multi-cursor selections.
        if (editor && editor.selections.length > 1) {
          this.push({
            type: "multi_cursor",
            path: editor.document.uri.fsPath,
            selections: editor.selections.length,
          });
        }
      }),
    );

    // Visible editors — split view / reference reading
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        this.push({
          type: "visible_editors",
          selections: editors.length,
        });
      }),
    );

    // Tab group changes
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        this.push({
          type: "tab_groups_changed",
          selections: vscode.window.tabGroups.all.length,
        });
      }),
    );

    // Workspace folder changes — major project switches
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const added of e.added) {
          this.push({ type: "workspace_add", path: added.uri.fsPath });
        }
        for (const removed of e.removed) {
          this.push({ type: "workspace_remove", path: removed.uri.fsPath });
        }
      }),
    );

    // Extension changes — workflow evolution
    this.disposables.push(
      vscode.extensions.onDidChange(() => {
        this.push({ type: "extensions_changed" });
      }),
    );

    // Detect Live Share sessions
    const liveshare = vscode.extensions.getExtension("MS-vsliveshare.vsliveshare");
    if (liveshare) {
      this.push({ type: "liveshare_available" });
    }

    // ── 1. Command execution tracking ─────────────────────────────────────
    // High-value developer intent signals — debounced to avoid noise.
    const trackedCmds = new Set([
      // Navigation / comprehension
      "editor.action.revealDefinition", "editor.action.goToDeclaration",
      "editor.action.goToReferences", "editor.action.peekDefinition",
      "editor.action.goToTypeDefinition", "editor.action.goToImplementation",
      // Search
      "actions.find", "editor.action.startFindReplaceAction",
      "workbench.action.findInFiles", "workbench.action.quickOpen",
      // Refactoring
      "editor.action.rename", "editor.action.quickFix",
      "editor.action.codeAction", "editor.action.refactor",
      // Formatting / cleanup
      "editor.action.formatDocument", "editor.action.organizeImports",
      // Folding
      "editor.fold", "editor.unfold", "editor.foldAll", "editor.unfoldAll",
      // Git
      "git.commit", "git.push", "git.pull", "git.checkout",
      "git.stage", "git.unstage", "git.stash",
      // AI / Copilot
      "inlineChat.start", "github.copilot.interactiveEditor.explain",
      "github.copilot.interactiveEditor.fix", "github.copilot.interactiveEditor.generate",
      "github.copilot.git.generateCommitMessage", "git.commitMessageGenerate",
      // Layout / focus management
      "workbench.action.toggleZenMode", "workbench.action.splitEditor",
      "workbench.action.terminal.toggleTerminal", "workbench.action.toggleSidebarVisibility",
      "workbench.action.togglePanel",
      // Debug
      "workbench.action.debug.start", "workbench.action.debug.stop",
      "workbench.action.debug.continue", "workbench.action.debug.stepOver",
      // Snippets
      "editor.action.insertSnippet",
      // Clipboard (replaces clipboard polling — no readText() needed)
      "editor.action.clipboardPasteAction",
      "editor.action.clipboardCopyAction",
      "editor.action.clipboardCutAction",
    ]);
    let lastCmdTs = 0;
    // VS Code 1.90+ exposes onDidExecuteCommand on the commands namespace.
    // For older versions, this is a no-op (the event doesn't exist).
    const onCmd = (vscode.commands as any).onDidExecuteCommand;
    if (typeof onCmd === "function") {
      this.disposables.push(
        onCmd((e: { command: string }) => {
          if (!trackedCmds.has(e.command)) return;
          const now = Date.now();
          if (now - lastCmdTs < 500) return; // debounce 500ms
          lastCmdTs = now;
          const editor = vscode.window.activeTextEditor;
          this.push({
            type: "command",
            command: e.command,
            path: editor?.document.uri.fsPath,
            language: editor?.document.languageId,
          });
        }),
      );
    }

    // ── 2. IntelliSense / autocomplete acceptance ────────────────────────
    // Track when completion items are accepted via text document changes.
    // Heuristic: multi-character single-line insertion (>8 chars, no newlines,
    // no range replacement) that follows an inline suggestion commit command.
    // The char threshold of 8 avoids false positives from fast typing of
    // short identifiers like "const" or "return".
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== "file") return;
        if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) return;
        for (const change of e.contentChanges) {
          // Completion insertion: multi-char (>8), single-line, no newlines, no replacement
          if (change.text.length > 8 && !change.text.includes("\n") && change.rangeLength === 0) {
            this.push({
              type: "completion_accepted",
              path: e.document.uri.fsPath,
              language: e.document.languageId,
              lines_added: change.text.length,
              source: "ai",
            });
            this._aiTracker?.recordCompletionAccepted(
              e.document.uri.fsPath,
              change.text.length,
              change.range.start.line,
              change.range.start.line + (change.text.split("\n").length - 1),
            );
            break;
          }
          // Paste heuristic: multi-line insertion of >8 chars with no replacement.
          // Detected without reading the clipboard (no permission churn).
          // Reuses the daemon's existing `clipboard_change` handler.
          if (change.text.length > 8 && change.text.includes("\n") && change.rangeLength === 0) {
            this.push({
              type: "clipboard_change",
              path: e.document.uri.fsPath,
              language: e.document.languageId,
              lines_added: change.text.split("\n").length,
            });
            break;
          }
        }
      }),
    );

    // ── 3. Paste tracking (no clipboard reads — privacy-preserving) ──────
    // We used to poll vscode.env.clipboard.readText() every 5s, which on
    // macOS Sonoma+ triggers the system "Paste from…" indicator and shows
    // the extension in Privacy & Security logs. Instead, we detect pastes
    // by listening for the paste command and reading the resulting document
    // change — no clipboard access required.

    // ── 4. Terminal activity ─────────────────────────────────────────────
    this.disposables.push(
      vscode.window.onDidOpenTerminal(() => {
        this.push({ type: "terminal_created", selections: vscode.window.terminals.length });
      }),
      vscode.window.onDidCloseTerminal(() => {
        this.push({ type: "terminal_closed", selections: vscode.window.terminals.length });
      }),
      vscode.window.onDidChangeActiveTerminal((t) => {
        if (t) {
          this.push({ type: "terminal_focus", command: t.name });
        }
      }),
    );

    // ── 5. Environment context (one-time capture) ────────────────────────
    this.push({
      type: "env_context",
      command: JSON.stringify({
        appHost: vscode.env.appHost,
        remoteName: vscode.env.remoteName ?? "local",
        shell: vscode.env.shell,
        uiKind: vscode.env.uiKind === vscode.UIKind.Desktop ? "desktop" : "web",
        language: vscode.env.language,
      }),
    });

    // ── 6. Code lens clicks ──────────────────────────────────────────────
    // Detected indirectly: when a code lens triggers navigation (go-to-ref),
    // the command tracking above catches it. For reference count lenses,
    // we detect via the "editor.action.showReferences" command if available.
    if (trackedCmds.has("editor.action.showReferences") === false) {
      trackedCmds.add("editor.action.showReferences");
    }

    // ── 7. Command palette frequency ─────────────────────────────────────
    // Ctrl+Shift+P / Cmd+Shift+P opens the command palette. Track via
    // the command that opens it (already in trackedCmds as workbench.action.quickOpen).
    // Also track the "show all commands" variant.
    trackedCmds.add("workbench.action.showCommands");

    // ── 8. File system watcher (selective) ───────────────────────────────
    // Watch for key project files changing externally (git pull, CI, deps).
    const watcher = vscode.workspace.createFileSystemWatcher("**/{package.json,Cargo.toml,go.mod,requirements.txt,.git/HEAD}");
    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => {
        this.push({ type: "project_file_changed", path: uri.fsPath });
      }),
      watcher.onDidCreate((uri) => {
        this.push({ type: "project_file_created", path: uri.fsPath });
      }),
      watcher.onDidDelete((uri) => {
        this.push({ type: "project_file_deleted", path: uri.fsPath });
      }),
    );

    // Detect AI extensions
    const aiExtensions = ["GitHub.copilot", "Codeium.codeium", "Continue.continue", "sourcegraph.cody-ai"];
    for (const ext of aiExtensions) {
      if (vscode.extensions.getExtension(ext)) {
        this.push({ type: "ai_extension_detected", command: ext });
      }
    }

    // ── Signal 1: Error recovery timing ──────────────────────────────────
    // Track how fast developers fix errors.
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics((e) => {
        for (const uri of e.uris) {
          if (uri.scheme !== "file") continue;
          const diags = vscode.languages.getDiagnostics(uri);
          const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
          const path = uri.fsPath;
          const prev = this._diagSnapshots.get(path);
          if (prev && errors < prev.errors) {
            // Errors decreased — developer fixed something.
            const latency = Math.floor((Date.now() - prev.firstSeen) / 1000);
            this.push({
              type: "error_fixed",
              path,
              fix_latency_secs: latency,
              severity: "error",
              errors,
            });
          }
          if (errors > 0) {
            if (!prev || errors > prev.errors) {
              this._diagSnapshots.set(path, { errors, firstSeen: Date.now() });
            }
          } else {
            this._diagSnapshots.delete(path);
          }
        }
      }),
    );

    // ── Signal 3: Typing velocity (sampled every 30s) ────────────────────
    this._velocityTimer = setInterval(() => {
      const now = Date.now();
      const cutoff = now - 30_000;
      const recent = this._recentChars.filter((c) => c.ts > cutoff);
      if (recent.length === 0) return; // No editing in last 30s.
      const totalChars = recent.reduce((s, c) => s + c.chars, 0);
      const cpm = Math.round(totalChars * 2); // 30s window → multiply by 2 for per-minute
      const totalEdits = recent.length;
      const backspaceRate = totalEdits > 0 ? this._recentBackspaces / totalEdits : 0;
      this.push({
        type: "typing_velocity",
        chars_per_min: cpm,
        backspace_rate: Math.round(backspaceRate * 100) / 100,
      });
      this._recentChars = [];
      this._recentBackspaces = 0;
    }, 30_000);

    // ── Signal 4: Test execution tracking ────────────────────────────────
    const testPattern = /\b(test|jest|pytest|mocha|vitest|cargo.test|go.test|rspec|phpunit|unittest)\b/i;
    this.disposables.push(
      vscode.tasks.onDidEndTaskProcess((e) => {
        const name = e.execution.task.name;
        if (!testPattern.test(name)) return;
        const exitCode = e.exitCode ?? -1;
        // TDD cycle detection: test → edit → test within 5 min.
        const now = Date.now();
        const cycleDetected = this._lastTestTs > 0 && this._editAfterTest && now - this._lastTestTs < 300_000;
        this._lastTestTs = now;
        this._editAfterTest = false;
        // Extract framework name.
        const match = name.match(testPattern);
        const framework = match ? match[0].toLowerCase() : "";
        this.push({
          type: "test_run",
          command: name,
          exit_code: exitCode,
          framework,
          cycle_detected: cycleDetected,
        });
      }),
    );

    // ── Signal 5: Documentation access ───────────────────────────────────
    // Add doc commands to tracked set (hover, parameter hints, trigger suggest).
    if (typeof (vscode.commands as any).onDidExecuteCommand === "function") {
      const docCmds = new Set([
        "editor.action.showHover",
        "editor.action.triggerParameterHints",
        "editor.action.triggerSuggest",
      ]);
      this.disposables.push(
        (vscode.commands as any).onDidExecuteCommand((e: { command: string }) => {
          if (!docCmds.has(e.command)) return;
          const editor = vscode.window.activeTextEditor;
          this.push({
            type: "doc_access",
            command: e.command,
            path: editor?.document.uri.fsPath,
            language: editor?.document.languageId,
          });
        }),
      );
    }

    // ── Signal 6: File create/delete/rename ──────────────────────────────
    this.disposables.push(
      vscode.workspace.onDidCreateFiles((e) => {
        for (const uri of e.files) {
          this.push({ type: "file_created", path: uri.fsPath });
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const uri of e.files) {
          this.push({ type: "file_deleted", path: uri.fsPath });
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { newUri } of e.files) {
          this.push({ type: "file_renamed", path: newUri.fsPath });
        }
      }),
    );
  }

  /** Flush pending edit events after debounce period. */
  private scheduleEditFlush(): void {
    if (this.editDebounce) clearTimeout(this.editDebounce);
    this.editDebounce = setTimeout(() => {
      for (const [path, edit] of this.pendingEdits) {
        if (edit.added > 0 || edit.removed > 0) {
          // Classify as human or AI via the tracker.
          const source = this._aiTracker
            ? this._aiTracker.recordEdit(path, edit.added + edit.removed)
            : "human";
          this.push({
            type: "edit",
            path,
            lines_added: edit.added,
            lines_removed: edit.removed,
            undo: edit.undo,
            source,
          });
        }
      }
      this.pendingEdits.clear();
    }, 500);
  }

  /** Drain all queued events. */
  drain(): VscodeEvent[] {
    const events = this.queue;
    this.queue = [];
    return events;
  }

  dispose(): void {
    if (this.editDebounce) clearTimeout(this.editDebounce);
    if (this._velocityTimer) clearInterval(this._velocityTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
