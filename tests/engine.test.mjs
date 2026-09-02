import test from "node:test";
import assert from "node:assert/strict";
import { freshDemoState } from "../src/demo.mjs";
import {
  applyCommittedPlan,
  calculateGoalPlan,
  createStagedPlan,
  forecastCashflow,
  parseTransactionCsv,
  simulateAllocation,
} from "../src/engine.mjs";

test("safe allocation remains above obligations and reserve", () => {
  const state = freshDemoState();
  const result = simulateAllocation(state, [
    { goalId: "emergency", amountMinor: 1_000_000 },
    { goalId: "laptop", amountMinor: 500_000 },
  ]);
  assert.equal(result.withinBoundaries, true);
  assert.equal(result.totalAllocationMinor, 1_500_000);
  assert.equal(result.lowestProjectedMinor, 4_100_000);
});

test("allocation above maximum returns a deterministic violation", () => {
  const state = freshDemoState();
  const result = simulateAllocation(state, [
    { goalId: "emergency", amountMinor: 1_600_000 },
  ]);
  assert.equal(result.withinBoundaries, false);
  assert.ok(result.violations.some((violation) => violation.code === "MAX_ALLOCATION"));
});

test("surprise expense makes the previously safe amount violate the reserve", () => {
  const state = freshDemoState();
  state.checkingMinor -= 2_000_000;
  const result = simulateAllocation(state, [
    { goalId: "emergency", amountMinor: 1_000_000 },
    { goalId: "laptop", amountMinor: 500_000 },
  ]);
  assert.equal(result.withinBoundaries, false);
  assert.ok(result.violations.some((violation) => violation.code === "RESERVE_FLOOR"));
});

test("committing a plan updates checking and goal progress", () => {
  const state = freshDemoState();
  const plan = createStagedPlan(state, [
    { goalId: "emergency", amountMinor: 1_000_000 },
  ]);
  const next = applyCommittedPlan(state, plan);
  assert.equal(next.checkingMinor, state.checkingMinor - 1_000_000);
  assert.equal(
    next.goals.find((goal) => goal.id === "emergency").currentMinor,
    state.goals.find((goal) => goal.id === "emergency").currentMinor + 1_000_000,
  );
  assert.equal(next.stateVersion, state.stateVersion + 1);
});

test("goal planning and 90-day forecast return structured results", () => {
  const state = freshDemoState();
  const goals = calculateGoalPlan(state, ["emergency", "laptop"], new Date("2026-09-01"));
  const forecast = forecastCashflow(state, 90);
  assert.equal(goals.goals.length, 2);
  assert.equal(forecast.horizonDays, 90);
  assert.ok(forecast.points.length >= 4);
});

test("CSV import accepts date, description, amount", () => {
  const rows = parseTransactionCsv(
    "date,description,amount\n2026-09-01,Salary,100000\n2026-09-02,Rent,-25000",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].amountMinor, -2_500_000);
});
