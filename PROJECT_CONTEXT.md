# Settle Up - Master Architecture, Requirements & Test Spec (v1.0 Production)

## 1. Tech Stack & Infrastructure
- **Frontend / Fullstack:** Next.js 16 (App Router, React 19, TypeScript, Tailwind CSS, Lucide Icons) — fully responsive across Desktop, Tablet, and Mobile.
- **Backend / Database:** Supabase (PostgreSQL 15+, Google OAuth for Super-Admin only, Row-Level Security).
- **Keep-Alive Heartbeat:** Next.js API route (`/api/heartbeat`) + `vercel.json` cron job executing a lightweight query (`SELECT id FROM groups LIMIT 1`) every 5 days to prevent Supabase Free Tier 7-day inactivity pausing.
- **Testing & Tooling:** Node 24 built-in test runner (`node --experimental-strip-types --test`), ESLint 9.
- **Hosting & Production:** Vercel (`https://split.murphnduff.org`).
- **Deployment Workflow:** Local commits pushed via PowerShell `sync "commit message"` macro.

---

## 2. Security, Privacy & High-Trust Data Model

### 2.1 Philosophy: Clean Root Slugs + Single Global Super-Admin
- **Single Global Super-Admin (`murph@murphnduff.org`):**
  - Admin rights are verified strictly by `user?.email?.toLowerCase() === 'murph@murphnduff.org'` (client) and `lower(auth.jwt() ->> 'email') = 'murph@murphnduff.org'` via the `public.is_super_admin()` database helper.
  - Only `murph@murphnduff.org` can see the master group list, create groups, delete groups, manage members, or import CSV data.
  - Admin is not required to be a participant in created groups (e.g. creating a group for others; "Add me as a member" checkbox defaults to `true`).
- **Regular Users (Zero Sign-In & Root-Level Friendly URLs):**
  - Access any group directly via root slug: `https://split.murphnduff.org/[slug]` (or `?m=<display_name>`).
  - No OAuth login required for visitors.
  - "Who Are You?" pill selection saves `active_member_id` and adds the group to `localStorage` (`recent_groups`), updating the URL to `?m=<name>` via `window.history.replaceState` for cross-device recognition.
- **Stealth Root & Anti-Indexing Shield:**
  - Visiting root `/` unauthenticated with no local groups renders a minimal "Private Portal" sign-in card with zero descriptive copy.
  - `src/app/robots.ts` blocks all user agents and AI crawlers (`Googlebot`, `Google-Extended`, `GPTBot`, `CCBot`, etc.).
  - Global `noindex, nofollow, noarchive, nosnippet` metadata in `src/app/layout.tsx` and `X-Robots-Tag` HTTP headers in `next.config.ts`.

### 2.2 Database Tables & Schema
- **`groups`**: `id` (UUID PK), `name` (TEXT), `slug` (TEXT UNIQUE), `created_by` (UUID FK Nullable), `is_archived` (BOOLEAN DEFAULT false), `currencies` (TEXT[] DEFAULT `ARRAY['USD']`), `default_currency` (TEXT DEFAULT `'USD'`), `exchange_rates` (JSONB DEFAULT `'{}'`), `created_at` (TIMESTAMPTZ).
- **`group_members`**: `id` (UUID PK), `group_id` (UUID FK CASCADE), `display_name` (TEXT NOT NULL), `created_at` (TIMESTAMPTZ). Unique constraint on `(group_id, lower(display_name))`.
- **`expenses`**: `id` (UUID PK), `group_id` (UUID FK CASCADE), `type` (`'expense'` | `'payment'`), `description` (TEXT), `category` (TEXT NOT NULL DEFAULT `'General'`), `receipt_url` (TEXT NULLABLE), `amount_cents` (INTEGER > 0), `currency` (TEXT — any 3-letter ISO currency code such as `'USD'`, `'EUR'`, `'AUD'`, `'THB'`, `'GBP'`, `'CAD'`, `'JPY'`, `'NZD'`, `'CHF'`, `'MXN'`), `date` (DATE NOT NULL), `paid_by_member_id` (UUID FK), `created_at` (TIMESTAMPTZ).
- **`expense_splits`**: `id` (UUID PK), `expense_id` (UUID FK CASCADE), `member_id` (UUID FK), `split_amount_cents` (INTEGER >= 0), `created_at` (TIMESTAMPTZ).

