-- ====================================================================
-- Settle Up - Master Database Schema & RLS Security Migration
-- Aligned with PROJECT_CONTEXT.md (Sections 2 & 3)
-- Completely Idempotent (safe to run multiple times)
-- ====================================================================

-- Enable pgcrypto for UUID generation if not already active
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ====================================================================
-- 1. BASE TABLES DEFINITION & COLUMN MIGRATIONS
-- ====================================================================

-- 1.1 Groups table
CREATE TABLE IF NOT EXISTS public.groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 1.2 Group Members table (supports pre-created & claimable profiles)
CREATE TABLE IF NOT EXISTS public.group_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    display_name TEXT,
    invited_email TEXT,
    invite_token UUID UNIQUE DEFAULT gen_random_uuid(),
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Add missing columns to group_members if table already existed
DO $$
BEGIN
    -- user_id: allow NULL for pre-created members
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'group_members' AND column_name = 'user_id' AND is_nullable = 'NO'
    ) THEN
        ALTER TABLE public.group_members ALTER COLUMN user_id DROP NOT NULL;
    END IF;

    -- display_name
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'group_members' AND column_name = 'display_name'
    ) THEN
        ALTER TABLE public.group_members ADD COLUMN display_name TEXT;
    END IF;

    -- invited_email
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'group_members' AND column_name = 'invited_email'
    ) THEN
        ALTER TABLE public.group_members ADD COLUMN invited_email TEXT;
    END IF;

    -- invite_token
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'group_members' AND column_name = 'invite_token'
    ) THEN
        ALTER TABLE public.group_members ADD COLUMN invite_token UUID UNIQUE DEFAULT gen_random_uuid();
    END IF;

    -- role
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'group_members' AND column_name = 'role'
    ) THEN
        ALTER TABLE public.group_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
    END IF;
END $$;

-- Backfill display_name for existing members from profiles if available
UPDATE public.group_members gm
SET display_name = COALESCE(p.full_name, p.email, 'Member')
FROM public.profiles p
WHERE gm.user_id = p.id AND (gm.display_name IS NULL OR trim(gm.display_name) = '');

-- Fallback for any remaining NULL display_names
UPDATE public.group_members
SET display_name = 'Member'
WHERE display_name IS NULL OR trim(display_name) = '';

ALTER TABLE public.group_members ALTER COLUMN display_name SET NOT NULL;

-- Backfill invite_token for existing members if NULL
UPDATE public.group_members
SET invite_token = gen_random_uuid()
WHERE invite_token IS NULL;

ALTER TABLE public.group_members ALTER COLUMN invite_token SET NOT NULL;


-- 1.3 Expenses table (Future-Proofed for integer cents & member references)
CREATE TABLE IF NOT EXISTS public.expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense', 'payment')),
    description TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'EUR')),
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    paid_by_member_id UUID NOT NULL REFERENCES public.group_members(id) ON DELETE RESTRICT,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Add missing columns to expenses if table already existed
DO $$
BEGIN
    -- type
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'type'
    ) THEN
        ALTER TABLE public.expenses ADD COLUMN type TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('expense', 'payment'));
    END IF;

    -- currency
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'currency'
    ) THEN
        ALTER TABLE public.expenses ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
    END IF;

    -- amount_cents
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'amount_cents'
    ) THEN
        ALTER TABLE public.expenses ADD COLUMN amount_cents INTEGER;
        -- Backfill from legacy float/numeric 'amount' if present
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'amount'
        ) THEN
            UPDATE public.expenses 
            SET amount_cents = ROUND(amount * 100)::INTEGER 
            WHERE amount_cents IS NULL AND amount IS NOT NULL;
        END IF;
    END IF;

    -- paid_by_member_id
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'paid_by_member_id'
    ) THEN
        ALTER TABLE public.expenses ADD COLUMN paid_by_member_id UUID;

        -- Migrate legacy payer_id (which held auth.users.id or group_members.id)
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'payer_id'
        ) THEN
            -- First match where payer_id is already a group_members.id
            UPDATE public.expenses e
            SET paid_by_member_id = gm.id
            FROM public.group_members gm
            WHERE e.payer_id = gm.id AND e.paid_by_member_id IS NULL;

            -- Next match where payer_id is an auth.users.id
            UPDATE public.expenses e
            SET paid_by_member_id = gm.id
            FROM public.group_members gm
            WHERE e.payer_id = gm.user_id AND e.group_id = gm.group_id AND e.paid_by_member_id IS NULL;
        END IF;

        -- Add Foreign Key constraint with ON DELETE RESTRICT (Deletion Guard)
        ALTER TABLE public.expenses 
            ADD CONSTRAINT fk_expenses_paid_by_member 
            FOREIGN KEY (paid_by_member_id) 
            REFERENCES public.group_members(id) 
            ON DELETE RESTRICT;
    END IF;
