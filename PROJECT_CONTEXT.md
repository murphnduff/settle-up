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
  - Is the **ONLY** user who can Create Groups, Delete Groups, or Manage Members (Add/Delete members).
- **Root-Level Friendly Group URLs (`https://split.murphnduff.org/SoCal_2026`):**
  - Groups have a `slug` column in `public.groups` derived from `name` (`name.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')`, e.g., `'Test Group 1'` -> `'Test_Group_1'`, `'SoCal 2026'` -> `'SoCal_2026'`).
  - Groups are served directly at the root dynamic route `src/app/[slug]/page.tsx` (matching `ilike(slug, slugParam)` or `id = slugParam` if a UUID is passed).
  - Any legacy `/g/[slug]` requests automatically redirect to `/[slug]`.
- **Zero-Login Regular Users & Cross-Device Recognition:**
  - Anyone visiting `/<slug>` (or `/<slug>?m=<display_name>`) on a phone, tablet, or computer immediately sees and loads the group without logging in.
  - Visiting `/<slug>` immediately loads the group, sets it as the active group, adds it to `recent_groups` in `localStorage` so it appears under **"Your Groups"** in the sidebar, and loads its `group_members`, `expenses`, and `expense_splits`.
  - **"Who Are You?" Identity Pill:** Tapping a member pill (`"Who are you in this group?"`) saves `active_member_id` and adds the group to `recent_groups` in `localStorage`, defaults the **"Paid By"** selector to that member, and updates the URL query param to `?m=<display_name>` via `window.history.replaceState` so the user can bookmark or share their pre-selected link across devices.

### 2.2 Database Tables
- **`groups`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `name` (TEXT NOT NULL), `slug` (TEXT UNIQUE case-insensitively), `created_by` (UUID Nullable FK to `auth.users`), `created_at` (TIMESTAMPTZ DEFAULT `now()`).
- **`group_members`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `group_id` (UUID NOT NULL FK CASCADE), `display_name` (TEXT NOT NULL), `created_at` (TIMESTAMPTZ DEFAULT `now()`).
  - *Uniqueness:* Case-insensitive unique index on `(group_id, lower(display_name))` to prevent duplicate member names in the same group.
  - *Deletion Guard:* `ON DELETE RESTRICT` when referenced in `expenses` or `expense_splits`.
- **`expenses`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `group_id` (UUID NOT NULL FK CASCADE), `type` (`'expense'` | `'payment'`), `description` (TEXT), `amount_cents` (INTEGER > 0), `currency` (`'USD'` | `'EUR'`, default `'USD'`), `date` (DATE), `paid_by_member_id` (UUID NOT NULL FK to `group_members.id` ON DELETE RESTRICT), `created_by_member_id` (UUID Nullable FK to `group_members.id` ON DELETE SET NULL), `created_at` (TIMESTAMPTZ DEFAULT `now()`).
- **`expense_splits`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `expense_id` (UUID NOT NULL FK CASCADE), `member_id` (UUID NOT NULL FK to `group_members.id` ON DELETE RESTRICT), `split_amount_cents` (INTEGER >= 0), `created_at` (TIMESTAMPTZ DEFAULT `now()`).

### 2.3 Simplified Row-Level Security (RLS) Rules
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

### 2.4 Supabase Heartbeat (`/api/heartbeat`)
- **Route Handler (`src/app/api/heartbeat/route.ts`):** Executes `SELECT id FROM groups LIMIT 1` via Supabase and returns `{ status: 'ok', timestamp }` to prevent Supabase free-tier project pausing.
- **Vercel Cron (`vercel.json`):** Configured with a scheduled cron job hitting `/api/heartbeat`.

---

## 3. Permissions & Roles Matrix

| Action | Super-Admin (`murph@murphnduff.org`) | Regular User (Via `/<slug>` Link) |
| :--- | :--- | :--- |
| **Sign-In Required?** | Yes (Google OAuth) | **No** (Instant access on Phone, Tablet, or PC) |
| **Sidebar Group List** | Sees **ALL** groups in database | Sees groups visited on their device (`recent_groups` in `localStorage`) |
| **Create / Delete Group** | Yes (Auto-generates `slug` from `name`) | No (Hidden in UI, blocked by RLS) |
| **Manage Members (Add/Delete)**| Yes (Delete blocked if >0 txns) | No (Hidden in UI, blocked by RLS) |
| **Share Group / Member Link** | Yes (`/<slug>` & `/<slug>?m=<display_name>`) | Yes (Can copy `/<slug>` group link) |
| **Rename Members** | Yes (Any member) | Yes (Can rename own selected member profile) |
| **Add / Edit / Delete Txns** | Yes (Any expense or payment) | Yes (Any expense or payment in the group) |

---

## 4. Math Engine & Test Suite (`src/lib/reconciliation.test.ts`)
All 7 core integer-cent math and reconciliation edge-case tests pass 100%:
1. Indivisible Penny (`$100.00 / 3` -> `3334, 3333, 3333` cents).
2. Transitive Debt Simplification (`Murph -> Kev -> Fitz` collapses to 1 transfer).
3. 1-to-1 Direct Payment Offset.
4. Partial & Subset Member Splits.
5. Multi-Currency Isolation (`USD` vs `EUR` never cross-cancel).
6. Member Deletion Guard (`canDeleteMember`).
7. Transaction Mutation Recalculation.

---

## 5. Future Backlog
1. **Automated `/browser` E2E Walkthrough:** End-to-end browser verification of Super-Admin group creation, member addition, `/<slug>?m=<display_name>` sharing, and zero-login transaction entry.
2. **Full Group JSON Import/Export:** Support native group JSON backup/restore as well as legacy `ExpenseAppData.json` (`{ Users, Expenses }`) migration.
3. **Custom Split Types:** Support Percentage splits (e.g., `70% / 30%`) and Exact Dollar splits alongside Equal splits.