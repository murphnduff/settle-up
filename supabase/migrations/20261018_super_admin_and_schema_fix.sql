-- ====================================================================
-- Settle Up - Phase A Migration: High-Trust Group URL + Single Super-Admin
-- Aligned with PROJECT_CONTEXT.md (Sections 2, 3, and 5)
-- Completely Idempotent (safe to run multiple times in Supabase SQL Editor)
-- ====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ====================================================================
-- 1. DROP ALL EXISTING RLS POLICIES FIRST (Removes dependencies on legacy columns)
-- ====================================================================
DO $$
DECLARE
    pol RECORD;
BEGIN
    FOR pol IN 
        SELECT schemaname, tablename, policyname 
        FROM pg_policies 
        WHERE schemaname = 'public' 
          AND tablename IN ('groups', 'group_members', 'expenses', 'expense_splits', 'profiles')
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', pol.policyname, pol.schemaname, pol.tablename);
    END LOOP;
END $$;

-- Drop obsolete helper functions if present
DROP FUNCTION IF EXISTS public.claim_invite_token(UUID);
DROP FUNCTION IF EXISTS public.find_user_by_email(TEXT);
DROP FUNCTION IF EXISTS public.is_group_member(UUID, UUID);
DROP FUNCTION IF EXISTS public.is_group_creator(UUID, UUID);
DROP FUNCTION IF EXISTS public.is_group_admin(UUID, UUID);


-- ====================================================================
-- 2. CLEAN UP LEGACY COLUMNS & FIX NOT-NULL CONSTRAINT CRASHES
-- ====================================================================

-- 2.1 Ensure core tables exist
CREATE TABLE IF NOT EXISTS public.groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense', 'payment')),
    description TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'EUR')),
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    paid_by_member_id UUID NOT NULL REFERENCES public.group_members(id) ON DELETE RESTRICT,
    created_by_member_id UUID REFERENCES public.group_members(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE TABLE IF NOT EXISTS public.expense_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES public.group_members(id) ON DELETE RESTRICT,
    split_amount_cents INTEGER NOT NULL CHECK (split_amount_cents >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2.2 Migrate any remaining data before dropping legacy columns on expenses & expense_splits
DO $$
BEGIN
    -- Ensure created_by_member_id exists on expenses
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'created_by_member_id'
    ) THEN
        ALTER TABLE public.expenses ADD COLUMN created_by_member_id UUID REFERENCES public.group_members(id) ON DELETE SET NULL;
    END IF;

    -- Backfill amount_cents from legacy amount if needed
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'amount'
    ) THEN
        UPDATE public.expenses
        SET amount_cents = GREATEST(1, ROUND(amount * 100)::INTEGER)
        WHERE amount_cents IS NULL AND amount IS NOT NULL;
    END IF;

    -- Backfill paid_by_member_id from legacy payer_id if needed
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'payer_id'
    ) THEN
        UPDATE public.expenses e
        SET paid_by_member_id = gm.id
        FROM public.group_members gm
        WHERE e.paid_by_member_id IS NULL AND e.payer_id = gm.id;

        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' AND table_name = 'group_members' AND column_name = 'user_id'
        ) THEN
            UPDATE public.expenses e
            SET paid_by_member_id = gm.id
            FROM public.group_members gm
            WHERE e.paid_by_member_id IS NULL AND e.payer_id = gm.user_id AND e.group_id = gm.group_id;
        END IF;
    END IF;

    -- Backfill split_amount_cents from legacy amount on expense_splits if needed
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expense_splits' AND column_name = 'amount'
    ) THEN
        UPDATE public.expense_splits
        SET split_amount_cents = GREATEST(0, ROUND(amount * 100)::INTEGER)
        WHERE split_amount_cents IS NULL AND amount IS NOT NULL;
    END IF;

    -- Backfill member_id from legacy user_id on expense_splits if needed
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expense_splits' AND column_name = 'user_id'
    ) THEN
        UPDATE public.expense_splits es
        SET member_id = gm.id
        FROM public.group_members gm
        WHERE es.member_id IS NULL AND es.user_id = gm.id;

        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' AND table_name = 'group_members' AND column_name = 'user_id'
        ) THEN
            UPDATE public.expense_splits es
            SET member_id = gm.id
            FROM public.expenses e
            JOIN public.group_members gm ON e.group_id = gm.group_id
            WHERE es.member_id IS NULL AND es.expense_id = e.id AND es.user_id = gm.user_id;
        END IF;
    END IF;
