import {
  clientBalanceSum,
  clientGroups,
  findAdminById,
  findClientByEmail,
  findClientById,
  listClientPairs,
  listClients,
  type ClientRow,
} from "../db";
import { FbError, register, requireAdmin, requireClient, type CallContext } from "../dispatch";

/**
 * Client entity → API array, mirroring Client::toApiArray() +
 * Client Service::toClientApiArray() field-for-field (order included).
 */

export function clientBaseArray(row: ClientRow) {
  return {
    id: row.id,
    email: row.email,
    email_approved: row.email_approved,
    type: row.type,
    first_name: row.first_name,
    last_name: row.last_name,
    gender: row.gender,
    birthday: row.birthday ? String(row.birthday).slice(0, 10) : null,
    phone_cc: row.phone_cc,
    phone: row.phone,
    company: row.company,
    company_vat: row.company_vat,
    company_number: row.company_number,
    address_1: row.address_1,
    address_2: row.address_2,
    city: row.city,
    state: row.state,
    postcode: row.postcode,
    country: row.country,
    currency: row.currency,
    lang: row.lang,
    timezone: row.timezone,
  };
}

function adminExtras(row: ClientRow) {
  const groups = clientGroups(row.id);
  return {
    aid: row.aid,
    group_ids: groups.map((g) => g.id),
    role: row.role,
    auth_type: row.auth_type,
    status: row.status,
    tax_exempt: row.tax_exempt === null ? null : !!row.tax_exempt,
    merge_renewals: row.merge_renewals === null ? null : !!row.merge_renewals,
    notes: row.notes,
    ip: row.ip,
    referred_by: row.referred_by,
    billing_email: row.billing_email,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`custom_${i + 1}`, row[`custom_${i + 1}`] ?? null]),
    ),
    groups,
  };
}

/** Admin single-get shape: base + extras + balance + group info + api_token. */
export function clientAdminArray(row: ClientRow) {
  const { groups, ...extras } = adminExtras(row);
  return {
    ...clientBaseArray(row),
    ...extras,
    balance: clientBalanceSum(row.id),
    group: groups.length ? groups.map((g) => g.title).join(", ") : null,
    client_groups: groups.map((g) => ({ id: g.id, title: g.title })),
    api_token: row.api_token,
  };
}

/** Admin list-item shape: base + extras + balance + group (no client_groups/api_token). */
export function clientListArray(row: ClientRow) {
  const { groups, ...extras } = adminExtras(row);
  return {
    ...clientBaseArray(row),
    ...extras,
    balance: clientBalanceSum(row.id),
    group: groups.length ? groups.map((g) => g.title).join(", ") : null,
  };
}

/** Self shape (profile/get): base + billing_email + balance. */
export function clientSelfArray(row: ClientRow) {
  return {
    ...clientBaseArray(row),
    billing_email: row.billing_email,
    balance: clientBalanceSum(row.id),
  };
}

register("client", "profile", "get", (ctx: CallContext) => {
  requireClient(ctx);
  const row = findClientById(ctx.session!.client!.id);
  if (!row) throw new FbError("Client not found");
  return clientSelfArray(row);
});

register("admin", "profile", "get", (ctx: CallContext) => {
  requireAdmin(ctx);
  const row = findAdminById(ctx.session!.admin!.id);
  if (!row) throw new FbError("Admin not found");
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    signature: row.signature,
    status: row.status,
    api_token: row.api_token,
    timezone: row.timezone,
    created_at: row.created_at ? String(row.created_at).slice(0, 10) : null,
    updated_at: row.updated_at ? String(row.updated_at).slice(0, 10) : null,
  };
});

register("admin", "client", "get", (ctx: CallContext) => {
  requireAdmin(ctx);
  const id = ctx.params["id"];
  const email = ctx.params["email"];
  if (!id && !email) throw new FbError("Client ID or email is required");
  const row = id ? findClientById(Number(id)) : findClientByEmail(email!);
  if (!row) throw new FbError("Client not found");
  return clientAdminArray(row);
});

register("admin", "client", "get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const rows = listClients({
    id: ctx.params["id"],
    name: ctx.params["name"],
    email: ctx.params["email"],
    company: ctx.params["company"],
    status: ctx.params["status"],
    search: ctx.params["search"],
  });
  const perPage = parseInt(ctx.params["per_page"] ?? "100", 10) || 100;
  const page = parseInt(ctx.params["page"] ?? "1", 10) || 1;
  const total = rows.length;
  const list = rows.slice((page - 1) * perPage, page * perPage).map(clientListArray);
  return { pages: Math.max(1, Math.ceil(total / perPage)), page, per_page: perPage, total, list };
});

register("admin", "client", "get_pairs", (ctx: CallContext) => {
  requireAdmin(ctx);
  const perPageRaw = ctx.params["per_page"] ?? "30";
  const perPage = Number(perPageRaw);
  if (!Number.isFinite(perPage) || perPage < 1) throw new FbError("Invalid per page number");
  const out: Record<string, string> = {};
  for (const p of listClientPairs(perPage)) out[String(p.id)] = p.name;
  return out;
});

/** Subscription-embedded shape: base + admin extras + group info,
 * without balance or api_token (Invoice Subscription::toApiArray). */
export function clientSubscriptionArray(row: ClientRow) {
  const { groups, ...extras } = adminExtras(row);
  return {
    ...clientBaseArray(row),
    ...extras,
    group: groups.length ? groups.map((g) => g.title).join(", ") : null,
    client_groups: groups.map((g) => ({ id: g.id, title: g.title })),
  };
}
