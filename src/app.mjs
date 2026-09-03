import { createBlankWorkspace, freshDemoState } from "./demo.mjs";
import {
  applyCommittedPlan,
  calculateGoalPlan,
  createStagedPlan,
  fingerprintPlan,
  forecastCashflow,
  formatMoney,
  fromMinorUnits,
  parseTransactionCsv,
  simulateAllocation,
  toMinorUnits,
} from "./engine.mjs";
import { createWebMCPBridge } from "./webmcp.mjs";

const LEGACY_STORAGE_KEY = "cashlatch-workspace-v1";
const WORKSPACES_KEY = "cashlatch-workspaces-v2";
const ACTIVE_WORKSPACE_KEY = "cashlatch-active-workspace-v2";
// Site-tool calls can take long enough that a two-minute approval expires while
// the agent is still working. Five minutes keeps the permit short-lived without
// turning normal model latency into an apparent failure.
const PERMIT_TTL_MS = 300_000;
const WORKSPACE_TYPES = ["personal", "household", "independent", "business"];
const app = document.querySelector("#app");

let workspaces = loadWorkspaces();
let state = loadActiveWorkspace();
let permit = null;
let permitTimer = null;
let activeModal = null;
let workspaceDraft = null;
let boundaryDraft = null;
let toast = null;
let showWorkspaceHome = !state;
let webmcpStatus = {
  connected: false,
  message: "Checking site tools…",
  toolCount: 0,
};

function normalizeStoredWorkspace(parsed) {
  return {
    ...parsed,
    id: parsed.id || `workspace-${crypto.randomUUID().slice(0, 8)}`,
    name: parsed.name || "My workspace",
    isDemo: Boolean(parsed.isDemo),
    schemaVersion: 2,
    activity: parsed.activity || [],
    receipts: parsed.receipts || [],
    goals: parsed.goals || [],
    commitments: parsed.commitments || [],
    transactions: parsed.transactions || [],
    stagedPlan: parsed.stagedPlan?.status === "authorized"
      ? { ...parsed.stagedPlan, status: "stale" }
      : parsed.stagedPlan,
  };
}

function loadWorkspaces() {
  try {
    const stored = JSON.parse(localStorage.getItem(WORKSPACES_KEY) || "[]");
    if (Array.isArray(stored) && stored.length) return stored.map(normalizeStoredWorkspace);
    // Version 1 always began as demo data. Do not silently present that data as
    // the user's workspace after this real-user onboarding upgrade.
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return [];
  } catch {
    return [];
  }
}

function loadActiveWorkspace() {
  const activeId = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  return structuredClone(workspaces.find((item) => item.id === activeId) || workspaces[0] || null);
}

function persist() {
  if (state) {
    const index = workspaces.findIndex((item) => item.id === state.id);
    if (index >= 0) workspaces[index] = structuredClone(state);
    else workspaces.push(structuredClone(state));
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, state.id);
  }
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify(workspaces));
}

function activateWorkspace(workspaceId) {
  if (permit) revokePermit("workspace changed", { renderNow: false });
  state = structuredClone(workspaces.find((item) => item.id === workspaceId) || null);
  boundaryDraft = null;
  showWorkspaceHome = false;
  localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId || "");
  render();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderBrand() {
  return `
    <a class="brand" href="/" aria-label="CashLatch home">
      <img class="brand-logo" src="/assets/cashlatch-logo.png" alt="" />
      <span>CashLatch<small>Plans change. Your control doesn’t.</small></span>
    </a>
  `;
}

function fieldTitle(label, help) {
  return `
    <span class="field-title">
      <span>${escapeHtml(label)}</span>
      <span class="help-tip" tabindex="0" aria-label="${escapeHtml(`${label}: ${help}`)}">i<span role="tooltip">${escapeHtml(help)}</span></span>
    </span>
  `;
}

function money(value, compact = false) {
  return formatMoney(value, state.currency, compact);
}

function addActivity(target, message, type = "system") {
  target.activity = [
    { id: crypto.randomUUID(), at: new Date().toISOString(), type, message },
    ...(target.activity || []),
  ].slice(0, 40);
}

function showToast(message, tone = "default") {
  toast = { message, tone };
  render();
  window.setTimeout(() => {
    toast = null;
    render();
  }, 3200);
}

function clearPermitTimer() {
  if (permitTimer) window.clearTimeout(permitTimer);
  permitTimer = null;
}

function revokePermit(reason, { markPlanStale = true, renderNow = true } = {}) {
  if (!permit) return false;
  const shortId = permit.shortId;
  permit = null;
  clearPermitTimer();
  bridge.syncPermit(null).catch(() => {});
  if (markPlanStale && state.stagedPlan?.status === "authorized") {
    state.stagedPlan = { ...state.stagedPlan, status: "stale" };
  }
  addActivity(state, `Permit ${shortId} revoked · ${reason}`, "revoked");
  persist();
  if (renderNow) render();
  return true;
}

function mutateFinancialState(mutator, reason) {
  const previousPermit = permit;
  if (previousPermit) {
    permit = null;
    clearPermitTimer();
    bridge.syncPermit(null).catch(() => {});
  }

  const next = structuredClone(state);
  mutator(next);
  next.stateVersion += 1;
  if (next.stagedPlan && ["staged", "authorized"].includes(next.stagedPlan.status)) {
    next.stagedPlan.status = "stale";
  }
  addActivity(next, reason, "change");
  if (previousPermit) {
    addActivity(next, `Permit ${previousPermit.shortId} revoked · financial state changed`, "revoked");
  }
  state = next;
  persist();
  render();
}

function stagePlan(allocations, source = "human") {
  if (permit) revokePermit("a new plan was staged", { markPlanStale: false, renderNow: false });
  const plan = createStagedPlan(state, allocations, source);
  state = { ...state, stagedPlan: plan };
  addActivity(
    state,
    `${source === "agent" ? "Agent" : "Human"} staged ${money(plan.totalAllocationMinor)} across ${plan.allocations.length} goal${plan.allocations.length === 1 ? "" : "s"}`,
    source === "agent" ? "agent" : "human",
  );
  persist();
  render();
  return plan;
}

async function authorizeCurrentPlan() {
  const plan = state.stagedPlan;
  if (!plan || plan.status !== "staged" || !plan.withinBoundaries) return;

  const fingerprint = await fingerprintPlan(state, plan);
  const shortId = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
  const created = {
    id: crypto.randomUUID(),
    shortId,
    toolName: `commit_plan_${shortId}`,
    planId: plan.id,
    stateVersion: state.stateVersion,
    fingerprint,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PERMIT_TTL_MS).toISOString(),
  };

  permit = created;
  state = {
    ...state,
    stagedPlan: { ...plan, status: "authorized", approvedStateVersion: state.stateVersion },
  };
  addActivity(state, `Human authorized exact plan · permit ${shortId}`, "authorized");
  persist();

  try {
    await bridge.syncPermit(created);
    if (bridge.available()) {
      addActivity(state, `Execution capability created · ${created.toolName}`, "capability");
      persist();
    }
  } catch (error) {
    revokePermit(`capability registration failed: ${error.message}`, { renderNow: false });
    showToast("The plan was not authorized because the site tool could not be registered.", "danger");
    return;
  }

  permitTimer = window.setTimeout(() => {
    revokePermit("permit expired");
  }, PERMIT_TTL_MS);
  render();
}

