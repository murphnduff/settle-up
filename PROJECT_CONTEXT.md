# Settle Up - Master Architecture, Requirements & Test Spec (v1.0 Production)

## 1. Tech Stack & Infrastructure
- **Frontend / Fullstack:** Next.js 16 (App Router, React 19, TypeScript, Tailwind CSS, Lucide Icons) — fully responsive across Desktop, Tablet, and Mobile.
- **Backend / Database:** Supabase (PostgreSQL 15+, Google OAuth for Super-Admin only, Row-Level Security).
- **Keep-Alive Heartbeat:** Next.js API route (`/api/heartbeat`) + `vercel.json` cron job executing a lightweight query (`SELECT id FROM groups LIMIT 1`) every 5 days to prevent Supabase Free Tier 7-day inactivity pausing.
- **Testing & Tooling:** Node 24 built-in test runner (`node --experimental-strip-types --test`), ESLint 9.
- **Hosting & Production:** Vercel (`https://split.murphnduff.org`).
- **Deployment Workflow:** Local commits pushed via PowerShell `sync "commit message"` macro.

---

## 2. Security, Privacy & High-Trust Data Model

### 2.1 Philosophy: Clean Root Slugs + Single Global Super-Admin
- **Single Global Super-Admin (`murph@murphnduff.org`):**
  - Admin rights are verified strictly by `user?.email?.toLowerCase() === 'murph@murphnduff.org'` (client) and `lower(auth.jwt() ->> 'email') = 'murph@murphnduff.org'` via the `public.is_super_admin()` database helper.
  - Only `murph@murphnduff.org` can see the master group list, create groups, delete groups, manage members, or import CSV data.
  - Admin is not required to be a participant in created groups (e.g. creating a group for others; "Add me as a member" checkbox defaults to `true`).
- **Regular Users (Zero Sign-In & Root-Level Friendly URLs):**
  - Access any group directly via root slug: `https://split.murphnduff.org/[slug]` (or `?m=<display_name>`).
  - No OAuth login required for visitors.
  - "Who Are You?" pill selection saves `active_member_id` and adds the group to `localStorage` (`recent_groups`), updating the URL to `?m=<name>` via `window.history.replaceState` for cross-device recognition.
- **Stealth Root & Anti-Indexing Shield:**
  - Visiting root `/` unauthenticated with no local groups renders a minimal "Private Portal" sign-in card with zero descriptive copy.
  - `src/app/robots.ts` blocks all user agents and AI crawlers (`Googlebot`, `Google-Extended`, `GPTBot`, `CCBot`, etc.).
  - Global `noindex, nofollow, noarchive, nosnippet` metadata in `src/app/layout.tsx` and `X-Robots-Tag` HTTP headers in `next.config.ts`.

### 2.2 Database Tables & Schema
- **`groups`**: `id` (UUID PK), `name` (TEXT), `slug` (TEXT UNIQUE), `created_by` (UUID FK Nullable), `is_archived` (BOOLEAN DEFAULT false), `created_at` (TIMESTAMPTZ).
- **`group_members`**: `id` (UUID PK), `group_id` (UUID FK CASCADE), `display_name` (TEXT NOT NULL), `created_at` (TIMESTAMPTZ). Unique constraint on `(group_id, lower(display_name))`.
- **`expenses`**: `id` (UUID PK), `group_id` (UUID FK CASCADE), `type` (`'expense'` | `'payment'`), `description` (TEXT), `amount_cents` (INTEGER > 0), `currency` (`'USD'` | `'EUR'`), `date` (DATE NOT NULL), `paid_by_member_id` (UUID FK), `created_at` (TIMESTAMPTZ).
- **`expense_splits`**: `id` (UUID PK), `expense_id` (UUID FK CASCADE), `member_id` (UUID FK), `split_amount_cents` (INTEGER >= 0), `created_at` (TIMESTAMPTZ).

---

## 3. Core Math Engine & Reconciliation Rules (`src/lib/reconciliation.ts`)

### 3.1 Strict Integer-Cent Arithmetic
- All financial math is computed in integer cents to prevent floating-point drift.
- Isolated ledgers: `USD` and `EUR` calculate and settle independently.

### 3.2 Net Balance Calculation
For each user $u$ and currency $c$:
$$\text{Net Balance}(u) = \sum \text{Paid Expenses}(u) - \sum \text{Split Shares}(u) + \sum \text{Direct Payments Made}(u) - \sum \text{Direct Payments Received}(u)$$

