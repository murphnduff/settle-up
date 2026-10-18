# Settle Up - Master Architecture, Requirements & Test Spec

## 1. Tech Stack & Workflow
- **Frontend / Fullstack:** Next.js 16 (App Router, Turbopack, React 19, TypeScript, Tailwind CSS, Lucide Icons) — responsive across Desktop, Tablet, and Mobile.
- **Backend / Database:** Supabase (PostgreSQL 15+, Google OAuth for Super-Admin only, Row-Level Security).
- **Testing & Tooling:** Node 24 built-in test runner (`node --experimental-strip-types --test`), ESLint 9.
- **Hosting & Production:** Vercel (`https://split.murphnduff.org`).
- **Deployment Workflow:** Local edits pushed via PowerShell `sync "commit message"` macro.

---

## 2. Core Data Model & High-Trust Security Architecture

### 2.1 Philosophy: Root-Level Friendly Group URLs + Single Super-Admin
- **Single Global Super-Admin (`murph@murphnduff.org`):**
  - The **ONLY** user who signs in via Google OAuth (`user?.email?.toLowerCase() === 'murph@murphnduff.org'` on the client, and `lower(coalesce(auth.jwt() ->> 'email', '')) = 'murph@murphnduff.org'` in Supabase RLS).
  - Sees **ALL** groups in the database in the left sidebar.
  - Is the **ONLY** user who can Create Groups, Delete Groups, Import CSV files, or Manage Members (Add/Delete members).
  - **Super-Admin Group Creation (`"Add me as a member"` defaults to Checked `true`):** In the Create New Group form, the `"Add me as a member"` checkbox defaults to `true`, and can be unchecked when the Admin is creating a group for someone else. When viewing a group as a non-participant, the UI displays `"Admin View (non-participant)"` instead of nagging with `"Who are you in this group?"`.
- **Root-Level Friendly Group URLs (`https://split.murphnduff.org/SoCal_2026`):**
  - Groups have a `slug` column in `public.groups` derived from `name` (`name.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')`, e.g., `'Test Group 1'` -> `'Test_Group_1'`, `'SoCal 2026'` -> `'SoCal_2026'`).
  - Groups are served directly at the root dynamic route `src/app/[slug]/page.tsx` (matching `ilike(slug, slugParam)`, `ilike(name, spaceNormalizedTarget)`, or `id = slugParam` if a UUID is passed).
  - Any legacy `/g/[slug]` requests automatically redirect to `/[slug]`.
- **Zero-Login Regular Users & Cross-Device Recognition:**
  - Anyone visiting `/<slug>` (or `/<slug>?m=<display_name>`) on a phone, tablet, or computer immediately sees and loads the group without logging in.
  - Visiting `/<slug>` immediately loads the group, sets it as the active group, adds it to `recent_groups` in `localStorage` so it appears under **"Your Groups"** in the sidebar, and loads its `group_members`, `expenses`, and `expense_splits`.
  - **"Who Are You?" Identity Pill:** Tapping a member pill (`"Who are you in this group?"`) saves `active_member_id` and adds the group to `recent_groups` in `localStorage`, defaults the **"Paid By"** selector to that member, and updates the URL query param to `?m=<display_name>` via `window.history.replaceState` so the user can bookmark or share their pre-selected link across devices.
- **Transaction Date Picker & Chronological Ledger Sorting:**
  - Both the main **Add Transaction** form (`src/app/page.tsx`) and the **Edit Transaction** modal (`src/components/EditExpenseModal.tsx`) include an `<input type="date" />` field.
  - Defaults to today's local date (`YYYY-MM-DD`) when adding a new transaction, and pre-populates with `expense.date` when editing an existing transaction.
  - Saves the selected date to `public.expenses.date`, displays a human-friendly formatted date (e.g., `Oct 18, 2026`) on each transaction row in the ledger, and sorts the transaction ledger chronologically by `date` descending with `created_at` descending as tie-breaker.
- **Custom Unequal Splits (`Equal | % Percentage | $ Exact`):**
  - Both **Add Transaction** and **Edit Transaction** provide a 3-way split mode selector (`Equal` | `% Percentage` | `$ Exact`) for Group Expenses:
    - **Equal:** Distributes integer cents via `splitAmountEqually(totalAmountCents, memberIds)`.
    - **% Percentage:** Inline percentage inputs per member with live remaining-percentage validation and cent allocation via `splitAmountByPercentage(totalAmountCents, memberPercentages)` (Largest Remainder Method so `SUM(splitAmountCents) === totalAmountCents`).
    - **$ Exact:** Inline dollar/euro inputs per member with live remaining-amount validation via `validateExactSplits(totalAmountCents, exactInputs)`.

