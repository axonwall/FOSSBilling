// eNom reseller API client (https://reseller.enom.com/interface.asp).
//
// Every command is an HTTP GET query string with command=/uid=/pw=
// (the API token goes in pw) and ResponseType=XML. Failure model:
// ErrCount > 0 means failure, messages in Err1..ErrN. Command and
// parameter spellings below are verified against api.enom.com docs and
// the HostBill eNom module (a shipping integration), not guessed:
//   check          RRPCode 210 = available, 211 = taken
//   GetRegLock     RegLock field; setRegLock with UnlockRegistrar=0
//                  locks, =1 unlocks
//   GetDNS         NSCount + DNS1..N
//   GetContacts    Registrant*/Admin*/Tech*/AuxBilling* field sets
//   Contacts       omit ContactType and send all four prefixed sets to
//                  update every contact at once
//   ModifyNS       NS1..NS12 params
//   SynchAuthInfo  EmailEpp=True&RunSynchAutoInfo=True emails the auth
//                  code to the registrant; EPPEmailMessage marks success
//   Purchase       RRPCode 200 = registered, 1300 = pending (non-realtime
//                  TLD); ns1.. or usedns=default, ignoreNsFail=yes
//   TP_createorder DomainCount=1, OrderType=Autoverification, sld1/tld1,
//                  numyears, AuthInfo1, usecontacts=1; success=True
//   Extend         numyears (renewal of a not-yet-expired domain)
//   AddToCart      producttype=IDProtect + InsertNewOrder purchases
//                  ID Protect (WHOIS privacy)
// Not implemented, deliberately: there is no verified reseller-API
// command for toggling ID Protect off (the control panel exposes it;
// the purchase path above is the only verified API path), and no
// domain-delete command (domains expire). disablePrivacyProtection
// throws instead of faking success. Renewal of an already-expired
// domain needs updateExpiredDomains and is likewise not implemented.
//
// Live verification is impossible in the sandbox (no eNom credentials,
// and eNom requires the caller IP whitelisted), so every function here
// is exercised against a local fixture-XML mock server instead; see
// docs/nextjs-strangler/phase5/enom-mock-server.mjs.

import { FbError } from "./dispatch";

export interface EnomConfig {
  username: string;
  password: string;
  testMode: boolean;
}

/** One contact, as the TS domain row stores it (phone split in two). */
export interface EnomContact {
  firstName: string;
  lastName: string;
  company: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email: string;
  phoneCc: string;
  phone: string;
}

export interface EnomDomainDetails {
  /** Expiration as epoch seconds, or null when eNom gives no parseable date. */
  expiresAtEpoch: number | null;
  /** GetDomainInfo carries no creation date, so this is always null. */
  registeredAtEpoch: null;
  /** Null when the lock state cannot be determined. */
  locked: boolean | null;
  /** Null: the WPPS service-node shape was not verified, so sync leaves privacy untouched. */
  privacy: null;
  ns: string[];
  /** Null when the contacts fetch fails; the caller then fails the whole sync, like PHP. */
  contact: EnomContact | null;
}

function baseUrl(testMode: boolean): string {
  const override = process.env.FB_ENOM_API_URL;
  if (override) return override;
  return testMode ? "https://resellertest.enom.com/interface.asp" : "https://reseller.enom.com/interface.asp";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => String.fromCharCode(parseInt(n, 16)));
}

/**
 * Flat first-wins field map for eNom's XML responses. eNom's response
 * XML is flat for the fields this client reads (nested service nodes
 * are deliberately not parsed), so a small regex extractor beats a
 * dependency. Tag lookup is case-insensitive; eNom varies tag case
 * between commands (RRPCode vs RRPText, ErrCount vs Err1).
 */
function parseXmlFields(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const pair = /<([A-Za-z0-9_.-]+)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = pair.exec(xml)) !== null) {
    const key = m[1].toLowerCase();
    if (!out.has(key)) out.set(key, decodeEntities(m[2].trim()));
  }
  const empty = /<([A-Za-z0-9_.-]+)(?:\s[^>]*)?\/>/g;
  while ((m = empty.exec(xml)) !== null) {
    const key = m[1].toLowerCase();
    if (!out.has(key)) out.set(key, "");
  }
  return out;
}

