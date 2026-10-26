// Servicedomain — domain service management, TLDs, and registrars.
//
// Registrar split: metadata (get/list/pairs/available/install/copy/
// update) is data-only and works for every in-tree adapter, since the
// adapter getConfig tables are static. Action dispatch (domain actions,
// guest check/transfer, sync) runs the Custom adapter and the eNom
// adapter (src/server/enom.ts); any other registrar code throws the
// post-cut "Domain registrar :adapter was not found" shape, matching
// the D7 plan (cut adapters are deleted with their modules at R6, not
// ported). Custom's network-free behavior is pinned by capture24.

import { domainToASCII } from "node:url";
import { FbError, register, requireAdmin, requireClient, type CallContext } from "../dispatch";
import {
  enomCanBeTransferred,
  enomCheckAvailable,
  enomDisablePrivacy,
  enomEnablePrivacy,
  enomGetDomainDetails,
  enomGetEpp,
  enomGetExpiration,
  enomModifyContact,
  enomModifyNs,
  enomSetLock,
  type EnomConfig,
  type EnomContact,
} from "../enom";
import { getDb, getDbWrite, nowTimestamp } from "../db";
import { paginate } from "../util";

interface OrderRow {
  id: number;
  client_id: number;
  service_id: number | null;
  service_type: string | null;
  status: string;
  expires_at: string | null;
}

interface DomainRow {
  id: number;
  client_id: number;
  sld: string | null;
  tld: string | null;
  ns1: string | null;
  ns2: string | null;
  ns3: string | null;
  ns4: string | null;
  period: number | null;
  privacy: number | null;
  locked: number | null;
  transfer_code: string | null;
  contact_email: string | null;
  contact_company: string | null;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_address1: string | null;
  contact_address2: string | null;
  contact_city: string | null;
  contact_state: string | null;
  contact_postcode: string | null;
  contact_country: string | null;
  contact_phone_cc: string | null;
  contact_phone: string | null;
  synced_at: string | null;
  registered_at: string | null;
  expires_at: string | null;
  tld_registrar_id: number | null;
}

interface TldRow {
  id: number;
  tld: string;
  price_registration: string | number | null;
  price_renew: string | number | null;
  price_transfer: string | number | null;
  allow_register: number;
  allow_transfer: number;
  require_transfer_code: number | null;
  active: number;
  min_years: number;
  periods: string | null;
  tld_registrar_id: number | null;
}

interface RegistrarRow {
  id: number;
  name: string | null;
  registrar: string | null;
  test_mode: number;
  config: string | null;
}

/** PHP (bool) cast: '' and '0' are false, everything else true. */
export function phpBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "" && v !== "0";
  return !!v;
}

function parseJson<T>(json: string | null, fallback: T): T {
  try {
    const v = json ? JSON.parse(json) : undefined;
    return v === undefined || v === null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** PHP Validator::isSldValid. */
function isSldValid(raw: string): boolean {
  let sld = raw.replace(/^\.+/, "");
  if (sld === "") return false;
  if (/[^\x00-\x7F]/.test(sld)) {
    try {
      sld = domainToASCII(sld);
    } catch {
      return false;
    }
    if (!sld) return false;
  }
  sld = sld.toLowerCase();
  if (sld.startsWith("xn--")) return !sld.includes(".") && sld.length < 64;
  return /^[a-z0-9]+[a-z0-9-]*[a-z0-9]+$/i.test(sld) && sld.length < 64 && sld.slice(2, 4) !== "--";
}

/** PHP Servicedomain Service::normalizeTld. */
function normalizeTld(raw: string): string {
  let tld = raw.trim().replace(/^\.+|\.+$/g, "");
  if (tld === "") throw new FbError("TLD is invalid.");
  if (/[^\x00-\x7F]/.test(tld)) {
    try {
      tld = domainToASCII(tld);
    } catch {
      throw new FbError("TLD is invalid.");
    }
    if (!tld) throw new FbError("TLD is invalid.");
  }
  if (tld.length > 253) throw new FbError("TLD is invalid.");
  for (const label of tld.toLowerCase().split(".")) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) throw new FbError("TLD is invalid.");
  }
  return "." + tld.toLowerCase();
}

function periodsArray(periods: string | null): number[] | null {
  if (periods === null || periods.trim() === "") return null;
  const years = [...new Set(periods.split(",").map((p) => parseInt(p.trim(), 10)))].sort((a, b) => a - b);
  return years;
}

export function tldToApiArray(row: TldRow, isAdmin = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    tld: row.tld,
    price_registration: row.price_registration === null ? null : String(row.price_registration),
    price_renew: row.price_renew === null ? null : String(row.price_renew),
    price_transfer: row.price_transfer === null ? null : String(row.price_transfer),
    active: !!row.active,
    allow_register: !!row.allow_register,
    allow_transfer: !!row.allow_transfer,
    require_transfer_code: row.require_transfer_code === null ? null : !!row.require_transfer_code,
    min_years: row.min_years,
    periods: periodsArray(row.periods),
  };
  if (isAdmin) {
    const reg =
      row.tld_registrar_id !== null
        ? (getDb().prepare("SELECT id, name FROM tld_registrar WHERE id = ?").get(row.tld_registrar_id) as unknown as
            | { id: number; name: string | null }
            | undefined)
        : undefined;
    out["registrar"] = { id: reg?.id ?? null, title: reg?.name ?? null };
  }
  return out;
}

// --- Registrar adapter metadata (static getConfig tables) ---

type FormField = [string, Record<string, unknown>];
interface AdapterConfig {
  label: string;
  form: Record<string, FormField>;
}