async function commitPermit(permitId) {
  if (!permit || permit.id !== permitId) {
    return { success: false, code: "PERMIT_NOT_ACTIVE", message: "This permit is not active." };
  }
  if (Date.now() >= new Date(permit.expiresAt).getTime()) {
    revokePermit("permit expired");
    return { success: false, code: "PERMIT_EXPIRED", message: "The human authorization expired." };
  }

  const plan = state.stagedPlan;
  if (!plan || plan.id !== permit.planId || plan.status !== "authorized") {
    revokePermit("the approved plan is no longer active");
    return { success: false, code: "PLAN_CHANGED", message: "The approved plan is no longer active." };
  }
  if (state.stateVersion !== permit.stateVersion) {
    revokePermit("financial state version changed");
    return { success: false, code: "STALE_STATE", message: "Financial state changed after approval." };
  }

  const currentFingerprint = await fingerprintPlan(state, plan);
  if (currentFingerprint !== permit.fingerprint) {
    revokePermit("state fingerprint changed");
    return { success: false, code: "FINGERPRINT_MISMATCH", message: "Approved conditions changed." };
  }

  const validation = simulateAllocation(state, plan.allocations);
  if (!validation.withinBoundaries) {
    revokePermit("the plan no longer passes configured boundaries");
    return {
      success: false,
      code: "BOUNDARY_VIOLATION",
      message: "The plan no longer passes configured boundaries.",
      violations: validation.violations,
    };
  }

  const consumedPermit = permit;
  permit = null;
  clearPermitTimer();
  bridge.syncPermit(null).catch(() => {});

  state = applyCommittedPlan(state, plan);
  state.receipts = [
    {
      id: `receipt-${consumedPermit.shortId}`,
      permitId: consumedPermit.shortId,
      planId: plan.id,
      at: new Date().toISOString(),
      fingerprint: consumedPermit.fingerprint,
      totalAllocationMinor: plan.totalAllocationMinor,
      allocations: plan.allocations,
    },
    ...(state.receipts || []),
  ];
  addActivity(state, `Plan committed once · ${money(plan.totalAllocationMinor)} · permit consumed`, "committed");
  addActivity(state, `Execution capability removed · ${consumedPermit.toolName}`, "capability");
  persist();
  render();

  return {
    success: true,
    planId: plan.id,
    receiptId: `receipt-${consumedPermit.shortId}`,
    committedTotal: fromMinorUnits(plan.totalAllocationMinor),
    checkingAfter: fromMinorUnits(state.checkingMinor),
    currency: state.currency,
    message: "The exact human-approved plan was committed once. Its execution capability has been removed.",
  };
}

function proposeWorkspace(input, source = "human") {
  workspaceDraft = {
    id: `draft-${crypto.randomUUID().slice(0, 8)}`,
    name: String(input.name || "My workspace").trim().slice(0, 60),
    workspaceType: input.workspaceType || "personal",
    currency: input.currency || "INR",
    checking: Math.max(0, Number(input.checking) || 0),
    monthlyIncome: Math.max(0, Number(input.monthlyIncome) || 0),
    minimumReserve: Math.max(0, Number(input.minimumReserve) || 0),
    maximumAllocation: Math.max(0, Number(input.maximumAllocation) || 0),
    source,
  };
  activeModal = null;
  render();
  return {
    draftId: workspaceDraft.id,
    status: "awaiting_human_confirmation",
    message: "Workspace draft is visible in CashLatch. The human must review it and select Open workspace.",
  };
}

function confirmWorkspaceDraft() {
  if (!workspaceDraft) return null;
  const created = createBlankWorkspace(workspaceDraft);
  addActivity(
    created,
    workspaceDraft.source === "agent"
      ? "Agent prepared workspace details; human confirmed creation"
      : "Workspace details confirmed",
    "human",
  );
  workspaces.push(structuredClone(created));
  state = created;
  showWorkspaceHome = false;
  workspaceDraft = null;
  persist();
  render();
  return created;
}

const GOAL_COLORS = ["#6EE7B7", "#A7C7FF", "#F9C97C", "#D8B4FE", "#FDA4AF"];

function upsertGoal(input, source = "human") {
  if (!state) throw new Error("Create a workspace first.");
  const existing = input.goalId && state.goals.find((goal) => goal.id === input.goalId);
  const id = existing?.id || `goal-${crypto.randomUUID().slice(0, 8)}`;
  const goal = {
    id,
    name: String(input.name || existing?.name || "Goal").trim().slice(0, 80),
    currentMinor: toMinorUnits(input.current ?? fromMinorUnits(existing?.currentMinor || 0)),
    targetMinor: Math.max(1, toMinorUnits(input.target ?? fromMinorUnits(existing?.targetMinor || 1))),
    targetDate: String(input.targetDate || existing?.targetDate || new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10)),
    priority: input.priority || existing?.priority || "important",
    color: existing?.color || GOAL_COLORS[state.goals.length % GOAL_COLORS.length],
  };
  mutateFinancialState((next) => {
    const index = next.goals.findIndex((item) => item.id === id);
    if (index >= 0) next.goals[index] = goal;
    else next.goals.push(goal);
  }, `${source === "agent" ? "Agent" : "Human"} ${existing ? "updated" : "added"} goal · ${goal.name}`);
  return {
    success: true,
    goalId: id,
    action: existing ? "updated" : "added",
    message: `${goal.name} is now visible in the active workspace. Any previous plan approval was cancelled.`,
  };
}

function upsertCommitment(input, source = "human") {
  if (!state) throw new Error("Create a workspace first.");
  const existing = input.commitmentId && state.commitments.find((item) => item.id === input.commitmentId);
  const id = existing?.id || `commitment-${crypto.randomUUID().slice(0, 8)}`;
  const commitment = {
    id,
    name: String(input.name || existing?.name || "Commitment").trim().slice(0, 80),
    amountMinor: Math.max(1, toMinorUnits(input.amount ?? fromMinorUnits(existing?.amountMinor || 1))),
    dueDay: Math.max(1, Math.min(31, Math.round(Number(input.dueDay ?? existing?.dueDay ?? 1)))),
  };
  mutateFinancialState((next) => {
    const index = next.commitments.findIndex((item) => item.id === id);
    if (index >= 0) next.commitments[index] = commitment;
    else next.commitments.push(commitment);
  }, `${source === "agent" ? "Agent" : "Human"} ${existing ? "updated" : "added"} commitment · ${commitment.name}`);
  return {
    success: true,
    commitmentId: id,
    action: existing ? "updated" : "added",
    message: `${commitment.name} is now included in CashLatch forecasts. Any previous plan approval was cancelled.`,
  };
}

function recordFinancialEvent(input, source = "human") {
  if (!state) throw new Error("Create a workspace first.");
  const previousPlanStatus = state.stagedPlan?.status || null;
  const authorizationCancelled = Boolean(permit || previousPlanStatus === "authorized");
  const planInvalidated = ["staged", "authorized"].includes(previousPlanStatus);
  const amountMinor = Math.max(1, toMinorUnits(input.amount));
  const signedAmount = input.kind === "expense" ? -amountMinor : amountMinor;
  const description = String(input.description || "Transaction").trim().slice(0, 120);
  const transactionId = `tx-${crypto.randomUUID().slice(0, 8)}`;
  mutateFinancialState((next) => {
    next.checkingMinor += signedAmount;
    next.transactions.unshift({
      id: transactionId,
      date: input.date || new Date().toISOString().slice(0, 10),
      description,
      amountMinor: signedAmount,
      kind: input.kind,
    });
  }, `${source === "agent" ? "Agent recorded" : "Recorded"} ${input.kind} · ${description}`);
  return {
    success: true,
    transactionId,
    currentBalance: fromMinorUnits(state.checkingMinor),
    currency: state.currency,
    planInvalidated,
    authorizationCancelled,
    message: authorizationCancelled
      ? "The financial event was recorded and the active plan authorization was cancelled."
      : planInvalidated
        ? "The financial event was recorded and the staged plan became stale. No plan had been authorized."
        : "The financial event was recorded. There was no active plan to invalidate.",
  };
}

