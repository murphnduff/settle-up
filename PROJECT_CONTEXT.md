# Settle Up - Master Architecture, Requirements & Test Spec

## 1. Tech Stack & Workflow
- **Stack:** Next.js (App Router, TypeScript, Tailwind CSS), Supabase (PostgreSQL, Google OAuth, RLS), Vercel (`https://split.murphnduff.org`).
- **Deployment:** Local edits pushed via PowerShell `sync "commit message"` macro.

## 2. Core Data Model & RLS Rules
- **RLS Recursion Safeguard:** Always use the `SECURITY DEFINER` function `public.is_group_member(p_group_id UUID, p_user_id UUID)` in RLS policies to avoid infinite recursion between `groups` and `group_members`.
- **Group Members (`group_members` table):**
  - Columns: `id` (UUID, PK), `group_id` (UUID, FK), `user_id` (UUID, Nullable FK to `auth.users`), `display_name` (TEXT, required), `invited_email` (TEXT, nullable), `invite_token` (UUID, unique default `gen_random_uuid()`), `role` (TEXT, `'admin'` or `'member'`).
  - **Pre-created / Claimable Profiles:** Admins add members by specifying `display_name` and optional `invited_email`. `user_id` starts as `NULL` so members can immediately be included in expenses/payments before signing up.
  - **Unique Invite Link per Member:** Each member row gets a unique `invite_token` (`https://split.murphnduff.org/join?token=<invite_token>`). When clicked by an authenticated user, it binds their `auth.uid()` to that `group_members` row while keeping the Admin-assigned `display_name`.
  - **Deletion Guard:** A member CANNOT be deleted if they are referenced as a payer or participant in any transaction in that group.
- **Transactions (`expenses` & `expense_splits` tables - Future-Proofed):**
  - `expenses`: `id` (UUID, PK), `group_id` (UUID, FK), `type` (`'expense'` | `'payment'`), `description` (TEXT), `amount_cents` (INTEGER, strictly > 0), `currency` (`'USD'` | `'EUR'`, default `'USD'`), `date` (DATE), `paid_by_member_id` (UUID, FK to `group_members.id`), `created_by` (UUID, FK to `auth.users`).
  - `expense_splits`: `id` (UUID, PK), `expense_id` (UUID, FK CASCADE), `member_id` (UUID, FK to `group_members.id`), `split_amount_cents` (INTEGER).
  - *Note:* Foreign keys for payers and splits reference `group_members.id` (NOT `auth.users.id`) so unclaimed members work seamlessly!
  - *Future-Proofing:* Storing exact `split_amount_cents` per row supports equal splits now (with penny-remainder distribution) and custom 70/30 or exact-amount splits later without schema changes.

## 3. Permissions & Roles
- **Group Admin (Creator):** Can create/delete groups, add/remove members (if member has 0 transactions), generate/copy individual member invite links, and rename any member.
- **All Group Members (Admin & Regular):**
  - Can rename their own `display_name`.
  - Can create, edit, or delete **any** transaction (`expense` or `payment`) within their group, including logging transactions on behalf of other members.
  - `created_by` is recorded for audit purposes only and does not restrict editing/deleting by other members of the same group.
- **Transaction Rules:**
  - `expense`: Split among 1 or more selected group members.
  - `payment`: Strictly 1-to-1 (1 Payer `paid_by_member_id` to 1 Recipient in `expense_splits`). Visually distinct in the UI ledger (e.g., soft red `#FFC4C4` for expenses, soft blue `#BDE0FF` for payments).

## 4. Math Engine & Required Test Suite (`src/lib/reconciliation.test.ts`)
All math must operate on integers (`amount_cents`) and run isolated per currency (`USD` vs `EUR`).
1. **The Indivisible Penny Edge Case ($100.00 / 3):**
   - Splitting `10000` cents among 3 members must allocate `3334`, `3333`, `3333` cents so `SUM(split_amount_cents) === amount_cents` (10000). Never lose or invent a penny.
2. **Transitive Debt Simplification (A -> B -> C):**
   - Murph pays $30 for Kev; Kev pays $30 for Fitz. Net balances: Murph +$30, Kev $0, Fitz -$30. Output: 1 transaction (`Fitz pays Murph $30.00`).
3. **1-to-1 Payment Offset:**
   - If Fitz owes Murph $30.00, and records a `payment` of $10.00 from Fitz to Murph, the updated settlement plan must output `Fitz pays Murph $20.00`.
4. **Partial & Subset Splits:**
   - Group has Murph, Kev, Fitz. Murph pays $40 for just Murph & Kev. Fitz's balance must remain $0.00; Kev owes Murph $20.00.
5. **Multi-Currency Isolation:**
   - Murph pays $60 USD (split all 3) and Kev pays €30 EUR (split all 3). USD and EUR must never cross-cancel; output separate USD and EUR settlement instructions.
6. **Member Deletion Guard:**
   - Attempting to delete a member who is a payer or split participant must fail/block cleanly; deleting a member with 0 transactions succeeds.
7. **Transaction Mutation Recalculation:**
   - Editing an existing expense's amount, payer, or split participants (or deleting it) immediately recalculates the net balances without ghost data.