# Settle Up - Architecture & Context

## 1. Stack & Infrastructure
- Next.js 14+ (App Router, TypeScript, Tailwind CSS).
- Supabase (PostgreSQL, Auth via Google OAuth, Row-Level Security).
- Deployed on Vercel at `https://split.murphnduff.org` (Squarespace DNS CNAME).
- Windows PowerShell local workflow; deployment via `sync "[message]"` git macro.

## 2. Business Logic Rules
- Reconciliation: Greedy cash-flow minimization pairing largest debtor with largest creditor.
- Financial Precision: Amounts must be stored/calculated strictly as integers (cents) or exact decimals—never floating-point.
- Multi-Currency: Strictly isolate USD ($) and EUR (€) ledgers.

## 3. Database & RLS Safeguards
- Security Definer Function: Must use `public.is_group_member(p_group_id UUID, p_user_id UUID)` to prevent circular infinite recursion between `groups` and `group_members`.
- Policies:
  - `groups`: Creator can SELECT, INSERT, DELETE. Members can SELECT via `is_group_member()`.
  - `group_members`: Users can SELECT group members for groups they belong to or created; users can INSERT their own admin membership on group creation or member role upon accepting an invite link; existing group members/creators can INSERT new members via `is_group_member()`.
  - `profiles`: Authenticated users can SELECT profiles by email to look up members when inviting.

## 4. Current State
- Working:
  - Google OAuth authentication & session listener.
  - Multi-group sidebar listing, group creation with automatic admin membership, and group deletion.
  - Group member invitation modal (`src/components/MemberInviteModal.tsx`):
    - Search & add registered members directly by email.
    - Shareable join link (`/?join=[groupId]`) with one-click clipboard copy.
    - Automatic invite detection on sign-in and join flow.
    - Current group members listing with avatar initials, email, and admin/member role badges.
    - Native accessible modal dialog with backdrop light-dismiss and keyboard escape support.
  - Basic transaction addition and greedy settlement minimization.
- In Progress / Next Immediate Tasks:
  - Multi-currency transaction entry (currency tab toggles, explicit USD vs EUR ledgers).
  - Unequal/custom splits and multi-payer transaction support.
  - Real-time/live settlement output updates (Supabase Realtime subscriptions).
