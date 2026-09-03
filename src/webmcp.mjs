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
    priority: {
      essential: "must_fund",
      important: "important",
      flexible: "nice_to_have",
    }[goal.priority] || goal.priority,
    progressPercent: Math.min(100, Math.round((goal.currentMinor / goal.targetMinor) * 100)),
    display: `${formatMoney(goal.currentMinor, currency)} of ${formatMoney(goal.targetMinor, currency)}`,
  };
}

function publicSimulation(result, state) {
  return {
    goalFunding: result.allocations.map((allocation) => ({
      goalId: allocation.goalId,
      amount: fromMinorUnits(allocation.amountMinor),
      goalName: state.goals.find((goal) => goal.id === allocation.goalId)?.name,
    })),
    totalGoingToGoals: fromMinorUnits(result.totalAllocationMinor),
    balanceAfterFundingGoals: fromMinorUnits(result.checkingAfterMinor),
    lowestExpectedBalance: fromMinorUnits(result.lowestProjectedMinor),
    monthlyBills: fromMinorUnits(result.upcomingCommitmentsMinor),
    passesSafetyChecks: result.withinBoundaries,
    problems: result.violations.map((item) => item.message),
    summary: result.withinBoundaries
      ? `This option passes the user's safety limits. The lowest expected balance is ${formatMoney(result.lowestProjectedMinor, state.currency)}.`
      : `This option does not pass ${result.violations.length} of the user's safety checks.`,
  };
}

function publicRecommendationStatus(status) {
  return {
    staged: "needs_review",
    blocked: "blocked",
    authorized: "approved",
    stale: "needs_update",
    committed: "applied",
  }[status] || status;
}

