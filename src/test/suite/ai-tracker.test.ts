import * as assert from "assert";
import { AIActivityTracker } from "../../ai-tracker";

suite("AI Activity Tracker", () => {
  let tracker: AIActivityTracker;

  setup(() => {
    tracker = new AIActivityTracker();
  });

  teardown(() => {
    tracker.dispose();
  });

  test("New tracker should report 0 AI ratio", () => {
    assert.strictEqual(tracker.getOverallAIRatio(), 0);
    assert.strictEqual(tracker.getAIRatioForFile("/test.ts"), 0);
  });

  test("recordEdit classifies as human by default", () => {
    const source = tracker.recordEdit("/test.ts", 5);
    assert.strictEqual(source, "human");
  });

  test("Human edits produce 0 AI ratio", () => {
    tracker.recordEdit("/test.ts", 10);
    tracker.recordEdit("/test.ts", 5);
    tracker.recordEdit("/test.ts", 3);
    assert.strictEqual(tracker.getAIRatioForFile("/test.ts"), 0);
    assert.strictEqual(tracker.getOverallAIRatio(), 0);
  });

  test("recordCompletionAccepted increases AI ratio", () => {
    // Some human edits first.
    tracker.recordEdit("/test.ts", 10);
    // Then an AI completion.
    tracker.recordCompletionAccepted("/test.ts", 80, 10, 12);
    const ratio = tracker.getAIRatioForFile("/test.ts");
    assert.ok(ratio > 0, `AI ratio should be > 0, got ${ratio}`);
    assert.ok(ratio < 1, `AI ratio should be < 1, got ${ratio}`);
  });

  test("AI ratio is per-file", () => {
    tracker.recordCompletionAccepted("/ai-file.ts", 100, 5, 8);
    tracker.recordEdit("/human-file.ts", 10);
    assert.ok(tracker.getAIRatioForFile("/ai-file.ts") > 0);
    assert.strictEqual(tracker.getAIRatioForFile("/human-file.ts"), 0);
  });

  test("Overall AI ratio covers all files", () => {
    tracker.recordCompletionAccepted("/a.ts", 40, 1, 2); // ~1 line AI
    tracker.recordEdit("/b.ts", 10); // 10 lines human
    const overall = tracker.getOverallAIRatio();
    assert.ok(overall > 0, "Overall ratio should be > 0");
    assert.ok(overall < 0.5, `Overall should be < 0.5 (mostly human), got ${overall}`);
  });

  test("Commit AI flag defaults to false", () => {
    assert.strictEqual(tracker.isCommitAIAssisted(), false);
  });

  test("Commit AI flag can be cleared", () => {
    // Simulate: we can't trigger the command listener in unit tests,
    // but we can test the clear behavior.
    assert.strictEqual(tracker.isCommitAIAssisted(), false);
    tracker.clearCommitAIFlag();
    assert.strictEqual(tracker.isCommitAIAssisted(), false);
  });

  test("Multiple files track independently", () => {
    tracker.recordEdit("/a.ts", 20);
    tracker.recordEdit("/b.ts", 2);
    tracker.recordCompletionAccepted("/b.ts", 400, 1, 10); // 400 chars ≈ 10 lines AI

    assert.strictEqual(tracker.getAIRatioForFile("/a.ts"), 0, "File A should be all human");
    const bRatio = tracker.getAIRatioForFile("/b.ts");
    assert.ok(bRatio > 0, `File B should have AI ratio > 0, got ${bRatio}`);
  });
});
