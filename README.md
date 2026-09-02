# CashLatch

**Financial plans that expire when reality changes.**

CashLatch is a browser-local financial planning workspace built for the OpenAI WebMCP Challenge. A person can create separate workspaces, choose a currency, record balances, bills and goals, and then ask ChatGPT to organize the information or compare possible allocations.

ChatGPT can prepare changes and plans through the site's tools. CashLatch remains the system of record: it performs deterministic checks, shows consequential proposals on the webpage, and requires the person to approve an exact plan before it can be applied to the CashLatch ledger.

## Start as a real user

CashLatch no longer opens with sample finances. On first visit, choose one of two paths:

1. **Create my workspace** — enter a name, type, currency, available balance, estimated income and two safety limits.
2. **Try fictional demo** — open a clearly labelled sample workspace for the challenge walkthrough.

Each workspace keeps separate balances, goals, monthly commitments, transactions, plans, receipts and activity. Workspaces are organizational boundaries inside one browser profile; they are not separate authenticated users.

With the page open in ChatGPT's browser, a person can also say:

> Create a Personal workspace in INR. My balance is ₹76,000, income is ₹80,000, I want to protect ₹25,000, and no plan should allocate more than ₹15,000.

ChatGPT prepares a draft on the CashLatch page. The person reviews it and selects **Create workspace**. Goals and commitments can then be added manually or through chat.

## Human and agent responsibilities

| Action | ChatGPT | CashLatch webpage | Human |
| --- | --- | --- | --- |
| Read current workspace | Uses a site tool | Returns structured current state | Requests the analysis |
| Create a workspace | Prepares a draft | Shows all entered values | Confirms creation |
| Add goals or bills | Can add or update them | Saves them and refreshes forecasts | Can inspect/edit them |
| Change safety limits | Can only propose | Shows old and new limits | Accepts or rejects |
| Prepare an allocation | Compares and stages | Checks the exact amounts | Reviews and approves |
| Apply an allocation | Can call a temporary tool | Revalidates and updates the local ledger once | Must have approved first |

## Why WebMCP?

A normal chat can calculate from text, but it does not own CashLatch's current state or controls. WebMCP lets the same conversation work with the live webpage instead of copying numbers back and forth:

- ChatGPT can read the currently selected workspace.
- ChatGPT can update visible goals, commitments and financial events.
- CashLatch performs its own forecast and allocation checks.
- The human sees workspace and boundary proposals on the webpage.
- Applying a plan is impossible until webpage approval creates a temporary capability.
- Any financial change cancels that capability, forcing a fresh plan.

The agent reasons. CashLatch enforces. The human controls consequential action.

## WebMCP tools

CashLatch registers eleven permanent site tools:

| Tool | Effect |
| --- | --- |
| `get_financial_context` | Reads the active workspace or reports that none exists |
| `get_transactions` | Reads filtered transaction history |
| `create_workspace_draft` | Prepares a workspace for human confirmation on the page |
| `add_or_update_goal` | Adds or updates a visible financial goal |
| `add_or_update_commitment` | Adds or updates a recurring monthly commitment |
| `record_financial_event` | Records income or an expense and changes the current balance |
| `propose_boundary_change` | Shows proposed safety limits for human acceptance or rejection |
| `forecast_cashflow` | Calculates a deterministic 30/60/90-day outlook |
| `calculate_goal_plan` | Calculates required contributions and monthly feasibility |
| `simulate_allocation` | Tests an exact allocation against saved boundaries |
| `stage_allocation_plan` | Places an exact proposal in the page for human review |

After the human approves an exact valid plan, CashLatch dynamically registers:

```text
commit_plan_<permit-id>
```

This temporary tool accepts no replacement amount or plan. It is tied to the exact plan, workspace state version and SHA-256 state fingerprint; expires after two minutes; rechecks all boundaries; works once; and disappears after use or any financial-state change. The fingerprint is a stale-state detector, not a digital signature or server-side security boundary.

## Run locally

No dependency installation or OpenAI API key is required.

```bash
npm run dev
```

Open `http://localhost:4173`. For WebMCP discovery, use ChatGPT's compatible browser flow or a supported Chrome build with WebMCP testing enabled.

## Test

```bash
npm test
```

The tests cover workspace creation and currency, safe and blocked allocations, stale financial state, ledger application, goal planning, forecasting, CSV parsing, and registration/revocation of permanent and dynamic tools.

## Challenge demo path

1. Open CashLatch and choose **Try fictional demo**.
2. Ask ChatGPT to inspect the workspace, forecast 30/60/90 days, compare allocations and stage the safest plan without authorizing it.
3. Review the plan on the webpage and select **Approve this exact plan**.
4. Observe the one-use apply capability become available.
5. Before applying, select the fictional unexpected-expense button.
6. Observe the plan become stale and the capability disappear.
7. Ask ChatGPT to reread the workspace and prepare another plan.
8. Approve it, then ask ChatGPT to apply the approved plan.
9. Observe the local checking balance, goal ledger, receipt and activity trail update; the temporary tool disappears after its single use.

## CSV format

Use `samples/cashlatch-demo.csv` or provide:

```csv
date,description,amount
2026-08-01,Salary,100000
2026-08-02,Rent,-12000
```

CSV imports add transaction history to the active workspace. They do not change the manually entered current checking balance.

## Privacy model

- Workspace state is stored in browser `localStorage`; CashLatch has no financial-data backend.
- The active workspace alone is available to its page tools.
- Information returned by a WebMCP tool is intentionally shared with the browser agent the person asks to use the page.
- Different devices or browser profiles have separate storage. Multiple workspaces in one profile are organization, not access control.
- Anyone with access to the same browser profile may be able to read its local data.

## Limitations

- CashLatch is a planning prototype, not a bank connection or investment adviser.
- Applying a plan updates CashLatch's local allocation ledger; it does not move bank funds.
- Forecasts use only entered income and commitments. Unknown expenses are not included.
- Changing currency changes display formatting; it does not convert existing amounts.
- Permits are intentionally not restored after refresh or tab close.

## Technology

- Standards-based HTML, CSS and JavaScript modules.
- WebMCP imperative API through `document.modelContext.registerTool`.
- Web Crypto SHA-256 state fingerprints.
- Browser-local, multi-workspace persistence.
- Dependency-free Node static server for local testing.

## License

MIT
