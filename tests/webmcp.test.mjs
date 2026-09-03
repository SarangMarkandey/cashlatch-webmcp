import test from "node:test";
import assert from "node:assert/strict";

import { freshDemoState } from "../src/demo.mjs";
import { createWebMCPBridge } from "../src/webmcp.mjs";

test("registers eleven permanent tools and one revocable apply tool", async (t) => {
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
    proposeWorkspace: () => ({ status: "awaiting_human_confirmation" }),
    upsertGoal: () => ({ success: true }),
    upsertCommitment: () => ({ success: true }),
    recordFinancialEvent: () => ({ success: true }),
    proposeBoundaryChange: () => ({ status: "awaiting_human_confirmation" }),
    onStatus: (status) => statuses.push(status),
  });

  await bridge.registerStaticTools();
  assert.equal(registrations.length, 11);
  assert.deepEqual(
    registrations.map(({ tool }) => tool.name),
    [
      "get_money_workspace",
      "get_transactions",
      "prepare_money_workspace",
      "add_or_update_goal",
      "add_or_update_monthly_bill",
      "record_income_or_expense",
      "propose_safety_limit_change",
      "estimate_balance",
      "calculate_goal_funding_needs",
      "check_goal_funding_option",
      "prepare_goal_recommendation",
    ],
  );
  assert.equal(statuses.at(-1).connected, true);

  const permit = {
    id: "permit-test",
    shortId: "a1b2c3",
    toolName: "apply_approved_recommendation_a1b2c3",
    planId: "plan-test",
    stateVersion: state.stateVersion,
    fingerprint: "fingerprint-test",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  await bridge.syncPermit(permit);

  assert.equal(registrations.length, 12);
  assert.equal(registrations[11].tool.name, "apply_approved_recommendation_a1b2c3");
  assert.equal(registrations[11].options.signal.aborted, false);

  await bridge.syncPermit(null);
  assert.equal(registrations[11].options.signal.aborted, true);

  bridge.destroy();
});

test("supports first-run workspace drafting while no workspace is active", async (t) => {
  const registrations = [];
  globalThis.document = {
    modelContext: {
      registerTool: async (tool, options = {}) => registrations.push({ tool, options }),
    },
  };
  t.after(() => delete globalThis.document);

  let receivedDraft = null;
  const bridge = createWebMCPBridge({
    getState: () => null,
    stagePlan: () => { throw new Error("unexpected stage"); },
    commitPermit: async () => ({ success: true }),
    proposeWorkspace: (input, source) => {
      receivedDraft = { input, source };
      return { status: "awaiting_human_confirmation" };
    },
    upsertGoal: () => ({ success: true }),
    upsertCommitment: () => ({ success: true }),
    recordFinancialEvent: () => ({ success: true }),
    proposeBoundaryChange: () => ({ status: "awaiting_human_confirmation" }),
    onStatus: () => {},
  });

  await bridge.registerStaticTools();
  const contextTool = registrations.find(({ tool }) => tool.name === "get_money_workspace").tool;
  const context = await contextTool.execute({});
  assert.equal(context.hasActiveWorkspace, false);

  const draftTool = registrations.find(({ tool }) => tool.name === "prepare_money_workspace").tool;
  const result = await draftTool.execute({
    name: "Personal",
    workspaceType: "personal",
    currency: "USD",
    currentBalance: 4000,
    expectedMonthlyIncome: 6000,
    minimumBalanceToKeep: 1200,
    maximumPerRecommendation: 800,
  });

  assert.equal(result.status, "awaiting_human_confirmation");
  assert.equal(receivedDraft.source, "agent");
  assert.equal(receivedDraft.input.currency, "USD");
  bridge.destroy();
});

test("routes safety-limit changes to human review instead of applying them", async (t) => {
  const registrations = [];
  globalThis.document = {
    modelContext: {
      registerTool: async (tool, options = {}) => registrations.push({ tool, options }),
    },
  };
  t.after(() => delete globalThis.document);

  const state = freshDemoState();
  let proposal = null;
  const bridge = createWebMCPBridge({
    getState: () => state,
    stagePlan: () => ({ id: "plan", status: "staged", withinBoundaries: true, violations: [] }),
    commitPermit: async () => ({ success: true }),
    proposeWorkspace: () => ({ status: "awaiting_human_confirmation" }),
    upsertGoal: () => ({ success: true }),
    upsertCommitment: () => ({ success: true }),
    recordFinancialEvent: () => ({ success: true }),
    proposeBoundaryChange: (input, source) => {
      proposal = { input, source };
      return { status: "awaiting_human_confirmation" };
    },
    onStatus: () => {},
  });

  await bridge.registerStaticTools();
  const boundaryTool = registrations.find(({ tool }) => tool.name === "propose_safety_limit_change").tool;
  const result = await boundaryTool.execute({ minimumBalanceToKeep: 30000, reason: "Increase the buffer" });

  assert.equal(result.status, "awaiting_human_confirmation");
  assert.equal(proposal.source, "agent");
  assert.equal(state.boundaries.minimumReserveMinor, 2500000);
  bridge.destroy();
});