function proposeBoundaryChange(input, source = "agent") {
  if (!state) throw new Error("Create a workspace first.");
  boundaryDraft = {
    minimumReserveMinor: input.minimumReserve === undefined
      ? state.boundaries.minimumReserveMinor
      : toMinorUnits(input.minimumReserve),
    maximumAllocationMinor: input.maximumAllocation === undefined
      ? state.boundaries.maximumAllocationMinor
      : toMinorUnits(input.maximumAllocation),
    reason: String(input.reason || "No reason supplied").slice(0, 240),
    source,
  };
  render();
  return {
    status: "awaiting_human_confirmation",
    message: "The proposed safety-limit change is visible in CashLatch. It has not been applied.",
  };
}

function applyBoundaryDraft() {
  if (!boundaryDraft || !state) return;
  const accepted = boundaryDraft;
  boundaryDraft = null;
  mutateFinancialState((next) => {
    next.boundaries.minimumReserveMinor = accepted.minimumReserveMinor;
    next.boundaries.maximumAllocationMinor = accepted.maximumAllocationMinor;
  }, "Human approved new safety limits");
}

const bridge = createWebMCPBridge({
  getState: () => state,
  stagePlan,
  commitPermit,
  proposeWorkspace,
  upsertGoal,
  upsertCommitment,
  recordFinancialEvent,
  proposeBoundaryChange,
  onStatus: (status) => {
    webmcpStatus = { ...webmcpStatus, ...status };
    render();
  },
});

function progressPercent(goal) {
  return Math.min(100, Math.round((goal.currentMinor / goal.targetMinor) * 100));
}

function renderForecastChart(forecast) {
  const width = 760;
  const height = 238;
  const padX = 42;
  const padTop = 28;
  const padBottom = 42;
  const plotBottom = height - padBottom;
  const allValues = [
    ...forecast.points.map((point) => point.balanceMinor),
    forecast.reserveMinor,
  ];
  const max = Math.max(...allValues, 1);
  const min = Math.min(...allValues, 0);
  const range = Math.max(1, max - min);
  const x = (day) => padX + (day / forecast.horizonDays) * (width - padX * 2);
  const y = (balance) => padTop + ((max - balance) / range) * (plotBottom - padTop);
  const points = forecast.points.map((point) => `${x(point.day)},${y(point.balanceMinor)}`).join(" ");
  const reserveY = y(forecast.reserveMinor);
  const axisDays = [0, 30, 60, 90].filter((day) => day <= forecast.horizonDays);
  const tooltipWidth = 174;
  const tooltipHeight = 62;

  return `
    <svg class="forecast-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Projected cash balance over ${forecast.horizonDays} days">
      <defs>
        <linearGradient id="cashArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#6ee7b7" stop-opacity=".32" />
          <stop offset="100%" stop-color="#6ee7b7" stop-opacity="0" />
        </linearGradient>
      </defs>
      <line x1="${padX}" y1="${reserveY}" x2="${width - padX}" y2="${reserveY}" class="reserve-line" />
      <text x="${width - padX}" y="${reserveY - 8}" text-anchor="end" class="chart-label reserve-label">Reserve ${escapeHtml(money(forecast.reserveMinor, true))}</text>
      <line x1="${padX}" y1="${plotBottom}" x2="${width - padX}" y2="${plotBottom}" class="axis-line" />
      <polygon points="${points} ${x(forecast.horizonDays)},${plotBottom} ${padX},${plotBottom}" fill="url(#cashArea)" />
      <polyline points="${points}" class="cash-line" />
      ${forecast.points.map((point) => {
        const pointX = x(point.day);
        const pointY = y(point.balanceMinor);
        const tooltipX = Math.max(padX, Math.min(width - padX - tooltipWidth, pointX - tooltipWidth / 2));
        const tooltipY = Math.max(8, pointY - tooltipHeight - 14);
        const reserveDifference = point.balanceMinor - forecast.reserveMinor;
        const reserveText = reserveDifference >= 0
          ? `${money(reserveDifference, true)} above reserve`
          : `${money(Math.abs(reserveDifference), true)} below reserve`;
        return `
          <g class="forecast-point" tabindex="0" role="img" aria-label="${escapeHtml(`${point.label}, day ${point.day}, projected balance ${money(point.balanceMinor)}, ${reserveText}`)}">
            <circle cx="${pointX}" cy="${pointY}" r="12" class="cash-point-hit" />
            <circle cx="${pointX}" cy="${pointY}" r="5" class="cash-point" />
            <g class="forecast-tooltip" aria-hidden="true">
              <rect x="${tooltipX}" y="${tooltipY}" width="${tooltipWidth}" height="${tooltipHeight}" rx="9" />
              <text x="${tooltipX + 11}" y="${tooltipY + 18}" class="tooltip-title">${escapeHtml(point.label)} · Day ${point.day}</text>
              <text x="${tooltipX + 11}" y="${tooltipY + 37}" class="tooltip-value">${escapeHtml(money(point.balanceMinor))}</text>
              <text x="${tooltipX + 11}" y="${tooltipY + 52}" class="tooltip-detail">${escapeHtml(reserveText)}</text>
            </g>
          </g>
        `;
      }).join("")}
      ${axisDays.map((day) => `
        <line x1="${x(day)}" y1="${plotBottom}" x2="${x(day)}" y2="${plotBottom + 6}" class="axis-tick" />
        <text x="${x(day)}" y="${height - 12}" text-anchor="middle" class="chart-label">${day} days</text>
      `).join("")}
    </svg>
  `;
}

function renderGoal(goal, plan) {
  const allocation = plan?.allocations.find((item) => item.goalId === goal.id)?.amountMinor || 0;
  return `
    <article class="goal-card">
      <div class="goal-heading">
        <div class="goal-icon" style="--goal-color:${goal.color}">${escapeHtml(goal.name.slice(0, 1))}</div>
        <div>
          <h3>${escapeHtml(goal.name)}</h3>
          <p>${escapeHtml(goal.priority)} · ${escapeHtml(goal.targetDate)}</p>
        </div>
        <span class="goal-percent">${progressPercent(goal)}%</span>
      </div>
      <div class="goal-bar"><span style="width:${progressPercent(goal)}%;--goal-color:${goal.color}"></span></div>
      <div class="goal-values">
        <strong>${money(goal.currentMinor)}</strong>
        <span>of ${money(goal.targetMinor)}</span>
      </div>
      <label class="allocation-field">
        <span>Allocate now</span>
        <div><b>${escapeHtml(new Intl.NumberFormat("en-IN", { style: "currency", currency: state.currency, maximumFractionDigits: 0 }).formatToParts(0).find((part) => part.type === "currency")?.value || "₹")}</b><input inputmode="decimal" name="allocation-${goal.id}" value="${allocation ? fromMinorUnits(allocation) : ""}" placeholder="0" /></div>
      </label>
    </article>
  `;
}

