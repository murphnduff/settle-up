import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse, connection } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  splitAmountEqually,
  calculateSettlements,
  calculateMemberBreakdown,
  calculateUnifiedReconciliation,
  type MemberRecord,
  type ExpenseRecord,
} from "@/lib/reconciliation";
import {
  normalizeCurrencyCode,
  formatCurrency,
  buildGroupCurrencies,
  fetchTransactionFxRates,
  normalizeFxRatesMap,
  type FxRatesMap,
} from "@/lib/currencies";

// Note: `nextConfig.cacheComponents` is enabled in `next.config.ts`, which disallows
// `export const dynamic = 'force-dynamic'`. Calling `await connection()` and reading
// `request.headers` guarantees dynamic request-time execution (`ƒ (Dynamic)`).

function isAuthorized(request: NextRequest): boolean {
  const expectedSecret = process.env.MCP_SECRET_KEY?.trim();
  if (!expectedSecret) {
    return false;
  }

  const authHeader = request.headers.get("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedSecret = match?.[1]?.trim();
  if (!providedSecret) {
    return false;
  }

  const expectedBuf = Buffer.from(expectedSecret, "utf8");
  const providedBuf = Buffer.from(providedSecret, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}

function getServerSupabase(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or Supabase API key environment variables."
    );
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
    global: {
      fetch: (url, options = {}) =>
        fetch(url, { ...options, cache: "no-store" }),
    },
  });
}

interface ResolvedGroup {
  id: string;
  name: string;
  slug: string;
  is_archived: boolean;
  currencies: string[];
  default_currency: string;
  exchange_rates: Record<string, number>;
  created_by: string | null;
}

async function resolveGroupAndMembers(
  supabase: SupabaseClient,
  groupSlug: string
): Promise<{
  group: ResolvedGroup;
  members: Array<MemberRecord & { display_name: string }>;
}> {
  const cleanTarget = groupSlug.trim().toLowerCase();
  const { data: allGroups, error: groupErr } = await supabase
    .from("groups")
    .select(
      "id, name, slug, is_archived, currencies, default_currency, exchange_rates, created_by"
    );

  if (groupErr) {
    throw new Error(`Failed to query groups: ${groupErr.message}`);
  }

  const matched =
    (allGroups || []).find(
      (g) => typeof g.slug === "string" && g.slug.trim().toLowerCase() === cleanTarget
    ) ||
    (allGroups || []).find(
      (g) => typeof g.name === "string" && g.name.trim().toLowerCase() === cleanTarget
    );

  if (!matched) {
    throw new Error(`Group not found for slug or name "${groupSlug}".`);
  }

  const defaultCurrency = normalizeCurrencyCode(
    matched.default_currency ||
      (Array.isArray(matched.currencies) ? matched.currencies[0] : "USD")
  );
  const currencies = buildGroupCurrencies(
    Array.isArray(matched.currencies) ? matched.currencies : [defaultCurrency],
    defaultCurrency
  );

  const exchangeRates: Record<string, number> = {};
  if (
    matched.exchange_rates &&
    typeof matched.exchange_rates === "object" &&
    !Array.isArray(matched.exchange_rates)
  ) {
    for (const [k, v] of Object.entries(
      matched.exchange_rates as Record<string, unknown>
    )) {
      const num = Number(v);
      if (Number.isFinite(num) && num > 0) {
        exchangeRates[normalizeCurrencyCode(k)] = num;
      }
    }
  }

  const { data: memberRows, error: memErr } = await supabase
    .from("group_members")
    .select("id, display_name")
    .eq("group_id", matched.id);

  if (memErr) {
    throw new Error(`Failed to query group members: ${memErr.message}`);
  }

  const members = (memberRows || []).map((m) => ({
    id: m.id as string,
    name: (m.display_name as string) || "Member",
    display_name: (m.display_name as string) || "Member",
  }));

  return {
    group: {
      id: matched.id as string,
      name: (matched.name as string) || "Group",
      slug: (matched.slug as string) || (matched.id as string),
      is_archived: Boolean(matched.is_archived),
      currencies,
      default_currency: defaultCurrency,
      exchange_rates: exchangeRates,
      created_by: (matched.created_by as string | null) ?? null,
    },
    members,
  };
}