---

## 3. Core Math Engine & Reconciliation Rules (`src/lib/reconciliation.ts` & `src/lib/currencies.ts`)

### 3.1 Strict Integer-Cent Arithmetic, Isolated Ledgers & Unified Cross-Currency Reconciliation
- All financial math is computed in integer cents to prevent floating-point drift.
- **Per-Currency Isolated Mode (Default):** Each currency enabled on a group (`USD`, `AUD`, `THB`, `EUR`, etc.) calculates and settles independently.
- **Cross-Currency Unified Reconciliation (`calculateUnifiedReconciliation`):** When a group has 2+ currencies, users can toggle **🌐 Unified Settlement (Convert All)** to convert each member's Paid, Accrued Share, and Net Balance into any selected target currency using live exchange rates (`https://open.er-api.com/v6/latest/${targetCurrency}`) or custom overrides stored in `groups.exchange_rates`. Any 1-cent rounding remainder is resolved deterministically on the member with the largest absolute balance so $\sum \text{netBalanceCents} = 0$, outputting a single unified Settlement Plan (with secondary currency equivalents).

### 3.2 Net Balance Calculation
For each user $u$ and currency $c$:
$$\text{Net Balance}(u) = \sum \text{Paid Expenses}(u) - \sum \text{Split Shares}(u) + \sum \text{Direct Payments Made}(u) - \sum \text{Direct Payments Received}(u)$$

### 3.3 Overpayment & Balance Inversion Handling (Critical)
- Direct settlement transfers (`type === 'payment'`) must **never clamp or cap at $0.00**.
- If Kevin owes Murph $20.00 ($\text{Kevin} = -2000\text{c}, \text{Murph} = +2000\text{c}$) and Kevin sends a payment of $22.00 ($2200\text{c}$) to Murph:
  - Kevin's balance becomes: $-2000 + 2200 = +200\text{c}$ ($+\$2.00$, now a Creditor).
  - Murph's balance becomes: $+2000 - 2200 = -200\text{c}$ ($-\$2.00$, now a Debtor).
  - The Greedy Cash-Flow Settlement Plan must evaluate Murph as the debtor and Kevin as the creditor, generating: **"Murph pays Kevin : $2.00"**.
- This scenario is codified as an explicit unit test in `src/lib/reconciliation.test.ts`.

### 3.4 Metric Aggregation: "Spent" Running Total
- The running `USD Spent` and `EUR Spent` totals on the group dashboard strictly sum entries where `type === 'expense'`.
- Direct settlement payments (`type === 'payment'`) are balance-clearing transfers, not consumption, and are strictly excluded from the "Spent" metric.

### 3.5 Cash-Flow Minimization (Greedy Algorithm)
1. Filter out all zero-balance members ($|\text{balance}| = 0$).
2. Split remaining members into **Debtors** ($\text{balance} < 0$) and **Creditors** ($\text{balance} > 0$).
3. Sort both lists descending by absolute amount.
4. Greedily match largest debtor to largest creditor for $\min(|\text{Debtor}|, \text{Creditor})$, decrementing balances until all debts clear.

---

## 4. Features & UX Specifications

### 4.1 Split Modes (Group Expenses)
- **`Equal`**: Evenly divides total among selected participants with remainder cents distributed deterministically.
- **`% Percentage`**: Numeric inputs per member validating to $100\%$ with integer-cent rounding.
- **`$ Exact`**: Inline dollar/euro input per member. The top-level `Amount` field automatically updates in real time to match the exact sum of member inputs, preventing double-entry.