export function createWebMCPBridge({
  getState,
  stagePlan,
  commitPermit,
  proposeWorkspace,
  upsertGoal,
  upsertCommitment,
  recordFinancialEvent,
  proposeBoundaryChange,
  onStatus,
}) {
  let staticController = null;
  let dynamicController = null;
  let dynamicToolName = null;

  const modelContext = () => document.modelContext;
  const available = () => typeof modelContext()?.registerTool === "function";
  const currentState = () => {
    const state = getState();
    if (!state) throw new Error("No CashLatch money workspace is open. Prepare one for the user to review first.");
    return state;
  };

  async function register(tool, options = {}) {
    await modelContext().registerTool(tool, options);
  }

  async function registerStaticTools() {
    if (!available()) {
      onStatus({ connected: false, message: "Open this page beside ChatGPT in a supported browser to use chat assistance." });
      return false;
    }

    staticController?.abort();
    staticController = new AbortController();
    const options = { signal: staticController.signal };

    const tools = [
      {
        name: "get_money_workspace",
        description: "Read the open CashLatch money workspace: current balance, expected income, monthly bills, savings goals, safety limits, and any recommendation awaiting review.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async () => {
          const state = getState();
          if (!state) {
            return toolResult({
              hasActiveWorkspace: false,
              message: "No money workspace is open. Ask the user for the basic details, then use prepare_money_workspace so they can review it.",
            });
          }
          return toolResult({
            hasActiveWorkspace: true,
            workspaceId: state.id,
            workspaceName: state.name,
            isFictionalDemo: Boolean(state.isDemo),
            workspaceType: state.workspaceType,
            currency: state.currency,
            currentBalance: fromMinorUnits(state.checkingMinor),
            expectedMonthlyIncome: fromMinorUnits(state.monthlyIncomeMinor),
            safetyLimits: {
              minimumBalanceToKeep: fromMinorUnits(state.boundaries.minimumReserveMinor),
              maximumPerRecommendation: fromMinorUnits(state.boundaries.maximumAllocationMinor),
            },
            monthlyBills: state.commitments.map((item) => ({
              id: item.id,
              name: item.name,
              amount: fromMinorUnits(item.amountMinor),
              dueDay: item.dueDay,
            })),
            goals: state.goals.map((goal) => publicGoal(goal, state.currency)),
            recommendation: state.stagedPlan
              ? {
                  id: state.stagedPlan.id,
                  status: publicRecommendationStatus(state.stagedPlan.status),
                  totalGoingToGoals: fromMinorUnits(state.stagedPlan.totalAllocationMinor),
                }
              : null,
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
          const state = currentState();
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
        name: "prepare_money_workspace",
        description: "Prepare a new CashLatch money workspace from details the user supplied. Show the details on the page so the user can review and confirm them; do not save it automatically.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 60 },
            workspaceType: {
              type: "string",
              minLength: 1,
              maxLength: 40,
              description: "Workspace category, such as personal, household, independent, business, education, wedding, or another user-supplied label.",
            },
            currency: { type: "string", enum: ["INR", "USD", "EUR", "GBP", "CAD", "AUD", "JPY"] },
            currentBalance: { type: "number", minimum: 0 },
            expectedMonthlyIncome: { type: "number", minimum: 0 },
            minimumBalanceToKeep: { type: "number", minimum: 0 },
            maximumPerRecommendation: { type: "number", minimum: 0 },
          },
          required: ["name", "workspaceType", "currency", "currentBalance", "expectedMonthlyIncome", "minimumBalanceToKeep", "maximumPerRecommendation"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input) => toolResult(proposeWorkspace({
          ...input,
          checking: input.currentBalance,
          monthlyIncome: input.expectedMonthlyIncome,
          minimumReserve: input.minimumBalanceToKeep,
          maximumAllocation: input.maximumPerRecommendation,
        }, "agent")),
      },
      {
        name: "add_or_update_goal",
        description: "Add a savings goal to the open CashLatch money workspace or update one by ID. This cannot change the user's safety limits or approve a recommendation.",
        inputSchema: {
          type: "object",
          properties: {
            goalId: { type: "string", description: "Existing goal ID to update. Omit to add a goal." },
            name: { type: "string", minLength: 1, maxLength: 80 },
            current: { type: "number", minimum: 0 },
            target: { type: "number", exclusiveMinimum: 0 },
            targetDate: { type: "string", description: "Date in YYYY-MM-DD format." },
            priority: { type: "string", enum: ["essential", "important", "flexible"] },
          },
          required: ["name", "current", "target", "targetDate", "priority"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input) => {
          currentState();
          return toolResult(upsertGoal(input, "agent"));
        },
      },
      {
        name: "add_or_update_monthly_bill",
        description: "Add or update a monthly bill in the open money workspace. This updates the balance estimate and cancels any previous recommendation approval.",
        inputSchema: {
          type: "object",
          properties: {
            monthlyBillId: { type: "string", description: "Existing monthly bill ID to update. Omit to add a bill." },
            name: { type: "string", minLength: 1, maxLength: 80 },
            amount: { type: "number", exclusiveMinimum: 0 },
            dueDay: { type: "integer", minimum: 1, maximum: 31 },
          },
          required: ["name", "amount", "dueDay"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input) => {
          currentState();
          return toolResult(upsertCommitment({ ...input, commitmentId: input.monthlyBillId }, "agent"));
        },
      },
      {
        name: "record_income_or_expense",
        description: "Record income or an expense supplied by the user and update the current balance. Any previous recommendation then needs to be prepared and approved again.",
        inputSchema: {
          type: "object",
          properties: {
            description: { type: "string", minLength: 1, maxLength: 120 },
            amount: { type: "number", exclusiveMinimum: 0 },
            kind: { type: "string", enum: ["income", "expense"] },
            date: { type: "string", description: "Date in YYYY-MM-DD format. Omit to use today." },
          },
          required: ["description", "amount", "kind"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input) => {
          currentState();
          return toolResult(recordFinancialEvent(input, "agent"));
        },
      },
      {
        name: "propose_safety_limit_change",
        description: "Propose a new minimum balance to keep or a new maximum per recommendation. Show it on the CashLatch page; only the user can accept the change.",
        inputSchema: {
          type: "object",
          properties: {
            minimumBalanceToKeep: { type: "number", minimum: 0 },
            maximumPerRecommendation: { type: "number", minimum: 0 },
            reason: { type: "string", minLength: 1, maxLength: 240 },
          },
          required: ["reason"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input) => {
          currentState();
          return toolResult(proposeBoundaryChange({
            reason: input.reason,
            minimumReserve: input.minimumBalanceToKeep,
            maximumAllocation: input.maximumPerRecommendation,
          }, "agent"));
        },
      },
      {
        name: "estimate_balance",
        description: "Estimate the balance after 30, 60, or 90 days using the current balance, expected monthly income, and monthly bills.",
        inputSchema: {
          type: "object",
          properties: {
            horizonDays: { type: "integer", enum: [30, 60, 90], default: 30 },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async ({ horizonDays = 30 } = {}) => {
          const state = currentState();
          const result = forecastCashflow(state, horizonDays);
          return toolResult({
            horizonDays: result.horizonDays,
            estimatedEndBalance: fromMinorUnits(result.projectedEndBalanceMinor),
            lowestExpectedBalance: fromMinorUnits(result.lowestBalanceMinor),
            monthlyBills: fromMinorUnits(result.monthlyCommitmentsMinor),
            availableForGoalsNow: fromMinorUnits(result.availableNowMinor),
            minimumBalanceToKeep: fromMinorUnits(result.reserveMinor),
            goesBelowMinimum: result.crossesReserve,
            currency: state.currency,
          });
        },
      },
      {
        name: "calculate_goal_funding_needs",
        description: "Calculate how much the user needs to add to selected savings goals each month and whether their expected income after bills can cover it.",
        inputSchema: {
          type: "object",
          properties: {
            goalIds: {
              type: "array",
              items: { type: "string" },
              description: "Goal IDs from get_money_workspace. Omit to include every goal.",
            },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async ({ goalIds } = {}) => {
          const state = currentState();
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
            availableEachMonthAfterBills: fromMinorUnits(result.monthlyCapacityMinor),
            neededEachMonthForGoals: fromMinorUnits(result.totalRequiredMonthlyMinor),
            affordableWithExpectedIncome: result.feasible,
            monthlyShortfall: fromMinorUnits(result.monthlyGapMinor),
          });
        },
      },
      {
        name: "check_goal_funding_option",
        description: "Check one possible way to add money to savings goals. Report the balance afterward and whether it protects monthly bills and the minimum balance the user wants to keep.",
        inputSchema: {
          type: "object",
          properties: {
            goalFunding: {
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
          required: ["goalFunding"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute: async ({ goalFunding }) => {
          const state = currentState();
          const result = simulateAllocation(
            state,
            goalFunding.map((item) => ({ goalId: item.goalId, amountMinor: toMinorUnits(item.amount) })),
          );
          return toolResult(publicSimulation(result, state));
        },
      },
      {
        name: "prepare_goal_recommendation",
        description: "Prepare one exact goal-funding recommendation and show it in CashLatch for the user to review. Do not approve or apply it.",
        inputSchema: {
          type: "object",
          properties: {
            goalFunding: {
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
          required: ["goalFunding"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async ({ goalFunding }) => {
          currentState();
          const plan = stagePlan(
            goalFunding.map((item) => ({ goalId: item.goalId, amountMinor: toMinorUnits(item.amount) })),
            "agent",
          );
          return toolResult({
            recommendationId: plan.id,
            status: publicRecommendationStatus(plan.status),
            passesSafetyChecks: plan.withinBoundaries,
            problems: plan.violations.map((item) => item.message),
            message: plan.withinBoundaries
              ? "The recommendation is ready for the user to review in CashLatch. It has not been approved or applied."
              : "The recommendation is visible in CashLatch, but it does not pass the user's safety limits and cannot be approved.",
          });
        },
      },
    ];

    try {
      for (const tool of tools) await register(tool, options);
      onStatus({ connected: true, message: "ChatGPT can work with this open money workspace", toolCount: tools.length });
      return true;
    } catch (error) {
      staticController.abort();
      onStatus({ connected: false, message: `ChatGPT connection could not start: ${error.message}` });
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
          description: `Apply only the exact CashLatch recommendation the user approved. Approval ${permit.shortId} expires ${permit.expiresAt}. Takes no replacement amounts, checks the latest information again, and can be used once.`,
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