const ADAPTER_CONFIGS: Record<string, AdapterConfig> = {
  Custom: {
    label: "Custom Registrar always responds with positive results. Useful if no other registrar is suitable.",
    form: {
      use_rdap: ["radio", { multiOptions: { "1": "Yes", "0": "No" }, label: "Use RDAP Registry Lookups to Check for Domain Availability" }],
    },
  },
  Email: {
    label:
      "This registrar type sends notifications to the given email about domain management events. For example, when client registers a new domain an email with domain details will be sent to you. It is then your responsibility to register domain on real registrar.",
    form: {
      email: ["text", { label: "Email Address", description: "Email to Send Domain Change Notifications" }],
      use_rdap: ["radio", { multiOptions: { "1": "Yes", "0": "No" }, label: "Use RDAP Registry Lookups to Check for Domain Availability" }],
    },
  },
  Internetbs: {
    label: "Manages domains on Internetbs via API",
    form: {
      apikey: ["password", { label: "Internetbs API Key", description: "Internetbs API Key", secret: true }],
      password: ["password", { label: "Internetbs API Password", description: "Internetbs API Password", secret: true }],
    },
  },
  Namecheap: {
    label: "Manages domains on Namecheap via API. Namecheap requires your server IP in order to work.",
    form: {
      "api-user-id": ["text", { label: "Reseller ID", description: "Namecheap Reseller ID. If you don't have one, leave this blank.", required: false }],
      "api-key": ["password", { label: "API Key", description: "You can get this at Namecheap control panel.", required: true, secret: true }],
      username: ["text", { label: "Namecheap Username", description: "The username you use to login to the Namecheap control panel.", required: true }],
      ip: ["text", { label: "Server's Public IP Address", description: "Public IP address of this server. Ensure that this IP address is whitelisted under your NameCheap settings.", required: true }],
    },
  },
  Resellerclub: {
    label:
      "Manages domains on ResellerClub via API. ResellerClub requires your server IP in order to work. Login to the ResellerClub control panel (the url will be in the email you received when you signed up with them) and then go to Settings > API and enter the IP address of the server where FOSSBilling is installed to authorize it for API access.",
    form: {
      userid: ["text", { label: "Reseller ID. You can get this at ResellerClub control panel Settings > Personal information > Primary profile > Reseller ID", description: "ResellerClub Reseller ID" }],
      "api-key": ["password", { label: "ResellerClub API Key", description: "You can get this at ResellerClub control panel, go to Settings -> API", required: false, secret: true }],
    },
  },
  Netearthone: {
    label:
      "Manages domains on NetEarthOne via API. NetEarthOne requires your server IP in order to work. Login to the NetEarthOne control panel (the url will be in the email you received when you signed up with them) and then go to Settings > API and enter the IP address of the server where FOSSBilling is installed to authorize it for API access.",
    form: {
      userid: ["text", { label: "Reseller ID. You can get this at NetEarthOne control panel Settings > Personal information > Primary profile > Reseller ID", description: "NetEarthOne Reseller ID" }],
      "api-key": ["password", { label: "NetEarthOne API Key", description: "NetEarthOne control panel, go to Settings -> API", required: false, secret: true }],
    },
  },
  Resellbiz: {
    label:
      "Manages domains on Resell.biz via API. Resell.biz requires your server IP in order to work. Login to the Resell.biz control panel (the url will be in the email you received when you signed up with them) and then go to Settings > API and enter the IP address of the server where FOSSBilling is installed to authorize it for API access.",
    form: {
      userid: ["text", { label: "Reseller ID. You can get this at Resell.biz control panel Settings > Personal information > Primary profile > Reseller ID", description: "Resell.biz Reseller ID" }],
      "api-key": ["password", { label: "Resell.biz API Key", description: "Resell.biz control panel, go to Settings -> API", required: false, secret: true }],
    },
  },
  Resellerid: {
    label:
      "Manages domains on ResellerID via API. ResellerID requires your server IP in order to work. Login to the ResellerID control panel (the url will be in the email you received when you signed up with them) and then go to Settings > API and enter the IP address of the server where FOSSBilling is installed to authorize it for API access.",
    form: {
      userid: ["text", { label: "Reseller ID. You can get this at ResellerID control panel Settings > Personal information > Primary profile > Reseller ID", description: "ResellerID Reseller ID" }],
      "api-key": ["password", { label: "ResellerID API Key", description: "ResellerID control panel, go to Settings -> API", required: false, secret: true }],
    },
  },
  Enom: {
    label: "Manages domains on eNom via API. eNom requires your server IP to be whitelisted on your eNom account.",
    form: {
      username: ["text", { label: "User Name", required: true }],
      password: ["password", { label: "Password", required: true, secret: true }],
    },
  },
};

const ALL_ADAPTER_CODES = Object.keys(ADAPTER_CONFIGS).sort();

function adapterConfig(code: string | null): AdapterConfig {
  const cfg = code ? ADAPTER_CONFIGS[code] : undefined;
  if (!cfg) throw new FbError(`Domain registrar ${code} was not found`);
  return cfg;
}

function adapterSecretFields(code: string | null): string[] {
  const cfg = adapterConfig(code);
  const out: string[] = [];
  for (const [name, field] of Object.entries(cfg.form)) {
    if (field[1]["secret"]) out.push(name);
  }
  return out;
}

function registrarConfig(row: RegistrarRow): Record<string, unknown> {
  // PHP: json_decode(config ?? '', true) ?? [] — NULL decodes to the
  // empty PHP array, which re-encodes as [] (not {}).
  const parsed = parseJson<unknown>(row.config, []);
  return isPlainObject(parsed) ? parsed : {};
}

function registrarToApi(row: RegistrarRow): Record<string, unknown> {
  const cfg = adapterConfig(row.registrar);
  const secrets = adapterSecretFields(row.registrar);
  const stored = registrarConfig(row);
  const storedObj = Object.keys(stored).length > 0 ? { ...stored } : undefined;
  let configOut: unknown = storedObj ?? [];
  if (secrets.length > 0) {
    const obj: Record<string, unknown> = storedObj ?? {};
    for (const field of secrets) {
      const value = stored[field];
      obj[field] = null;
      obj[`${field}_set`] = value !== null && value !== undefined && value !== "";
    }
    configOut = obj;
  }
  return {
    id: row.id,
    title: row.name,
    label: cfg.label,
    config: configOut,
    secret_fields: secrets,
    form: cfg.form,
    test_mode: !!row.test_mode,
  };
}

/** PHP registrarValidateConfiguration, against the stored config. */
function validateRegistrarConfig(row: RegistrarRow, config: Record<string, unknown>): void {
  const cfg = adapterConfig(row.registrar);
  for (const [field, element] of Object.entries(cfg.form)) {
    const options = element[1];
    let required = options["required"] !== undefined && options["required"] !== false && options["required"] !== "false";
    if (Array.isArray(options["required_when"])) {
      // No in-tree adapter form uses required_when; kept for parity.
      required = true;
    }
    const value = config[field];
    if (required && (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0))) {
      const name = row.name ?? row.registrar;
      throw new FbError(`Registrar ${name} is missing required configuration: ${String(options["label"] ?? field)}`);
    }
  }
}

// --- Lookups ---