### 4.2 Unified CSV Import & Export (Splitwise-Compatible)
- **Format:** `Date,Description,Category,Cost,Currency,<Member 1>,<Member 2>,...`
- **Payer identification:** Member column with positive value (`val > 0`).
- **Split allocations:** Member columns with negative values (`val < 0`) indicate owed split amounts. Payer's own share $= \text{Cost} - \text{val}$.
- **Summary footer:** Ignores and generates trailing blank line + `<Date>,Total balance, , ,<Currency>,<Net 1>,...`.
- **High-Speed Bulk Insert:** Import pre-generates client UUIDs and commits all members, expenses, and splits in three batched Supabase calls (< 0.5s).

### 4.3 Cumulative Member Breakdown (`calculateMemberBreakdown`)
- Displays a per-currency **Member Summary** table on the group dashboard with three columns:
  - **Paid (Out-of-Pocket):** Sum of `amount_cents` for `type === 'expense'` paid by the member (strictly excluding `type === 'payment'`).
  - **Share (Accrued Cost):** Sum of `split_amount_cents` for `type === 'expense'` allocated to the member (strictly excluding `type === 'payment'`).
  - **Net Balance:** Current net balance (including both expenses and direct settlement payments), color-coded green (`+$` owed to them), red (`-$` they owe), or gray (`$0.00` settled).

### 4.4 Group Archiving ("Retire Group" + Read-Only Lock)
- Uses `is_archived BOOLEAN NOT NULL DEFAULT false` on `public.groups`.
- **Sidebar Organization:** Active groups appear at the top; archived groups are organized in a collapsible `Archived (N)` section at the bottom.
- **Super-Admin Toggle:** `Archive Group` / `Unarchive Group` button in the group header toolbar.
- **Read-Only Lock:** When `activeGroup.is_archived === true`, displays an `"Archived — Read-Only"` badge and banner, hides the "Add Transaction" form, and disables editing/deleting transactions or members while keeping `Export CSV` and `Copy Group Link` active.

### 4.5 Expense Categorization & Spend Breakdown (`calculateCategorySpend` & `buildGroupCategories`)
- **Preset Categories (`EXPENSE_CATEGORIES`):** `['General', 'Dining out', 'Groceries', 'Drinks', 'Lodging', 'Flights', 'Car Rental', 'Gas', 'Activities']`.
- **Dynamic Per-Group Categories (`buildGroupCategories`):** Combines the 9 preset categories with any unique custom `expense.category` values already present in the active group's `expenses` (excluding `'Payment'`). Any custom category added to a transaction or imported via CSV automatically becomes a 1-click pill option for all future transactions in that group.
- **Inline `+ Custom...` Input:** Both the main **Add Transaction** form and `EditExpenseModal` include a `+ Custom...` pill button that reveals an inline text input for on-the-fly custom categories (e.g. `'Golf'`, `'Ski Passes'`, `'Tolls'`). Direct Payments hide the category selector and automatically store `'Payment'`.
- **Spend by Category Breakdown:** Aggregates `amount_cents` grouped by `category` per currency strictly for `type === 'expense'` (excluding payments), sorted descending by spend with formatted totals, percentage of group spend, and progress bars.
- **Lossless CSV Mapping:** Maps `expenses.category` directly to/from the 3rd CSV column (`Category`).

### 4.6 Receipt Attachments & AI Receipt Extraction (`src/lib/receipts.ts` & `/api/parse-receipt`)
- **Explicit Mobile & Desktop Capture Inputs:**
  - Provides three side-by-side buttons in Add/Edit Transaction forms: **📷 Take Photo** (`accept="image/*" capture="environment"`), **🖼️ Photo Library** (`accept="image/*"` without `capture` so Android/iOS open the native photo gallery), and **📄 PDF** (`accept="application/pdf"`).
- **Client-Side Compression & Storage (`src/lib/receipts.ts`):**
  - Resizes receipt images (`image/jpeg`, `image/png`, `image/webp`, HEIC/Ultra-HDR JPEG) larger than `1600px` down to `1600px` max dimension at JPEG quality `0.80` via HTML5 `<canvas>` (with raw base64 fallback if canvas decoding fails, and passing PDFs through as-is).
  - Uploads receipts to the Supabase Storage `'receipts'` bucket at `${groupId}/${crypto.randomUUID()}.${ext}` and persists the public URL in `expenses.receipt_url`.
