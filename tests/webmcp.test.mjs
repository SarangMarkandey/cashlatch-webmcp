import test from "node:test";
import assert from "node:assert/strict";

import { freshDemoState } from "../src/demo.mjs";
import { createWebMCPBridge } from "../src/webmcp.mjs";

test("registers six permanent tools and one revocable commit tool", async (t) => {
  const registrations = [];
  globalThis.document = {
    modelContext: {
      registerTool: async (tool, options = {}) => {
        registrations.push({ tool, options });
      },
    },
  };

  t.after(() => {
    delete globalThis.document;
  });

  const state = freshDemoState();
  const statuses = [];
  const bridge = createWebMCPBridge({
    getState: () => state,
    stagePlan: () => ({ id: "plan-test", status: "staged", withinBoundaries: true, violations: [] }),
    commitPermit: async () => ({ success: true }),
    onStatus: (status) => statuses.push(status),
  });

  await bridge.registerStaticTools();
  assert.equal(registrations.length, 6);
  assert.deepEqual(
    registrations.map(({ tool }) => tool.name),
    [
      "get_financial_context",
      "get_transactions",
      "forecast_cashflow",
      "calculate_goal_plan",
      "simulate_allocation",
      "stage_allocation_plan",
    ],
  );
  assert.equal(statuses.at(-1).connected, true);

  const permit = {
    id: "permit-test",
    shortId: "a1b2c3",
    toolName: "commit_plan_a1b2c3",
    planId: "plan-test",
    stateVersion: state.stateVersion,
    fingerprint: "fingerprint-test",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  await bridge.syncPermit(permit);

  assert.equal(registrations.length, 7);
  assert.equal(registrations[6].tool.name, "commit_plan_a1b2c3");
  assert.equal(registrations[6].options.signal.aborted, false);

  await bridge.syncPermit(null);
  assert.equal(registrations[6].options.signal.aborted, true);

  bridge.destroy();
});