END $$;

-- 2.3 Drop legacy columns that cause NOT NULL constraint violations
ALTER TABLE public.expenses DROP COLUMN IF EXISTS payer_id CASCADE;
ALTER TABLE public.expenses DROP COLUMN IF EXISTS paid_by CASCADE;
ALTER TABLE public.expenses DROP COLUMN IF EXISTS user_id CASCADE;
ALTER TABLE public.expenses DROP COLUMN IF EXISTS amount CASCADE;
ALTER TABLE public.expenses DROP COLUMN IF EXISTS created_by CASCADE;

ALTER TABLE public.expense_splits DROP COLUMN IF EXISTS user_id CASCADE;
ALTER TABLE public.expense_splits DROP COLUMN IF EXISTS amount CASCADE;

ALTER TABLE public.group_members DROP COLUMN IF EXISTS user_id CASCADE;
ALTER TABLE public.group_members DROP COLUMN IF EXISTS invited_email CASCADE;
ALTER TABLE public.group_members DROP COLUMN IF EXISTS invite_token CASCADE;
ALTER TABLE public.group_members DROP COLUMN IF EXISTS role CASCADE;


-- ====================================================================
-- 3. DEDUPLICATE GROUP_MEMBERS & ENFORCE CASE-INSENSITIVE UNIQUENESS
-- ====================================================================

-- Trim whitespace and ensure non-empty display_name
UPDATE public.group_members
SET display_name = trim(COALESCE(display_name, 'Member'))
WHERE display_name IS NULL OR display_name <> trim(display_name) OR trim(display_name) = '';

ALTER TABLE public.group_members ALTER COLUMN display_name SET NOT NULL;

-- Safely merge duplicate (group_id, lower(display_name)) rows, preserving references
DO $$
DECLARE
    dup_group RECORD;
    keeper_id UUID;
    dup_row RECORD;
BEGIN
    FOR dup_group IN
        SELECT group_id, lower(display_name) AS norm_name
        FROM public.group_members
        GROUP BY group_id, lower(display_name)
        HAVING COUNT(*) > 1
    LOOP
        -- Pick the best canonical member row to keep (preferring rows referenced by transactions, then earliest created)
        SELECT gm.id INTO keeper_id
        FROM public.group_members gm
        WHERE gm.group_id = dup_group.group_id
          AND lower(gm.display_name) = dup_group.norm_name
        ORDER BY
          (
            EXISTS (SELECT 1 FROM public.expenses e WHERE e.paid_by_member_id = gm.id)
            OR EXISTS (SELECT 1 FROM public.expense_splits es WHERE es.member_id = gm.id)
          ) DESC,
          gm.created_at ASC NULLS LAST,
          gm.id ASC
        LIMIT 1;

        -- Re-point any transactions from duplicate rows to keeper_id, then delete the duplicate row
        FOR dup_row IN
            SELECT id
            FROM public.group_members
            WHERE group_id = dup_group.group_id
              AND lower(display_name) = dup_group.norm_name
              AND id <> keeper_id
        LOOP
            UPDATE public.expenses
            SET paid_by_member_id = keeper_id
            WHERE paid_by_member_id = dup_row.id;

            UPDATE public.expenses
            SET created_by_member_id = keeper_id
            WHERE created_by_member_id = dup_row.id;

            UPDATE public.expense_splits
            SET member_id = keeper_id
            WHERE member_id = dup_row.id;

            DELETE FROM public.group_members
            WHERE id = dup_row.id;
        END LOOP;
    END LOOP;
END $$;

-- Add case-insensitive unique index on (group_id, lower(display_name))
CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_unique_lower_name
ON public.group_members (group_id, lower(display_name));

-- Ensure ON DELETE RESTRICT foreign keys exist for Deletion Guard
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'fk_expenses_paid_by_member'
    ) THEN
        ALTER TABLE public.expenses
            ADD CONSTRAINT fk_expenses_paid_by_member
            FOREIGN KEY (paid_by_member_id)
            REFERENCES public.group_members(id)
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'fk_splits_member'
    ) THEN
        ALTER TABLE public.expense_splits
            ADD CONSTRAINT fk_splits_member
            FOREIGN KEY (member_id)
            REFERENCES public.group_members(id)
            ON DELETE RESTRICT;
    END IF;