async function fetchGroupExpenses(
  supabase: SupabaseClient,
  groupId: string
): Promise<Array<ExpenseRecord & { id: string; createdAt: string }>> {
  const { data, error } = await supabase
    .from("expenses")
    .select("*, expense_splits(member_id, split_amount_cents)")
    .eq("group_id", groupId)
    .order("date", { ascending: false });

  if (error) {
    throw new Error(`Failed to query expenses: ${error.message}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapped = (data || []).map((e: any) => {
    const amountCents = Number(
      e.amount_cents ?? Math.round(Number(e.amount || 0) * 100)
    );
    const currency = normalizeCurrencyCode(e.currency);
    const cleanDate =
      typeof e.date === "string"
        ? e.date.split("T")[0]
        : new Date().toISOString().split("T")[0];
    const isPayment = e.type === "payment";
    return {
      id: e.id as string,
      paidByMemberId: e.paid_by_member_id as string,
      payerId: e.paid_by_member_id as string,
      description: (e.description as string) || "",
      category: isPayment
        ? "Payment"
        : typeof e.category === "string" && e.category.trim().length > 0
          ? e.category.trim()
          : "General",
      amount: amountCents / 100,
      amountCents,
      currency,
      type: (isPayment ? "payment" : "expense") as "expense" | "payment",
      fxRates: normalizeFxRatesMap(e.fx_rates, currency),
      date: cleanDate,
      createdAt: typeof e.created_at === "string" ? e.created_at : "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      splits: (e.expense_splits || []).map((s: any) => {
        const splitCents = Number(
          s.split_amount_cents ?? Math.round(Number(s.amount || 0) * 100)
        );
        return {
          memberId: s.member_id as string,
          userId: s.member_id as string,
          amount: splitCents / 100,
          splitAmountCents: splitCents,
        };
      }),
    };
  });

  return mapped.sort((a, b) => {
    const dateCmp = (b.date || "").localeCompare(a.date || "");
    if (dateCmp !== 0) return dateCmp;
    const createdCmp = (b.createdAt || "").localeCompare(a.createdAt || "");
    if (createdCmp !== 0) return createdCmp;
    return b.id.localeCompare(a.id);
  });
}

function createSettleUpMcpServer(): McpServer {
  const server = new McpServer({
    name: "settle-up",
    version: "1.0.0",
  });

  // 1. list_groups
  server.registerTool(
    "list_groups",
    {
      title: "List Groups",
      description:
        "List all non-archived Settle Up groups with their slugs, enabled currencies, default currency, and members.",
      inputSchema: {},
    },
    async () => {
      try {
        const supabase = getServerSupabase();
        const { data: groupRows, error: grpErr } = await supabase
          .from("groups")
          .select("id, name, slug, is_archived, currencies, default_currency")
          .eq("is_archived", false)
          .order("created_at", { ascending: false });

        if (grpErr) {
          throw new Error(grpErr.message);
        }

        const { data: memberRows, error: memErr } = await supabase
          .from("group_members")
          .select("id, group_id, display_name");

        if (memErr) {
          throw new Error(memErr.message);
        }

        const membersByGroup = new Map<
          string,
          Array<{ id: string; display_name: string }>
        >();
        for (const m of memberRows || []) {
          const gid = m.group_id as string;
          const list = membersByGroup.get(gid) || [];
          list.push({
            id: m.id as string,
            display_name: (m.display_name as string) || "Member",
          });
          membersByGroup.set(gid, list);
        }

        const groups = (groupRows || []).map((g) => {
          const defaultCurrency = normalizeCurrencyCode(
            g.default_currency ||
              (Array.isArray(g.currencies) ? g.currencies[0] : "USD")
          );
          const currencies = buildGroupCurrencies(
            Array.isArray(g.currencies) ? g.currencies : [defaultCurrency],
            defaultCurrency
          );
          return {
            id: g.id as string,
            name: g.name as string,
            slug: (g.slug as string) || (g.id as string),
            currencies,
            default_currency: defaultCurrency,
            members: membersByGroup.get(g.id as string) || [],
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ groups }, null, 2),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing groups: ${
                err instanceof Error ? err.message : "Unknown error"
              }`,
            },
          ],
        };
      }
    }
  );

  // 2. add_transaction
  server.registerTool(
    "add_transaction",
    {
      title: "Add Transaction",
      description:
        "Log an expense or direct settlement payment in a Settle Up group, auto-fetching transaction-date FX rates for multi-currency groups and computing exact integer-cent splits.",
      inputSchema: {
        group_slug: z
          .string()
          .min(1)
          .describe("Group slug or name (case-insensitive)"),
        type: z
          .enum(["expense", "payment"])
          .default("expense")
          .describe("'expense' for shared costs, 'payment' for settling debt"),
        paid_by: z
          .string()
          .min(1)
          .describe("Display name of the member who paid"),
        amount: z
          .number()
          .positive()
          .describe("Positive transaction amount in major currency units"),
        currency: z
          .string()
          .min(3)
          .max(5)
          .optional()
          .describe(
            "Optional 3-letter ISO currency code (defaults to group.default_currency)"
          ),
        description: z
          .string()
          .optional()
          .describe(
            "Transaction description (defaults to 'Settlement Payment' for payments)"
          ),
        category: z
          .string()
          .optional()
          .describe(
            "Category such as 'Dining out', 'Groceries', 'Lodging', 'Transport', 'General'"
          ),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD date format")
          .optional()
          .describe("Transaction date in YYYY-MM-DD format (defaults to today)"),
        split_among: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Optional member display names to split equally among (defaults to all members for expenses; required single recipient for payments)"
          ),
        exact_splits: z
          .record(z.string().min(1), z.number().nonnegative())
          .optional()
          .describe(
            "Optional map of { [memberName]: amount } for exact split amounts summing to amount"
          ),
      },
    },
    async (args) => {
      try {
        const supabase = getServerSupabase();
        const { group, members } = await resolveGroupAndMembers(
          supabase,
          args.group_slug
        );

        if (group.is_archived) {
          throw new Error(
            `Group "${group.name}" is archived (read-only) and cannot accept new transactions.`
          );
        }

        if (members.length === 0) {
          throw new Error(`Group "${group.name}" has no members.`);
        }

        const findMember = (name: string) => {
          const lower = name.trim().toLowerCase();
          return members.find((m) => m.display_name.trim().toLowerCase() === lower);
        };

        const payer = findMember(args.paid_by);
        if (!payer) {
          throw new Error(
            `Member "${args.paid_by}" not found in "${group.name}". Available members: ${members
              .map((m) => m.display_name)
              .join(", ")}.`
          );
        }

        const amountCents = Math.round(args.amount * 100);
        if (amountCents <= 0) {
          throw new Error("Transaction amount must be greater than zero.");
        }

        const txType = args.type ?? "expense";
        const isoCurrency = normalizeCurrencyCode(
          args.currency || group.default_currency
        );
        const txDate = args.date || new Date().toISOString().split("T")[0];
        const txDescription =
          args.description?.trim() ||
          (txType === "payment" ? "Settlement Payment" : "Group Expense");
        const txCategory =
          txType === "payment"
            ? "Payment"
            : args.category?.trim() || "General";

        let calculatedSplits: Array<{
          memberId: string;
          memberName: string;
          splitAmountCents: number;
        }> = [];

        if (txType === "payment") {
          const recipientNames =
            args.split_among && args.split_among.length > 0
              ? args.split_among
              : args.exact_splits
                ? Object.keys(args.exact_splits)
                : [];
          if (recipientNames.length !== 1) {
            throw new Error(
              "Direct payments require exactly 1 recipient in `split_among`."
            );
          }
          const recipient = findMember(recipientNames[0]);
          if (!recipient) {
            throw new Error(
              `Recipient "${recipientNames[0]}" not found in "${group.name}".`
            );
          }
          calculatedSplits = [
            {
              memberId: recipient.id,
              memberName: recipient.display_name,
              splitAmountCents: amountCents,
            },
          ];
        } else if (
          args.exact_splits &&
          Object.keys(args.exact_splits).length > 0
        ) {
          let exactSumCents = 0;
          for (const [rawName, rawAmt] of Object.entries(args.exact_splits)) {
            const member = findMember(rawName);
            if (!member) {
              throw new Error(
                `Split member "${rawName}" not found in "${group.name}".`
              );
            }
            const splitCents = Math.round(rawAmt * 100);
            if (splitCents > 0) {
              exactSumCents += splitCents;
              calculatedSplits.push({
                memberId: member.id,
                memberName: member.display_name,
                splitAmountCents: splitCents,
              });
            }
          }
          if (exactSumCents !== amountCents) {
            throw new Error(
              `Exact splits sum (${formatCurrency(
                exactSumCents,
                isoCurrency
              )}) must equal total amount (${formatCurrency(
                amountCents,
                isoCurrency
              )}).`
            );
          }
        } else {
          const targetMembers =
            args.split_among && args.split_among.length > 0
              ? args.split_among.map((rawName) => {
                  const m = findMember(rawName);
                  if (!m) {
                    throw new Error(
                      `Split member "${rawName}" not found in "${group.name}".`
                    );
                  }
                  return m;
                })
              : members;

          const equalSplits = splitAmountEqually(
            amountCents,
            targetMembers.map((m) => m.id)
          );
          const nameById = new Map(
            targetMembers.map((m) => [m.id, m.display_name])
          );
          calculatedSplits = equalSplits.map((s) => ({
            memberId: s.memberId,
            memberName: nameById.get(s.memberId) || "Member",
            splitAmountCents: s.splitAmountCents,
          }));
        }

        // Auto-enable currency on group if new
        const updatedGroupCurrencies = buildGroupCurrencies(
          group.currencies,
          group.default_currency,
          [isoCurrency]
        );
        if (updatedGroupCurrencies.length > group.currencies.length) {
          await supabase
            .from("groups")
            .update({ currencies: updatedGroupCurrencies })
            .eq("id", group.id);
        }

        // Fetch date-aware FX rates when multi-currency
        let fxRates: FxRatesMap | null = null;
        if (
          updatedGroupCurrencies.length > 1 ||
          isoCurrency !== group.default_currency
        ) {
          try {
            fxRates = await fetchTransactionFxRates(
              isoCurrency,
              txDate,
              updatedGroupCurrencies
            );
          } catch {
            fxRates = null;
          }
        }

        const expensePayload: Record<string, unknown> = {
          group_id: group.id,
          paid_by_member_id: payer.id,
          description: txDescription,
          category: txCategory,
          amount_cents: amountCents,
          currency: isoCurrency,
          fx_rates: fxRates,
          type: txType,
          date: txDate,
        };

        let { data: newExp, error: expError } = await supabase
          .from("expenses")
          .insert(expensePayload)
          .select("id")
          .single();

        for (let attempt = 0; attempt < 3 && expError; attempt++) {
          const msg = expError.message?.toLowerCase() || "";
          let updated = false;
          if (msg.includes("fx_rates") && "fx_rates" in expensePayload) {
            delete expensePayload.fx_rates;
            updated = true;
          }
          if (msg.includes('"amount"') && !("amount" in expensePayload)) {
            expensePayload.amount = Number((amountCents / 100).toFixed(2));
            updated = true;
          }
          if (msg.includes('"created_by"') && !("created_by" in expensePayload) && group.created_by) {
            expensePayload.created_by = group.created_by;
            updated = true;
          }
          if (!updated) break;
          const retry = await supabase
            .from("expenses")
            .insert(expensePayload)
            .select("id")
            .single();
          newExp = retry.data;
          expError = retry.error;
        }

        if (expError || !newExp) {
          throw new Error(
            `Failed to insert transaction: ${expError?.message || "Unknown error"}`
          );
        }

        const splitsPayload = calculatedSplits.map((s) => ({
          expense_id: newExp.id,
          member_id: s.memberId,
          split_amount_cents: s.splitAmountCents,
        }));

        const { error: splitsError } = await supabase
          .from("expense_splits")
          .insert(splitsPayload);

        if (splitsError) {
          await supabase.from("expenses").delete().eq("id", newExp.id);
          throw new Error(`Failed to insert splits: ${splitsError.message}`);
        }

        const splitSummary = calculatedSplits
          .map(
            (s) =>
              `  - ${s.memberName}: ${formatCurrency(s.splitAmountCents, isoCurrency)}`
          )
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text: [
                `Recorded ${txType} in "${group.name}" (${group.slug}):`,
                `- ID: ${newExp.id}`,
                `- Date: ${txDate}`,
                `- Description: ${txDescription} [${txCategory}]`,
                `- Paid by: ${payer.display_name}`,
                `- Amount: ${formatCurrency(amountCents, isoCurrency)} (${isoCurrency})`,
                fxRates ? `- Locked FX Rates: ${JSON.stringify(fxRates)}` : null,
                `- Splits:\n${splitSummary}`,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error adding transaction: ${
                err instanceof Error ? err.message : "Unknown error"
              }`,
            },
          ],
        };
      }
    }
  );

  // 3. get_settlement_plan
  server.registerTool(
    "get_settlement_plan",
    {
      title: "Get Settlement Plan",
      description:
        "Compute the member balances and greedy cash-flow minimization settlement plan for a group (supports unified cross-currency conversion when target_currency is provided).",
      inputSchema: {
        group_slug: z
          .string()
          .min(1)
          .describe("Group slug or name (case-insensitive)"),
        target_currency: z
          .string()
          .min(3)
          .max(5)
          .optional()
          .describe(
            "Optional 3-letter ISO currency code for unified cross-currency settlement (e.g., 'USD')"
          ),
      },
    },
    async (args) => {
      try {
        const supabase = getServerSupabase();
        const { group, members } = await resolveGroupAndMembers(
          supabase,
          args.group_slug
        );
        const expenses = await fetchGroupExpenses(supabase, group.id);
        const activeCurrencies = buildGroupCurrencies(
          group.currencies,
          group.default_currency,
          expenses
        );

        if (args.target_currency) {
          const targetCode = normalizeCurrencyCode(args.target_currency);
          const unified = calculateUnifiedReconciliation(
            members,
            expenses,
            targetCode,
            group.exchange_rates
          );

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    mode: "unified",
                    group: { id: group.id, name: group.name, slug: group.slug },
                    target_currency: unified.targetCurrency,
                    member_breakdown: unified.memberBreakdown.map((m) => ({
                      member: m.memberName,
                      paid: formatCurrency(m.paidCents, targetCode),
                      share: formatCurrency(m.shareCents, targetCode),
                      net_balance: formatCurrency(m.netBalanceCents, targetCode),
                      net_balance_cents: m.netBalanceCents,
                    })),
                    settlements: unified.settlements.map((s) => ({
                      from: s.fromMemberName,
                      to: s.toMemberName,
                      amount: formatCurrency(s.amountCents, targetCode),
                      amount_cents: s.amountCents,
                      currency: targetCode,
                    })),
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        const allSettlements = calculateSettlements(members, expenses);
        const perCurrency = activeCurrencies.map((code) => {
          const breakdown = calculateMemberBreakdown(members, expenses, code);
          const transfers = allSettlements.filter(
            (s) => normalizeCurrencyCode(s.currency) === code
          );
          return {
            currency: code,
            member_breakdown: breakdown.map((m) => ({
              member: m.memberName,
              paid: formatCurrency(m.paidCents, code),
              share: formatCurrency(m.shareCents, code),
              net_balance: formatCurrency(m.netBalanceCents, code),
              net_balance_cents: m.netBalanceCents,
            })),
            settlements: transfers.map((s) => ({
              from: s.fromMemberName,
              to: s.toMemberName,
              amount: formatCurrency(s.amountCents, code),
              amount_cents: s.amountCents,
              currency: code,
            })),
          };
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  mode: "per_currency",
                  group: { id: group.id, name: group.name, slug: group.slug },
                  ledgers: perCurrency,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error calculating settlement plan: ${
                err instanceof Error ? err.message : "Unknown error"
              }`,
            },
          ],
        };
      }
    }
  );

  // 4. list_recent_transactions
  server.registerTool(
    "list_recent_transactions",
    {
      title: "List Recent Transactions",
      description:
        "Return the most recent transactions (expenses and payments) for a group.",
      inputSchema: {
        group_slug: z
          .string()
          .min(1)
          .describe("Group slug or name (case-insensitive)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe("Maximum number of transactions to return (default 10)"),
      },
    },
    async (args) => {
      try {
        const supabase = getServerSupabase();
        const { group, members } = await resolveGroupAndMembers(
          supabase,
          args.group_slug
        );
        const expenses = await fetchGroupExpenses(supabase, group.id);
        const memberNameById = new Map(
          members.map((m) => [m.id, m.display_name])
        );

        const recent = expenses.slice(0, args.limit ?? 10).map((exp) => ({
          id: exp.id,
          date: exp.date,
          type: exp.type,
          description: exp.description,
          category: exp.category,
          amount: formatCurrency(exp.amountCents || 0, exp.currency || "USD"),
          amount_cents: exp.amountCents,
          currency: exp.currency,
          paid_by: memberNameById.get(exp.paidByMemberId || "") || "Unknown",
          fx_rates: exp.fxRates || null,
          splits: (exp.splits || []).map((s) => ({
            member: memberNameById.get(s.memberId || "") || "Unknown",
            amount: formatCurrency(
              s.splitAmountCents || 0,
              exp.currency || "USD"
            ),
            split_amount_cents: s.splitAmountCents,
          })),
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  group: { id: group.id, name: group.name, slug: group.slug },
                  total_count: expenses.length,
                  returned_count: recent.length,
                  transactions: recent,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: unknown) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing transactions: ${
                err instanceof Error ? err.message : "Unknown error"
              }`,
            },
          ],
        };
      }
    }
  );

  return server;
}

async function handleMcpRequest(request: NextRequest): Promise<Response> {
  await connection();

  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const server = createSettleUpMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleMcpRequest(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  return handleMcpRequest(request);
}

export async function DELETE(request: NextRequest): Promise<Response> {
  return handleMcpRequest(request);
}
