# Settle Up - Master Architecture, Requirements & Test Spec

## 1. Tech Stack & Workflow
- **Frontend / Fullstack:** Next.js 16 (App Router, Turbopack, React 19, TypeScript, Tailwind CSS, Lucide Icons).
- **Backend / Database:** Supabase (PostgreSQL 15+, Google OAuth, hardened Row-Level Security, PL/pgSQL Security Definer RPCs).
- **Testing & Tooling:** Node 24 built-in test runner (`node --experimental-strip-types --test`), ESLint 9.
- **Hosting & Production:** Vercel (`https://split.murphnduff.org`).
- **Deployment Workflow:** Local edits pushed via PowerShell `sync "commit message"` macro.

---

## 2. Core Data Model & Database Architecture

### 2.1 Database Tables
- **`groups`**:
  - Columns: `id` (UUID PK), `name` (TEXT), `created_by` (UUID FK to `auth.users`), `created_at` (TIMESTAMPTZ).
- **`group_members`**:
  - Columns: `id` (UUID PK), `group_id` (UUID FK CASCADE), `user_id` (UUID Nullable FK to `auth.users`), `display_name` (TEXT NOT NULL), `invited_email` (TEXT NULL), `invite_token` (UUID UNIQUE DEFAULT `gen_random_uuid()`), `role` (`'admin'` | `'member'`), `created_at` (TIMESTAMPTZ).
  - *Pre-created / Claimable Profiles:* Admins add members by specifying `display_name` and optional `invited_email`. `user_id` starts as `NULL` so members can immediately be selected as payers or participants before signing up.
  - *Unique Invite Links:* Each member row receives a unique `invite_token` (`https://split.murphnduff.org/join?token=<invite_token>`). Clicking the link binds their `auth.uid()` to that `group_members` row while preserving the admin-assigned `display_name`.
  - *Deletion Guard:* A member CANNOT be deleted if they are referenced as a payer or participant in any transaction in that group (enforced by `ON DELETE RESTRICT` and RLS).
- **`expenses`**:
  - Columns: `id` (UUID PK), `group_id` (UUID FK CASCADE), `type` (`'expense'` | `'payment'`), `description` (TEXT), `amount_cents` (INTEGER > 0), `currency` (`'USD'` | `'EUR'`, default `'USD'`), `date` (DATE), `paid_by_member_id` (UUID FK to `group_members.id` ON DELETE RESTRICT), `created_by` (UUID FK to `auth.users`), `created_at` (TIMESTAMPTZ).
- **`expense_splits`**:
  - Columns: `id` (UUID PK), `expense_id` (UUID FK CASCADE), `member_id` (UUID FK to `group_members.id` ON DELETE RESTRICT), `split_amount_cents` (INTEGER >= 0), `created_at` (TIMESTAMPTZ).
  - *Note:* Foreign keys for payers and splits reference `group_members.id` (NOT `auth.users.id`), enabling unclaimed members to participate seamlessly.
  - *Future-Proofing:* Exact integer cents per split supports equal splits with penny remainders now and custom percentage/exact-dollar splits later without schema changes.

### 2.2 Security Definer Functions & Anti-Recursion Design
To prevent circular infinite recursion (`42P17`) between `groups` and `group_members`, all cross-table authorization checks use procedural PL/pgSQL functions (`LANGUAGE plpgsql`) with `SECURITY DEFINER` and `SET search_path = public, pg_temp`:
- `public.is_group_member(p_group_id UUID, p_user_id UUID) RETURNS BOOLEAN`: Bypasses RLS to verify group membership without recursive query expansion.
- `public.is_group_creator(p_group_id UUID, p_user_id UUID) RETURNS BOOLEAN`: Checks if user created the group without triggering `groups` RLS policies.
- `public.is_group_admin(p_group_id UUID, p_user_id UUID) RETURNS BOOLEAN`: Checks admin role or creator status safely.
- `public.claim_invite_token(p_token UUID) RETURNS JSONB`: Atomically binds an authenticated caller's `auth.uid()` to an unclaimed `group_members` record.
- `public.find_user_by_email(lookup_email TEXT)`: Scoped email lookup avoiding profile enumeration.

---

## 3. Permissions & Roles Matrix

