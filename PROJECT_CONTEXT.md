# Settle Up (v1.0) — Production Architecture & Maintenance Reference

## 1. Tech Stack & Deployment
- **Framework:** Next.js 16 (App Router, Turbopack, React 19, TypeScript)
- **Styling & UI:** Tailwind CSS + Lucide Icons (responsive across Desktop, Tablet, and Mobile)
- **Database & Auth:** Supabase (PostgreSQL 15+, Row-Level Security, Google OAuth strictly for Super-Admin)
- **Testing & Linting:** Node 24 built-in test runner (`node --experimental-strip-types --test src/lib/reconciliation.test.ts`), ESLint 9
- **Production Hosting:** Vercel (`https://split.murphnduff.org`)
- **Deployment Workflow:** Local commits deployed via PowerShell `sync "commit message"` macro (`git add . && git commit -m ... && git push`)

---

## 2. Security, Privacy & Anti-Indexing

### 2.1 Single Global Super-Admin (`murph@murphnduff.org`)
- **Database Enforcement (`public.is_super_admin()`):**
  - PostgreSQL RLS helper verifies `lower(coalesce(auth.jwt() ->> 'email', '')) = 'murph@murphnduff.org'`.
  - Only `public.is_super_admin()` is permitted to `INSERT`, `UPDATE`, or `DELETE` rows in `public.groups` or `INSERT` / `DELETE` rows in `public.group_members`.
- **Client Enforcement (`src/app/page.tsx`):**
  - Checks `user?.email?.toLowerCase() === 'murph@murphnduff.org'`.
  - Super-Admin sees **all** groups in the left sidebar and has exclusive access to **Create Group** (`"Add me as a member"` checked by default, uncheckable for non-participant group creation), **Delete Group**, **Import CSV**, and **Manage Members** (Add/Delete members).

### 2.2 Zero-Login Regular Users & Cross-Device Identity Recognition
- **Root-Level Friendly Group URLs (`https://split.murphnduff.org/[slug]`):**
  - Groups have a `slug` column in `public.groups` derived from `name` (`name.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')`, e.g., `SoCal 2026` $\rightarrow$ `/SoCal_2026`).
  - Dynamic route `src/app/[slug]/page.tsx` resolves groups by `slug` (case-insensitive), `id`, or space-normalized `name`. Legacy `/g/[group_id]` URLs automatically redirect to `/[slug]`.
- **Instant Access & `?m=<Name>` Recognition:**
  - Anyone opening `/<slug>` or `/<slug>?m=<Name>` immediately views the group without signing in.
  - Selecting a member pill (`"Who are you in this group?"`) stores `settleup_member_<groupId>` and `recent_groups` in `localStorage`, sets that member as the default payer, and updates the browser URL to `/<slug>?m=<Name>` via `window.history.replaceState` for bookmarking and cross-device recognition.

### 2.3 Stealth Root Homepage (`/`)
- Unauthenticated visitors hitting `/` with no saved `recent_groups` in `localStorage` never query or enumerate `public.groups`.
- Instead, `/` renders only a minimal **"Private Portal"** card with an **Admin Sign In** button and instructions to open a shared group link directly.

### 2.4 Full Crawler & AI-Scraper Shield
1. **`src/app/robots.ts`:** Serves `/robots.txt` with `User-agent: *` and `Disallow: /`.
2. **`src/app/layout.tsx`:** Global `metadata.robots` configured with `index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noimageindex: true, 'max-snippet': -1 }`.
3. **`next.config.ts`:** Global `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex` HTTP response header applied to `/:path*`.

---

## 3. Keep-Alive Architecture
- **Heartbeat Endpoint (`src/app/api/heartbeat/route.ts`):** Executes `SELECT id FROM groups LIMIT 1` against Supabase and returns `{"status":"ok","timestamp":"..."}`.
- **Vercel Cron (`vercel.json`):** Scheduled cron job invokes `/api/heartbeat` (`0 12 * * *`) to prevent Supabase Free Tier 7-day inactivity pausing.

---