function findOrder(id: number): OrderRow | undefined {
  return getDb().prepare("SELECT * FROM client_order WHERE id = ?").get(id) as unknown as OrderRow | undefined;
}

function findOrderForClient(id: number, clientId: number): OrderRow | undefined {
  return getDb()
    .prepare("SELECT * FROM client_order WHERE id = ? AND client_id = ?")
    .get(id, clientId) as unknown as OrderRow | undefined;
}

function domainByOrder(order: OrderRow): DomainRow | undefined {
  if (order.service_id === null || order.service_type !== "domain") return undefined;
  return getDb().prepare("SELECT * FROM service_domain WHERE id = ?").get(order.service_id) as unknown as
    | DomainRow
    | undefined;
}

function assertUsable(order: OrderRow): void {
  if (order.expires_at && new Date(order.expires_at).getTime() <= Date.now()) {
    throw new FbError("Subscription expired");
  }
}

function getServiceAdmin(ctx: CallContext): [OrderRow, DomainRow] {
  if (!ctx.params["order_id"]) throw new FbError("Order ID is missing");
  const order = findOrder(Number(ctx.params["order_id"]));
  if (!order) throw new FbError("Order not found");
  const svc = domainByOrder(order);
  if (!svc) throw new FbError("Domain order is not activated");
  return [order, svc];
}

function getServiceClient(ctx: CallContext): [OrderRow, DomainRow] {
  if (!ctx.params["order_id"]) throw new FbError("Order ID is required");
  const order = findOrderForClient(Number(ctx.params["order_id"]), ctx.session!.client!.id);
  if (!order) throw new FbError("Order not found");
  assertUsable(order);
  const svc = domainByOrder(order);
  if (!svc || order.status !== "active") throw new FbError("Order is not activated");
  return [order, svc];
}

function findTldByTld(raw: string): TldRow | undefined {
  const normalized = normalizeTld(raw);
  return getDb()
    .prepare("SELECT * FROM tld WHERE tld = ? OR tld = ? ORDER BY id ASC LIMIT 1")
    .get(normalized, normalized.slice(1)) as unknown as TldRow | undefined;
}

function getRegistrar(id: number): RegistrarRow {
  const row = getDb().prepare("SELECT * FROM tld_registrar WHERE id = ?").get(id) as unknown as
    | RegistrarRow
    | undefined;
  if (!row) throw new FbError("Registrar not found");
  return row;
}

/**
 * Adapter dispatch for a domain service: resolves the service's registrar
 * row, requires a ported adapter (Custom or Enom), and requires the
 * client row (PHP _getD merges the client profile into the domain).
 */
function resolveAdapter(svc: DomainRow): { reg: RegistrarRow; code: string } {
  if (svc.tld_registrar_id === null) throw new FbError("Registrar not found");
  const reg = getRegistrar(svc.tld_registrar_id);
  if (reg.registrar !== "Custom" && reg.registrar !== "Enom") {
    throw new FbError(`Domain registrar ${reg.registrar} was not found`);
  }
  const client = getDb().prepare("SELECT id FROM client WHERE id = ?").get(svc.client_id);
  if (!client) throw new FbError("Client not found");
  return { reg, code: reg.registrar };
}

/** eNom client config from the stored registrar row (validates required fields). */
function enomConfig(reg: RegistrarRow): EnomConfig {
  const cfg = registrarConfig(reg);
  validateRegistrarConfig(reg, cfg);
  return { username: String(cfg["username"]), password: String(cfg["password"]), testMode: !!reg.test_mode };
}

/** eNom takes bare TLDs ("com"); rows store ".com" or "com". */
function stripDots(tld: string | null): string {
  return (tld ?? "").replace(/^\.+|\.+$/g, "");
}

