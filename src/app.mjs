import { freshDemoState } from "./demo.mjs";
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

const STORAGE_KEY = "cashlatch-workspace-v1";
const PERMIT_TTL_MS = 120_000;
const app = document.querySelector("#app");

let state = loadState();
let permit = null;
let permitTimer = null;
let activeModal = null;
let toast = null;
let webmcpStatus = {
  connected: false,
  message: "Checking site tools…",
  toolCount: 0,
};

function loadState() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return freshDemoState();
    const parsed = JSON.parse(stored);
    return {
      ...freshDemoState(),
      ...parsed,
      receipts: parsed.receipts || [],
      stagedPlan: parsed.stagedPlan?.status === "authorized"
        ? { ...parsed.stagedPlan, status: "stale" }
        : parsed.stagedPlan,
    };
  } catch {
    return freshDemoState();
  }
}

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
    revokePermit("permit expired after two minutes");
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

const bridge = createWebMCPBridge({
  getState: () => state,
  stagePlan,
  commitPermit,
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
  const height = 220;
  const padX = 36;
  const padY = 28;
  const allValues = [
    ...forecast.points.map((point) => point.balanceMinor),
    forecast.reserveMinor,
  ];
  const max = Math.max(...allValues, 1);
  const min = Math.min(...allValues, 0);
  const range = Math.max(1, max - min);
  const x = (day) => padX + (day / forecast.horizonDays) * (width - padX * 2);
  const y = (balance) => padY + ((max - balance) / range) * (height - padY * 2);
  const points = forecast.points.map((point) => `${x(point.day)},${y(point.balanceMinor)}`).join(" ");
  const reserveY = y(forecast.reserveMinor);

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
      <polygon points="${points} ${x(forecast.horizonDays)},${height - padY} ${padX},${height - padY}" fill="url(#cashArea)" />
      <polyline points="${points}" class="cash-line" />
      ${forecast.points.map((point) => `
        <circle cx="${x(point.day)}" cy="${y(point.balanceMinor)}" r="5" class="cash-point" />
        <text x="${x(point.day)}" y="${height - 8}" text-anchor="middle" class="chart-label">${point.day}d</text>
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
        <div class="section-kicker">Staged plan</div>
        <h2>No plan is waiting</h2>
        <p>Enter allocations above or ask your agent to calculate and stage a plan through site tools.</p>
      </section>
    `;
  }

  const statusLabels = {
    staged: "Ready for human review",
    blocked: "Blocked by boundaries",
    authorized: "Exact plan authorized",
    stale: "Approval required again",
    committed: "Committed once",
  };

  return `
    <section class="panel plan-panel ${plan.status}">
      <div class="plan-title-row">
        <div>
          <div class="section-kicker">Staged plan · ${escapeHtml(plan.id)}</div>
          <h2>${statusLabels[plan.status] || escapeHtml(plan.status)}</h2>
        </div>
        <span class="status-pill ${plan.status}">${escapeHtml(plan.status)}</span>
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
      ` : `<p class="pass-note">✓ Within every configured boundary. This is not financial advice.</p>`}
      <div class="plan-actions">
        ${plan.status === "staged" ? `<button class="primary-button" data-action="authorize">Authorize exact plan</button>` : ""}
        ${plan.status === "authorized" ? `<div class="authorized-note"><span>Permit ${permit?.shortId || "—"}</span><b>Waiting for agent commit</b></div>` : ""}
        ${plan.status === "stale" ? `<button class="primary-button" data-action="restage-safe">Recalculate from current state</button>` : ""}
        ${plan.status === "committed" ? `<div class="authorized-note"><span>Receipt created</span><b>${escapeHtml(state.receipts?.[0]?.id || "Committed")}</b></div>` : ""}
      </div>
    </section>
  `;
}

function renderAccessPanel() {
  const baseTools = [
    "Read financial context",
    "Read transactions",
    "Forecast cash flow",
    "Calculate goal plan",
    "Simulate allocation",
    "Stage allocation",
  ];
  return `
    <section class="panel access-panel">
      <div class="access-header">
        <div>
          <div class="section-kicker">Agent access</div>
          <h2>Capability surface</h2>
        </div>
        <span class="connection-badge ${webmcpStatus.connected ? "online" : "offline"}"><i></i>${webmcpStatus.connected ? "Connected" : "Preview"}</span>
      </div>
      <p class="access-message">${escapeHtml(webmcpStatus.message)}</p>
      <div class="tool-list">
        ${baseTools.map((tool) => `<div><span class="tool-dot read"></span><span>${tool}</span><b>Available</b></div>`).join("")}
        <div class="execute-tool ${permit ? "active" : "locked"}">
          <span class="tool-dot execute"></span>
          <span>${permit ? escapeHtml(permit.toolName) : "Commit approved plan"}</span>
          <b>${permit ? "One use" : "Human approval required"}</b>
        </div>
      </div>
      <div class="permit-card ${permit ? "visible" : ""}">
        ${permit ? `
          <div><span>Permit</span><strong>${permit.shortId}</strong></div>
          <div><span>Bound state</span><strong>v${permit.stateVersion}</strong></div>
          <div><span>Fingerprint</span><code>${permit.fingerprint.slice(0, 12)}…</code></div>
          <p>Expires ${new Date(permit.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</p>
        ` : `<p>Execution does not exist until a person authorizes one exact staged plan.</p>`}
      </div>
    </section>
  `;
}

function renderSettingsModal() {
  if (activeModal !== "settings") return "";
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="modal-header">
          <div><div class="section-kicker">Workspace</div><h2 id="settings-title">Edit financial state</h2></div>
          <button class="icon-button" data-action="close-modal" aria-label="Close">×</button>
        </div>
        <form id="settings-form">
          <div class="form-grid">
            <label>Workspace type<select name="workspaceType">
              ${["personal", "household", "independent", "business"].map((type) => `<option value="${type}" ${state.workspaceType === type ? "selected" : ""}>${type}</option>`).join("")}
            </select></label>
            <label>Workspace currency<select name="currency">
              ${["INR", "USD", "EUR", "GBP"].map((currency) => `<option value="${currency}" ${state.currency === currency ? "selected" : ""}>${currency}</option>`).join("")}
            </select></label>
            <label>Checking balance<input name="checking" type="number" step="0.01" value="${fromMinorUnits(state.checkingMinor)}" required /></label>
            <label>Monthly income<input name="monthlyIncome" type="number" step="0.01" value="${fromMinorUnits(state.monthlyIncomeMinor)}" required /></label>
            <label>Minimum reserve<input name="minimumReserve" type="number" step="0.01" value="${fromMinorUnits(state.boundaries.minimumReserveMinor)}" required /></label>
            <label>Maximum allocation<input name="maximumAllocation" type="number" step="0.01" value="${fromMinorUnits(state.boundaries.maximumAllocationMinor)}" required /></label>
          </div>
          <h3 class="form-section-title">Goals</h3>
          <div class="editable-list">
            ${state.goals.map((goal) => `
              <div class="editable-row">
                <input name="goalName-${goal.id}" value="${escapeHtml(goal.name)}" aria-label="Goal name" />
                <input name="goalCurrent-${goal.id}" type="number" value="${fromMinorUnits(goal.currentMinor)}" aria-label="Current amount" />
                <input name="goalTarget-${goal.id}" type="number" value="${fromMinorUnits(goal.targetMinor)}" aria-label="Target amount" />
                <input name="goalDate-${goal.id}" type="date" value="${goal.targetDate}" aria-label="Target date" />
              </div>
            `).join("")}
          </div>
          <h3 class="form-section-title">Monthly commitments</h3>
          <div class="editable-list">
            ${state.commitments.map((item) => `
              <div class="editable-row commitment-row">
                <input name="commitmentName-${item.id}" value="${escapeHtml(item.name)}" aria-label="Commitment name" />
                <input name="commitmentAmount-${item.id}" type="number" value="${fromMinorUnits(item.amountMinor)}" aria-label="Amount" />
                <input name="commitmentDay-${item.id}" type="number" min="1" max="31" value="${item.dueDay}" aria-label="Due day" />
              </div>
            `).join("")}
          </div>
          <div class="modal-actions"><button type="button" class="ghost-button" data-action="close-modal">Cancel</button><button class="primary-button" type="submit">Save state</button></div>
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
  const forecast = forecastCashflow(state, 90);
  const goalPlan = calculateGoalPlan(state);
  const plan = state.stagedPlan;
  const availableNow = Math.min(forecast.availableNowMinor, state.boundaries.maximumAllocationMinor);
  const recentActivity = state.activity.slice(0, 8);
  const recentTransactions = state.transactions.slice(0, 5);

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="/" aria-label="CashLatch home"><span class="brand-mark">C</span><span>CashLatch<small>State-bound financial planning</small></span></a>
        <div class="topbar-actions">
          <button class="ghost-button" data-action="import-csv">Import CSV</button>
          <button class="ghost-button" data-action="settings">Edit workspace</button>
          <button class="secondary-button" data-action="load-demo">Reload demo</button>
        </div>
      </header>

      <main>
        <section class="hero-panel">
          <div class="hero-copy">
            <div class="eyebrow"><span></span>Human-approved agent delegation</div>
            <h1>Plans that expire when<br /><em>reality changes.</em></h1>
            <p>Let your agent inspect current state, forecast cash flow and stage allocations. CashLatch enforces your boundaries. You authorize the exact plan.</p>
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

        <section class="metrics-row">
          <article><span>Monthly income</span><strong>${money(state.monthlyIncomeMinor)}</strong><small>Workspace estimate</small></article>
          <article><span>Goal funding needed</span><strong>${money(goalPlan.totalRequiredMonthlyMinor)}</strong><small>${goalPlan.feasible ? "Within monthly capacity" : "Needs prioritization"}</small></article>
          <article><span>State version</span><strong>v${state.stateVersion}</strong><small>Every relevant change revokes approval</small></article>
          <article><span>Agent execution</span><strong class="${permit ? "permit-on" : "permit-off"}">${permit ? "Authorized" : "Locked"}</strong><small>${permit ? `Permit ${permit.shortId}` : "No capability exists"}</small></article>
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
                <div class="goals-grid">${state.goals.map((goal) => renderGoal(goal, plan?.status === "staged" ? plan : null)).join("")}</div>
                <div class="allocation-submit"><span>Enter any split. CashLatch will test the exact plan against your current state.</span><button class="secondary-button" type="submit">Simulate & stage</button></div>
              </form>
            </section>

            ${renderPlan(plan)}

            <section class="panel transaction-panel">
              <div class="panel-heading"><div><div class="section-kicker">Live state</div><h2>Transactions</h2></div><button class="danger-quiet-button" data-action="surprise-expense">Simulate ₹20k surprise expense</button></div>
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
      if (action === "settings") activeModal = "settings";
      if (action === "import-csv") activeModal = "csv";
      if (action === "close-modal") activeModal = null;
      if (action === "authorize") await authorizeCurrentPlan();
      if (action === "copy-prompt") {
        const text = document.querySelector(".prompt-box p")?.textContent || "";
        await navigator.clipboard.writeText(text);
        showToast("Prompt copied");
        return;
      }
      if (action === "load-demo") {
        if (window.confirm("Reload the demo workspace and replace current local data?")) {
          if (permit) revokePermit("workspace reset", { renderNow: false });
          state = freshDemoState();
          state.receipts = [];
          persist();
          showToast("Demo workspace reloaded");
          return;
        }
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
        const maxSafe = Math.min(
          state.boundaries.maximumAllocationMinor,
          forecastCashflow(state, 30).availableNowMinor,
        );
        const emergency = Math.round(maxSafe * 0.7);
        const laptop = maxSafe - emergency;
        stagePlan([
          { goalId: "emergency", amountMinor: emergency },
          { goalId: "laptop", amountMinor: laptop },
        ]);
        showToast("Plan recalculated from the new state");
        return;
      }
      render();
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
    const amountMinor = toMinorUnits(data.get("amount"));
    const kind = data.get("kind");
    const signedAmount = kind === "expense" ? -amountMinor : amountMinor;
    mutateFinancialState((next) => {
      next.checkingMinor += signedAmount;
      next.transactions.unshift({
        id: crypto.randomUUID(),
        date: new Date().toISOString().slice(0, 10),
        description: String(data.get("description") || "Transaction"),
        amountMinor: signedAmount,
        kind,
      });
    }, `${kind === "expense" ? "Expense" : "Income"} added · ${String(data.get("description"))}`);
  });

  document.querySelector("#settings-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutateFinancialState((next) => {
      next.workspaceType = String(data.get("workspaceType"));
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

window.addEventListener("beforeunload", () => bridge.destroy());
