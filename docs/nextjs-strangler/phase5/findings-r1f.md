# Phase 5 R1 — eNom registrar adapter (findings-r1f)

Josh directed 2026-10-26: "Build the enom adapter". This narrows the
registrar-scope question: eNom is added; Email, Internetbs, Namecheap,
Resellerclub (+ subclasses) remain cut. eNom is NOT in FOSSBilling
0.8.9 in-tree, so there is no PHP oracle to parity against — the
adapter is new code, verified against a fixture-XML mock eNom server
instead of live eNom (no credentials in the sandbox, and eNom requires
the caller IP whitelisted).

## What shipped

- `apps/nextjs/src/server/enom.ts` — eNom reseller API client
  (GET `interface.asp`, `ResponseType=XML`, 10s timeout, `ErrCount>0`
  → FbError with the eNom messages).
- `apps/nextjs/src/server/modules/servicedomain.ts` — Enom wired
  into the adapter dispatch: `ADAPTER_CONFIGS` gains `Enom` (username
  text required, password password required+secret; test mode rides
  the existing `tld_registrar.test_mode` column), so
  `registrar_get_available` / `registrar_install` / `registrar_update`
  / `registrar_get` / `registrar_copy` work through the existing
  metadata machinery, including secret masking (`password` → null +
  `password_set`) and the standard missing-config message.
- TS-served surface for Enom domains (admin + client where the
  endpoint exists): guest `check`, guest `can_be_transferred`,
  `update_nameservers`, `update_contacts`, `lock`, `unlock`,
  `enable_privacy_protection`, `disable_privacy_protection`,
  `get_transfer_code`, `sync`, `batch_sync_expiration_dates`.
- `FB_ENOM_API_URL` env override selects the endpoint (default:
  reseller host, or resellertest when the registrar row has test_mode);
  the mock smoke test points it at a local fixture server.

## Command map (verified, not guessed)

Sources: api.enom.com docs pages for Check, GetDomainInfo,
GetRegLock, Contacts; the HostBill eNom module (shipping
integration) for the rest.

| TS operation | eNom command(s) |
|---|---|
| check | `check`, RRPCode 210 = available, 211 = taken |
| can_be_transferred | `check` (211) + `GetRegLock` (unlocked) |
| modifyNs | `ModifyNS`, NS1.. for non-empty servers |
| modifyContact | `Contacts`, no ContactType, all four prefixed sets (Registrant/AuxBilling/Tech/Admin) with the same data — eNom docs warn unsupplied contacts become empty/defaults |
| getEpp | `SynchAuthInfo&EmailEpp=True&RunSynchAutoInfo=True`; success marker `EPPEmailMessage` |
| lock / unlock | `SetRegLock&UnlockRegistrar=0` / `=1` |
| enablePrivacy | `AddToCart&producttype=IDProtect&quantity=<period>` + `InsertNewOrder` |
| sync details | `GetDomainInfo` (Expiration) + `GetRegLock` + `GetDNS` (NSCount/DNSn) + `GetContacts` (Registrant*) |
| batch sync | `GetDomainInfo` only (expires) |
| register (future bridge) | `Purchase`, RRPCode 200 registered / 1300 pending (non-realtime TLD), `ignoreNsFail=yes`, `usedns=default` when no nameservers |
| transfer (future bridge) | `TP_createorder&DomainCount=1&OrderType=Autoverification&sld1&tld1&numyears&AuthInfo1&usecontacts=1`, `success=True` |
| renew (future bridge) | `Extend&numyears` |

## Semantics pinned to PHP Servicedomain/Service.php

- Adapter-first ordering everywhere: the eNom call runs before the
  local save, so an eNom failure persists nothing (matches PHP's
  adapter-before-flush for nameservers/contacts/privacy/lock).
