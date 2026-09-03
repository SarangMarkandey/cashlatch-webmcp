# CashLatch

**Plan your money. Protect what matters.**

CashLatch is a browser-local money manager built for the OpenAI WebMCP Challenge. A person can create separate money workspaces, choose a currency, record balances, income, expenses, monthly bills and savings goals, and then ask ChatGPT to organize the information or compare possible ways to fund those goals.

ChatGPT can prepare changes and goal-funding recommendations through the page tools. CashLatch checks each recommendation against the person's monthly bills and chosen safety limits. The person reviews and approves the exact recommendation on the webpage before it can be recorded in CashLatch.

## Live project

- **Live app:** https://cashlatch-webmcp.vercel.app/
- **Source code:** https://github.com/SarangMarkandey/cashlatch-webmcp

## Start as a real user

CashLatch no longer opens with sample finances. On first visit, choose one of two paths:

1. **Create my money workspace** — enter a name, purpose, currency, current balance, expected income and two safety limits.
2. **Open example finances** — open a clearly labelled fictional money workspace for the challenge walkthrough.

Each workspace keeps separate balances, goals, monthly bills, transactions, recommendations, receipts and activity. Workspaces are organizational boundaries inside one browser profile; they are not separate authenticated users.

With the page open in ChatGPT's browser, a person can also say:

> Create a personal money workspace in INR. My balance is ₹76,000, income is ₹80,000, I want to keep at least ₹25,000, and no recommendation should put more than ₹15,000 toward my goals.

ChatGPT prepares the details on the CashLatch page. The person reviews them and selects **Open money workspace**. Goals and monthly bills can then be added manually or through chat.

## What the dashboard shows

- **Current balance** — the amount currently recorded in the money workspace.
- **Available for goals** — the most CashLatch currently considers safe to put toward goals after monthly bills, the minimum balance to keep, and the maximum allowed for one recommendation.
- **Upcoming monthly bills** — each saved bill, its due day and amount, plus the total included in the next 30 days.
- **Savings goals** — saved progress, target amounts and target dates.
- **How your balance may change** — a 90-day estimate based on the current balance, expected income and monthly bills.
- **Safety limits** — the minimum balance to keep and the maximum allowed in one recommendation.

The graph's green line is the estimated balance. The yellow line is the minimum balance the person wants to keep. Hovering or focusing a graph point explains whether monthly income was added or monthly bills were deducted, the resulting estimated balance, and how far it is above or below the chosen minimum. Expenses that have not been entered are not included.

## Who does what

| Action | ChatGPT | CashLatch webpage | Human |
| --- | --- | --- | --- |
| Read current money workspace | Uses a page tool | Returns the current information | Requests the analysis |
| Create a money workspace | Prepares the details | Shows all entered values | Confirms creation |
| Add goals or bills | Can add or update them | Saves them and refreshes balance estimates | Can inspect/edit them |
| Change safety limits | Can only propose | Shows old and new limits | Accepts or rejects |
| Prepare a recommendation | Compares goal-funding options | Checks the exact amounts | Reviews and approves |
| Apply a recommendation | Can use a temporary one-time action | Checks again and records it once | Must have approved first |

## Why WebMCP?

A normal chat can calculate from text, but it does not own CashLatch's current state or controls. WebMCP lets the same conversation work with the live webpage instead of copying numbers back and forth:

- ChatGPT can read the currently selected money workspace.
- ChatGPT can update visible savings goals, monthly bills, income and expenses.
- CashLatch calculates its own balance estimates and checks goal-funding options.
- The person sees new-workspace and safety-limit proposals on the webpage.
- A recommendation cannot be applied until the person approves it on the webpage.
- Any financial change cancels that approval, so the recommendation must be updated.

ChatGPT compares the options. CashLatch checks the numbers. The person makes the decision.

## WebMCP tools

CashLatch registers eleven permanent site tools:

| Tool | Effect |
| --- | --- |
| `get_money_workspace` | Reads the open money workspace or reports that none exists |
| `get_transactions` | Reads filtered transaction history |
| `prepare_money_workspace` | Shows new money-workspace details for the person to confirm |
| `add_or_update_goal` | Adds or updates a visible savings goal |
| `add_or_update_monthly_bill` | Adds or updates a monthly bill |
| `record_income_or_expense` | Records income or an expense and changes the current balance |
| `propose_safety_limit_change` | Shows proposed safety limits for the person to accept or reject |
| `estimate_balance` | Estimates the balance after 30, 60 or 90 days |
| `calculate_goal_funding_needs` | Calculates how much each goal needs per month |
| `check_goal_funding_option` | Checks one option against monthly bills and safety limits |
| `prepare_goal_recommendation` | Shows an exact recommendation for the person to review |

After the person approves an exact valid recommendation, CashLatch temporarily registers:

```text
apply_approved_recommendation_<approval-id>
```

This temporary tool accepts no replacement amount. It is tied to the exact approved recommendation and the money-workspace version used to prepare it. It expires after five minutes, checks the latest numbers and safety limits again, works once, and disappears after use or any financial change. Internally, a SHA-256 fingerprint detects changed information; it is not a digital signature or a server-side security boundary.

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

The automated tests cover money-workspace creation and currency, safe and blocked goal funding, outdated recommendations, one-time application, goal calculations, balance estimates, CSV parsing, plain-language dashboard requirements, responsive interface requirements, and registration/removal of permanent and temporary tools.

## Judge test

Open the live app in ChatGPT's WebMCP-enabled in-app browser or Chrome 149+ with WebMCP testing enabled. Choose **Open example finances**, then ask:

> Use CashLatch's page tools to read the open money workspace, estimate my balance after 30, 60 and 90 days, calculate what my goals need, compare at least two ways to fund them, and prepare the safest recommendation in CashLatch. Do not approve or apply it.

Review the recommendation on the CashLatch page and select **Approve this recommendation**. Then ask ChatGPT to **Apply my approved recommendation**. To test changed-information protection, record the fictional unexpected expense before applying and verify that CashLatch cancels the old approval.

## Challenge demo path

1. Open CashLatch and choose **Open example finances**.
2. Ask ChatGPT to read the money workspace, estimate 30/60/90-day balances, compare two goal-funding options and prepare the safest recommendation without approving it.
3. Review the recommendation on the webpage and select **Approve this recommendation**.
4. Observe that ChatGPT can now apply that exact recommendation once.
5. Before applying, select the fictional unexpected-expense button.
6. Observe that the recommendation now needs an update and the old approval disappears.
7. Ask ChatGPT to reread the money workspace and prepare another recommendation.
8. Approve it, then ask ChatGPT to apply the approved recommendation.
9. Observe the current balance, savings goal, confirmation and recent activity update; the temporary action disappears after its single use.

## CSV format

Use `samples/cashlatch-demo.csv` or provide:

```csv
date,description,amount
2026-08-01,Salary,100000
2026-08-02,Rent,-12000
```

CSV imports add transaction history to the open money workspace. They do not change the manually entered current balance.

## Privacy model

- Money-workspace information is stored in browser `localStorage`; CashLatch has no financial-data backend.
- Only the open money workspace is available to its page tools.
- Information returned by a WebMCP tool is intentionally shared with ChatGPT when the person asks it to use the page.
- Different devices or browser profiles have separate storage. Multiple workspaces in one profile are organization, not access control.
- Anyone with access to the same browser profile may be able to read its local data.

## Limitations

- CashLatch is a planning prototype, not a bank connection or investment adviser.
- Applying a recommendation records the goal funding inside CashLatch; it does not move bank funds.
- Balance estimates use only entered income and monthly bills. Unknown expenses are not included.
- Changing currency changes display formatting; it does not convert existing amounts.
- One-time approvals are intentionally not restored after refresh or tab close.

## Technology

- Standards-based HTML, CSS and JavaScript modules.
- WebMCP imperative API through `document.modelContext.registerTool`.
- Web Crypto SHA-256 state fingerprints.
- Browser-local, multi-workspace persistence.
- Dependency-free Node static server for local testing.

## License

MIT