- **AI Receipt Extraction Route (`src/app/api/parse-receipt/route.ts`):**
  - `POST /api/parse-receipt` calls the Gemini REST API (`gemini-2.5-flash` with automatic fallback to `gemini-2.0-flash`, `GEMINI_API_KEY`, and `responseMimeType: "application/json"`) to extract `{ description, amount, currency, date, category }`.
  - Prefers preset categories (`General`, `Dining out`, `Groceries`, `Drinks`, `Lodging`, `Flights`, `Car Rental`, `Gas`, `Activities`) or returns a concise 1–2 word custom category (e.g. `Parking`, `Tolls`, `Golf`, `Pharmacy`), which is automatically added to the group's category pills and selected.
  - Pre-fills the Add/Edit Transaction form in parallel with the storage upload (preserving auto-summed `Amount` if the user is in `'$ Exact'` split mode) and surfaces diagnostic error banners if OCR fails.
- **Ledger Receipt Badge & Lightbox Modal:**
  - Transactions with a non-null `receipt_url` display a clickable `Receipt` badge in the ledger that opens a `<dialog closedby="any">` Lightbox Modal for full-size images or embedded/linked PDFs.

### 4.7 Per-Group Custom Currencies & Cross-Currency Unified Settlement (`src/lib/currencies.ts` & `src/lib/reconciliation.ts`)
- **Supported Currency Catalog (`SUPPORTED_CURRENCIES`):**
  - First-class support for `USD` (`$`), `EUR` (`€`), `AUD` (`A$`), `THB` (`฿`), `GBP` (`£`), `CAD` (`C$`), `JPY` (`¥`), `NZD` (`NZ$`), `CHF` (`CHF`), `MXN` (`Mex$`), plus any custom 3-letter ISO currency code via `formatCurrency(cents, currencyCode)`.
- **Per-Group Currency Management:**
  - New groups default to `currencies = ['USD']` and `default_currency = 'USD'`, with optional multi-currency selection in Create Group and a **Manage Group Currencies** modal (`Currencies (...)` button in the group header) for the Super-Admin (`murph@murphnduff.org`).
  - **Clean Single-Currency UX:** Groups with only 1 currency enabled hide currency switcher tabs and dropdowns so the UI stays minimal.
  - **Auto-Enable on AI Receipt Scan & CSV Import:** Scanning a receipt or importing a CSV with a new currency automatically appends that currency to `group.currencies`.
- **Cross-Currency Conversion & "🌐 Unified Settlement (Convert All)" Mode:**
  - Available whenever a group has 2+ currencies. Includes a target currency selector, **Fetch Live Rates** (`https://open.er-api.com/v6/latest/${targetCurrency}`), editable exchange rate overrides persisted in `groups.exchange_rates`, and unified Member Summary + Settlement Plan with secondary currency equivalents (tested in Edge Case 15).

---

## 5. Active Backlog & Future Development Roadmap

### Phase 1.1: Core Polish & Settlement Integrity (Completed ✅)
1. ✅ **Fix Direct Payment Overpayment Inversion:**
   - Direct payments allow net balances to invert past zero without clamping, plus zero-sum safeguard if an expense has empty splits.
   - Automated tests in `src/lib/reconciliation.test.ts` (Edge Cases 10 & 11).
2. ✅ **Exclude Payments from Running Spent Metric:**
   - `USD Spent` and `EUR Spent` strictly aggregate `type === 'expense'`.
3. ✅ **Cumulative Member Breakdown:**
   - `calculateMemberBreakdown` in `src/lib/reconciliation.ts` (tested in Edge Case 12) + dashboard **Member Summary** card showing **Paid (Out-of-Pocket)** vs. **Share (Accrued Cost)** vs. **Net Balance**.
4. ✅ **Group Archiving ("Retire Group"):**
   - Collapsible `Archived (N)` sidebar section, Super-Admin `Archive Group` / `Unarchive Group` toggle, and full Read-Only lock (`Archived — Read-Only` badge/banner).