function renderPlan(plan) {
  if (!plan) {
    return `
      <section class="panel plan-panel empty-plan">
        <div class="section-kicker">Recommendation</div>
        <h2>No recommendation yet</h2>
        <p>Enter an allocation above or ask ChatGPT to compare options and prepare a recommendation.</p>
      </section>
    `;
  }

  const statusLabels = {
    staged: "Review this recommendation",
    blocked: "This plan breaks one of your limits",
    authorized: "Ready to apply",
    stale: "Your finances changed—review again",
    committed: "Applied successfully",
  };
  const statusPills = {
    staged: "Review",
    blocked: "Blocked",
    authorized: "Ready",
    stale: "Review again",
    committed: "Applied",
  };

  return `
    <section class="panel plan-panel ${plan.status}">
      <div class="plan-title-row">
        <div>
          <div class="section-kicker">Recommendation · ${escapeHtml(plan.id)}</div>
          <h2>${statusLabels[plan.status] || escapeHtml(plan.status)}</h2>
        </div>
        <span class="status-pill ${plan.status}">${escapeHtml(statusPills[plan.status] || plan.status)}</span>
      </div>
      <div class="plan-allocations">
        ${plan.allocations.map((allocation) => {
          const goal = state.goals.find((item) => item.id === allocation.goalId);
          return `<div><span>${escapeHtml(goal?.name || allocation.goalId)}</span><strong>${money(allocation.amountMinor)}</strong></div>`;
        }).join("")}
        <div class="plan-total"><span>Total allocation</span><strong>${money(plan.totalAllocationMinor)}</strong></div>
      </div>
      <div class="plan-metrics">
        <div><span>Checking after</span><strong>${money(plan.checkingAfterMinor)}</strong></div>
        <div><span>Upcoming commitments</span><strong>${money(plan.upcomingCommitmentsMinor)}</strong></div>
        <div><span>Lowest projected</span><strong>${money(plan.lowestProjectedMinor)}</strong></div>
      </div>
      ${plan.violations.length ? `
        <div class="violations">
          ${plan.violations.map((violation) => `<p><b>${escapeHtml(violation.code)}</b> ${escapeHtml(violation.message)}</p>`).join("")}
        </div>
      ` : `<p class="pass-note">✓ This plan stays within the limits currently saved in CashLatch. This is not financial advice.</p>`}
      <div class="plan-actions">
        ${plan.status === "staged" ? `<button class="primary-button" data-action="authorize">Approve this plan</button><button class="ghost-button" data-action="reject-plan">Reject</button>` : ""}
        ${plan.status === "authorized" ? `<div class="authorized-note"><span>Approval ${permit?.shortId || "—"}</span><b>Return to ChatGPT and say: Apply my approved plan</b></div>` : ""}
        ${plan.status === "stale" ? `<button class="primary-button" data-action="restage-safe">Update recommendation</button>` : ""}
        ${plan.status === "committed" ? `<div class="authorized-note"><span>Decision receipt</span><b>${escapeHtml(state.receipts?.[0]?.id || "Applied")}</b></div>` : ""}
      </div>
    </section>
  `;
}

