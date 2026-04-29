# Changelog

All notable changes to the NeuroSkill VS Code extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/).

## [0.0.1] — 2026-04-28

Initial public release.

### Added
- Sidebar webview with live focus score, in-flow timer, energy / mode / deep-work / streak cards, focus heatmap, flow recipe, focus-scored recent commits, and 7-day AI insights.
- Two status-bar indicators: live brain state (left) and daemon connection (right).
- Command palette: Show Brain Status, Today's Brain Report, Am I Stuck?, Best Time to Code, Show Files Needing Review, Toggle Flow Shield, Take a Break, Pause / Resume Tracking, Reconnect to Daemon, Show Output.
- Auto-discovery of the NeuroSkill daemon on `127.0.0.1:18444` (production) and `18445` (dev). Auth token read from the user config dir.
- AI activity attribution for GitHub Copilot, Codeium, Continue, and Cody, plus inline-chat acceptance events.
- Privacy guarantees: file content and clipboard content are never read or transmitted; only metadata leaves VS Code, and only to localhost.
- Configurable feature toggles for Flow Shield, Break Coach, Struggle Bridge, Flow Triggers, Focus Commits, Task Router, EEG Heatmap, CodeLens annotations, and notification verbosity.
- Localised UI in 9 languages: English, German, Spanish, French, Japanese, Korean, Hebrew, Ukrainian, and Chinese (Simplified).
- Research-use disclaimer rendered in the sidebar and README, mirroring the main NeuroSkill app.

### Notes
- Requires the [NeuroSkill app](https://neuroskill.com) running locally for the daemon.
- This is a research tool and **not** a medical device. See the disclaimer in the README.
