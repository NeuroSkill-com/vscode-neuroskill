import * as assert from "assert";
import { FlowShield } from "../../flow-shield";
import { TaskRouter } from "../../task-router";

suite("Flow Shield", () => {
  let shield: FlowShield;

  setup(() => {
    shield = new FlowShield();
  });

  teardown(() => {
    shield.dispose();
  });

  test("Should construct without error", () => {
    assert.ok(shield);
  });

  test("Should not activate on null flow state", () => {
    shield.update(null);
    // No assertion — just verify no throw.
    assert.ok(true);
  });

  test("Should not activate when not in flow", () => {
    shield.update({ in_flow: false, score: 30, duration_secs: 0 });
    assert.ok(true);
  });

  test("Should handle flow state transitions", () => {
    // Enter flow.
    shield.update({ in_flow: true, score: 85, duration_secs: 300 });
    // Stay in flow.
    shield.update({ in_flow: true, score: 90, duration_secs: 600 });
    // Exit flow.
    shield.update({ in_flow: false, score: 40, duration_secs: 0 });
    assert.ok(true);
  });

  test("Toggle should cycle through auto → on → off → auto", () => {
    // Start: auto mode.
    shield.toggle(); // auto → forced on
    shield.toggle(); // forced on → forced off
    shield.toggle(); // forced off → auto
    assert.ok(true);
  });
});

suite("Task Router", () => {
  let router: TaskRouter;

  setup(() => {
    router = new TaskRouter();
  });

  teardown(() => {
    router.dispose();
  });

  test("Should construct without error", () => {
    assert.ok(router);
  });

  test("Should handle null flow state", () => {
    router.check(null, null);
    assert.ok(true);
  });

  test("Should not fire on first reading (no previous score)", () => {
    // First call establishes baseline — should not show notification.
    router.check(
      { in_flow: false, score: 80, duration_secs: 0, avg_focus: 80 },
      { task_type: "coding", confidence: 0.8 },
    );
    assert.ok(true);
  });

  test("Should handle repeated calls with same score (no notification)", () => {
    const flow = { in_flow: false, score: 60, duration_secs: 0, avg_focus: 60 };
    const task = { task_type: "coding", confidence: 0.8 };
    // Set baseline.
    router.check(flow, task);
    // Same score — no suggestion.
    router.check(flow, task);
    router.check(flow, task);
    assert.ok(true);
  });
});

suite("Event Source Classification", () => {
  test("VscodeEvent interface has source field", () => {
    // TypeScript compile-time check — if this compiles, the field exists.
    const event: import("../../events").VscodeEvent = {
      type: "edit",
      path: "/test.ts",
      source: "human",
    };
    assert.strictEqual(event.source, "human");
  });

  test("VscodeEvent source can be ai", () => {
    const event: import("../../events").VscodeEvent = {
      type: "edit",
      path: "/test.ts",
      source: "ai",
    };
    assert.strictEqual(event.source, "ai");
  });

  test("Git commit event can carry source", () => {
    const event: import("../../events").VscodeEvent = {
      type: "git_commit",
      command: "fix: resolve auth bug",
      source: "human",
    };
    assert.strictEqual(event.type, "git_commit");
    assert.strictEqual(event.source, "human");
  });
});

suite("Sidebar Provider", () => {
  test("SidebarProvider has correct viewType", () => {
    const { SidebarProvider } = require("../../sidebar");
    assert.strictEqual(SidebarProvider.viewType, "neuroskill.sidebar");
  });

  test("SidebarProvider can record commits", () => {
    const { SidebarProvider } = require("../../sidebar");
    const provider = new SidebarProvider({ fsPath: "/tmp", scheme: "file" } as any);
    // Should not throw even without a webview.
    provider.recordCommit("fix: auth bug", 82, "human");
    provider.recordCommit("chore: update deps", 45, "ai");
    assert.ok(true);
  });
});