### Phase 1.2: Expense Categorization & Custom Categories (Completed ✅)
5. ✅ **Categories, Custom Categories & Spend Breakdown:**
   - Added `category` column support on `expenses` with tailored presets (`General`, `Dining out`, `Groceries`, `Drinks`, `Lodging`, `Flights`, `Car Rental`, `Gas`, `Activities`, `Miscellaneous`, `Other`), dynamic per-group category merging (`buildGroupCategories`), inline `+ Custom...` category input in Add/Edit forms, ledger badges, **Spend by Category** summary card (`calculateCategorySpend` tested in Edge Case 13), and lossless CSV `Category` column import/export.

### Phase 1.3: Disaster Recovery & Snapshots (Next Up)
6. **Automated Daily Snapshots:**
   - Scheduled GitHub Action or cron task pulling daily table dumps into timestamped private archives.

### Phase 1.4: Receipts & AI Vision (Completed ✅)
7. ✅ **Receipt Attachments & AI Receipt Extraction (OCR):**
   - Client-side HTML5 `<canvas>` compression (`1600px`, `0.80` JPEG quality) + Supabase Storage `'receipts'` bucket upload (`expenses.receipt_url`).
   - `POST /api/parse-receipt` Gemini Multimodal JSON extraction (`['gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash']` with `thinkingConfig: { thinkingBudget: 0 }`, `maxOutputTokens: 300`, and dynamic model auto-discovery), dual-resolution client compression (`1024px @ 0.70` for fast AI OCR + `1600px @ 0.82` for crisp Supabase Storage), decoupled instant form auto-fill in Add/Edit Transaction forms, dynamic category creation, ledger `Receipt` badge, and Lightbox Modal viewer (tested in Edge Case 14).

### Phase 1.5: Per-Group Custom Currencies & Cross-Currency Unified Reconciliation (Completed ✅)
8. ✅ **Per-Group Custom Currencies & Unified Settlement:**
   - `src/lib/currencies.ts` catalog (`USD`, `EUR`, `AUD`, `THB`, `GBP`, `CAD`, `JPY`, `NZD`, `CHF`, `MXN`, + custom ISO codes) and `formatCurrency` helper.
   - Per-group `currencies`, `default_currency`, and `exchange_rates` management, clean single-currency UX, auto-enable on AI scan/CSV import, and **🌐 Unified Settlement (Convert All)** with live exchange rates (`open.er-api.com`), editable rate overrides, and zero-sum unified reconciliation (`calculateUnifiedReconciliation` tested in Edge Case 15).

### Phase 2: Fast AI OCR, 1-Click Settlement & Mobile PWA Web Share Target (Completed ✅)
9. ✅ **4x–5x Faster Receipt Scanning:**
   - Prioritizes `gemini-flash-lite-latest` & `gemini-2.5-flash-lite` with `thinkingBudget: 0` (`maxOutputTokens: 300`, `temperature: 0.1`), dual-resolution client compression (`1024px` @ `0.70` JPEG for AI vs. `1600px` @ `0.82` JPEG for storage), and decoupled form auto-fill that populates fields the instant `/api/parse-receipt` resolves without waiting for storage upload.
10. ✅ **1-Click "Settle" Button in Settlement Plan:**
    - Each settlement instruction (in both Per-Currency Ledgers and Unified Settlement mode) includes a **"Settle"** button (hidden when archived) that switches the Add Transaction form to `Direct Payment` mode, pre-fills debtor, creditor, exact transfer amount, currency, and `'Settlement Payment'`, and smoothly scrolls the highlighted form into view.
11. ✅ **Mobile "Share Receipt to Settle Up" (`public/manifest.json` + `/share-receipt`):**
    - Configured PWA `share_target` in `public/manifest.json` and `POST /share-receipt` route handler (`src/app/share-receipt/route.ts`) that uploads shared images/PDFs to `receipts/shared/...` and redirects (`303 See Other`) to `/?shared_receipt=<url>` (or `/[slug]?shared_receipt=<url>`), where Settle Up automatically attaches the receipt, triggers AI OCR auto-fill, and cleans up the query string via `window.history.replaceState`.