async function call(cfg: EnomConfig, command: string, extra: Record<string, string>): Promise<Map<string, string>> {
  const params = new URLSearchParams({
    command,
    uid: cfg.username,
    pw: cfg.password,
    responsetype: "xml",
    ...extra,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl(cfg.testMode)}?${params.toString()}`, { signal: ctrl.signal });
  } catch (err) {
    throw new FbError(`eNom request failed: ${err instanceof Error ? err.message : "network error"}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new FbError(`eNom request failed with HTTP ${res.status}`);
  const fields = parseXmlFields(await res.text());
  const errCount = Number(fields.get("errcount") ?? "0");
  if (Number.isFinite(errCount) && errCount > 0) {
    const msgs: string[] = [];
    for (let i = 1; i <= errCount; i++) {
      const msg = fields.get(`err${i}`);
      if (msg) msgs.push(msg);
    }
    throw new FbError(msgs.length > 0 ? msgs.join("; ") : "eNom request failed");
  }
  return fields;
}

function parseBool(v: string | undefined): boolean | null {
  if (v === undefined) return null;
  if (v === "1" || v.toLowerCase() === "true") return true;
  if (v === "0" || v.toLowerCase() === "false") return false;
  return null;
}

/** eNom Expiration strings ("2027-03-15", "3/15/2027", datetimes) to epoch seconds. */
function parseEnomDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

function domainParams(sld: string, tld: string): Record<string, string> {
  return { sld, tld };
}

export async function enomCheckAvailable(cfg: EnomConfig, sld: string, tld: string): Promise<boolean> {
  const f = await call(cfg, "check", domainParams(sld, tld));
  const code = f.get("rrpcode");
  if (code === "210") return true;
  if (code === "211") return false;
  throw new FbError(f.get("rrptext") ?? "eNom availability check failed");
}

export async function enomGetRegLock(cfg: EnomConfig, sld: string, tld: string): Promise<boolean | null> {
  const f = await call(cfg, "GetRegLock", domainParams(sld, tld));
  return parseBool(f.get("reglock"));
}

export async function enomCanBeTransferred(cfg: EnomConfig, sld: string, tld: string): Promise<boolean> {
  // No dedicated "can transfer" command: a registered, unlocked domain
  // can transfer; an available name has nothing to transfer, and a
  // locked domain cannot transfer until unlocked.
  if (await enomCheckAvailable(cfg, sld, tld)) return false;
  const locked = await enomGetRegLock(cfg, sld, tld);
  return locked !== true;
}

export async function enomGetExpiration(cfg: EnomConfig, sld: string, tld: string): Promise<number | null> {
  const f = await call(cfg, "GetDomainInfo", domainParams(sld, tld));
  return parseEnomDate(f.get("expiration"));
}

function contactFromFields(f: Map<string, string>, prefix: string): EnomContact {
  const p = prefix.toLowerCase();
  const get = (field: string): string => f.get(`${p}${field.toLowerCase()}`) ?? "";
  return {
    firstName: get("firstname"),
    lastName: get("lastname"),
    company: get("organizationname"),
    address1: get("address1"),
    address2: get("address2"),
    city: get("city"),
    state: get("stateprovince"),
    postcode: get("postalcode"),
    country: get("country"),
    email: get("emailaddress"),
    phoneCc: "",
    phone: get("phone"),
  };
}

export async function enomGetDomainDetails(cfg: EnomConfig, sld: string, tld: string): Promise<EnomDomainDetails> {
  const info = await call(cfg, "GetDomainInfo", domainParams(sld, tld));
  const lock = await enomGetRegLock(cfg, sld, tld);
  const dns = await call(cfg, "GetDNS", domainParams(sld, tld));
  const nsCount = Number(dns.get("nscount") ?? "0");
  const ns: string[] = [];
  if (Number.isFinite(nsCount)) {
    for (let i = 1; i <= nsCount; i++) {
      const v = dns.get(`dns${i}`);
      if (v) ns.push(v);
    }
  }
  const contacts = await call(cfg, "GetContacts", domainParams(sld, tld));
  return {
    expiresAtEpoch: parseEnomDate(info.get("expiration")),
    registeredAtEpoch: null,
    locked: lock,
    privacy: null,
    ns,
    contact: contactFromFields(contacts, "Registrant"),
  };
}

export async function enomModifyNs(cfg: EnomConfig, sld: string, tld: string, ns: (string | null)[]): Promise<void> {
  const extra: Record<string, string> = { ...domainParams(sld, tld) };
  let i = 1;
  for (const server of ns) {
    if (server !== null && server !== "") {
      extra[`NS${i}`] = server;
      i++;
    }
  }
  await call(cfg, "ModifyNS", extra);
}

function contactFieldSet(prefix: string, c: EnomContact): Record<string, string> {
  // Namecheap-adapter precedent for the single Phone field.
  const phone = c.phoneCc ? `+${c.phoneCc}.${c.phone}` : c.phone;
  const out: Record<string, string> = {
    [`${prefix}FirstName`]: c.firstName,
    [`${prefix}LastName`]: c.lastName,
    [`${prefix}OrganizationName`]: c.company,
    [`${prefix}Address1`]: c.address1,
    [`${prefix}City`]: c.city,
    [`${prefix}Country`]: c.country,
    [`${prefix}EmailAddress`]: c.email,
    [`${prefix}Phone`]: phone,
  };
  if (c.address2) out[`${prefix}Address2`] = c.address2;
  if (c.state) {
    out[`${prefix}StateProvinceChoice`] = "S";
    out[`${prefix}StateProvince`] = c.state;
  }
  if (c.postcode) out[`${prefix}PostalCode`] = c.postcode;
  return out;
}

export async function enomModifyContact(cfg: EnomConfig, sld: string, tld: string, c: EnomContact): Promise<void> {
  // Omit ContactType and send all four sets with the same data, so no
  // contact type is left empty/defaulted (eNom docs warning).
  const extra: Record<string, string> = { ...domainParams(sld, tld) };
  for (const prefix of ["Registrant", "AuxBilling", "Tech", "Admin"]) {
    Object.assign(extra, contactFieldSet(prefix, c));
  }
  await call(cfg, "Contacts", extra);
}

/** eNom never returns the code over the API; it emails it to the registrant. */
export async function enomGetEpp(cfg: EnomConfig, sld: string, tld: string): Promise<string> {
  const f = await call(cfg, "SynchAuthInfo", {
    ...domainParams(sld, tld),
    EmailEpp: "True",
    RunSynchAutoInfo: "True",
  });
  if (f.has("eppemailmessage")) return "EPP code emailed to registrant";
  throw new FbError("eNom did not confirm the auth code email");
}

export async function enomSetLock(cfg: EnomConfig, sld: string, tld: string, locked: boolean): Promise<void> {
  await call(cfg, "SetRegLock", { ...domainParams(sld, tld), UnlockRegistrar: locked ? "0" : "1" });
}

export async function enomEnablePrivacy(cfg: EnomConfig, sld: string, tld: string, years: number): Promise<void> {
  await call(cfg, "AddToCart", { ...domainParams(sld, tld), producttype: "IDProtect", quantity: String(years) });
  await call(cfg, "InsertNewOrder", {});
}

export function enomDisablePrivacy(): never {
  throw new FbError(
    "eNom ID Protect cannot be disabled through the reseller API; disable it in the eNom control panel (Domains → ID Protect → Unprotected)",
  );
}

// --- Lifecycle: no TS caller yet (order activation is status-only in
// the TS order module). Implemented against the verified commands so
// the future provisioning bridge can call them; mock-tested. ---

export async function enomRegisterDomain(
  cfg: EnomConfig,
  sld: string,
  tld: string,
  period: number,
  c: EnomContact,
  ns: (string | null)[],
): Promise<boolean> {
  const extra: Record<string, string> = {
    ...domainParams(sld, tld),
    numyears: String(period),
    ignoreNsFail: "yes",
    ...contactFieldSet("Registrant", c),
  };
  let i = 1;
  let anyNs = false;
  for (const server of ns) {
    if (server !== null && server !== "") {
      extra[`ns${i}`] = server;
      i++;
      anyNs = true;
    }
  }
  if (!anyNs) extra["usedns"] = "default";
  const f = await call(cfg, "Purchase", extra);
  const code = f.get("rrpcode");
  if (code === "200" || code === "1300") return true;
  throw new FbError(f.get("rrptext") ?? "eNom registration failed");
}

export async function enomTransferDomain(
  cfg: EnomConfig,
  sld: string,
  tld: string,
  period: number,
  epp: string,
): Promise<boolean> {
  const f = await call(cfg, "TP_createorder", {
    DomainCount: "1",
    OrderType: "Autoverification",
    sld1: sld,
    tld1: tld,
    numyears: String(period),
    AuthInfo1: epp,
    usecontacts: "1",
  });
  if ((f.get("success") ?? "").toLowerCase() === "true") return true;
  throw new FbError("eNom transfer order failed");
}

export async function enomRenewDomain(cfg: EnomConfig, sld: string, tld: string, period: number): Promise<boolean> {
  await call(cfg, "Extend", { ...domainParams(sld, tld), numyears: String(period) });
  return true;
}