END $$;

-- High-performance indexes
CREATE INDEX IF NOT EXISTS idx_group_members_group_id ON public.group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_expenses_group_id ON public.expenses(group_id);
CREATE INDEX IF NOT EXISTS idx_expenses_paid_by_member ON public.expenses(paid_by_member_id);
CREATE INDEX IF NOT EXISTS idx_expense_splits_expense_id ON public.expense_splits(expense_id);
CREATE INDEX IF NOT EXISTS idx_expense_splits_member_id ON public.expense_splits(member_id);


-- ====================================================================
-- 4. SINGLE SUPER-ADMIN HELPER FUNCTION (murph@murphnduff.org)
-- ====================================================================

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN lower(coalesce(auth.jwt() ->> 'email', '')) = 'murph@murphnduff.org';
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO anon, authenticated;


-- ====================================================================
-- 5. TABLE GRANTS & SIMPLIFIED RLS POLICIES (Section 2.3)
-- ====================================================================

-- Ensure anon and authenticated have table-level privileges so RLS governs access
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON public.groups TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.groups TO authenticated;

GRANT SELECT, UPDATE ON public.group_members TO anon, authenticated;
GRANT INSERT, DELETE ON public.group_members TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.expenses TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_splits TO anon, authenticated;

-- --------------------------------------------------------------------
-- 5.1 GROUPS POLICIES
-- --------------------------------------------------------------------
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "groups_select_all"
ON public.groups
FOR SELECT
TO anon, authenticated
USING (true);

CREATE POLICY "groups_insert_super_admin"
ON public.groups
FOR INSERT
TO authenticated
WITH CHECK (public.is_super_admin());

CREATE POLICY "groups_update_super_admin"
ON public.groups
FOR UPDATE
TO authenticated
USING (public.is_super_admin())
WITH CHECK (public.is_super_admin());

CREATE POLICY "groups_delete_super_admin"
ON public.groups
FOR DELETE
TO authenticated
USING (public.is_super_admin());


-- --------------------------------------------------------------------
-- 5.2 GROUP_MEMBERS POLICIES
-- --------------------------------------------------------------------
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "group_members_select_all"
ON public.group_members
FOR SELECT
TO anon, authenticated
USING (true);

CREATE POLICY "group_members_update_all"
ON public.group_members
FOR UPDATE
TO anon, authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "group_members_insert_super_admin"
ON public.group_members
FOR INSERT
TO authenticated
WITH CHECK (public.is_super_admin());

CREATE POLICY "group_members_delete_super_admin"
ON public.group_members
FOR DELETE
TO authenticated
USING (
  public.is_super_admin()
  AND NOT EXISTS (
    SELECT 1 FROM public.expenses e WHERE e.paid_by_member_id = group_members.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.expense_splits es WHERE es.member_id = group_members.id
  )
);


-- --------------------------------------------------------------------
-- 5.3 EXPENSES POLICIES
-- --------------------------------------------------------------------
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "expenses_select_all"
ON public.expenses
FOR SELECT
TO anon, authenticated
USING (true);

CREATE POLICY "expenses_insert_all"
ON public.expenses
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

CREATE POLICY "expenses_update_all"
ON public.expenses
FOR UPDATE
TO anon, authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "expenses_delete_all"
ON public.expenses
FOR DELETE
TO anon, authenticated
USING (true);


-- --------------------------------------------------------------------
-- 5.4 EXPENSE_SPLITS POLICIES
-- --------------------------------------------------------------------
ALTER TABLE public.expense_splits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "expense_splits_select_all"
ON public.expense_splits
FOR SELECT
TO anon, authenticated
USING (true);

CREATE POLICY "expense_splits_insert_all"
ON public.expense_splits
FOR INSERT
TO anon, authenticated
WITH CHECK (true);

CREATE POLICY "expense_splits_update_all"
ON public.expense_splits
FOR UPDATE
TO anon, authenticated
USING (true)
WITH CHECK (true);

CREATE POLICY "expense_splits_delete_all"
ON public.expense_splits
FOR DELETE
TO anon, authenticated
USING (true);

