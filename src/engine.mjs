const DAY_MS = 86_400_000;

export function clampInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

export function toMinorUnits(value) {
  return clampInteger(Number(value) * 100);
}

export function fromMinorUnits(value) {
  return clampInteger(value) / 100;
}

export function currencyFormatter(currency = "INR", compact = false) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
    notation: compact ? "compact" : "standard",
  });
}

export function formatMoney(valueMinor, currency = "INR", compact = false) {
  return currencyFormatter(currency, compact).format(fromMinorUnits(valueMinor));
}

export function monthlyCommitments(state) {
  return state.commitments.reduce((sum, item) => sum + item.amountMinor, 0);
}

export function forecastCashflow(state, horizonDays = 30, proposedAllocationMinor = 0) {
  const boundedHorizon = Math.max(30, Math.min(90, clampInteger(horizonDays, 30)));
  const months = Math.ceil(boundedHorizon / 30);
  const monthlyBills = monthlyCommitments(state);
  const projected = [];
  let balance = state.checkingMinor - proposedAllocationMinor;
  let lowestBalance = balance;

  projected.push({ day: 0, balanceMinor: balance, label: "Today" });

  for (let month = 1; month <= months; month += 1) {
    balance -= monthlyBills;
    lowestBalance = Math.min(lowestBalance, balance);
    projected.push({
      day: Math.min(month * 30, boundedHorizon),
      balanceMinor: balance,
      label: `Bills ${month}`,
    });

    if (month < months) {
      balance += state.monthlyIncomeMinor;
      projected.push({
        day: Math.min(month * 30 + 1, boundedHorizon),
        balanceMinor: balance,
        label: `Income ${month}`,
      });
    }
  }

  const availableNowMinor = Math.max(
    0,
    state.checkingMinor - monthlyBills - state.boundaries.minimumReserveMinor,
  );

  return {
    horizonDays: boundedHorizon,
    monthlyCommitmentsMinor: monthlyBills,
    projectedEndBalanceMinor: balance,
    lowestBalanceMinor: lowestBalance,
    availableNowMinor,
    reserveMinor: state.boundaries.minimumReserveMinor,
    crossesReserve: lowestBalance < state.boundaries.minimumReserveMinor,
    points: projected,
  };
}

export function monthsUntil(targetDate, now = new Date()) {
  const target = new Date(`${targetDate}T00:00:00`);
  if (Number.isNaN(target.getTime())) return 1;
  const days = Math.max(1, Math.ceil((target.getTime() - now.getTime()) / DAY_MS));
  return Math.max(1, Math.ceil(days / 30));
}

export function calculateGoalPlan(state, goalIds = state.goals.map((goal) => goal.id), now = new Date()) {
  const selected = state.goals.filter((goal) => goalIds.includes(goal.id));
  const monthlyCapacityMinor = Math.max(
    0,
    state.monthlyIncomeMinor - monthlyCommitments(state),
  );

  const goals = selected.map((goal) => {
    const remainingMinor = Math.max(0, goal.targetMinor - goal.currentMinor);
    const months = monthsUntil(goal.targetDate, now);
    return {
      goalId: goal.id,
      name: goal.name,
      remainingMinor,
      months,
      requiredMonthlyMinor: Math.ceil(remainingMinor / months),
      priority: goal.priority,
    };
  });

  const totalRequiredMonthlyMinor = goals.reduce(
    (sum, goal) => sum + goal.requiredMonthlyMinor,
    0,
  );

  return {
    goals,
    monthlyCapacityMinor,
    totalRequiredMonthlyMinor,
    feasible: totalRequiredMonthlyMinor <= monthlyCapacityMinor,
    monthlyGapMinor: monthlyCapacityMinor - totalRequiredMonthlyMinor,
  };
}

export function normalizeAllocations(state, allocations = []) {
  const goalIds = new Set(state.goals.map((goal) => goal.id));
  return allocations
    .filter((item) => goalIds.has(item.goalId))
    .map((item) => ({
      goalId: item.goalId,
      amountMinor: Math.max(0, clampInteger(item.amountMinor)),
    }))
    .filter((item) => item.amountMinor > 0);
}