END $$;


-- 1.4 Expense Splits table (Future-Proofed for exact integer cents per split)
CREATE TABLE IF NOT EXISTS public.expense_splits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
    member_id UUID NOT NULL REFERENCES public.group_members(id) ON DELETE RESTRICT,
    split_amount_cents INTEGER NOT NULL CHECK (split_amount_cents >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Add missing columns to expense_splits if table already existed
DO $$
BEGIN
    -- split_amount_cents
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expense_splits' AND column_name = 'split_amount_cents'
    ) THEN
        ALTER TABLE public.expense_splits ADD COLUMN split_amount_cents INTEGER;
        -- Backfill from legacy float/numeric 'amount' if present
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' AND table_name = 'expense_splits' AND column_name = 'amount'
        ) THEN
            UPDATE public.expense_splits 
            SET split_amount_cents = ROUND(amount * 100)::INTEGER 
            WHERE split_amount_cents IS NULL AND amount IS NOT NULL;
        END IF;
    END IF;

    -- member_id
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'expense_splits' AND column_name = 'member_id'
    ) THEN
        ALTER TABLE public.expense_splits ADD COLUMN member_id UUID;

        -- Migrate legacy user_id
        IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_schema = 'public' AND table_name = 'expense_splits' AND column_name = 'user_id'
        ) THEN
            -- First match where user_id is already a group_members.id
            UPDATE public.expense_splits es
            SET member_id = gm.id
            FROM public.group_members gm
            WHERE es.user_id = gm.id AND es.member_id IS NULL;

            -- Next match where user_id is an auth.users.id
            UPDATE public.expense_splits es
            SET member_id = gm.id
            FROM public.expenses e
            JOIN public.group_members gm ON e.group_id = gm.group_id
            WHERE es.expense_id = e.id AND es.user_id = gm.user_id AND es.member_id IS NULL;
        END IF;

        -- Add Foreign Key constraint with ON DELETE RESTRICT (Deletion Guard)
        ALTER TABLE public.expense_splits 
            ADD CONSTRAINT fk_splits_member 
            FOREIGN KEY (member_id) 
            REFERENCES public.group_members(id) 
            ON DELETE RESTRICT;
    END IF;
END $$;


-- ====================================================================
-- 2. HIGH-PERFORMANCE INDEXES
-- ====================================================================
CREATE INDEX IF NOT EXISTS idx_group_members_group_user ON public.group_members(group_id, user_id);
CREATE INDEX IF NOT EXISTS idx_group_members_invite_token ON public.group_members(invite_token);
CREATE INDEX IF NOT EXISTS idx_expenses_group_id ON public.expenses(group_id);
CREATE INDEX IF NOT EXISTS idx_expenses_paid_by_member ON public.expenses(paid_by_member_id);
CREATE INDEX IF NOT EXISTS idx_expense_splits_expense_id ON public.expense_splits(expense_id);
CREATE INDEX IF NOT EXISTS idx_expense_splits_member_id ON public.expense_splits(member_id);


-- ====================================================================
-- 3. SECURITY DEFINER FUNCTIONS (Recursion Barrier & Search Path Hardening)
-- ====================================================================

-- 3.1 Check if user is an active member of the group
CREATE OR REPLACE FUNCTION public.is_group_member(p_group_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members
    WHERE group_id = p_group_id
      AND user_id = p_user_id
  );
$$;

-- 3.2 Check if user is an admin of the group or the group creator
CREATE OR REPLACE FUNCTION public.is_group_admin(p_group_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members
    WHERE group_id = p_group_id
      AND user_id = p_user_id
      AND role = 'admin'
  )
  OR EXISTS (
    SELECT 1
    FROM public.groups
    WHERE id = p_group_id
      AND created_by = p_user_id
  );
$$;

