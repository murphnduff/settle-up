# Settle Up - Master Architecture, Requirements & Test Spec

## 1. Tech Stack & Workflow
- **Frontend / Fullstack:** Next.js 16 (App Router, Turbopack, React 19, TypeScript, Tailwind CSS, Lucide Icons) — responsive across Desktop, Tablet, and Mobile.
- **Backend / Database:** Supabase (PostgreSQL 15+, Google OAuth for Super-Admin only, Row-Level Security).
- **Testing & Tooling:** Node 24 built-in test runner (`node --experimental-strip-types --test`), ESLint 9.
- **Hosting & Production:** Vercel (`https://split.murphnduff.org`).
- **Deployment Workflow:** Local edits pushed via PowerShell `sync "commit message"` macro.

---

## 2. Core Data Model & High-Trust Security Architecture

### 2.1 Philosophy: High-Trust Shared Group URLs + Single Super-Admin
- **Single Global Super-Admin (`murph@murphnduff.org`):**
  - Admin status is determined EXCLUSIVELY by `user?.email?.toLowerCase() === 'murph@murphnduff.org'` (on the client) and `lower(auth.jwt() ->> 'email') = 'murph@murphnduff.org'` (in Supabase RLS).
  - No other email or account is EVER an admin, even if they previously created a test group.
  - Only `murph@murphnduff.org` can see the Master All-Groups list, Create Groups, Delete Groups, Import JSON backups, or Add/Remove members.
- **Regular Group Users (Zero Sign-In Required):**
  - Access any group directly via its unguessable UUID URL: `https://split.murphnduff.org/g/[group_id]` (or optional pre-selected member link `/g/[group_id]?m=[member_id]`).
  - **No OAuth Wall:** Visiting `/g/[group_id]` on any phone, tablet, or computer loads the group immediately without requiring sign-in.
  - **"Who Are You?" Identity Pill:** On first visit to `/g/[group_id]` (if `?m=[member_id]` is not in the URL), the user taps their name from the group's member pills (`"Who are you in this group?"`). This saves `active_member_id` for that `group_id` (plus adds the group to a `recent_groups` list) in `localStorage`.
  - Regular users only see groups stored in their device's `localStorage` `recent_groups` (plus the currently open `/g/[group_id]`).

### 2.2 Database Tables (Cleaned of Legacy Columns)
- **`groups`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `name` (TEXT NOT NULL), `created_by` (UUID Nullable FK to `auth.users`), `created_at` (TIMESTAMPTZ).
- **`group_members`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `group_id` (UUID FK CASCADE), `display_name` (TEXT NOT NULL), `created_at` (TIMESTAMPTZ).
  - *Uniqueness:* `UNIQUE (group_id, lower(display_name))` to prevent duplicate member pills in the same group.
  - *Deletion Guard:* `ON DELETE RESTRICT` when referenced in `expenses` or `expense_splits`.
- **`expenses`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `group_id` (UUID FK CASCADE), `type` (`'expense'` | `'payment'`), `description` (TEXT), `amount_cents` (INTEGER > 0), `currency` (`'USD'` | `'EUR'`, default `'USD'`), `date` (DATE), `paid_by_member_id` (UUID NOT NULL FK to `group_members.id` ON DELETE RESTRICT), `created_by_member_id` (UUID Nullable FK to `group_members.id` ON DELETE SET NULL), `created_at` (TIMESTAMPTZ).
  - *Legacy Cleanup:* Legacy columns (`payer_id`, `paid_by`, `user_id`) MUST be dropped so `INSERT` never fails with `null value in column "payer_id" violates not-null constraint`.
- **`expense_splits`**:
  - Columns: `id` (UUID PK DEFAULT `gen_random_uuid()`), `expense_id` (UUID FK CASCADE), `member_id` (UUID NOT NULL FK to `group_members.id` ON DELETE RESTRICT), `split_amount_cents` (INTEGER >= 0), `created_at` (TIMESTAMPTZ).

### 2.3 Simplified Row-Level Security (RLS) Rules
- **Admin Helper:** `public.is_super_admin()` returns `true` ONLY when `lower(coalesce(auth.jwt() ->> 'email', '')) = 'murph@murphnduff.org'`.
- **`groups`**:
  - `SELECT`: Allowed for `anon` and `authenticated`.
  - `INSERT / UPDATE / DELETE`: Allowed strictly for `public.is_super_admin()`.
- **`group_members`**:
  - `SELECT`: Allowed for `anon` and `authenticated`.
  - `UPDATE`: Allowed for `anon` and `authenticated` (renaming display_name).
  - `INSERT / DELETE`: Allowed strictly for `public.is_super_admin()`.
- **`expenses` & `expense_splits`**:
  - `SELECT / INSERT / UPDATE / DELETE`: Allowed for `anon` and `authenticated`.

---

## 3. Permissions & Roles Matrix

| Action | Super-Admin (`murph@murphnduff.org`) | Regular User (Via `/g/[group_id]` Link) |
| :--- | :--- | :--- |
| **Sign-In Required?** | Yes (Google OAuth) | **No** (Instant access on Phone, Tablet, or PC) |
| **Sidebar Group List** | Sees **ALL** groups in database | Sees only groups visited on their device (`localStorage`) |
| **Create / Delete Group** | Yes | No (Hidden in UI, blocked by RLS) |
| **Manage Members (Add/Delete)**| Yes (Delete blocked if >0 txns) | No (Hidden in UI, blocked by RLS) |
| **Share Group Link** | Yes (`/g/[id]` or `/g/[id]?m=[mid]`) | Yes (Can copy `/g/[id]` group link) |
| **Rename Members** | Yes (Any member) | Yes (Can rename own selected member profile) |
| **Add / Edit / Delete Txns** | Yes (Any expense or payment) | Yes (Any expense or payment in the group) |
| **Import / Export Group JSON** | Yes (Full Import & Export) | Export only |

---

## 4. Math Engine & Test Suite (`src/lib/reconciliation.test.ts`)
All 7 core integer-cent math and reconciliation tests pass 100%.

---

## 5. Active Sprint Tasks

### Phase A: Fix Current Bugs & Pivot to Group URL + Super-Admin Model (Immediate)
1. **Fix `payer_id` NULL Constraint Crash:** Drop legacy `payer_id` (and any other obsolete columns) on `expenses` and `expense_splits` so adding transactions works reliably.
2. **Enforce Strict Super-Admin (`murph@murphnduff.org`):**
   - `murph@murphnduff.org` must see ALL groups in the database.
   - Non-admin accounts (like `murphmurphy@gmail.com`) or anonymous visitors must NEVER see "Create Group", "Delete Group", or "Manage Members".
3. **Deduplicate Members & Remove Confusing Email Check:**
   - Remove the email input from "Add Member" (we only need `display_name`).
   - Clean up duplicate member rows (e.g., duplicate "Andrew Murphy" in the same group) and prevent duplicate names within the same group.
4. **Implement `/g/[group_id]` Route & Zero-Login Member Selector:**
   - Create `/g/[group_id]` (or handle via shared view) so anyone with the link can open the group without logging in, tap their name ("Who are you?"), and add/edit/delete transactions.
   - Provide a 1-click **"Copy Group Link"** button (plus optional per-member link `/g/[group_id]?m=[member_id]` in Manage Members).

### Phase B: Next Features
5. **Full Group Historical Data Import & Export (JSON + CSV):** Support native JSON backups and legacy `ExpenseAppData.json` (`{ Users, Expenses }`) files.
6. **Custom Split Types:** Equal, Percentage (70/30), and Exact Dollar splits.