| Action | Group Admin (Creator) | Regular Group Member | Non-Member / Unauthenticated |
| :--- | :--- | :--- | :--- |
| **Create Group** | Yes | Yes (becomes Admin of new group) | Authenticated only |
| **Delete Group** | Yes (Creator only) | No (hidden in UI, blocked in RLS) | No |
| **Add Pre-created Members** | Yes (via "Manage Members") | No (hidden in UI, blocked in RLS) | No |
| **Copy Member Invite Links** | Yes (from "Manage Members") | No | No |
| **Delete Members** | Yes (ONLY if 0 transactions) | No | No |
| **Rename Members** | Yes (Can rename any member) | Can rename only own `display_name` | No |
| **Add Transactions** | Yes (Expenses & Payments) | Yes (Expenses & Payments) | No |
| **Edit Transactions** | Yes (Any transaction in group) | Yes (Any transaction in group) | No |
| **Delete Transactions** | Yes (Any transaction in group) | Yes (Any transaction in group) | No |
| **View Group & Ledger** | Yes | Yes | Blocked by RLS |

---

## 4. Math Engine & Test Suite (`src/lib/reconciliation.test.ts`)
All calculations operate strictly on integers (`amount_cents`) with isolated ledgers per currency (`USD` vs `EUR`). All 7 core edge cases pass 100%:
1. **The Indivisible Penny Edge Case ($100.00 / 3):**
   - Splitting `10000` cents among 3 members allocates `3334`, `3333`, `3333` cents so `SUM(split_amount_cents) === amount_cents` (10000). Never loses or invents a penny.
2. **Transitive Debt Simplification (A -> B -> C):**
   - Murph pays $30 for Kev; Kev pays $30 for Fitz. Net balances: Murph +$30, Kev $0, Fitz -$30. Collapses into 1 transfer (`Fitz pays Murph $30.00`).
3. **1-to-1 Payment Offset:**
   - If Fitz owes Murph $30.00, and logs a $10.00 direct payment from Fitz to Murph, the settlement plan updates to `Fitz pays Murph $20.00`.
4. **Partial & Subset Splits:**
   - Group has Murph, Kev, Fitz. Murph pays $40 for just Murph & Kev. Fitz's balance remains $0.00; Kev owes Murph $20.00.
5. **Multi-Currency Isolation:**
   - Murph pays $60 USD (split 3 ways) and Kev pays €30 EUR (split 3 ways). USD and EUR never cross-cancel; produces independent USD and EUR settlement transfers.
6. **Member Deletion Guard:**
   - Attempting to delete a member who is a payer or split participant fails cleanly (`canDeleteMember() === false`); deleting an unreferenced member succeeds.
7. **Transaction Mutation Recalculation:**
   - Editing an existing transaction's amount, payer, participants, or deleting it immediately recalculates net balances without ghost data.

---

## 5. What Was Built Today

### 5.1 Math Engine & Automated Test Suite
- **`src/lib/reconciliation.ts`**:
  - Implemented `splitAmountEqually(totalAmountCents, memberIds)` with remainder penny distribution.
  - Implemented `calculateBalancesByCurrency()` and greedy cash-flow minimization `calculateSettlements()`.
  - Implemented `canDeleteMember(memberId, expenses)` deletion safeguard.
- **`src/lib/reconciliation.test.ts`**:
  - Created automated test suite covering all 7 Section 4 edge cases.
  - Added `npm test` script to `package.json`. Ran in terminal: **7/7 tests passed (100% pass rate)**.

### 5.2 Supabase Schema & Anti-Recursion Migration
- **`supabase/migrations/20261017_schema_and_rls_update.sql`**:
  - Complete idempotent SQL script updating `group_members`, `expenses`, and `expense_splits`.
  - Dynamic PL/pgSQL block to safely drop all legacy policies across tables, eliminating lingering recursive policies.
  - Converted all helper functions (`is_group_member`, `is_group_creator`, `is_group_admin`, `claim_invite_token`) to `LANGUAGE plpgsql` to prevent query planner inlining.
  - Added `ON DELETE RESTRICT` constraints on `paid_by_member_id` and `expense_splits.member_id` for database-level deletion integrity.