-- 3.3 Atomic RPC function to claim an invite token link
-- Usage: supabase.rpc('claim_invite_token', { p_token: '...' })
CREATE OR REPLACE FUNCTION public.claim_invite_token(p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_member public.group_members%ROWTYPE;
  v_current_user_id UUID := auth.uid();
BEGIN
  IF v_current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required to claim invite token.';
  END IF;

  SELECT * INTO v_member
  FROM public.group_members
  WHERE invite_token = p_token
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invalid or expired invite token.';
  END IF;

  -- If this member is already bound to the caller, return success idempotently
  IF v_member.user_id = v_current_user_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'group_id', v_member.group_id,
      'member_id', v_member.id,
      'status', 'already_claimed'
    );
  END IF;

  -- If already bound to another user, block claiming
  IF v_member.user_id IS NOT NULL AND v_member.user_id <> v_current_user_id THEN
    RAISE EXCEPTION 'This invite link has already been claimed by another account.';
  END IF;

  -- Bind authenticated user to this member profile
  UPDATE public.group_members
  SET user_id = v_current_user_id
  WHERE id = v_member.id;

  RETURN jsonb_build_object(
    'success', true,
    'group_id', v_member.group_id,
    'member_id', v_member.id,
    'status', 'claimed'
  );
END;
$$;

-- 3.4 Rate-limit friendly user lookup by email for invite modal
CREATE OR REPLACE FUNCTION public.find_user_by_email(lookup_email TEXT)
RETURNS TABLE (id UUID, full_name TEXT, email TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
STABLE
AS $$
  SELECT p.id, p.full_name, p.email
  FROM public.profiles p
  WHERE lower(trim(p.email)) = lower(trim(lookup_email))
  LIMIT 1;
$$;

-- Grant execution to authenticated users
GRANT EXECUTE ON FUNCTION public.is_group_member(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_group_admin(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_invite_token(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.find_user_by_email(TEXT) TO authenticated;


-- ====================================================================
-- 4. ROW-LEVEL SECURITY (RLS) POLICIES
-- ====================================================================

-- --------------------------------------------------------------------
-- 4.1 GROUPS TABLE
-- --------------------------------------------------------------------
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view groups they created or belong to" ON public.groups;
CREATE POLICY "Users can view groups they created or belong to"
ON public.groups
FOR SELECT
TO authenticated
USING (
  created_by = auth.uid()
  OR public.is_group_member(id, auth.uid())
);

DROP POLICY IF EXISTS "Users can insert groups they create" ON public.groups;
CREATE POLICY "Users can insert groups they create"
ON public.groups
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = auth.uid()
);

DROP POLICY IF EXISTS "Group creators can update their groups" ON public.groups;
CREATE POLICY "Group creators can update their groups"
ON public.groups
FOR UPDATE
TO authenticated
USING (created_by = auth.uid() OR public.is_group_admin(id, auth.uid()))
WITH CHECK (created_by = auth.uid() OR public.is_group_admin(id, auth.uid()));

DROP POLICY IF EXISTS "Group creators can delete their groups" ON public.groups;
CREATE POLICY "Group creators can delete their groups"
ON public.groups
FOR DELETE
TO authenticated
USING (created_by = auth.uid());


-- --------------------------------------------------------------------
-- 4.2 GROUP_MEMBERS TABLE
-- --------------------------------------------------------------------
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

-- SELECT: Co-members can view all members in their shared groups
DROP POLICY IF EXISTS "Members can view co-members of their groups" ON public.group_members;
CREATE POLICY "Members can view co-members of their groups"
ON public.group_members
FOR SELECT
TO authenticated
USING (
  public.is_group_member(group_id, auth.uid())
  OR EXISTS (SELECT 1 FROM public.groups g WHERE g.id = group_id AND g.created_by = auth.uid())
  OR user_id = auth.uid()
);

-- INSERT: 
-- 1. Creator inserting their initial admin member row
-- 2. Admins adding pre-created or invited members
-- 3. Authenticated users self-joining via group link with role 'member'
DROP POLICY IF EXISTS "Allow controlled insert into group_members" ON public.group_members;
CREATE POLICY "Allow controlled insert into group_members"
ON public.group_members
FOR INSERT
TO authenticated
WITH CHECK (
  -- Scenario A: Group creator adding initial admin row for themselves
  (
    user_id = auth.uid() 
    AND role = 'admin' 
    AND EXISTS (SELECT 1 FROM public.groups g WHERE g.id = group_id AND g.created_by = auth.uid())
  )
  OR
  -- Scenario B: Group admin or creator adding pre-created or invited members
  (
    public.is_group_admin(group_id, auth.uid())
  )
  OR
  -- Scenario C: Self-joining via group link (must be role 'member')
  (
    user_id = auth.uid() 
    AND role = 'member'
  )
);

-- UPDATE:
-- 1. Admins can update roles or names
-- 2. Any member can rename their own display_name
-- 3. Authenticated user can claim an unclaimed member record matching an invite token
DROP POLICY IF EXISTS "Allow controlled update on group_members" ON public.group_members;
CREATE POLICY "Allow controlled update on group_members"
ON public.group_members
FOR UPDATE
TO authenticated
USING (
  public.is_group_admin(group_id, auth.uid())
  OR user_id = auth.uid()
  OR (user_id IS NULL AND invite_token IS NOT NULL)
)
WITH CHECK (
  public.is_group_admin(group_id, auth.uid())
  OR (user_id = auth.uid())
  OR (user_id = auth.uid() AND role = 'member')
);

-- DELETE:
-- Admins or members themselves can remove membership ONLY IF they have 0 transactions (Section 2 Deletion Guard)
DROP POLICY IF EXISTS "Admins or members themselves can delete membership" ON public.group_members;
CREATE POLICY "Admins or members themselves can delete membership"
ON public.group_members
FOR DELETE
TO authenticated
USING (
  (
    user_id = auth.uid() 
    OR public.is_group_admin(group_id, auth.uid())
    OR EXISTS (SELECT 1 FROM public.groups g WHERE g.id = group_id AND g.created_by = auth.uid())
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.expenses e WHERE e.paid_by_member_id = group_members.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.expense_splits es WHERE es.member_id = group_members.id
  )
);


-- --------------------------------------------------------------------
-- 4.3 PROFILES TABLE
-- --------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile and shared group members" ON public.profiles;
CREATE POLICY "Users can view own profile and shared group members"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.group_members gm1
    JOIN public.group_members gm2 ON gm1.group_id = gm2.group_id
    WHERE gm1.user_id = auth.uid() AND gm2.user_id = profiles.id
  )
);

DROP POLICY IF EXISTS "Users can update their own profile" ON public.profiles;
CREATE POLICY "Users can update their own profile"
ON public.profiles
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());


