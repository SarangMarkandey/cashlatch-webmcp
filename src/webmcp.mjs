import {
  calculateGoalPlan,
  forecastCashflow,
  formatMoney,
  fromMinorUnits,
  simulateAllocation,
  toMinorUnits,
} from "./engine.mjs";

function toolResult(value) {
  return value;
}

function publicGoal(goal, currency) {
  return {
    id: goal.id,
    name: goal.name,
    current: fromMinorUnits(goal.currentMinor),
    target: fromMinorUnits(goal.targetMinor),
    remaining: fromMinorUnits(Math.max(0, goal.targetMinor - goal.currentMinor)),
    targetDate: goal.targetDate,
    priority: goal.priority,
    progressPercent: Math.min(100, Math.round((goal.currentMinor / goal.targetMinor) * 100)),
    display: `${formatMoney(goal.currentMinor, currency)} of ${formatMoney(goal.targetMinor, currency)}`,
  };
}

function publicSimulation(result, state) {
  return {
    allocations: result.allocations.map((allocation) => ({
      goalId: allocation.goalId,
      amount: fromMinorUnits(allocation.amountMinor),
      goalName: state.goals.find((goal) => goal.id === allocation.goalId)?.name,
    })),
    totalAllocation: fromMinorUnits(result.totalAllocationMinor),
    checkingAfter: fromMinorUnits(result.checkingAfterMinor),
    lowestProjectedBalance: fromMinorUnits(result.lowestProjectedMinor),
    upcomingCommitments: fromMinorUnits(result.upcomingCommitmentsMinor),
    withinConfiguredBoundaries: result.withinBoundaries,
    violations: result.violations,
    summary: result.withinBoundaries
      ? `This allocation is within the configured boundaries. The lowest projected balance is ${formatMoney(result.lowestProjectedMinor, state.currency)}.`
      : `This allocation is blocked by ${result.violations.length} configured boundary check(s).`,
  };
}