### 3.3 Overpayment & Balance Inversion Handling (Critical)
- Direct settlement transfers (`type === 'payment'`) must **never clamp or cap at $0.00**.
- If Kevin owes Murph $20.00 ($\text{Kevin} = -2000\text{c}, \text{Murph} = +2000\text{c}$) and Kevin sends a payment of $22.00 ($2200\text{c}$) to Murph:
  - Kevin's balance becomes: $-2000 + 2200 = +200\text{c}$ ($+\$2.00$, now a Creditor).
  - Murph's balance becomes: $+2000 - 2200 = -200\text{c}$ ($-\$2.00$, now a Debtor).
  - The Greedy Cash-Flow Settlement Plan must evaluate Murph as the debtor and Kevin as the creditor, generating: **"Murph pays Kevin : $2.00"**.
- This scenario is codified as an explicit unit test in `src/lib/reconciliation.test.ts`.

### 3.4 Metric Aggregation: "Spent" Running Total
- The running `USD Spent` and `EUR Spent` totals on the group dashboard strictly sum entries where `type === 'expense'`.
- Direct settlement payments (`type === 'payment'`) are balance-clearing transfers, not consumption, and are strictly excluded from the "Spent" metric.

### 3.5 Cash-Flow Minimization (Greedy Algorithm)
1. Filter out all zero-balance members ($|\text{balance}| = 0$).
2. Split remaining members into **Debtors** ($\text{balance} < 0$) and **Creditors** ($\text{balance} > 0$).
3. Sort both lists descending by absolute amount.
4. Greedily match largest debtor to largest creditor for $\min(|\text{Debtor}|, \text{Creditor})$, decrementing balances until all debts clear.

---

## 4. Features & UX Specifications

### 4.1 Split Modes (Group Expenses)
- **`Equal`**: Evenly divides total among selected participants with remainder cents distributed deterministically.
- **`% Percentage`**: Numeric inputs per member validating to $100\%$ with integer-cent rounding.
- **`$ Exact`**: Inline dollar/euro input per member. The top-level `Amount` field automatically updates in real time to match the exact sum of member inputs, preventing double-entry.

### 4.2 Unified CSV Import & Export (Splitwise-Compatible)
- **Format:** `Date,Description,Category,Cost,Currency,<Member 1>,<Member 2>,...`
- **Payer identification:** Member column with positive value (`val > 0`).
- **Split allocations:** Member columns with negative values (`val < 0`) indicate owed split amounts. Payer's own share $= \text{Cost} - \text{val}$.
- **Summary footer:** Ignores and generates trailing blank line + `<Date>,Total balance, , ,<Currency>,<Net 1>,...`.
- **High-Speed Bulk Insert:** Import pre-generates client UUIDs and commits all members, expenses, and splits in three batched Supabase calls (< 0.5s).

---

## 5. Active Backlog & Future Development Roadmap

### Phase 1.1: Core Polish & Settlement Integrity (Next Up)
1. **Fix Direct Payment Overpayment Inversion:**
   - Ensure direct payments allow net balances to invert past zero without clamping.
   - Add automated test in `src/lib/reconciliation.test.ts`: Kevin owes $20, pays $22 $\rightarrow$ Murph owes Kevin $2.
2. **Exclude Payments from Running Spent Metric:**
   - Filter `type === 'expense'` on `USD Spent` and `EUR Spent` calculations.
3. **Cumulative Member Breakdown:**
   - Display a card/table showing each member's **Out-of-Pocket Fronted** vs. **Accrued Cost Consumed** vs. **Net Balance**.
4. **Group Archiving ("Retire Group"):**
   - Add `is_archived` column to `groups`. Archived groups move to a collapsed sidebar folder and lock to read-only.

### Phase 1.2: Expense Categorization
5. **Categories & Category Breakdown:**
   - Add `category` column to `expenses` (Dining, Groceries, Lodging, Transport, General) with UI pill selectors, category spend totals, and direct CSV column mapping.

### Phase 1.3: Disaster Recovery & Snapshots
6. **Automated Daily Snapshots:**
   - Scheduled GitHub Action or cron task pulling daily table dumps into timestamped private archives.

### Phase 1.4: Receipts & AI Vision
7. **Receipt Attachments & Extraction:**
   - Supabase Storage upload for receipts + Gemini Multimodal API route to auto-extract merchant, date, amount, currency, and category.
   