-- --------------------------------------------------------------------
-- 4.4 EXPENSES TABLE (Group-Wide Transaction Management)
-- Section 3: Any member can create, edit, or delete any transaction in the group
-- --------------------------------------------------------------------
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view expenses in their groups" ON public.expenses;
CREATE POLICY "Members can view expenses in their groups"
ON public.expenses
FOR SELECT
TO authenticated
USING (public.is_group_member(group_id, auth.uid()));

DROP POLICY IF EXISTS "Members can insert expenses in their groups" ON public.expenses;
CREATE POLICY "Members can insert expenses in their groups"
ON public.expenses
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = auth.uid()
  AND public.is_group_member(group_id, auth.uid())
);

DROP POLICY IF EXISTS "Members can update expenses in their groups" ON public.expenses;
CREATE POLICY "Members can update expenses in their groups"
ON public.expenses
FOR UPDATE
TO authenticated
USING (public.is_group_member(group_id, auth.uid()))
WITH CHECK (public.is_group_member(group_id, auth.uid()));

DROP POLICY IF EXISTS "Members can delete expenses in their groups" ON public.expenses;
CREATE POLICY "Members can delete expenses in their groups"
ON public.expenses
FOR DELETE
TO authenticated
USING (public.is_group_member(group_id, auth.uid()));


-- --------------------------------------------------------------------
-- 4.5 EXPENSE_SPLITS TABLE
-- --------------------------------------------------------------------
ALTER TABLE public.expense_splits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view splits for their group expenses" ON public.expense_splits;
CREATE POLICY "Members can view splits for their group expenses"
ON public.expense_splits
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.expenses e
    WHERE e.id = expense_splits.expense_id
      AND public.is_group_member(e.group_id, auth.uid())
  )
);

DROP POLICY IF EXISTS "Members can insert splits for their group expenses" ON public.expense_splits;
CREATE POLICY "Members can insert splits for their group expenses"
ON public.expense_splits
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.expenses e
    WHERE e.id = expense_splits.expense_id
      AND public.is_group_member(e.group_id, auth.uid())
  )
);

DROP POLICY IF EXISTS "Members can update splits for their group expenses" ON public.expense_splits;
CREATE POLICY "Members can update splits for their group expenses"
ON public.expense_splits
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.expenses e
    WHERE e.id = expense_splits.expense_id
      AND public.is_group_member(e.group_id, auth.uid())
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.expenses e
    WHERE e.id = expense_splits.expense_id
      AND public.is_group_member(e.group_id, auth.uid())
  )
);

DROP POLICY IF EXISTS "Members can delete splits for their group expenses" ON public.expense_splits;
CREATE POLICY "Members can delete splits for their group expenses"
ON public.expense_splits
FOR DELETE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.expenses e
    WHERE e.id = expense_splits.expense_id
      AND public.is_group_member(e.group_id, auth.uid())
  )
);

