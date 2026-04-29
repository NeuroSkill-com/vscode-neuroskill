import * as assert from "assert";
import { DaemonClient } from "../../daemon-client";

suite("Daemon Client", () => {
  test("Should construct without error", () => {
    const client = new DaemonClient(
      {
        enabled: true,
        daemonHost: "127.0.0.1",
        daemonPort: 99999, // non-existent port
        trackUndos: true,
        trackDiagnostics: true,
        batchIntervalMs: 2000,
        focusCodeLens: true,
        flowShield: true,
        breakCoach: true,
        struggleBridge: true,
        flowTriggers: true,
        focusCommits: true,
        taskRouter: true,
        eegHeatmap: true,
        excludePaths: [],
        notifications: "critical",
        systemNotifications: "never",
      },
      "test-token",
    );
    assert.ok(client);
  });

  test("POST to unreachable daemon returns null (not throw)", async () => {
    const client = new DaemonClient(
      {
        enabled: true,
        daemonHost: "127.0.0.1",
        daemonPort: 1, // definitely not listening
        trackUndos: true,
        trackDiagnostics: true,
        batchIntervalMs: 2000,
        focusCodeLens: true,
        flowShield: true,
        breakCoach: true,
        struggleBridge: true,
        flowTriggers: true,
        focusCommits: true,
        taskRouter: true,
        eegHeatmap: true,
        excludePaths: [],
        notifications: "critical",
        systemNotifications: "never",
      },
    );

    const result = await client.post<any>("/brain/flow-state", { windowSecs: 300 });
    assert.strictEqual(result, null, "Should return null when daemon unreachable");
  });

  test("GET to unreachable daemon returns null (not throw)", async () => {
    const client = new DaemonClient(
      {
        enabled: true,
        daemonHost: "127.0.0.1",
        daemonPort: 1,
        trackUndos: true,
        trackDiagnostics: true,
        batchIntervalMs: 2000,
        focusCodeLens: true,
        flowShield: true,
        breakCoach: true,
        struggleBridge: true,
        flowTriggers: true,
        focusCommits: true,
        taskRouter: true,
        eegHeatmap: true,
        excludePaths: [],
        notifications: "critical",
        systemNotifications: "never",
      },
    );

    const result = await client.get<any>("/brain/fatigue");
    assert.strictEqual(result, null);
  });

  test("Token can be updated after construction", () => {
    const client = new DaemonClient(
      {
        enabled: true,
        daemonHost: "127.0.0.1",
        daemonPort: 18444,
        trackUndos: true,
        trackDiagnostics: true,
        batchIntervalMs: 2000,
        focusCodeLens: true,
        flowShield: true,
        breakCoach: true,
        struggleBridge: true,
        flowTriggers: true,
        focusCommits: true,
        taskRouter: true,
        eegHeatmap: true,
        excludePaths: [],
        notifications: "critical",
        systemNotifications: "never",
      },
      "old-token",
    );
    client.setToken("new-token");
    // No assertion needed — just verify it doesn't throw.
    assert.ok(true);
  });
});