### 5.3 Member Management & Unique Token Invite Flow
- **`src/components/MemberInviteModal.tsx`**:
  - Pre-created profiles: Admins enter name and optional email, creating unclaimed rows (`user_id = null`) with unique `invite_token`.
  - Individual invite links: Prominent **"Copy Invite Link"** button for each unclaimed member (`https://split.murphnduff.org/join?token=<invite_token>`).
  - Inline member renaming for admins and self-renaming for members.
  - Deletion guard: UI disables deletion for any member who has transactions.
  - Removed confusing "General Group Link" to keep invite flow strictly token-based.
- **`src/app/join/page.tsx`**:
  - Dedicated claim page handling `/join?token=<uuid>`.
  - If unauthenticated: caches token in `sessionStorage` and prompts Google sign-in.
  - If authenticated: calls `claim_invite_token` RPC, linking Google account to pre-created member profile while retaining admin-assigned display name.

### 5.4 Group-Wide Transaction Editing & UI Ledger
- **`src/components/EditExpenseModal.tsx`**:
  - Native `<dialog closedby="any">` accessible modal allowing any group member to edit transaction amounts, descriptions, currencies, payers, types, and split participants.
  - Dynamically recalculates integer splits and updates settlement plans.
- **`src/app/page.tsx`**:
  - Role-based header: Admins see **"Manage Members"** (blue button with invite/delete powers); regular members see **"View Members"** (view-only roster).
  - Sidebar: Only shows groups where user is an active member or creator. Group deletion restricted strictly to the creator (`g.created_by === user.id`).
  - Visual ledger styling: Soft red (`#FFC4C4`) accent styling for expenses; soft blue (`#BDE0FF`) accent styling for payments.
  - Group-wide deletion: Any group member can delete a transaction with immediate settlement recalculation.

---

## 6. Current State of the App
- **Tests & Quality:** `npm test` passes 100% (7/7 tests). `npm run lint` passes with 0 errors and 0 warnings.
- **Build Status:** `next build` compiles cleanly with Turbopack (`/`, `/join`, `/_not-found`).
- **Database:** Supabase schema migration executed and active. Zero circular recursion in RLS.
- **Core Functionality:** Google OAuth sign-in, group creation, member pre-creation, unique token invite links, token claiming, transaction entry, equal penny splitting, group-wide transaction editing/deleting, multi-currency isolation (USD / EUR), and greedy cash-flow settlement minimization are all live and verified.

---

## 7. What is Left to Do (Roadmap & Backlog)

### High Priority
1. **Outbound Transactional Email Service (Resend / SendGrid / Postmark):**
   - *Current Behavior:* Entering an email stores it as metadata on the member row; admins copy the invite link to share manually.
   - *Enhancement:* Integrate a transactional email API (e.g., via Resend Next.js Server Action) to automatically send the claim link when an admin enters an email.

### Medium Priority
2. **Custom Split Types:**
   - *Current Behavior:* Equal split with penny remainder distribution.
   - *Enhancement:* Support percentage-based splits (e.g. 70/30, 50/25/25) and exact-dollar custom splits. The schema already stores exact `split_amount_cents` per row, so this requires only UI controls.
3. **Receipt Image Uploads:**
   - Add Supabase Storage bucket (`receipts`) and an image upload attachment field in `Add Transaction` and `Edit Transaction`.
4. **Audit Log & Activity History:**
   - Display `created_by` and edit history (e.g. "Edited by Kev on Oct 18") for group transactions.

### Low Priority / Polish
5. **CSV / PDF Ledger Export:**
   - Allow exporting group expense history and settlement summary as CSV or printable PDF report.
6. **Push / In-App Notifications:**
   - Notify members when a new expense is logged or when debts are settled.
   - Editing an existing transaction's amount, payer, participants, or deleting it immediately recalculates net balances without ghost data.

---

## 5. What Was Built Today

### 5.1 Math Engine & Automated Test Suite
- **`src/lib/reconciliation.ts`**:
  - Implemented `splitAmountEqually(totalAmountCents, memberIds)` with remainder penny distribution.
  - Implemented `calculateBalancesByCurrency()` and greedy cash-flow minimization `calculateSettlements()`.
  - Implemented `canDeleteMember(memberId, expenses)` deletion safeguard.
- **`src/lib/reconciliation.test.ts`**:
  - Created automated test suite covering all 7 Section 4 edge cases.
  - Added `npm test` script to `package.json`. Ran in terminal: **7/7 tests passed (100% pass rate)**.

