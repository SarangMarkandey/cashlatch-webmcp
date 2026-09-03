export const DEMO_STATE = {
  schemaVersion: 1,
  id: "demo-workspace",
  name: "Example finances",
  isDemo: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  workspaceType: "household",
  currency: "INR",
  checkingMinor: 7600000,
  monthlyIncomeMinor: 10000000,
  boundaries: {
    minimumReserveMinor: 2500000,
    maximumAllocationMinor: 1500000,
  },
  goals: [
    {
      id: "emergency",
      name: "Emergency fund",
      currentMinor: 8000000,
      targetMinor: 20000000,
      targetDate: "2027-06-01",
      priority: "essential",
      color: "#6EE7B7",
    },
    {
      id: "laptop",
      name: "Work laptop",
      currentMinor: 2000000,
      targetMinor: 8000000,
      targetDate: "2027-02-01",
      priority: "important",
      color: "#A7C7FF",
    },
    {
      id: "travel",
      name: "Family trip",
      currentMinor: 1500000,
      targetMinor: 7000000,
      targetDate: "2027-10-01",
      priority: "flexible",
      color: "#F9C97C",
    },
  ],
  commitments: [
    { id: "rent", name: "Rent", amountMinor: 1200000, dueDay: 5 },
    { id: "emi", name: "EMI", amountMinor: 800000, dueDay: 12 },
  ],
  transactions: [
    { id: "tx-1", date: "2026-08-31", description: "Salary", amountMinor: 10000000 },
    { id: "tx-2", date: "2026-08-29", description: "Groceries", amountMinor: -420000 },
    { id: "tx-3", date: "2026-08-27", description: "Utilities", amountMinor: -275000 },
    { id: "tx-4", date: "2026-08-24", description: "Client reimbursement", amountMinor: 650000 },
  ],
  stateVersion: 1,
  stagedPlan: null,
  activity: [
    {
      id: "activity-demo",
      at: new Date().toISOString(),
      type: "system",
      message: "Example money workspace opened",
    },
  ],
};

export function freshDemoState() {
  const state = structuredClone(DEMO_STATE);
  state.id = `workspace-${crypto.randomUUID().slice(0, 8)}`;
  state.createdAt = new Date().toISOString();
  state.activity[0].at = new Date().toISOString();
  return state;
}

export function createBlankWorkspace({
  name,
  workspaceType = "personal",
  currency = "INR",
  checking = 0,
  monthlyIncome = 0,
  minimumReserve = 0,
  maximumAllocation = 0,
} = {}) {
  const toMinor = (value) => Math.round(Math.max(0, Number(value) || 0) * 100);
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    id: `workspace-${crypto.randomUUID().slice(0, 8)}`,
    name: String(name || "My money workspace").trim().slice(0, 60) || "My money workspace",
    isDemo: false,
    createdAt: now,
    workspaceType,
    currency,
    checkingMinor: toMinor(checking),
    monthlyIncomeMinor: toMinor(monthlyIncome),
    boundaries: {
      minimumReserveMinor: toMinor(minimumReserve),
      maximumAllocationMinor: toMinor(maximumAllocation),
    },
    goals: [],
    commitments: [],
    transactions: [],
    stateVersion: 1,
    stagedPlan: null,
    receipts: [],
    activity: [
      {
        id: crypto.randomUUID(),
        at: now,
        type: "human",
        message: "Money workspace created",
      },
    ],
  };
}