function epochToTs(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function saveDomain(svc: DomainRow, patch: Partial<DomainRow>): void {
  const next = { ...svc, ...patch };
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  getDbWrite()
    .prepare(`UPDATE service_domain SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...(keys.map((k) => (next as unknown as Record<string, unknown>)[k]) as (string | number | null)[]), nowTimestamp(), svc.id);
}

function bracketSubObject(params: Record<string, string>, prefix: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let found = false;
  for (const [k, v] of Object.entries(params)) {
    const m = new RegExp(`^${prefix}\\[([^\\]]+)\\]$`).exec(k);
    if (m) {
      out[m[1]] = v;
      found = true;
    }
  }
  return found ? out : undefined;
}

function paramPresent(ctx: CallContext, key: string): boolean {
  return ctx.params[key] !== undefined || (ctx.rawParams as Record<string, unknown>)[key] !== undefined;
}

function paramValue(ctx: CallContext, key: string): unknown {
  const raw = (ctx.rawParams as Record<string, unknown>)[key];
  return raw !== undefined ? raw : ctx.params[key];
}

// --- TLD validation (validateTldConfiguration) ---

function validatePriceField(data: Record<string, unknown>, field: string): number | undefined {
  if (!(field in data)) return undefined;
  const v = data[field];
  if (typeof v === "string" && v.trim() === "") throw new FbError("Domain price must be a non-negative number");
  const n = typeof v === "number" ? v : Number(v);
  if (typeof v !== "number" && typeof v !== "string") throw new FbError("Domain price must be a non-negative number");
  if (!Number.isFinite(n) || n < 0) throw new FbError("Domain price must be a non-negative number");
  return n;
}

function validateMinYears(data: Record<string, unknown>): number | undefined {
  if (!("min_years" in data)) return undefined;
  const v = data["min_years"];
  const n = typeof v === "number" ? v : /^-?\d+$/.test(String(v).trim()) ? parseInt(String(v).trim(), 10) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new FbError("Minimum registration period must be a positive integer");
  return n;
}

function normalizePeriodsInput(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (s.trim() === "") return null;
  const years: number[] = [];
  for (const part of s.split(",")) {
    const t = part.trim();
    if (t === "") continue;
    if (!/^-?\d+$/.test(t)) throw new FbError("Registration periods must be a comma-separated list of positive integers");
    const n = parseInt(t, 10);
    if (n < 1) throw new FbError("Registration periods must be a comma-separated list of positive integers");
    years.push(n);
  }
  if (years.length === 0) return null;
  return [...new Set(years)].sort((a, b) => a - b).join(",");
}

// --- Registrations: domain actions ---

register("admin", "servicedomain", "update", (ctx) => {
  requireAdmin(ctx);
  const [, svc] = getServiceAdmin(ctx);
  const patch: Partial<DomainRow> = {};
  if (ctx.params["ns1"] !== undefined) patch.ns1 = ctx.params["ns1"];
  if (ctx.params["ns2"] !== undefined) patch.ns2 = ctx.params["ns2"];
  if (ctx.params["ns3"] !== undefined) patch.ns3 = ctx.params["ns3"];
  if (ctx.params["ns4"] !== undefined) patch.ns4 = ctx.params["ns4"];
  const period = paramValue(ctx, "period");
  if (period !== undefined && period !== null) patch.period = Number(period);
  const privacy = paramValue(ctx, "privacy");
  if (privacy !== undefined && privacy !== null) patch.privacy = phpBool(privacy) ? 1 : 0;
  const locked = paramValue(ctx, "locked");
  if (locked !== undefined && locked !== null) patch.locked = phpBool(locked) ? 1 : 0;
  const tc = paramValue(ctx, "transfer_code");
  if (tc !== undefined && tc !== null) patch.transfer_code = String(tc);
  saveDomain(svc, patch);
  return true;
});

async function updateNameservers(
  ctx: CallContext,
  getService: (ctx: CallContext) => [OrderRow, DomainRow],
): Promise<boolean> {
  const [, svc] = getService(ctx);
  if (ctx.params["ns1"] === undefined && (ctx.rawParams as Record<string, unknown>)["ns1"] === undefined) {
    throw new FbError("Nameserver 1 is required");
  }
  if (ctx.params["ns2"] === undefined && (ctx.rawParams as Record<string, unknown>)["ns2"] === undefined) {
    throw new FbError("Nameserver 2 is required");
  }
  const { reg, code } = resolveAdapter(svc);
  // PHP: adapter modifyNs runs BEFORE the local model set + flush, so
  // an adapter failure persists nothing.
  if (code === "Enom") {
    await enomModifyNs(
      enomConfig(reg),
      svc.sld ?? "",
      stripDots(svc.tld),
      ["ns1", "ns2", "ns3", "ns4"].map((k) => {
        const v = ctx.params[k];
        return v === undefined || v === null ? null : String(v);
      }),
    );
  }
  saveDomain(svc, {
    ns1: ctx.params["ns1"] ?? null,
    ns2: ctx.params["ns2"] ?? null,
    ns3: ctx.params["ns3"] ?? null,
    ns4: ctx.params["ns4"] ?? null,
  });
  return true;
}

register("admin", "servicedomain", "update_nameservers", (ctx) => {
  requireAdmin(ctx);
  return updateNameservers(ctx, getServiceAdmin);
});
register("client", "servicedomain", "update_nameservers", (ctx) => {
  requireClient(ctx);
  return updateNameservers(ctx, getServiceClient);
});

function contactObject(ctx: CallContext): Record<string, unknown> | undefined {
  const raw = (ctx.rawParams as Record<string, unknown>)["contact"];
  if (raw !== null && typeof raw === "object") return raw as Record<string, unknown>;
  const bracket = bracketSubObject(ctx.params, "contact");
  return bracket ? (bracket as Record<string, unknown>) : undefined;
}

async function updateContacts(
  ctx: CallContext,
  getService: (ctx: CallContext) => [OrderRow, DomainRow],
): Promise<boolean> {
  const [, svc] = getService(ctx);
  const contact = contactObject(ctx);
  if (!contact || Object.keys(contact).length === 0) throw new FbError("Required field contact is missing");
  const required: [string, string][] = [
    ["first_name", "Required field first_name is missing"],
    ["last_name", "Required field last_name is missing"],
    ["email", "Required field email is missing"],
    ["address1", "Required field address1 is missing"],
    ["country", "Required field country is missing"],
    ["city", "Required field city is missing"],
    ["state", "Required field state is missing"],
    ["postcode", "Required field postcode is missing"],
    ["phone_cc", "Required field phone_cc is missing"],
    ["phone", "Required field phone is missing"],
  ];
  for (const [field, message] of required) {
    const v = contact[field];
    if (v === undefined || v === null || v === "") throw new FbError(message);
  }
  const { reg, code } = resolveAdapter(svc);
  // PHP sets the model fields before the adapter call but flushes
  // after it, so adapter-first-then-save is equivalent: a failure
  // persists nothing.
  if (code === "Enom") {
    const enomContact: EnomContact = {
      firstName: String(contact["first_name"]),
      lastName: String(contact["last_name"]),
      company: contact["company"] !== undefined && contact["company"] !== null ? String(contact["company"]) : "",
      address1: String(contact["address1"]),
      address2: contact["address2"] !== undefined && contact["address2"] !== null ? String(contact["address2"]) : "",
      country: String(contact["country"]),
      city: String(contact["city"]),
      state: String(contact["state"]),
      postcode: String(contact["postcode"]),
      email: String(contact["email"]),
      phoneCc: String(contact["phone_cc"]),
      phone: String(contact["phone"]),
    };
    await enomModifyContact(enomConfig(reg), svc.sld ?? "", stripDots(svc.tld), enomContact);
  }
  saveDomain(svc, {
    contact_first_name: String(contact["first_name"]),
    contact_last_name: String(contact["last_name"]),
    contact_email: String(contact["email"]),
    contact_company: contact["company"] !== undefined && contact["company"] !== null ? String(contact["company"]) : null,
    contact_address1: String(contact["address1"]),
    contact_address2: contact["address2"] !== undefined && contact["address2"] !== null ? String(contact["address2"]) : null,
    contact_country: String(contact["country"]),
    contact_city: String(contact["city"]),
    contact_state: String(contact["state"]),
    contact_postcode: String(contact["postcode"]),
    contact_phone_cc: String(contact["phone_cc"]),
    contact_phone: String(contact["phone"]),
  });
  return true;
}

register("admin", "servicedomain", "update_contacts", (ctx) => {
  requireAdmin(ctx);
  return updateContacts(ctx, getServiceAdmin);
});
register("client", "servicedomain", "update_contacts", (ctx) => {
  requireClient(ctx);
  return updateContacts(ctx, getServiceClient);
});

async function setPrivacy(
  ctx: CallContext,
  getService: (ctx: CallContext) => [OrderRow, DomainRow],
  value: boolean,
): Promise<boolean> {
  const [, svc] = getService(ctx);
  const { reg, code } = resolveAdapter(svc);
  // PHP: adapter first, then the local flag — a failure flips nothing.
  if (code === "Enom") {
    if (value) {
      await enomEnablePrivacy(enomConfig(reg), svc.sld ?? "", stripDots(svc.tld), svc.period ?? 1);
    } else {
      enomDisablePrivacy();
    }
  }
  saveDomain(svc, { privacy: value ? 1 : 0 });
  return true;
}

register("admin", "servicedomain", "enable_privacy_protection", (ctx) => {
  requireAdmin(ctx);
  return setPrivacy(ctx, getServiceAdmin, true);
});
register("admin", "servicedomain", "disable_privacy_protection", (ctx) => {
  requireAdmin(ctx);
  return setPrivacy(ctx, getServiceAdmin, false);
});
register("client", "servicedomain", "enable_privacy_protection", (ctx) => {
  requireClient(ctx);
  return setPrivacy(ctx, getServiceClient, true);
});
register("client", "servicedomain", "disable_privacy_protection", (ctx) => {
  requireClient(ctx);
  return setPrivacy(ctx, getServiceClient, false);
});

async function setLocked(
  ctx: CallContext,
  getService: (ctx: CallContext) => [OrderRow, DomainRow],
  value: boolean,
): Promise<boolean> {
  const [, svc] = getService(ctx);
  const { reg, code } = resolveAdapter(svc);
  if (code === "Enom") {
    await enomSetLock(enomConfig(reg), svc.sld ?? "", stripDots(svc.tld), value);
  }
  saveDomain(svc, { locked: value ? 1 : 0 });
  return true;
}

register("admin", "servicedomain", "lock", (ctx) => {
  requireAdmin(ctx);
  return setLocked(ctx, getServiceAdmin, true);
});
register("admin", "servicedomain", "unlock", (ctx) => {
  requireAdmin(ctx);
  return setLocked(ctx, getServiceAdmin, false);
});
register("client", "servicedomain", "lock", (ctx) => {
  requireClient(ctx);
  return setLocked(ctx, getServiceClient, true);
});
register("client", "servicedomain", "unlock", (ctx) => {
  requireClient(ctx);
  return setLocked(ctx, getServiceClient, false);
});

function addYears(ts: string, years: number): string {
  const d = new Date(ts.replace(" ", "T") + "Z");
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function syncDomain(svc: DomainRow): Promise<void> {
  const order = getDb()
    .prepare("SELECT * FROM client_order WHERE service_type = 'domain' AND service_id = ? ORDER BY id ASC LIMIT 1")
    .get(svc.id) as unknown as OrderRow | undefined;
  if (!order) throw new FbError("Domain order not found");
  const { reg, code } = resolveAdapter(svc);
  if (code === "Enom") {
    await syncEnomDomain(svc, reg);
    return;
  }
  const client = getDb().prepare("SELECT * FROM client WHERE id = ?").get(svc.client_id) as unknown as
    | Record<string, unknown>
    | undefined;
  const pick = (modelVal: string | null, clientKey: string): string => {
    if (modelVal !== null && modelVal !== "") return modelVal;
    const cv = client?.[clientKey];
    return cv === null || cv === undefined ? "" : String(cv);
  };
  const now = nowTimestamp();
  saveDomain(svc, {
    contact_email: pick(svc.contact_email, "email"),
    contact_first_name: pick(svc.contact_first_name, "first_name"),
    contact_last_name: pick(svc.contact_last_name, "last_name"),
    contact_company: pick(svc.contact_company, "company"),
    contact_address1: pick(svc.contact_address1, "address_1"),
    contact_address2: pick(svc.contact_address2, "address_2"),
    contact_country: pick(svc.contact_country, "country"),
    contact_city: pick(svc.contact_city, "city"),
    contact_state: pick(svc.contact_state, "state"),
    contact_postcode: pick(svc.contact_postcode, "postcode"),
    contact_phone_cc: pick(svc.contact_phone_cc, "phone_cc"),
    contact_phone: pick(svc.contact_phone, "phone"),
    registered_at: now,
    expires_at: svc.expires_at ?? addYears(now, svc.period ?? 1),
    synced_at: now,
  });
}

/**
 * PHP syncWhois for eNom, field by field: locked/privacy copied only
 * when the adapter supplies them (eNom supplies lock via GetRegLock;
 * privacy is null — see enom.ts — so it is never overwritten here);
 * contact fields overwritten directly from the eNom registrant contact
 * (no client-profile merge — that merge is _getD's outbound shape, not
 * sync's); expires/registered via formatRegistrarTimestamp, which maps
 * an unparseable value to null — and GetDomainInfo carries no creation
 * date, so sync wipes registered_at, exactly as PHP would. Nameservers
 * are untouched by syncWhois. The whole patch is one UPDATE after every
 * eNom call succeeds, so a failed call persists nothing.
 */
async function syncEnomDomain(svc: DomainRow, reg: RegistrarRow): Promise<void> {
  const details = await enomGetDomainDetails(enomConfig(reg), svc.sld ?? "", stripDots(svc.tld));
  const patch: Partial<DomainRow> = {
    expires_at: details.expiresAtEpoch !== null ? epochToTs(details.expiresAtEpoch) : null,
    registered_at: null,
    synced_at: nowTimestamp(),
  };
  if (details.locked !== null) patch.locked = details.locked ? 1 : 0;
  if (details.contact) {
    const c = details.contact;
    patch.contact_first_name = c.firstName;
    patch.contact_last_name = c.lastName;
    patch.contact_email = c.email;
    patch.contact_company = c.company;
    patch.contact_address1 = c.address1;
    patch.contact_address2 = c.address2;
    patch.contact_country = c.country;
    patch.contact_city = c.city;
    patch.contact_state = c.state;
    patch.contact_postcode = c.postcode;
    // eNom's Phone is a single string; there is no cc split to write
    // back, so phone_cc is left alone.
    patch.contact_phone = c.phone;
  }
  saveDomain(svc, patch);
}

register("admin", "servicedomain", "sync", async (ctx) => {
  requireAdmin(ctx);
  const [, svc] = getServiceAdmin(ctx);
  await syncDomain(svc);
  return true;
});
register("client", "servicedomain", "sync", async (ctx) => {
  requireClient(ctx);
  const [, svc] = getServiceClient(ctx);
  await syncDomain(svc);
  return true;
});

register("admin", "servicedomain", "get_transfer_code", async (ctx) => {
  requireAdmin(ctx);
  const [, svc] = getServiceAdmin(ctx);
  const { reg, code } = resolveAdapter(svc);
  if (code === "Enom") return enomGetEpp(enomConfig(reg), svc.sld ?? "", stripDots(svc.tld));
  return "";
});
register("client", "servicedomain", "get_transfer_code", async (ctx) => {
  requireClient(ctx);
  const [, svc] = getServiceClient(ctx);
  const { reg, code } = resolveAdapter(svc);
  if (code === "Enom") return enomGetEpp(enomConfig(reg), svc.sld ?? "", stripDots(svc.tld));
  return "";
});

// --- Registrations: TLDs ---

function tldSortClause(params: Record<string, string>): string {
  const allowed: Record<string, string> = {
    tld: "t.tld",
    price_registration: "t.price_registration",
    price_renew: "t.price_renew",
    price_transfer: "t.price_transfer",
    registrar: "r.name",
    id: "t.id",
  };
  const dir = (params["direction"] ?? "").toUpperCase() === "DESC" ? "DESC" : "ASC";
  if (params["sort"] && allowed[params["sort"]]) {
    const col = allowed[params["sort"]];
    return col === "t.id" ? `t.id ${dir}` : `${col} ${dir}, t.id ${dir}`;
  }
  return "t.tld ASC, t.id ASC";
}

register("admin", "servicedomain", "tld_get_list", (ctx) => {
  requireAdmin(ctx);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (paramPresent(ctx, "hide_inactive") && phpBool(paramValue(ctx, "hide_inactive"))) {
    where.push("t.active = 1");
  }
  if (paramPresent(ctx, "allow_register")) {
    where.push("t.allow_register = ?");
    args.push(phpBool(paramValue(ctx, "allow_register")) ? 1 : 0);
  }
  if (paramPresent(ctx, "allow_transfer")) {
    where.push("t.allow_transfer = ?");
    args.push(phpBool(paramValue(ctx, "allow_transfer")) ? 1 : 0);
  }
  const order = tldSortClause(ctx.params);
  const rows = getDb()
    .prepare(
      `SELECT t.* FROM tld t LEFT JOIN tld_registrar r ON r.id = t.tld_registrar_id ${where.length ? `WHERE ${where.join(" AND ")} ` : ""}ORDER BY ${order}`,
    )
    .all(...args) as unknown as TldRow[];
  return paginate(rows.map((r) => tldToApiArray(r, true)), ctx.params);
});

register("admin", "servicedomain", "tld_get", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["tld"]) throw new FbError("TLD is missing");
  const row = findTldByTld(ctx.params["tld"]);
  if (!row) throw new FbError("TLD not found");
  return tldToApiArray(row, true);
});

register("admin", "servicedomain", "tld_get_id", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("ID is missing");
  const row = getDb().prepare("SELECT * FROM tld WHERE id = ?").get(Number(ctx.params["id"])) as unknown as
    | TldRow
    | undefined;
  if (!row) throw new FbError("TLD not found");
  return tldToApiArray(row, true);
});

register("admin", "servicedomain", "tld_delete", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["tld"]) throw new FbError("TLD is missing");
  const normalized = normalizeTld(ctx.params["tld"]);
  const row = findTldByTld(ctx.params["tld"]);
  if (!row) throw new FbError("TLD not found");
  const count = getDb()
    .prepare("SELECT COUNT(*) AS c FROM service_domain WHERE LOWER(RTRIM(TRIM(tld), '.')) IN (?, ?)")
    .get(normalized, normalized.slice(1)) as unknown as { c: number };
  if (count.c > 0) throw new FbError(`TLD is used by ${count.c} domains`, 707);
  getDbWrite().prepare("DELETE FROM tld WHERE id = ?").run(row.id);
  return true;
});

register("admin", "servicedomain", "tld_create", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["tld"]) throw new FbError("TLD is missing");
  if (!ctx.params["tld_registrar_id"]) throw new FbError("TLD registrar ID is missing");
  if (!ctx.params["price_registration"]) throw new FbError("Registration price is missing");
  if (!ctx.params["price_renew"]) throw new FbError("Renewal price is missing");
  if (!ctx.params["price_transfer"]) throw new FbError("Transfer price is missing");
  if (findTldByTld(ctx.params["tld"])) throw new FbError("TLD already registered");
  const data: Record<string, unknown> = {};
  for (const k of ["price_registration", "price_renew", "price_transfer", "min_years", "periods"]) {
    if (paramPresent(ctx, k)) data[k] = paramValue(ctx, k);
  }
  const prices: Record<string, number> = {};
  for (const f of ["price_registration", "price_renew", "price_transfer"]) {
    prices[f] = validatePriceField(data, f)!;
  }
  const minYears = validateMinYears(data);
  const periods = "periods" in data ? normalizePeriodsInput(data["periods"]) : undefined;
  const registrar = getRegistrar(Number(ctx.params["tld_registrar_id"]));
  validateRegistrarConfig(registrar, registrarConfig(registrar));
  const ts = nowTimestamp();
  const info = getDbWrite()
    .prepare(
      `INSERT INTO tld (tld, price_registration, price_renew, price_transfer, allow_register, allow_transfer,
       require_transfer_code, active, min_years, periods, tld_registrar_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      normalizeTld(ctx.params["tld"]),
      String(prices["price_registration"]),
      String(prices["price_renew"]),
      String(prices["price_transfer"]),
      paramPresent(ctx, "allow_register") ? (phpBool(paramValue(ctx, "allow_register")) ? 1 : 0) : 1,
      paramPresent(ctx, "allow_transfer") ? (phpBool(paramValue(ctx, "allow_transfer")) ? 1 : 0) : 1,
      paramPresent(ctx, "require_transfer_code") && phpBool(paramValue(ctx, "require_transfer_code")) ? 1 : 0,
      paramPresent(ctx, "active") ? (phpBool(paramValue(ctx, "active")) ? 1 : 0) : 1,
      minYears ?? 1,
      periods ?? null,
      registrar.id,
      ts,
      ts,
    );
  return Number(info.lastInsertRowid);
});