### 5.2 Supabase Schema & Anti-Recursion Migration
- **`supabase/migrations/20261017_schema_and_rls_update.sql`**:
  - Complete idempotent SQL script updating `group_members`, `expenses`, and `expense_splits`.
  - Dynamic PL/pgSQL block to safely drop all legacy policies across tables, eliminating lingering recursive policies.
  - Converted all helper functions (`is_group_member`, `is_group_creator`, `is_group_admin`, `claim_invite_token`) to `LANGUAGE plpgsql` to prevent query planner inlining.
  - Added `ON DELETE RESTRICT` constraints on `paid_by_member_id` and `expense_splits.member_id` for database-level deletion integrity.

### 5.3 Member Management & Unique Token Invite Flow
- **`src/components/MemberInviteModal.tsx`**:
  - Pre-created profiles: Admins enter name and optional email, creating unclaimed rows (`user_id = null`) with unique `invite_token`.
  - Individual invite links: Prominent **"Copy Invite Link"** button for each unclaimed member (`https://split.murphnduff.org/join?token=<invite_token>`).
  - Inline member renaming for admins and self-renaming for members.
  - Deletion guard: UI disables deletion for any member who has transactions.
  - Removed confusing "General Group Link" to keep invite flow strictly token-based.
- **`src/app/join/page.tsx`**:
  - Dedicated claim page handling `/join?token=<uuid>`.
  - If unauthenticated: caches token in `sessionStorage` and prompts Google sign-in.
  - If authenticated: calls `claim_invite_token` RPC, linking Google account to pre-created member profile while retaining admin-assigned display name.

### 5.4 Group-Wide Transaction Editing & UI Ledger
- **`src/components/EditExpenseModal.tsx`**:
  - Native `<dialog closedby="any">` accessible modal allowing any group member to edit transaction amounts, descriptions, currencies, payers, types, and split participants.
  - Dynamically recalculates integer splits and updates settlement plans.
- **`src/app/page.tsx`**:
  - Role-based header: Admins see **"Manage Members"** (blue button with invite/delete powers); regular members see **"View Members"** (view-only roster).
  - Sidebar: Only shows groups where user is an active member or creator. Group deletion restricted strictly to the creator (`g.created_by === user.id`).
  - Visual ledger styling: Soft red (`#FFC4C4`) accent styling for expenses; soft blue (`#BDE0FF`) accent styling for payments.
  - Group-wide deletion: Any group member can delete a transaction with immediate settlement recalculation.

---

## 6. Current State of the App
- **Tests & Quality:** `npm test` passes 100% (7/7 tests). `npm run lint` passes with 0 errors and 0 warnings.
- **Build Status:** `next build` compiles cleanly with Turbopack (`/`, `/join`, `/_not-found`).
- **Database:** Supabase schema migration executed and active. Zero circular recursion in RLS.
- **Core Functionality:** Google OAuth sign-in, group creation, member pre-creation, unique token invite links, token claiming, transaction entry, equal penny splitting, group-wide transaction editing/deleting, multi-currency isolation (USD / EUR), and greedy cash-flow settlement minimization are all live and verified.

---

## 7. What is Left to Do (Roadmap & Backlog)

### High Priority
1. **Outbound Transactional Email Service (Resend / SendGrid / Postmark):**
   - *Current Behavior:* Entering an email stores it as metadata on the member row; admins copy the invite link to share manually.
   - *Enhancement:* Integrate a transactional email API (e.g., via Resend Next.js Server Action) to automatically send the claim link when an admin enters an email.

### Medium Priority
2. **Custom Split Types:**
   - *Current Behavior:* Equal split with penny remainder distribution.
   - *Enhancement:* Support percentage-based splits (e.g. 70/30, 50/25/25) and exact-dollar custom splits. The schema already stores exact `split_amount_cents` per row, so this requires only UI controls.
3. **Receipt Image Uploads:**
   - Add Supabase Storage bucket (`receipts`) and an image upload attachment field in `Add Transaction` and `Edit Transaction`.
4. **Audit Log & Activity History:**
   - Display `created_by` and edit history (e.g. "Edited by Kev on Oct 18") for group transactions.

### Low Priority / Polish
5. **CSV / PDF Ledger Export:**
   - Allow exporting group expense history and settlement summary as CSV or printable PDF report.
6. **Push / In-App Notifications:**
   - Notify members when a new expense is logged or when debts are settled.