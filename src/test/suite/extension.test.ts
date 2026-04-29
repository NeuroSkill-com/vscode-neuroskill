import * as assert from "assert";
import * as vscode from "vscode";

suite("Extension Activation", () => {
  test("Extension should be present", () => {
    const ext = vscode.extensions.getExtension("neuroskill.neuroskill");
    assert.ok(ext, "Extension should be found by ID");
  });

  test("Extension should activate", async () => {
    const ext = vscode.extensions.getExtension("neuroskill.neuroskill");
    assert.ok(ext);
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test("All commands should be registered", async () => {
    const commands = await vscode.commands.getCommands(true);
    const expected = [
      "neuroskill.reconnect",
      "neuroskill.showBrainStatus",
      "neuroskill.showReport",
      "neuroskill.amIStuck",
      "neuroskill.bestTimeToCode",
      "neuroskill.showFilesNeedingReview",
      "neuroskill.toggleFlowShield",
      "neuroskill.takeBreak",
    ];
    for (const cmd of expected) {
      assert.ok(commands.includes(cmd), `Command '${cmd}' should be registered`);
    }
  });
});

suite("Configuration", () => {
  test("Default settings should have correct values", () => {
    const cfg = vscode.workspace.getConfiguration("neuroskill");
    assert.strictEqual(cfg.get("enabled"), true);
    assert.strictEqual(cfg.get("daemonPort"), 0);
    assert.strictEqual(cfg.get("batchIntervalMs"), 2000);
    assert.strictEqual(cfg.get("focusCodeLens"), true);
    assert.strictEqual(cfg.get("flowShield"), true);
    assert.strictEqual(cfg.get("breakCoach"), true);
    assert.strictEqual(cfg.get("struggleBridge"), true);
    assert.strictEqual(cfg.get("flowTriggers"), true);
    assert.strictEqual(cfg.get("focusCommits"), true);
    assert.strictEqual(cfg.get("taskRouter"), true);
    assert.strictEqual(cfg.get("eegHeatmap"), true);
  });

  test("All 8 feature toggles exist", () => {
    const cfg = vscode.workspace.getConfiguration("neuroskill");
    const features = [
      "focusCodeLens", "flowShield", "breakCoach", "struggleBridge",
      "flowTriggers", "focusCommits", "taskRouter", "eegHeatmap",
    ];
    for (const feature of features) {
      const val = cfg.get<boolean>(feature);
      assert.strictEqual(typeof val, "boolean", `${feature} should be boolean`);
    }
  });
});

suite("Sidebar View", () => {
  test("Sidebar view container should be registered", async () => {
    // The view should exist — try to focus it.
    try {
      await vscode.commands.executeCommand("neuroskill.sidebar.focus");
      // If we get here without error, the view exists.
      assert.ok(true);
    } catch {
      // View might not render in headless test but the command should exist.
      // Check that the extension contributes the view.
      const ext = vscode.extensions.getExtension("neuroskill.neuroskill");
      const pkg = ext?.packageJSON;
      assert.ok(pkg?.contributes?.viewsContainers?.activitybar?.length > 0,
        "Should have activity bar view container");
      assert.ok(pkg?.contributes?.views?.neuroskill?.length > 0,
        "Should have neuroskill views");
    }
  });
});