register("admin", "servicedomain", "tld_update", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["tld"]) throw new FbError("TLD is missing");
  const row = findTldByTld(ctx.params["tld"]);
  if (!row) throw new FbError("TLD not found");
  const data: Record<string, unknown> = {};
  for (const k of ["price_registration", "price_renew", "price_transfer", "min_years", "periods", "tld_registrar_id"]) {
    if (paramPresent(ctx, k)) data[k] = paramValue(ctx, k);
  }
  const validatedPrices: Record<string, string> = {};
  for (const f of ["price_registration", "price_renew", "price_transfer"]) {
    if (f in data && data[f] !== null) validatedPrices[f] = String(validatePriceField(data, f)!);
  }
  const minYears = "min_years" in data && data["min_years"] !== null ? validateMinYears(data) : undefined;
  const periods = "periods" in data ? normalizePeriodsInput(data["periods"]) : undefined;
  let registrarId = row.tld_registrar_id;
  if ("tld_registrar_id" in data && data["tld_registrar_id"] !== null) {
    const reg = getRegistrar(Number(data["tld_registrar_id"]));
    validateRegistrarConfig(reg, registrarConfig(reg));
    registrarId = reg.id;
  }
  const patch: Record<string, unknown> = {
    tld: normalizeTld(row.tld),
    ...validatedPrices,
    ...(minYears !== undefined ? { min_years: minYears } : {}),
    ...(periods !== undefined ? { periods } : {}),
    ...(paramPresent(ctx, "allow_register") ? { allow_register: phpBool(paramValue(ctx, "allow_register")) ? 1 : 0 } : {}),
    ...(paramPresent(ctx, "allow_transfer") ? { allow_transfer: phpBool(paramValue(ctx, "allow_transfer")) ? 1 : 0 } : {}),
    ...(paramPresent(ctx, "require_transfer_code")
      ? { require_transfer_code: phpBool(paramValue(ctx, "require_transfer_code")) ? 1 : 0 }
      : {}),
    ...(paramPresent(ctx, "active") ? { active: phpBool(paramValue(ctx, "active")) ? 1 : 0 } : {}),
    tld_registrar_id: registrarId,
  };
  const sets = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
  getDbWrite()
    .prepare(`UPDATE tld SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...(Object.values(patch) as (string | number | null)[]), nowTimestamp(), row.id);
  return true;
});

// --- Registrations: registrars ---

function installedRegistrarCodes(): string[] {
  const rows = getDb().prepare("SELECT registrar FROM tld_registrar").all() as unknown as { registrar: string | null }[];
  return rows.map((r) => r.registrar).filter((c): c is string => c !== null);
}

register("admin", "servicedomain", "registrar_get_list", (ctx) => {
  requireAdmin(ctx);
  const dir = (ctx.params["direction"] ?? "").toUpperCase() === "DESC" ? "DESC" : "ASC";
  const order = ctx.params["sort"] === "id" ? `tr.id ${dir}` : `tr.name ${dir}, tr.id ${dir}`;
  const rows = getDb().prepare(`SELECT * FROM tld_registrar tr ORDER BY ${order}`).all() as unknown as RegistrarRow[];
  return paginate(rows.map(registrarToApi), ctx.params);
});

register("admin", "servicedomain", "registrar_get_pairs", (ctx) => {
  requireAdmin(ctx);
  const rows = getDb().prepare("SELECT id, name FROM tld_registrar ORDER BY id DESC").all() as unknown as {
    id: number;
    name: string;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.id)] = r.name;
  return Object.keys(out).length > 0 ? out : [];
});

register("admin", "servicedomain", "registrar_get_available", (ctx) => {
  requireAdmin(ctx);
  const installed = new Set(installedRegistrarCodes());
  return ALL_ADAPTER_CODES.filter((c) => !installed.has(c));
});

register("admin", "servicedomain", "registrar_install", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["code"]) throw new FbError("Registrar code is missing");
  const installed = new Set(installedRegistrarCodes());
  if (installed.has(ctx.params["code"]) || !ALL_ADAPTER_CODES.includes(ctx.params["code"])) {
    throw new FbError("Registrar is not available for installation.");
  }
  getDbWrite()
    .prepare("INSERT INTO tld_registrar (name, registrar, test_mode, config) VALUES (?, ?, 0, NULL)")
    .run(ctx.params["code"], ctx.params["code"]);
  return true;
});

register("admin", "servicedomain", "registrar_delete", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Registrar ID is missing");
  const row = getRegistrar(Number(ctx.params["id"]));
  const domains = getDb()
    .prepare("SELECT COUNT(*) AS c FROM service_domain WHERE tld_registrar_id = ?")
    .get(row.id) as unknown as { c: number };
  if (domains.c > 0) throw new FbError(`Registrar is used by ${domains.c} domains`, 707);
  const tlds = getDb().prepare("SELECT COUNT(*) AS c FROM tld WHERE tld_registrar_id = ?").get(row.id) as unknown as {
    c: number;
  };
  if (tlds.c > 0) throw new FbError(`Registrar is used by ${tlds.c} TLDs`, 707);
  getDbWrite().prepare("DELETE FROM tld_registrar WHERE id = ?").run(row.id);
  return true;
});

register("admin", "servicedomain", "registrar_copy", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Registrar ID is missing");
  const row = getRegistrar(Number(ctx.params["id"]));
  const info = getDbWrite()
    .prepare("INSERT INTO tld_registrar (name, registrar, test_mode, config) VALUES (?, ?, ?, NULL)")
    .run(`${row.name} (Copy)`, row.registrar, row.test_mode);
  return Number(info.lastInsertRowid);
});

register("admin", "servicedomain", "registrar_get", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Registrar ID is missing");
  return registrarToApi(getRegistrar(Number(ctx.params["id"])));
});

register("admin", "servicedomain", "registrar_update", (ctx) => {
  requireAdmin(ctx);
  if (!ctx.params["id"]) throw new FbError("Registrar ID is missing");
  const row = getRegistrar(Number(ctx.params["id"]));
  const title = paramValue(ctx, "title");
  const nextName = title !== undefined && title !== null ? String(title) : row.name;
  const nextTestMode = paramPresent(ctx, "test_mode") ? (phpBool(paramValue(ctx, "test_mode")) ? 1 : 0) : row.test_mode;
  let nextConfig = row.config;
  const rawConfig = (ctx.rawParams as Record<string, unknown>)["config"];
  const bracket = bracketSubObject(ctx.params, "config");
  const incoming = isPlainObject(rawConfig) ? (rawConfig as Record<string, unknown>) : bracket
    ? (bracket as Record<string, unknown>)
    : undefined;
  if (incoming !== undefined) {
    const stored = registrarConfig(row);
    const merged: Record<string, unknown> = { ...stored };
    const secrets = adapterSecretFields(row.registrar);
    for (const [key, value] of Object.entries(incoming)) {
      if (secrets.includes(key)) {
        if (value === null || value === undefined || typeof value !== "string") continue;
        if (value.trim() === "" || value === "__KEEP__") continue;
        merged[key] = value;
      } else {
        merged[key] = value;
      }
    }
    const cfg = adapterConfig(row.registrar);
    for (const [field, element] of Object.entries(cfg.form)) {
      const options = element[1];
      if (!(field in merged) && options["default"] !== undefined) merged[field] = options["default"];
    }
    validateRegistrarConfig(row, merged);
    nextConfig = Object.keys(merged).length > 0 ? JSON.stringify(merged) : "[]";
  }
  getDbWrite()
    .prepare("UPDATE tld_registrar SET name = ?, test_mode = ?, config = ? WHERE id = ?")
    .run(nextName, nextTestMode, nextConfig, row.id);
  return true;
});

register("admin", "servicedomain", "batch_sync_expiration_dates", async (ctx) => {
  requireAdmin(ctx);
  const setting = getDb().prepare("SELECT * FROM setting WHERE param = ?").get("servicedomain_last_sync") as unknown as
    | { value: string | null }
    | undefined;
  if (setting?.value) {
    const last = new Date(setting.value.replace(" ", "T") + "Z").getTime();
    if (!Number.isNaN(last) && Date.now() - last < 86400 * 30 * 1000) return false;
  }
  const domains = getDb().prepare("SELECT * FROM service_domain").all() as unknown as DomainRow[];
  for (const d of domains) {
    try {
      if (d.tld_registrar_id === null) throw new FbError("Registrar not found");
      const reg = getRegistrar(d.tld_registrar_id);
      if (reg.registrar === "Custom") {
        const now = nowTimestamp();
        saveDomain(d, { expires_at: d.expires_at ?? addYears(now, d.period ?? 1) });
      } else if (reg.registrar === "Enom") {
        // PHP syncExpirationDate: expires only, and only when the
        // adapter supplies a usable value.
        const exp = await enomGetExpiration(enomConfig(reg), d.sld ?? "", stripDots(d.tld));
        if (exp !== null) saveDomain(d, { expires_at: epochToTs(exp) });
      } else {
        throw new FbError(`Domain registrar ${reg.registrar} was not found`);
      }
    } catch {
      // PHP logs per-domain failures and continues.
    }
  }
  const now = nowTimestamp();
  if (setting) {
    getDbWrite().prepare("UPDATE setting SET value = ?, updated_at = ? WHERE param = ?").run(now, now, "servicedomain_last_sync");
  } else {
    getDbWrite()
      .prepare("INSERT INTO setting (param, value, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("servicedomain_last_sync", now, now, now);
  }
  return true;
});

// --- Registrations: guest ---

register("guest", "servicedomain", "tlds", (ctx) => {
  const where: string[] = ["active = 1"];
  const args: (string | number)[] = [];
  if (paramPresent(ctx, "allow_register")) {
    where.push("allow_register = ?");
    args.push(phpBool(paramValue(ctx, "allow_register")) ? 1 : 0);
  }
  if (paramPresent(ctx, "allow_transfer")) {
    where.push("allow_transfer = ?");
    args.push(phpBool(paramValue(ctx, "allow_transfer")) ? 1 : 0);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM tld WHERE ${where.join(" AND ")} ORDER BY id ASC`)
    .all(...args) as unknown as TldRow[];
  return rows.map((r) => tldToApiArray(r, false));
});