### 2.2 Single Unified CSV Import & Export Format (`<slug>_<YYYY-MM-DD>_export.csv`)
- **Standard CSV Structure (No JSON Import/Export):**
  - **Header Row:** `Date,Description,Category,Cost,Currency,<Member 1>,<Member 2>,...` (where `<Member 1>...` are the exact `display_name`s of the group members).
  - **Transaction Rows:** Each member column contains that member's net delta for the transaction (`+paid - share_owed`), formatted to 2 decimal places:
    - For the payer: `(amount_cents - payer_split_amount_cents) / 100` (positive number).
    - For all other participating members: `-split_amount_cents / 100` (negative number).
    - For non-participating members: `0.00`.
    - `Category` is `'Payment'` when `type === 'payment'`, and `'General'` when `type === 'expense'`.
  - **Footer Row (after a blank line):** `<YYYY-MM-DD>,Total balance, , ,<Currency>,<Net 1 Balance Member>,<Net 2 Balance Member>,...`
- **Export CSV Button (Available to All Users in Group Header):**
  - Downloads `<slug>_<YYYY-MM-DD>_export.csv` via `generateGroupCsv()`.
- **Import CSV Button & Modal (Super-Admin `murph@murphnduff.org` Only):**
  - Allows Super-Admin to upload a `.csv` file in this format to either create a new group (deriving the default group name from the filename via `deriveGroupNameFromCsvFilename`, e.g., `orphans_2026-10-18_export.csv` -> `'orphans'`) or import into the currently active group.
  - Reads member names from header index 5 onward, ensures all exist in `group_members`, skips blank lines and `'Total balance'` summary rows, identifies `paid_by_member_id` where `valCents > 0`, and reconstructs exact `expense_splits` (`Math.abs(valCents)` for `valCents < 0`, and `amount_cents - valCents` for the payer when `amount_cents - valCents > 0`).

### 2.3 Privacy, Anti-Indexing & Anti-Discovery Shield (4 Layers)
1. **`robots.txt` (`src/app/robots.ts`):** Sets `userAgent: '*'`, `disallow: '/'` to instruct all search engine and AI crawlers not to crawl any route on `split.murphnduff.org`.
2. **HTML Meta Tags (`src/app/layout.tsx`):** Global `metadata.robots` configured with `{ index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noimageindex: true, 'max-snippet': -1 } }`.
3. **Server-Level HTTP Header (`next.config.ts`):** Global `headers()` rule on `source: '/:path*'` returning `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex` across all HTML, API, and static responses.
4. **Root Group Enumeration Prevention (`src/app/page.tsx`):** Unauthenticated visitors (or anyone other than `murph@murphnduff.org`) NEVER execute an unfiltered `SELECT * FROM groups` query. On `/`, the client only queries `.in('id', recentIds)` for group IDs already stored in that browser's `localStorage` (`recent_groups`), and on `/[slug]` it only queries the specific group matching `slug`, `id`, or `name`.

### 2.4 Database Tables
- **`groups`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `name` (TEXT NOT NULL), `slug` (TEXT UNIQUE case-insensitively), `created_by` (UUID Nullable FK to `auth.users`), `created_at` (TIMESTAMPTZ DEFAULT `now()`).
- **`group_members`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `group_id` (UUID NOT NULL FK CASCADE), `display_name` (TEXT NOT NULL), `created_at` (TIMESTAMPTZ DEFAULT `now()`).
  - *Uniqueness:* Case-insensitive unique index on `(group_id, lower(display_name))` to prevent duplicate member names in the same group.
  - *Deletion Guard:* `ON DELETE RESTRICT` when referenced in `expenses` or `expense_splits`.
- **`expenses`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `group_id` (UUID NOT NULL FK CASCADE), `type` (`'expense'` | `'payment'`), `description` (TEXT), `amount_cents` (INTEGER > 0), `currency` (`'USD'` | `'EUR'` or `'$'` | `'€'`), `date` (DATE), `paid_by_member_id` (UUID NOT NULL FK to `group_members.id` ON DELETE RESTRICT), `created_by_member_id` (UUID Nullable FK to `group_members.id` ON DELETE SET NULL), `created_at` (TIMESTAMPTZ DEFAULT `now()`).
- **`expense_splits`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `expense_id` (UUID NOT NULL FK CASCADE), `member_id` (UUID NOT NULL FK to `group_members.id` ON DELETE RESTRICT), `split_amount_cents` (INTEGER >= 0), `created_at` (TIMESTAMPTZ DEFAULT `now()`).