export function simulateAllocation(state, allocations = []) {
  const normalized = normalizeAllocations(state, allocations);
  const totalAllocationMinor = normalized.reduce((sum, item) => sum + item.amountMinor, 0);
  const checkingAfterMinor = state.checkingMinor - totalAllocationMinor;
  const forecast = forecastCashflow(state, 30, totalAllocationMinor);
  const violations = [];

  if (normalized.length === 0) {
    violations.push({ code: "NO_GOAL_SELECTED", message: "Choose at least one savings goal and enter an amount." });
  }
  if (totalAllocationMinor > state.boundaries.maximumAllocationMinor) {
    violations.push({
      code: "MAX_ALLOCATION",
      message: "This recommendation exceeds the maximum you allow at one time.",
    });
  }
  if (checkingAfterMinor < 0) {
    violations.push({ code: "NOT_ENOUGH_MONEY", message: "This recommendation would take your current balance below zero." });
  }
  if (forecast.lowestBalanceMinor < state.boundaries.minimumReserveMinor) {
    violations.push({
      code: "RESERVE_FLOOR",
      message: "Your lowest expected balance would fall below the minimum you want to keep after monthly bills.",
    });
  }

  return {
    allocations: normalized,
    totalAllocationMinor,
    checkingAfterMinor,
    lowestProjectedMinor: forecast.lowestBalanceMinor,
    upcomingCommitmentsMinor: forecast.monthlyCommitmentsMinor,
    withinBoundaries: violations.length === 0,
    violations,
  };
}

export function createStagedPlan(state, allocations, source = "human") {
  const simulation = simulateAllocation(state, allocations);
  return {
    id: `plan-${crypto.randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    source,
    status: simulation.withinBoundaries ? "staged" : "blocked",
    approvedStateVersion: null,
    ...simulation,
  };
}

export function canonicalPermitPayload(state, plan) {
  return {
    schema: 1,
    stateVersion: state.stateVersion,
    currency: state.currency,
    checkingMinor: state.checkingMinor,
    monthlyIncomeMinor: state.monthlyIncomeMinor,
    boundaries: state.boundaries,
    commitments: state.commitments
      .map(({ id, name, amountMinor, dueDay }) => ({ id, name, amountMinor, dueDay }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    goals: state.goals
      .map(({ id, currentMinor, targetMinor, targetDate }) => ({
        id,
        currentMinor,
        targetMinor,
        targetDate,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    plan: {
      id: plan.id,
      totalAllocationMinor: plan.totalAllocationMinor,
      allocations: [...plan.allocations].sort((a, b) => a.goalId.localeCompare(b.goalId)),
    },
  };
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function fingerprintPlan(state, plan) {
  return sha256(JSON.stringify(canonicalPermitPayload(state, plan)));
}

export function applyCommittedPlan(state, plan) {
  const allocationsByGoal = new Map(
    plan.allocations.map((allocation) => [allocation.goalId, allocation.amountMinor]),
  );
  const now = new Date().toISOString();
  const nextVersion = state.stateVersion + 1;

  return {
    ...state,
    checkingMinor: state.checkingMinor - plan.totalAllocationMinor,
    goals: state.goals.map((goal) => ({
      ...goal,
      currentMinor: goal.currentMinor + (allocationsByGoal.get(goal.id) || 0),
    })),
    transactions: [
      ...plan.allocations.map((allocation, index) => {
        const goal = state.goals.find((item) => item.id === allocation.goalId);
        return {
          id: `commit-${Date.now()}-${index}`,
          date: now.slice(0, 10),
          description: `Goal allocation · ${goal?.name || allocation.goalId}`,
          amountMinor: -allocation.amountMinor,
          kind: "allocation",
        };
      }),
      ...state.transactions,
    ],
    stagedPlan: { ...plan, status: "committed", committedAt: now },
    stateVersion: nextVersion,
  };
}

export function parseTransactionCsv(csvText) {
  const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV must include a header and at least one row.");
  const headers = lines[0].split(",").map((header) => header.trim().toLowerCase());
  const dateIndex = headers.indexOf("date");
  const descriptionIndex = headers.indexOf("description");
  const amountIndex = headers.indexOf("amount");
  if ([dateIndex, descriptionIndex, amountIndex].includes(-1)) {
    throw new Error("CSV headers must be date, description, amount.");
  }

  return lines.slice(1).map((line, index) => {
    const cells = line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
    const amount = Number(cells[amountIndex]);
    if (!Number.isFinite(amount)) throw new Error(`Invalid amount on row ${index + 2}.`);
    return {
      id: `csv-${Date.now()}-${index}`,
      date: cells[dateIndex],
      description: cells[descriptionIndex] || "Imported transaction",
      amountMinor: toMinorUnits(amount),
      kind: "imported",
    };
  });
}