function renderAccessPanel() {
  const baseTools = [
    "Read and forecast this workspace",
    "Add goals and monthly commitments",
    "Record income and expenses",
    "Compare and prepare allocations",
  ];
  return `
    <section class="panel access-panel">
      <div class="access-header">
        <div>
          <div class="section-kicker">ChatGPT access</div>
          <h2>What your agent can do</h2>
        </div>
        <span class="connection-badge ${webmcpStatus.connected ? "online" : "offline"}"><i></i>${webmcpStatus.connected ? "Connected" : "Preview"}</span>
      </div>
      <p class="access-message">${escapeHtml(webmcpStatus.message)}</p>
      <div class="tool-list">
        ${baseTools.map((tool) => `<div><span class="tool-dot read"></span><span>${tool}</span><b>Available</b></div>`).join("")}
        <div class="execute-tool ${permit ? "active" : "locked"}">
          <span class="tool-dot execute"></span>
          <span>${permit ? "Apply your approved plan" : "Apply a financial plan"}</span>
          <b>${permit ? "Available once" : "Locked until you approve"}</b>
        </div>
      </div>
      <div class="permit-card ${permit ? "visible" : ""}">
        ${permit ? `
          <div><span>Approval code</span><strong>${permit.shortId}</strong></div>
          <div><span>Uses remaining</span><strong>1</strong></div>
          <p>Expires ${new Date(permit.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}. Any financial change cancels it.</p>
        ` : `<p>ChatGPT can prepare a plan, but only you can unlock the exact plan you reviewed.</p>`}
      </div>
    </section>
  `;
}

function renderWorkspaceDraftReview() {
  if (!workspaceDraft) return "";
  const draftMoney = (value) => formatMoney(toMinorUnits(value), workspaceDraft.currency);
  return `
    <section class="workspace-review-card" aria-live="polite">
      <div>
        <span class="review-label">${workspaceDraft.source === "agent" ? "ChatGPT prepared this" : "Review your workspace"}</span>
        <h2>${escapeHtml(workspaceDraft.name)}</h2>
        <p>Nothing is saved until you confirm these details.</p>
      </div>
      <div class="review-grid">
        <span><small>Type</small><b>${escapeHtml(workspaceDraft.workspaceType)}</b></span>
        <span><small>Currency</small><b>${escapeHtml(workspaceDraft.currency)}</b></span>
        <span><small>Current balance</small><b>${draftMoney(workspaceDraft.checking)}</b></span>
        <span><small>Monthly income</small><b>${draftMoney(workspaceDraft.monthlyIncome)}</b></span>
        <span><small>Protected minimum</small><b>${draftMoney(workspaceDraft.minimumReserve)}</b></span>
        <span><small>Plan limit</small><b>${draftMoney(workspaceDraft.maximumAllocation)}</b></span>
      </div>
      <div class="review-actions">
        <button class="primary-button" data-action="confirm-workspace">Open workspace</button>
        <button class="ghost-button" data-action="edit-workspace-draft">Edit details</button>
        <button class="ghost-button" data-action="cancel-workspace-draft">Cancel</button>
      </div>
    </section>
  `;
}

function renderWelcome() {
  return `
    <div class="welcome-shell">
      <header class="welcome-header">
        ${renderBrand()}
      </header>
      <main class="welcome-main">
        <section class="welcome-copy">
          <div class="eyebrow"><span></span>You stay in control</div>
          <h1>Plan your money without risking what comes next.</h1>
          <p>Keep balances, bills and goals in one private browser workspace. ChatGPT can organize the details and compare options. CashLatch checks your limits before anything is applied.</p>
          <div class="welcome-steps">
            <div><b>1</b><span><strong>Tell us the basics</strong><small>Create your own workspace—no demo data mixed in.</small></span></div>
            <div><b>2</b><span><strong>Ask ChatGPT to help</strong><small>It can add goals, record changes and prepare a plan.</small></span></div>
            <div><b>3</b><span><strong>Approve the exact plan</strong><small>If your finances change, the old approval is cancelled.</small></span></div>
          </div>
          <div class="welcome-actions">
            <button class="primary-button large-button" data-action="new-workspace">Create my workspace</button>
            <button class="ghost-button large-button" data-action="load-demo">Try fictional demo</button>
          </div>
          <p class="welcome-privacy">Stored in this browser. CashLatch has no financial-data server.</p>
        </section>
        <aside class="agent-start-card">
          <span class="section-kicker">Prefer to start in chat?</span>
          <h2>Describe your situation naturally</h2>
          <p>With this page open beside ChatGPT, try:</p>
          <blockquote>Create a Personal workspace in INR. My balance is ₹76,000, income is ₹80,000, I want to protect ₹25,000, and no plan should allocate more than ₹15,000.</blockquote>
          <small>ChatGPT will prepare a draft here. You review it before the workspace is created.</small>
        </aside>
        ${renderWorkspaceDraftReview()}
        ${workspaces.length ? `
          <section class="saved-workspaces" aria-labelledby="saved-workspaces-title">
            <div class="saved-workspaces-heading"><div><span class="section-kicker">Saved in this browser</span><h2 id="saved-workspaces-title">Your workspaces</h2></div><button class="primary-button" data-action="new-workspace">+ New workspace</button></div>
            <div class="saved-workspace-grid">
              ${workspaces.map((workspace) => `
                <button class="saved-workspace-card" data-action="open-workspace" data-id="${workspace.id}">
                  <span><b>${escapeHtml(workspace.name)}</b><small>${escapeHtml(workspace.workspaceType)} · ${escapeHtml(workspace.currency)}${workspace.isDemo ? " · Fictional demo" : ""}</small></span>
                  <strong>Open →</strong>
                </button>
              `).join("")}
            </div>
          </section>
        ` : ""}
      </main>
      ${renderNewWorkspaceModal()}
      ${toast ? `<div class="toast ${toast.tone}">${escapeHtml(toast.message)}</div>` : ""}
    </div>
  `;
}

function renderNewWorkspaceModal() {
  if (activeModal !== "new-workspace") return "";
  const draft = workspaceDraft || {};
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal setup-modal" role="dialog" aria-modal="true" aria-labelledby="new-workspace-title">
        <div class="modal-header">
          <div><div class="section-kicker">Your details</div><h2 id="new-workspace-title">Create a workspace</h2></div>
          <button class="icon-button" data-action="close-modal" aria-label="Close">×</button>
        </div>
        <p class="modal-intro">Start with the numbers that affect your next decision. You can add goals and bills afterward.</p>
        <form id="new-workspace-form">
          <div class="form-grid">
            <label>${fieldTitle("Workspace name", "A private label to help you distinguish this set of finances from your other workspaces.")}<input name="name" placeholder="For example, Personal finances" value="${escapeHtml(draft.name || "Personal finances")}" maxlength="60" required /></label>
            <label>${fieldTitle("Workspace type", "Choose the closest use, or select Custom and name your own type. This label does not change permissions.")}<select name="workspaceType" data-custom-type-select="new-workspace-custom">
              ${WORKSPACE_TYPES.map((type) => `<option value="${type}" ${draft.workspaceType === type ? "selected" : ""}>${type}</option>`).join("")}
              <option value="custom" ${draft.workspaceType && !WORKSPACE_TYPES.includes(draft.workspaceType) ? "selected" : ""}>custom</option>
            </select></label>
            <label id="new-workspace-custom" class="custom-type-field ${draft.workspaceType && !WORKSPACE_TYPES.includes(draft.workspaceType) ? "" : "is-hidden"}">${fieldTitle("Custom workspace type", "A short label such as Travel, Wedding, Education, or Side project.")}<input name="workspaceTypeCustom" placeholder="For example, Education" value="${escapeHtml(draft.workspaceType && !WORKSPACE_TYPES.includes(draft.workspaceType) ? draft.workspaceType : "")}" maxlength="40" /></label>
            <label>${fieldTitle("Currency", "Controls how money is displayed. CashLatch does not perform currency conversion.")}<select name="currency">
              ${["INR", "USD", "EUR", "GBP", "CAD", "AUD", "JPY"].map((currency) => `<option value="${currency}" ${(draft.currency || "INR") === currency ? "selected" : ""}>${currency}</option>`).join("")}
            </select></label>
            <label>${fieldTitle("Current available balance", "The amount currently available in the account you want CashLatch to plan from.")}<input name="checking" type="number" min="0" step="0.01" placeholder="0.00" value="${draft.checking ?? ""}" required /></label>
            <label>${fieldTitle("Expected monthly income", "Your normal monthly inflow. CashLatch uses it only for projections.")}<input name="monthlyIncome" type="number" min="0" step="0.01" placeholder="0.00" value="${draft.monthlyIncome ?? ""}" required /></label>
            <label>${fieldTitle("Protected minimum balance", "The lowest balance you want forecasts and plans to preserve.")}<input name="minimumReserve" type="number" min="0" step="0.01" placeholder="0.00" value="${draft.minimumReserve ?? ""}" required /><small>CashLatch will not approve a plan projected to cross this.</small></label>
            <label>${fieldTitle("Maximum amount per plan", "A hard cap on the total amount any single plan can allocate.")}<input name="maximumAllocation" type="number" min="0" step="0.01" placeholder="0.00" value="${draft.maximumAllocation ?? ""}" required /></label>
          </div>
          <div class="modal-actions"><button type="button" class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" type="submit">Review workspace</button></div>
        </form>
      </section>
    </div>
  `;
}

function renderBoundaryReview() {
  if (!boundaryDraft || !state) return "";
  return `
    <section class="boundary-review-card" aria-live="polite">
      <div>
        <span class="review-label">ChatGPT proposed a safety-limit change</span>
        <h2>Only you can change these limits</h2>
        <p>${escapeHtml(boundaryDraft.reason)}</p>
      </div>
      <div class="boundary-comparison">
        <span><small>Protected minimum</small><b>${money(state.boundaries.minimumReserveMinor)} → ${money(boundaryDraft.minimumReserveMinor)}</b></span>
        <span><small>Maximum per plan</small><b>${money(state.boundaries.maximumAllocationMinor)} → ${money(boundaryDraft.maximumAllocationMinor)}</b></span>
      </div>
      <div class="review-actions">
        <button class="primary-button" data-action="accept-boundaries">Accept new limits</button>
        <button class="ghost-button" data-action="reject-boundaries">Keep current limits</button>
      </div>
    </section>
  `;
}

function renderSettingsModal() {
  if (activeModal !== "settings" || !state) return "";
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="modal-header">
          <div><div class="section-kicker">Workspace settings</div><h2 id="settings-title">Edit ${escapeHtml(state.name)}</h2></div>
          <button class="icon-button" data-action="close-modal" aria-label="Close">×</button>
        </div>
        <form id="settings-form">
          <div class="form-grid">
            <label>${fieldTitle("Workspace name", "A private label used to identify this workspace.")}<input name="workspaceName" placeholder="Workspace name" value="${escapeHtml(state.name)}" maxlength="60" required /></label>
            <label>${fieldTitle("Workspace type", "Describes what this workspace is for. Select Custom to use your own label.")}<select name="workspaceType" data-custom-type-select="settings-custom">
              ${WORKSPACE_TYPES.map((type) => `<option value="${type}" ${state.workspaceType === type ? "selected" : ""}>${type}</option>`).join("")}
              <option value="custom" ${!WORKSPACE_TYPES.includes(state.workspaceType) ? "selected" : ""}>custom</option>
            </select></label>
            <label id="settings-custom" class="custom-type-field ${!WORKSPACE_TYPES.includes(state.workspaceType) ? "" : "is-hidden"}">${fieldTitle("Custom workspace type", "A short label that explains what this workspace is for.")}<input name="workspaceTypeCustom" placeholder="For example, Wedding" value="${escapeHtml(!WORKSPACE_TYPES.includes(state.workspaceType) ? state.workspaceType : "")}" maxlength="40" /></label>
            <label>${fieldTitle("Workspace currency", "Changes number formatting only; existing values are not converted.")}<select name="currency">
              ${["INR", "USD", "EUR", "GBP", "CAD", "AUD", "JPY"].map((currency) => `<option value="${currency}" ${state.currency === currency ? "selected" : ""}>${currency}</option>`).join("")}
            </select></label>
            <label>${fieldTitle("Checking balance", "The current amount available for planning.")}<input name="checking" type="number" min="0" step="0.01" placeholder="0.00" value="${fromMinorUnits(state.checkingMinor)}" required /></label>
            <label>${fieldTitle("Monthly income", "The recurring monthly income used by the forecast.")}<input name="monthlyIncome" type="number" min="0" step="0.01" placeholder="0.00" value="${fromMinorUnits(state.monthlyIncomeMinor)}" required /></label>
            <label>${fieldTitle("Minimum reserve", "Plans are blocked when their forecast would cross this protected amount.")}<input name="minimumReserve" type="number" min="0" step="0.01" placeholder="0.00" value="${fromMinorUnits(state.boundaries.minimumReserveMinor)}" required /></label>
            <label>${fieldTitle("Maximum allocation", "The maximum combined amount CashLatch will allow in one plan.")}<input name="maximumAllocation" type="number" min="0" step="0.01" placeholder="0.00" value="${fromMinorUnits(state.boundaries.maximumAllocationMinor)}" required /></label>
          </div>
          <div class="form-section-heading"><h3 class="form-section-title">Goals</h3><button type="button" class="ghost-button small-button" data-action="add-goal">+ Add goal</button></div>
          <div class="editable-list">
            ${state.goals.map((goal) => `
              <div class="editable-row goal-edit-row">
                <label class="compact-field wide-field"><span>Goal name</span><input name="goalName-${goal.id}" placeholder="For example, Emergency fund" value="${escapeHtml(goal.name)}" /></label>
                <label class="compact-field"><span>Saved so far</span><input name="goalCurrent-${goal.id}" type="number" min="0" step="0.01" placeholder="0.00" value="${fromMinorUnits(goal.currentMinor)}" /></label>
                <label class="compact-field"><span>Target amount</span><input name="goalTarget-${goal.id}" type="number" min="0.01" step="0.01" placeholder="0.00" value="${fromMinorUnits(goal.targetMinor)}" /></label>
                <label class="compact-field"><span>Target date</span><input name="goalDate-${goal.id}" type="date" value="${goal.targetDate}" /></label>
                <label class="compact-field"><span>Priority</span><select name="goalPriority-${goal.id}">${["essential", "important", "flexible"].map((priority) => `<option value="${priority}" ${goal.priority === priority ? "selected" : ""}>${priority}</option>`).join("")}</select></label>
                <button type="button" class="remove-button" data-action="remove-goal" data-id="${goal.id}" aria-label="Remove ${escapeHtml(goal.name)}">×</button>
              </div>
            `).join("") || `<p class="empty-list-note">No goals yet. Add one here or ask ChatGPT.</p>`}
          </div>
          <div class="form-section-heading"><h3 class="form-section-title">Monthly commitments</h3><button type="button" class="ghost-button small-button" data-action="add-commitment">+ Add commitment</button></div>
          <div class="editable-list">
            ${state.commitments.map((item) => `
              <div class="editable-row commitment-row">
                <label class="compact-field wide-field"><span>Commitment name</span><input name="commitmentName-${item.id}" placeholder="For example, Rent" value="${escapeHtml(item.name)}" /></label>
                <label class="compact-field"><span>Monthly amount</span><input name="commitmentAmount-${item.id}" type="number" min="0.01" step="0.01" placeholder="0.00" value="${fromMinorUnits(item.amountMinor)}" /></label>
                <label class="compact-field"><span>Due day</span><input name="commitmentDay-${item.id}" type="number" min="1" max="31" placeholder="1–31" value="${item.dueDay}" /></label>
                <button type="button" class="remove-button" data-action="remove-commitment" data-id="${item.id}" aria-label="Remove ${escapeHtml(item.name)}">×</button>
              </div>
            `).join("") || `<p class="empty-list-note">No monthly commitments yet.</p>`}
          </div>
          <p class="currency-warning">Changing currency changes formatting only; CashLatch does not convert existing amounts.</p>
          <div class="modal-actions split-actions"><button type="button" class="danger-quiet-button" data-action="delete-workspace">Delete workspace</button><span></span><button type="button" class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" type="submit">Save changes</button></div>
        </form>
      </section>
    </div>
  `;
}

function renderCsvModal() {
  if (activeModal !== "csv") return "";
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="csv-title">
        <div class="modal-header">
          <div><div class="section-kicker">Transactions</div><h2 id="csv-title">Import CSV history</h2></div>
          <button class="icon-button" data-action="close-modal" aria-label="Close">×</button>
        </div>
        <p>Use headers <code>date,description,amount</code>. Imported history does not alter the current checking balance you entered.</p>
        <label class="file-drop"><input id="csv-file" type="file" accept=".csv,text/csv" /><span>Choose CSV file</span><small>Transactions stay in this browser workspace.</small></label>
      </section>
    </div>
  `;
}

function render() {
  if (!state || showWorkspaceHome) {
    app.innerHTML = renderWelcome();
    bindEvents();
    return;
  }
  const forecast = forecastCashflow(state, 90);
  const goalPlan = calculateGoalPlan(state);
  const plan = state.stagedPlan;
  const availableNow = Math.min(forecast.availableNowMinor, state.boundaries.maximumAllocationMinor);
  const recentActivity = state.activity.slice(0, 8);
  const recentTransactions = state.transactions.slice(0, 5);

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="topbar-brand-group">${renderBrand()}</div>
        <nav class="workspace-navigation" aria-label="Workspace controls">
          <button class="back-to-workspaces" data-action="back-to-workspaces">← Workspaces</button>
          <div class="workspace-switcher">
          <label for="workspace-select">Workspace</label>
          <select id="workspace-select">
            ${workspaces.map((workspace) => `<option value="${workspace.id}" ${workspace.id === state.id ? "selected" : ""}>${escapeHtml(workspace.name)}${workspace.isDemo ? " · Demo" : ""}</option>`).join("")}
          </select>
          </div>
          <button class="add-workspace-button" data-action="new-workspace"><span aria-hidden="true">+</span><span>New workspace</span></button>
          <details class="topbar-menu">
            <summary aria-label="Open workspace actions">Actions <span aria-hidden="true">▾</span></summary>
            <div class="topbar-menu-popover">
              <button data-action="import-csv"><span>Import CSV</span><small>Add transaction history</small></button>
              <button data-action="settings"><span>Edit workspace</span><small>Balances, goals and limits</small></button>
              <button data-action="load-demo"><span>Try fictional demo</span><small>Open sample data separately</small></button>
            </div>
          </details>
        </nav>
      </header>

      <main>
        ${state.isDemo ? `<div class="demo-banner"><b>Fictional demo</b><span>This workspace contains sample data. Create your own workspace to use CashLatch with your situation.</span><button class="ghost-button" data-action="new-workspace">Create mine</button></div>` : ""}
        <section class="hero-panel">
          <div class="hero-copy">
            <div class="eyebrow"><span></span>${escapeHtml(state.name)}</div>
            <h1>Plan money without risking<br /><em>what comes next.</em></h1>
            <p>ChatGPT can organize your finances, compare options and prepare a plan. CashLatch checks every plan against the limits you set. Only you can approve it.</p>
            <div class="prompt-box">
              <div><span>Suggested agent prompt</span><p>Help me fund my goals without putting my next 30 days of commitments or ${money(state.boundaries.minimumReserveMinor)} reserve at risk. Compare the trade-offs, then stage your recommendation.</p></div>
              <button class="copy-button" data-action="copy-prompt" aria-label="Copy prompt">Copy</button>
            </div>
          </div>
          <div class="hero-balance">
            <div class="balance-label">Checking available</div>
            <strong>${money(state.checkingMinor)}</strong>
            <div class="balance-rule"><span style="width:${Math.min(100, (availableNow / Math.max(state.checkingMinor, 1)) * 100)}%"></span></div>
            <div class="balance-split"><span>Allocatable now</span><b>${money(Math.max(0, availableNow))}</b></div>
            <div class="balance-split"><span>30-day commitments</span><b>${money(forecast.monthlyCommitmentsMinor)}</b></div>
            <div class="balance-split"><span>Protected reserve</span><b>${money(state.boundaries.minimumReserveMinor)}</b></div>
          </div>
        </section>

        ${renderWorkspaceDraftReview()}
        ${renderBoundaryReview()}

        <section class="metrics-row">
          <article><span>Monthly income</span><strong>${money(state.monthlyIncomeMinor)}</strong><small>Workspace estimate</small></article>
          <article><span>Goal funding needed</span><strong>${money(goalPlan.totalRequiredMonthlyMinor)}</strong><small>${goalPlan.feasible ? "Within monthly capacity" : "Needs prioritization"}</small></article>
          <article><span>Workspace freshness</span><strong>Update ${state.stateVersion}</strong><small>Any new financial change cancels approval</small></article>
          <article><span>Apply plan</span><strong class="${permit ? "permit-on" : "permit-off"}">${permit ? "Ready once" : "Locked"}</strong><small>${permit ? `Approval ${permit.shortId}` : "You have not approved a plan"}</small></article>
        </section>

        <div class="main-grid">
          <div class="primary-column">
            <section class="panel forecast-panel">
              <div class="panel-heading">
                <div><div class="section-kicker">90-day outlook</div><h2>Cash forecast</h2></div>
                <div class="forecast-summary"><span>Lowest projected</span><strong>${money(forecast.lowestBalanceMinor)}</strong></div>
              </div>
              ${renderForecastChart(forecast)}
              <div class="chart-legend"><span><i class="legend-cash"></i>Projected cash</span><span><i class="legend-reserve"></i>Your reserve boundary</span><small>Uses recorded income and recurring commitments; unentered expenses are not included.</small></div>
            </section>

            <section class="goals-section">
              <div class="section-heading"><div><div class="section-kicker">Your priorities</div><h2>Goal allocation</h2></div><span>${state.goals.length} active goals</span></div>
              <form id="allocation-form">
                <div class="goals-grid">${state.goals.map((goal) => renderGoal(goal, plan?.status === "staged" ? plan : null)).join("") || `<div class="empty-goals"><h3>No goals yet</h3><p>Add a goal in workspace settings or ask ChatGPT to add one from this page.</p><button type="button" class="ghost-button" data-action="settings">Add a goal</button></div>`}</div>
                ${state.goals.length ? `<div class="allocation-submit"><span>Enter any split. CashLatch will test the exact plan against your current state.</span><button class="secondary-button" type="submit">Check & prepare plan</button></div>` : ""}
              </form>
            </section>

            ${renderPlan(plan)}

            <section class="panel transaction-panel">
              <div class="panel-heading"><div><div class="section-kicker">Money changes</div><h2>Income and expenses</h2></div>${state.isDemo ? `<button class="danger-quiet-button" data-action="surprise-expense">Demo unexpected ${money(2_000_000)} expense</button>` : ""}</div>
              <form id="transaction-form" class="transaction-form">
                <input name="description" placeholder="Description" required />
                <input name="amount" type="number" min="0.01" step="0.01" placeholder="Amount" required />
                <select name="kind"><option value="expense">Expense</option><option value="income">Income</option></select>
                <button type="submit" class="ghost-button">Add transaction</button>
              </form>
              <div class="transaction-list">
                ${recentTransactions.map((item) => `<div><span class="transaction-sign ${item.amountMinor >= 0 ? "income" : "expense"}">${item.amountMinor >= 0 ? "+" : "−"}</span><span><b>${escapeHtml(item.description)}</b><small>${escapeHtml(item.date)}</small></span><strong class="${item.amountMinor >= 0 ? "income-text" : ""}">${money(Math.abs(item.amountMinor))}</strong></div>`).join("")}
              </div>
            </section>
          </div>

          <aside class="side-column">
            ${renderAccessPanel()}
            <section class="panel boundaries-panel">
              <div class="section-kicker">Deterministic rules</div><h2>Your boundaries</h2>
              <div class="boundary-list">
                <div><span>Minimum checking reserve</span><strong>${money(state.boundaries.minimumReserveMinor)}</strong></div>
                <div><span>Maximum single allocation</span><strong>${money(state.boundaries.maximumAllocationMinor)}</strong></div>
                <div><span>Recurring commitments</span><strong>${money(forecast.monthlyCommitmentsMinor)}</strong></div>
                <div><span>Allow negative checking</span><strong>Never</strong></div>
              </div>
              <p>These values are application constraints—not instructions hidden in a prompt.</p>
            </section>
            <section class="panel activity-panel">
              <div class="section-kicker">Evidence</div><h2>Activity trail</h2>
              <div class="activity-list">
                ${recentActivity.map((item) => `<div class="activity-item ${item.type}"><i></i><span><b>${escapeHtml(item.message)}</b><small>${new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small></span></div>`).join("")}
              </div>
            </section>
            <div class="privacy-note"><b>Local workspace</b><p>CashLatch does not upload or store this workspace on its own server. Data returned through site tools is shared with the browser agent you ask to use this page.</p></div>
          </aside>
        </div>
      </main>
    </div>
    ${renderNewWorkspaceModal()}
    ${renderSettingsModal()}
    ${renderCsvModal()}
    ${toast ? `<div class="toast ${toast.tone}">${escapeHtml(toast.message)}</div>` : ""}
  `;

  bindEvents();
}

function bindEvents() {
  document.querySelectorAll("[data-action]").forEach((element) => {
    element.addEventListener("click", async (event) => {
      const action = element.dataset.action;
      if (action === "close-modal" && event.target !== element && element.classList.contains("modal-backdrop")) return;
      if (action === "new-workspace") {
        workspaceDraft = null;
        activeModal = "new-workspace";
      }
      if (action === "back-to-workspaces") {
        activeModal = null;
        showWorkspaceHome = true;
        render();
        return;
      }
      if (action === "open-workspace") {
        activateWorkspace(element.dataset.id);
        return;
      }
      if (action === "settings") activeModal = "settings";
      if (action === "import-csv") activeModal = "csv";
      if (action === "close-modal") activeModal = null;
      if (action === "authorize") await authorizeCurrentPlan();
      if (action === "confirm-workspace") {
        confirmWorkspaceDraft();
        showToast("Workspace created");
        return;
      }
      if (action === "edit-workspace-draft") activeModal = "new-workspace";
      if (action === "cancel-workspace-draft") workspaceDraft = null;
      if (action === "accept-boundaries") {
        applyBoundaryDraft();
        showToast("Safety limits updated");
        return;
      }
      if (action === "reject-boundaries") {
        boundaryDraft = null;
        render();
        showToast("Current safety limits kept");
        return;
      }
      if (action === "reject-plan" && state?.stagedPlan) {
        if (permit) revokePermit("plan rejected", { renderNow: false });
        state.stagedPlan = null;
        addActivity(state, "Human rejected the prepared plan", "human");
        persist();
        showToast("Plan rejected");
        return;
      }
      if (action === "copy-prompt") {
        const text = document.querySelector(".prompt-box p")?.textContent || "";
        await navigator.clipboard.writeText(text);
        showToast("Prompt copied");
        return;
      }
      if (action === "load-demo") {
        if (permit) revokePermit("workspace changed", { renderNow: false });
        const demo = freshDemoState();
        const existingDemoCount = workspaces.filter((item) => item.isDemo).length;
        demo.name = existingDemoCount ? `Fictional demo ${existingDemoCount + 1}` : "Fictional demo";
        workspaces.push(structuredClone(demo));
        state = demo;
        showWorkspaceHome = false;
        persist();
        activeModal = null;
        showToast("Fictional demo opened in a separate workspace");
        return;
      }
      if (action === "surprise-expense") {
        mutateFinancialState((next) => {
          next.checkingMinor -= 2_000_000;
          next.transactions.unshift({
            id: crypto.randomUUID(),
            date: new Date().toISOString().slice(0, 10),
            description: "Surprise laptop repair",
            amountMinor: -2_000_000,
            kind: "expense",
          });
        }, "Surprise expense added · checking reduced by ₹20,000");
        showToast("Financial state changed. Any authorization was revoked.", "danger");
        return;
      }
      if (action === "restage-safe") {
        if (!state.goals.length) {
          showToast("Add at least one goal before preparing a plan.", "danger");
          return;
        }
        const maxSafe = Math.min(
          state.boundaries.maximumAllocationMinor,
          forecastCashflow(state, 30).availableNowMinor,
        );
        const firstGoal = state.goals[0];
        const secondGoal = state.goals[1];
        const allocations = secondGoal
          ? [
              { goalId: firstGoal.id, amountMinor: Math.round(maxSafe * 0.7) },
              { goalId: secondGoal.id, amountMinor: maxSafe - Math.round(maxSafe * 0.7) },
            ]
          : [{ goalId: firstGoal.id, amountMinor: maxSafe }];
        stagePlan(allocations);
        showToast("Plan recalculated from the new state");
        return;
      }
      if (action === "add-goal") {
        upsertGoal({ name: "New goal", current: 0, target: 1000, targetDate: new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10), priority: "important" });
        activeModal = "settings";
        render();
        return;
      }
      if (action === "remove-goal") {
        const id = element.dataset.id;
        mutateFinancialState((next) => { next.goals = next.goals.filter((goal) => goal.id !== id); }, "Human removed a goal");
        activeModal = "settings";
        render();
        return;
      }
      if (action === "add-commitment") {
        upsertCommitment({ name: "New commitment", amount: 1, dueDay: 1 });
        activeModal = "settings";
        render();
        return;
      }
      if (action === "remove-commitment") {
        const id = element.dataset.id;
        mutateFinancialState((next) => { next.commitments = next.commitments.filter((item) => item.id !== id); }, "Human removed a monthly commitment");
        activeModal = "settings";
        render();
        return;
      }
      if (action === "delete-workspace") {
        if (window.confirm(`Delete ${state.name} from this browser? This cannot be undone.`)) {
          if (permit) revokePermit("workspace deleted", { renderNow: false });
          const deletedId = state.id;
          workspaces = workspaces.filter((workspace) => workspace.id !== deletedId);
          state = structuredClone(workspaces[0] || null);
          showWorkspaceHome = !state;
          activeModal = null;
          localStorage.setItem(ACTIVE_WORKSPACE_KEY, state?.id || "");
          persist();
          showToast("Workspace deleted");
          return;
        }
      }
      render();
    });
  });

  document.querySelector("#workspace-select")?.addEventListener("change", (event) => {
    activateWorkspace(event.target.value);
  });

  document.querySelectorAll("[data-custom-type-select]").forEach((select) => {
    const updateCustomTypeField = () => {
      const field = document.getElementById(select.dataset.customTypeSelect);
      if (!field) return;
      const isCustom = select.value === "custom";
      field.classList.toggle("is-hidden", !isCustom);
      const input = field.querySelector("input");
      if (input) input.required = isCustom;
    };
    select.addEventListener("change", updateCustomTypeField);
    updateCustomTypeField();
  });

  document.querySelector("#new-workspace-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    proposeWorkspace({
      name: data.get("name"),
      workspaceType: data.get("workspaceType") === "custom"
        ? String(data.get("workspaceTypeCustom") || "custom").trim().slice(0, 40)
        : data.get("workspaceType"),
      currency: data.get("currency"),
      checking: data.get("checking"),
      monthlyIncome: data.get("monthlyIncome"),
      minimumReserve: data.get("minimumReserve"),
      maximumAllocation: data.get("maximumAllocation"),
    });
  });

  document.querySelector("#allocation-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const allocations = state.goals
      .map((goal) => ({
        goalId: goal.id,
        amountMinor: toMinorUnits(data.get(`allocation-${goal.id}`) || 0),
      }))
      .filter((allocation) => allocation.amountMinor > 0);
    stagePlan(allocations);
  });

  document.querySelector("#transaction-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    recordFinancialEvent({
      description: data.get("description"),
      amount: data.get("amount"),
      kind: data.get("kind"),
    });
  });

  document.querySelector("#settings-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutateFinancialState((next) => {
      next.name = String(data.get("workspaceName") || next.name).trim().slice(0, 60);
      next.workspaceType = data.get("workspaceType") === "custom"
        ? String(data.get("workspaceTypeCustom") || "custom").trim().slice(0, 40)
        : String(data.get("workspaceType"));
      next.currency = String(data.get("currency"));
      next.checkingMinor = toMinorUnits(data.get("checking"));
      next.monthlyIncomeMinor = toMinorUnits(data.get("monthlyIncome"));
      next.boundaries.minimumReserveMinor = toMinorUnits(data.get("minimumReserve"));
      next.boundaries.maximumAllocationMinor = toMinorUnits(data.get("maximumAllocation"));
      next.goals = next.goals.map((goal) => ({
        ...goal,
        name: String(data.get(`goalName-${goal.id}`) || goal.name),
        currentMinor: toMinorUnits(data.get(`goalCurrent-${goal.id}`)),
        targetMinor: toMinorUnits(data.get(`goalTarget-${goal.id}`)),
        targetDate: String(data.get(`goalDate-${goal.id}`) || goal.targetDate),
        priority: String(data.get(`goalPriority-${goal.id}`) || goal.priority),
      }));
      next.commitments = next.commitments.map((item) => ({
        ...item,
        name: String(data.get(`commitmentName-${item.id}`) || item.name),
        amountMinor: toMinorUnits(data.get(`commitmentAmount-${item.id}`)),
        dueDay: Math.max(1, Math.min(31, Number(data.get(`commitmentDay-${item.id}`)) || item.dueDay)),
      }));
    }, "Workspace balances, goals, or boundaries updated");
    activeModal = null;
    showToast("Workspace state updated");
  });

  document.querySelector("#csv-file")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const transactions = parseTransactionCsv(await file.text());
      mutateFinancialState((next) => {
        next.transactions = [...transactions, ...next.transactions].slice(0, 100);
      }, `${transactions.length} transactions imported from CSV`);
      activeModal = null;
      showToast(`${transactions.length} transactions imported`);
    } catch (error) {
      showToast(error.message, "danger");
    }
  });
}

render();
bridge.registerStaticTools();

window.addEventListener("storage", (event) => {
  if (![WORKSPACES_KEY, ACTIVE_WORKSPACE_KEY].includes(event.key)) return;
  if (permit) revokePermit("workspace changed in another tab", { renderNow: false });
  workspaces = loadWorkspaces();
  state = loadActiveWorkspace();
  boundaryDraft = null;
  render();
});

window.addEventListener("beforeunload", () => bridge.destroy());