### 2.5 Simplified Row-Level Security (RLS) Rules
- **Admin Helper:** `public.is_super_admin()` returns `true` ONLY when `lower(coalesce(auth.jwt() ->> 'email', '')) = 'murph@murphnduff.org'`.
- **`groups`**:
  - `SELECT`: Allowed for `anon` and `authenticated`.
  - `INSERT / UPDATE / DELETE`: Allowed strictly for `public.is_super_admin()`.
- **`group_members`**:
  - `SELECT`: Allowed for `anon` and `authenticated`.
  - `UPDATE`: Allowed for `anon` and `authenticated` (renaming `display_name`).
  - `INSERT / DELETE`: Allowed strictly for `public.is_super_admin()`.
- **`expenses` & `expense_splits`**:
  - `SELECT / INSERT / UPDATE / DELETE`: Allowed for `anon` and `authenticated`.

### 2.6 Supabase Heartbeat (`/api/heartbeat`)
- **Route Handler (`src/app/api/heartbeat/route.ts`):** Executes `SELECT id FROM groups LIMIT 1` via Supabase and returns `{ status: 'ok', timestamp }` to prevent Supabase free-tier project pausing.
- **Vercel Cron (`vercel.json`):** Configured with a scheduled cron job hitting `/api/heartbeat`.

---

## 3. Permissions & Roles Matrix

| Action | Super-Admin (`murph@murphnduff.org`) | Regular User (Via `/<slug>` Link) |
| :--- | :--- | :--- |
| **Sign-In Required?** | Yes (Google OAuth) | **No** (Instant access on Phone, Tablet, or PC) |
| **Sidebar Group List** | Sees **ALL** groups in database | Sees only groups visited on their device (`recent_groups` in `localStorage`) |
| **Create / Delete Group** | Yes (`slug` auto-generated; `"Add me as a member"` checked by default) | No (Hidden in UI, blocked by RLS) |
| **Import CSV** | Yes (Create new group from CSV or import into active group) | No (Hidden in UI) |
| **Export CSV** | Yes (`<slug>_<YYYY-MM-DD>_export.csv`) | Yes (`<slug>_<YYYY-MM-DD>_export.csv`) |
| **Manage Members (Add/Delete)**| Yes (Delete blocked if >0 txns) | No (Hidden in UI, blocked by RLS) |
| **Share Group / Member Link** | Yes (`/<slug>` & `/<slug>?m=<display_name>`) | Yes (Can copy `/<slug>` group link) |
| **Rename Members** | Yes (Any member) | Yes (Can rename own selected member profile) |
| **Add / Edit / Delete Txns** | Yes (`Equal | % Percentage | $ Exact` splits & custom `date`) | Yes (`Equal | % Percentage | $ Exact` splits & custom `date`) |

---

## 4. Math Engine & Test Suite (`src/lib/reconciliation.test.ts`)
All 9 core integer-cent math, custom split, and CSV import/export edge-case tests pass 100%:
1. Indivisible Penny (`$100.00 / 3` -> `3334, 3333, 3333` cents).
2. Transitive Debt Simplification (`Murph -> Kev -> Fitz` collapses to 1 transfer).
3. 1-to-1 Direct Payment Offset.
4. Partial & Subset Member Splits.
5. Multi-Currency Isolation (`USD` vs `EUR` never cross-cancel).
6. Member Deletion Guard (`canDeleteMember`).
7. Transaction Mutation Recalculation.
8. Custom Unequal Splits (`splitAmountByPercentage` & `validateExactSplits`).
9. Unified CSV Parser & Exporter (`parseGroupCsv` & `generateGroupCsv` reconstructing odd-penny splits like `550.00,EUR,-78.57,-78.57,-78.57,-78.57,-78.57,-78.57,471.42` into `55000` cents paid by `Adele` with `7857 x 6 + 7858`).

---

## 5. Future Backlog
1. **Automated `/browser` E2E Walkthrough:** End-to-end browser verification of Super-Admin group creation, CSV import/export, member addition, `/<slug>?m=<display_name>` sharing, and zero-login transaction entry.