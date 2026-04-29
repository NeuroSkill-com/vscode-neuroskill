import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// VS Code's `vscode.l10n.t()` API treats its first argument as the English
// source string, not a key — for English locales it returns the argument
// unchanged. Our bundles are keyed by string identifiers (e.g.
// "connect.connectedTooltip"), so calling vscode.l10n.t(key) renders the raw
// key on English VS Code. This loader resolves keys against the existing
// bundle files for every locale, including English.

let bundle: Record<string, string> = {};

export function loadBundle(extensionFsPath: string): void {
  const locale = (vscode.env.language || "en").toLowerCase();
  const candidates = [
    `bundle.l10n.${locale}.json`,
    locale.includes("-") ? `bundle.l10n.${locale.split("-")[0]}.json` : null,
    "bundle.l10n.json",
  ].filter((s): s is string => s !== null);

  for (const name of candidates) {
    const p = path.join(extensionFsPath, "l10n", name);
    try {
      const raw = fs.readFileSync(p, "utf-8");
      bundle = JSON.parse(raw);
      return;
    } catch {
      // try next candidate
    }
  }
}

export function tr(key: string, ...args: unknown[]): string {
  let msg = bundle[key] ?? key;
  for (let i = 0; i < args.length; i++) {
    msg = msg.split(`{${i}}`).join(String(args[i]));
  }
  return msg;
}