export function createWebMCPBridge({ getState, stagePlan, commitPermit, onStatus }) {
  let staticController = null;
  let dynamicController = null;
  let dynamicToolName = null;

  const modelContext = () => document.modelContext;
  const available = () => typeof modelContext()?.registerTool === "function";

  async function register(tool, options = {}) {
    await modelContext().registerTool(tool, options);
  }

  async function registerStaticTools() {
    if (!available()) {
      onStatus({ connected: false, message: "Open this page in a WebMCP-enabled browser." });
      return false;
    }

    staticController?.abort();
    staticController = new AbortController();
    const options = { signal: staticController.signal };

    const tools = [
      {
        name: "get_financial_context",
        description: "Read the current CashLatch accounts, goals, commitments, user boundaries, staged plan, and financial state version.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async () => {
          const state = getState();
          return toolResult({
            workspaceType: state.workspaceType,
            currency: state.currency,
            checking: fromMinorUnits(state.checkingMinor),
            monthlyIncome: fromMinorUnits(state.monthlyIncomeMinor),
            boundaries: {
              minimumReserve: fromMinorUnits(state.boundaries.minimumReserveMinor),
              maximumAllocation: fromMinorUnits(state.boundaries.maximumAllocationMinor),
            },
            recurringCommitments: state.commitments.map((item) => ({
              id: item.id,
              name: item.name,
              amount: fromMinorUnits(item.amountMinor),
              dueDay: item.dueDay,
            })),
            goals: state.goals.map((goal) => publicGoal(goal, state.currency)),
            stagedPlan: state.stagedPlan
              ? {
                  id: state.stagedPlan.id,
                  status: state.stagedPlan.status,
                  totalAllocation: fromMinorUnits(state.stagedPlan.totalAllocationMinor),
                }
              : null,
            stateVersion: state.stateVersion,
          });
        },
      },
      {
        name: "get_transactions",
        description: "Read recent transactions from the current CashLatch workspace, optionally filtered by date and limited in count.",
        inputSchema: {
          type: "object",
          properties: {
            fromDate: { type: "string", description: "Optional inclusive date in YYYY-MM-DD format." },
            toDate: { type: "string", description: "Optional inclusive date in YYYY-MM-DD format." },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async ({ fromDate, toDate, limit = 20 } = {}) => {
          const state = getState();
          const transactions = state.transactions
            .filter((item) => !fromDate || item.date >= fromDate)
            .filter((item) => !toDate || item.date <= toDate)
            .slice(0, Math.max(1, Math.min(50, limit)))
            .map((item) => ({
              id: item.id,
              date: item.date,
              description: item.description,
              amount: fromMinorUnits(item.amountMinor),
            }));
          return toolResult({ currency: state.currency, transactions, count: transactions.length });
        },
      },
      {
        name: "forecast_cashflow",
        description: "Calculate a deterministic 30, 60, or 90-day cash forecast using current checking, recurring commitments, income, and reserve.",
        inputSchema: {
          type: "object",
          properties: {
            horizonDays: { type: "integer", enum: [30, 60, 90], default: 30 },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async ({ horizonDays = 30 } = {}) => {
          const state = getState();
          const result = forecastCashflow(state, horizonDays);
          return toolResult({
            horizonDays: result.horizonDays,
            projectedEndBalance: fromMinorUnits(result.projectedEndBalanceMinor),
            lowestProjectedBalance: fromMinorUnits(result.lowestBalanceMinor),
            monthlyCommitments: fromMinorUnits(result.monthlyCommitmentsMinor),
            availableNow: fromMinorUnits(result.availableNowMinor),
            minimumReserve: fromMinorUnits(result.reserveMinor),
            crossesReserve: result.crossesReserve,
            currency: state.currency,
          });
        },
      },
      {
        name: "calculate_goal_plan",
        description: "Calculate required monthly contributions for selected financial goals and compare them with current monthly capacity.",
        inputSchema: {
          type: "object",
          properties: {
            goalIds: {
              type: "array",
              items: { type: "string" },
              description: "Goal IDs from get_financial_context. Omit to include every goal.",
            },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async ({ goalIds } = {}) => {
          const state = getState();
          const result = calculateGoalPlan(state, goalIds || state.goals.map((goal) => goal.id));
          return toolResult({
            currency: state.currency,
            goals: result.goals.map((goal) => ({
              ...goal,
              remaining: fromMinorUnits(goal.remainingMinor),
              requiredMonthly: fromMinorUnits(goal.requiredMonthlyMinor),
              remainingMinor: undefined,
              requiredMonthlyMinor: undefined,
            })),
            monthlyCapacity: fromMinorUnits(result.monthlyCapacityMinor),
            totalRequiredMonthly: fromMinorUnits(result.totalRequiredMonthlyMinor),
            feasible: result.feasible,
            monthlyGap: fromMinorUnits(result.monthlyGapMinor),
          });
        },
      },
      {
        name: "simulate_allocation",
        description: "Evaluate one exact allocation across CashLatch goals against the maximum allocation, upcoming commitments, and reserve floor.",
        inputSchema: {
          type: "object",
          properties: {
            allocations: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  goalId: { type: "string" },
                  amount: { type: "number", minimum: 0, description: "Amount in the workspace currency." },
                },
                required: ["goalId", "amount"],
                additionalProperties: false,
              },
            },
          },
          required: ["allocations"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async ({ allocations }) => {
          const state = getState();
          const result = simulateAllocation(
            state,
            allocations.map((item) => ({ goalId: item.goalId, amountMinor: toMinorUnits(item.amount) })),
          );
          return toolResult(publicSimulation(result, state));
        },
      },
      {
        name: "stage_allocation_plan",
        description: "Stage one exact goal-allocation plan in CashLatch for human review. This does not commit or authorize the allocation.",
        inputSchema: {
          type: "object",
          properties: {
            allocations: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  goalId: { type: "string" },
                  amount: { type: "number", minimum: 0, description: "Amount in the workspace currency." },
                },
                required: ["goalId", "amount"],
                additionalProperties: false,
              },
            },
          },
          required: ["allocations"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async ({ allocations }) => {
          const plan = stagePlan(
            allocations.map((item) => ({ goalId: item.goalId, amountMinor: toMinorUnits(item.amount) })),
            "agent",
          );
          return toolResult({
            planId: plan.id,
            status: plan.status,
            withinConfiguredBoundaries: plan.withinBoundaries,
            violations: plan.violations,
            message: plan.withinBoundaries
              ? "Plan staged. The human must review and authorize it in CashLatch before any commit capability exists."
              : "Plan staged but blocked by configured boundaries. It cannot be authorized.",
          });
        },
      },
    ];

    try {
      for (const tool of tools) await register(tool, options);
      onStatus({ connected: true, message: `${tools.length} site tools available`, toolCount: tools.length });
      return true;
    } catch (error) {
      staticController.abort();
      onStatus({ connected: false, message: `Site tool registration failed: ${error.message}` });
      return false;
    }
  }

  async function syncPermit(permit) {
    dynamicController?.abort();
    dynamicController = null;
    dynamicToolName = null;

    if (!permit || !available()) return null;

    dynamicController = new AbortController();
    dynamicToolName = permit.toolName;
    try {
      await register(
        {
          name: permit.toolName,
          description: `Commit the one exact CashLatch plan authorized by the human. Permit ${permit.shortId}; expires ${permit.expiresAt}. Takes no plan inputs and revalidates state before committing.`,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute: async () => commitPermit(permit.id),
        },
        { signal: dynamicController.signal },
      );
      return dynamicToolName;
    } catch (error) {
      dynamicController.abort();
      dynamicController = null;
      dynamicToolName = null;
      throw error;
    }
  }

  function destroy() {
    staticController?.abort();
    dynamicController?.abort();
  }

  return {
    available,
    registerStaticTools,
    syncPermit,
    getDynamicToolName: () => dynamicToolName,
    destroy,
  };
}