- Sync follows PHP `syncWhois` exactly, not the Custom sync: contact
  fields are overwritten directly from the eNom registrant contact (no
  client-profile merge — that merge is `_getD`'s outbound shape);
  locked copied only when determinable; privacy never overwritten
  (see below); nameservers untouched by sync; `expires_at` from the
  eNom date string, `registered_at` wiped to NULL (GetDomainInfo
  carries no creation date, and PHP's `formatRegistrarTimestamp(null)`
  is null); `synced_at` stamped. One UPDATE after all four eNom calls
  succeed.
- Batch sync sets expires only, and only when eNom supplies a usable
  date (PHP `syncExpirationDate`).
- Contacts Phone uses the Namecheap-adapter precedent:
  `+<phone_cc>.<phone>`. Sync-back writes eNom's single Phone string
  verbatim to `contact_phone` and leaves `contact_phone_cc` alone
  (no cc split exists to write back).
- TLDs are stripped of leading/trailing dots before eNom calls
  (rows store `.com` or `com`; eNom wants `com`).
- `get_transfer_code` returns the sentinel string `EPP code emailed
  to registrant`: eNom never returns the code over the API, it emails
  it. Returning "" (Custom's shape) would imply "no code exists".

## Deliberate gaps (documented, not silent)

- `disable_privacy_protection` THROWS: `eNom ID Protect cannot be
  disabled through the reseller API; disable it in the eNom control
  panel (Domains → ID Protect → Unprotected)`. No disable command
  could be verified in api.enom.com docs, HostBill, or WWW::eNom
  sources (only the purchase path is verified); a fake success would
  flip the local flag while WHOIS stays masked. The local flag is
  unchanged on the throw.
- Sync privacy is never overwritten: the WPPS service-node shape in
  GetDomainInfo XML (1120 masked / 1123 viewable) was not verified
  end-to-end, so the client reports privacy null and sync leaves it
  alone (PHP's null-preserving rule). Resolving this needs one live
  GetDomainInfo response (or GetWPPSInfo output) from a real account.
- Lifecycle methods (`enomRegisterDomain`, `enomTransferDomain`,
  `enomRenewDomain`) are implemented and mock-tested but have NO TS
  caller: the TS order module's activate/cancel are status-only and
  never invoke servicedomain lifecycle. Wiring the provisioning bridge
  (order activation → servicedomain action_activate/renew/cancel) is
  a separate item. Renewal of an already-expired domain needs
  `updateExpiredDomains` (not implemented); `Extend` covers
  not-yet-expired renewals only. There is no eNom domain-delete API;
  deletion is expiry.
- Live eNom verification is still pending Josh's credentials/test
  account + IP whitelist. The mock fixtures mirror the documented
  response shapes (RRPCode 210/211, RegLock 1/0, NSCount/DNSn,
  Registrant* fields, EPPEmailMessage, ErrCount/ErrN), but field
  casing and date formats on the real API are the residual risk —
  the client's tag lookup is case-insensitive and its date parser
  accepts both `YYYY-MM-DD` and `M/D/YYYY` forms to absorb that.

## Verification (2026-10-26)

- `tsc --noEmit` clean; `next build` clean.
- `enom-smoke.py`: 60/60 checks against the mock server on a
  disposable DB copy — registrar install/config validation/secret
  masking, guest check + transfer checks (available/taken/locked),
  all domain actions admin + client lock, sync field-by-field,
  batch sync + last_sync refresh, eNom error surfacing (ErrCount,
  bad credentials), and mock-log assertions that the exact commands
  and parameters were sent (ModifyNS NS1/NS2, Contacts ×4 prefixes +
  `+cc.phone`, SetRegLock 0/1, SynchAuthInfo flags, ID Protect
  AddToCart + InsertNewOrder). Reference DB untouched by the smoke.
- `parity21.py`: 195/203 (was 196/203 at D7). The 7 D7 diffs are
  unchanged (all the `tld_delete` MySQL-only-TRIM upstream defect:
  3 direct + 4 downstream listings). The ONE new diff is expected and
  correct: `sd_reg_available` — TS now lists `Enom`, PHP 0.8.9 does
  not have it. No Custom-path regressions.
- Fixtures: 13/13 on both PHP and Next stacks.
- Reference DB invariants re-verified after the runs: tld 1 row,
  tld_registrar 3 rows, service_domain 0 rows, email_queue 67,
  `servicedomain_last_sync` unchanged.

## Count

TS-served total is unchanged at 456/579 by endpoint count (the eNom
adapter adds no new endpoints; it makes existing servicedomain
endpoints work for a second registrar code). Registrar codes with
action dispatch: Custom, Enom. All other in-tree codes still throw
the post-cut not-found error on actions.
