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
  - `group_members`: Users can SELECT group members for groups they belong to or created; users can INSERT their own admin membership on group creation.

## 4. Current State
- Working: Auth, multi-group sidebar listing, group creation/deletion with accessible contrast.
- In Progress: Group member invitation modal, multi-currency transaction entry, live settlement output.

