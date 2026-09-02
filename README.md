# CashLatch

**Financial plans that expire when reality changes.**

CashLatch is an AI-assisted cash-planning workspace built for the OpenAI WebMCP Challenge. It helps individuals, households, independent workers, and small operators allocate money across upcoming commitments and multiple goals while enforcing user-defined boundaries.

An agent can inspect current financial state, forecast cash flow, calculate goal contributions, simulate alternatives, and stage a plan. It cannot commit a plan by default. Human approval dynamically creates a one-use, state-bound WebMCP capability. The capability is removed after execution, after two minutes, or whenever relevant financial state changes.

## Why WebMCP?

Uploading a statement to an LLM produces advice from a static snapshot. CashLatch exposes a persistent operational workspace:

- Structured accounts, goals, commitments, transactions, and boundaries.
- Deterministic calculations instead of prompt-only guardrails.
- Visible staged plans that a person can inspect.
- Dynamic execution authority that does not exist before human approval.
- Automatic revocation when approved conditions change.
- One-use commitment, goal-ledger updates, receipts, and an activity trail.

The agent reasons. CashLatch enforces. The human authorizes.

## WebMCP tools

CashLatch registers six permanent tools in the top-level page:

| Tool | Effect |
| --- | --- |
| `get_financial_context` | Reads accounts, goals, commitments, boundaries, staged plan, and state version |
| `get_transactions` | Reads filtered transaction history |
| `forecast_cashflow` | Calculates a deterministic 30/60/90-day outlook |
| `calculate_goal_plan` | Calculates required contributions and monthly feasibility |
| `simulate_allocation` | Tests one exact goal allocation against every boundary |
| `stage_allocation_plan` | Writes a proposal into the shared UI for human review |

After the human approves an exact valid plan, CashLatch dynamically registers one additional tool:

```text
commit_plan_<permit-id>
```

That tool:

- Accepts no plan or amount inputs.
- Is bound to the approved plan and exact financial-state fingerprint.
- Expires after two minutes.
- Revalidates the state version, fingerprint, plan identity, and boundaries.
- Can commit once.
- Is unregistered after use or any relevant state change.

The SHA-256 fingerprint is a deterministic stale-state detector, not a digital signature or server-side security boundary.

## Run locally

No dependency installation or OpenAI API key is required.

```bash
node server.mjs
```

Open `http://localhost:4173`.

For WebMCP tool discovery, use ChatGPT's in-app browser or Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled.

## Test

```bash
node --test tests/*.test.mjs
```

Tests cover:

- Valid multi-goal allocation.
- Maximum-allocation rejection.
- Reserve-floor rejection after a surprise expense.
- One-time plan application to balances and goals.
- Goal-plan calculations and cash forecasting.
- CSV parsing.
- Registration and revocation of permanent and dynamic WebMCP tools.

## Two-minute demo path

1. Open the deployed CashLatch workspace.
2. Ask the agent:

   > Help me fund my goals without putting my next 30 days of commitments or ₹25,000 reserve at risk. Compare the trade-offs, then stage your recommendation.

3. The agent reads context, forecasts, calculates goals, simulates, and stages a ₹15,000 allocation.
4. The human reviews and selects **Authorize exact plan**.
5. Show `commit_plan_<permit-id>` appear in the Agent Access panel and the WebMCP tool list.
6. Before execution, select **Simulate ₹20k surprise expense**.
7. Show the approved plan become stale and the commit capability disappear.
8. Ask the agent to re-plan under the same reserve.
9. Approve the new lower allocation.
10. Ask the agent to commit it.
11. Show checking and goal balances update, the receipt appear, and the tool disappear after one use.

## CSV format

Use `samples/cashlatch-demo.csv` or provide:

```csv
date,description,amount
2026-08-01,Salary,100000
2026-08-02,Rent,-12000
```

CSV imports add context to the transaction history. They do not recalculate the manually supplied current checking balance.

## Privacy model

- Workspace state is stored in browser `localStorage`.
- CashLatch does not upload or store the workspace on its own server.
- Information returned by a WebMCP tool is shared with the browser agent asked to use the page.
- The demo uses fictional data. Users should understand their agent provider's data controls before supplying real financial information.

## Limitations

- CashLatch is a financial-planning prototype, not a bank connection or investment adviser.
- “Within configured boundaries” means only that the entered data passes the deterministic rules. Unentered expenses are not included.
- Committing updates the CashLatch allocation ledger; it does not move real bank funds.
- Permits are intentionally not restored after refresh or tab close.

## Technology

- Standards-based HTML, CSS, and JavaScript modules.
- WebMCP imperative API through `document.modelContext.registerTool`.
- Web Crypto SHA-256 state fingerprints.
- Browser-local persistence.
- Dependency-free Node static server for local testing.

## License

MIT