register("guest", "servicedomain", "pricing", (ctx) => {
  if (!ctx.params["tld"]) throw new FbError("TLD is missing");
  const row = findTldByTld(ctx.params["tld"]);
  if (!row) throw new FbError("TLD not found");
  return tldToApiArray(row, false);
});

function guestTldOrThrow(ctx: CallContext, notConfiguredMessage: string): TldRow {
  if (!ctx.params["tld"]) throw new FbError("TLD is missing");
  if (!ctx.params["sld"]) throw new FbError("SLD is missing");
  const row = findTldByTld(ctx.params["tld"]);
  if (!row) throw new FbError(notConfiguredMessage);
  if (!row.active) throw new FbError(notConfiguredMessage.replace("not configured", "not active"));
  return row;
}

register("guest", "servicedomain", "check", async (ctx) => {
  if (!ctx.params["tld"]) throw new FbError("TLD is missing");
  if (!ctx.params["sld"]) throw new FbError("SLD is missing");
  if (!isSldValid(ctx.params["sld"])) throw new FbError(`Domain ${ctx.params["sld"]} is invalid`);
  const row = findTldByTld(ctx.params["tld"]);
  if (!row) throw new FbError("Domain availability could not be determined. TLD is not configured.");
  if (!row.active) throw new FbError("Domain availability could not be determined. TLD is not active.");
  if (!row.allow_register) throw new FbError("Domain cannot be registered", 403);
  if (row.tld_registrar_id === null) throw new FbError("Registrar not found");
  const reg = getRegistrar(row.tld_registrar_id);
  validateRegistrarConfig(reg, registrarConfig(reg));
  if (reg.registrar === "Enom") {
    return enomCheckAvailable(enomConfig(reg), ctx.params["sld"], stripDots(row.tld));
  }
  if (reg.registrar !== "Custom") throw new FbError(`Domain registrar ${reg.registrar} was not found`);
  const cfg = registrarConfig(reg);
  if (phpBool(cfg["use_rdap"])) {
    throw new FbError("RDAP lookups are not available in the Next.js seam");
  }
  return true;
});

register("guest", "servicedomain", "can_be_transferred", async (ctx) => {
  const row = guestTldOrThrow(ctx, "TLD is not configured.");
  if (!row.allow_transfer) throw new FbError("Domain cannot be transferred", 403);
  if (row.tld_registrar_id === null) throw new FbError("Registrar not found");
  const reg = getRegistrar(row.tld_registrar_id);
  validateRegistrarConfig(reg, registrarConfig(reg));
  if (reg.registrar === "Enom") {
    return enomCanBeTransferred(enomConfig(reg), ctx.params["sld"], stripDots(row.tld));
  }
  if (reg.registrar !== "Custom") throw new FbError(`Domain registrar ${reg.registrar} was not found`);
  const cfg = registrarConfig(reg);
  if (phpBool(cfg["use_rdap"])) {
    throw new FbError("RDAP lookups are not available in the Next.js seam");
  }
  return true;
});