## 4. Core Features & Math Engine (`src/lib/reconciliation.ts`)

### 4.1 Isolated Multi-Currency Ledgers & Integer-Cent Math
- All monetary values are stored and calculated in integer cents (`amount_cents`, `split_amount_cents`) to eliminate floating-point drift.
- **Currency Isolation:** `USD ($)` and `EUR (€)` ledgers are calculated and settled independently (`calculateBalancesByCurrency`, `calculateSettlements`) using a greedy largest-debtor to largest-creditor cash-flow minimization algorithm.

### 4.2 Three Split Modes (`Equal | % Percentage | $ Exact`)
Available in both the main **Add Transaction** form (`src/app/page.tsx`) and **Edit Transaction** modal (`src/components/EditExpenseModal.tsx`):
1. **Equal (`splitAmountEqually`):** Divides `totalAmountCents` evenly across selected members and distributes remainder pennies (`total % N`) deterministically.
2. **% Percentage (`splitAmountByPercentage`):** Validates that member percentages sum to `100%` (within `0.01%` tolerance) and distributes integer cents via the Largest Fractional Remainder method so `SUM(splitAmountCents) === totalAmountCents`.
3. **$ Exact (`validateExactSplits` + Live Auto-Sum):** Users type exact dollar/euro amounts per member; the top **Amount** field becomes `readOnly` (`Auto-Summed`) and automatically updates on every keystroke to equal the live sum of entered member amounts. Opening `EditExpenseModal` on an existing unequal split automatically pre-selects `$ Exact` mode.

### 4.3 Transaction Date Picker & Chronological Sorting
- Both **Add Transaction** and **Edit Transaction** include an `<input type="date" />` field defaulting to today's local date (`YYYY-MM-DD`).
- Transactions are stored in `public.expenses.date`, rendered with human-friendly formatting (e.g., `Oct 18, 2026`), and sorted chronologically by `date` descending with `created_at` descending as tie-breaker.

### 4.4 High-Speed Bulk CSV Import & Export
- **Standard Multi-Column Net-Delta Format (`<slug>_<YYYY-MM-DD>_export.csv`):**
  - **Header Row:** `Date,Description,Category,Cost,Currency,<Member 1>,<Member 2>,...`
  - **Transaction Rows:** Each member column records their net delta (`+paid - share_owed`): `(amount_cents - payer_split_amount_cents) / 100` (positive) for the payer, `-split_amount_cents / 100` (negative) for other participants, and `0.00` for non-participants. `Category` is `'Payment'` for direct payments and `'General'` for expenses.
  - **Footer Row:** `<YYYY-MM-DD>,Total balance, , ,<Currency>,<Net Member 1>,<Net Member 2>,...`
- **Export CSV (`generateGroupCsv`):** Available to all users in the group header toolbar.
- **Bulk Import CSV (`parseGroupCsv` + Batch Inserts):** Available to Super-Admin in the left sidebar. Reconstructs exact payers and odd-penny splits (`7857 x 6 + 7858`), batch-inserts missing `group_members` in 1 query, generates client-side UUIDs (`crypto.randomUUID()`), and executes 1 bulk `expenses` insert followed by 1 bulk `expense_splits` insert.

### 4.5 Unit Test Suite (`src/lib/reconciliation.test.ts`)
9 automated test suites verify all math and CSV edge cases via `npm test`:
1. Indivisible Penny (`$100.00 / 3` $\rightarrow$ `3334, 3333, 3333` cents)
2. Transitive Debt Simplification (`Murph -> Kev -> Fitz` $\rightarrow$ 1 transfer)
3. 1-to-1 Direct Payment Offset
4. Partial & Subset Splits
5. Multi-Currency Isolation (`USD` vs `EUR`)
6. Member Deletion Guard (`canDeleteMember`)
7. Transaction Mutation Recalculation
8. Custom Unequal Splits (`splitAmountByPercentage` `70/30` & `33.33/33.33/33.34` + `validateExactSplits`)
9. Odd-Penny CSV Reconstruction (`parseGroupCsv` & `generateGroupCsv` round-trip verification)