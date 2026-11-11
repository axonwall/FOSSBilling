import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { getDbWrite, getSetting, setSettingValue } from "../db";
import { readExtensionConfig, writeExtensionConfig } from "../crypt";
import { getConfigProperty } from "../config-store";
import { parseZoneDateTime, resolveZone } from "../tz";
import { runCurrencyRatesBeforeCron } from "./currency";
import {
  doBatchRemindersSend,
  healInvoiceJournal,
  removeExpiredUnpaidInvoices,
  runBatchActivatePaid,
  runBatchGenerate,
  runBatchInvokeDueEvent,
  runBatchPayWithCredits,
} from "./invoice";
import {
  runBatchSendSuspensionWarnings,
  runBatchSuspendExpired,
  runBatchCancelSuspended,
  runBatchCancelUnpaid,
} from "./order";
import { runBatchTicketAutoClose } from "./support";
import { runBatchExpirePasswordReminders } from "./client";
import { runBatchExpireCarts } from "./cart";
import { batchSendMail } from "./email";

/**
 * Cron module (Phase 5 batch R5f) — TS port of
 * src/modules/Cron/Service.php runCrons() plus the Cron Api
 * Guest/Admin endpoints. The runner covers all 13 jobs in PHP's
 * fixed order (pay_with_credits and activate_paid NON-isolated;
 * the 11 others isolated by the runner), the finalization gate,
 * the guest throttle, clearOldSessions, and the Before/After
 * listener effects. TS has no event bus, so each listener's
 * DB-visible effect runs as a discrete function at the
 * Before/After point, in dispatch order, each try/caught so a
 * listener failure never fails the run.
 *
 * Parity oracle: capture42.py corpus (docs/nextjs-strangler/phase5/).
 */

// --- finalization gate --------------------------------------------------------
// PHP layers, in order: (1) the Api dispatcher (Client.php
// checkUpdateFinalization) throws for admin calls NOT in
// ALLOWED_ADMIN_API_CALLS when finalization is required; (2) the
// runner's own gate (Cron\Service::runCrons) throws the runner
// message for guest runs. TS envelopes are always HTTP 200 by seam
// convention, so both throw FbError code 503 with the PHP message;
// the HTTP status difference (PHP 503) is documented, not faked.

export const FINALIZATION_DISPATCHER_MESSAGE =
  "FOSSBilling update finalization is pending. Complete finalization before using the admin API.";
export const FINALIZATION_RUNNER_MESSAGE =
  "Update finalization is pending. Cron jobs are paused until finalization is completed.";

function finalizationStatePath(): string | null {
  const dbPath = process.env.FB_DATABASE_PATH;
  if (!dbPath) return null;
  // PATH_DATA = dirname(dirname(FB_DATABASE_PATH)); state file lives in data/.
  const parts = dbPath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `/${parts.slice(0, -2).join("/")}/data/update-finalization.json`;
}

/** stateRequiresFinalization + isCompleteForCurrentVersion: status
 * pending/finalized require finalization; only status 'complete'
 * AND version '0.0.1' (Version::VERSION) is complete. A missing,
 * unreadable, or unparseable state file is treated as gate CLOSED:
 * PHP's ensure() would create a pending state and close the gate,
 * and TS mirrors the observable outcome (503, no jobs) without the
 * ensure side effect (no patcher, no maintenance toggle — that is
 * update-finalization/R5j, not the runner). */
export function finalizationRequired(): boolean {
  const path = finalizationStatePath();
  if (!path) return false;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { status?: string; version?: string };
    if (state.status === "complete" && state.version === "0.0.1") return false;
    return true;
  } catch {
    return true;
  }
}

// --- Before listeners ---------------------------------------------------------

async function cleanupActivityHistory(): Promise<void> {
  const config = await readExtensionConfig("mod_activity");
  const maxAge = Math.trunc(Number(config["max_age"] ?? 90)) || 0;
  const emailMaxAge = Math.trunc(Number(config["email_max_age"] ?? 0)) || 0;
  if (maxAge === 0 && emailMaxAge === 0) return;
  const w = getDbWrite();
  const nowSec = Math.floor(Date.now() / 1000);
  if (maxAge !== 0) {
    const cutoff = new Date((nowSec - maxAge * 86400) * 1000).toISOString().slice(0, 19).replace("T", " ");
    for (const table of ["activity_admin_history", "activity_client_history", "activity_system"]) {
      await w.prepare(`DELETE FROM ${table} WHERE created_at <= ?`).run(cutoff);
    }
  }
  if (emailMaxAge !== 0) {
    const cutoff = new Date((nowSec - emailMaxAge * 86400) * 1000).toISOString().slice(0, 19).replace("T", " ");
    await w.prepare("DELETE FROM activity_client_email WHERE created_at <= ?").run(cutoff);
  }
}

/** Client 900s prune — SEPARATE from the isolated 2h expire job;
 * the runner runs both. */
async function pruneRecentPasswordResets(): Promise<void> {
  const cutoff = new Date(Date.now() - 900_000).toISOString().slice(0, 19).replace("T", " ");
  await getDbWrite().prepare("DELETE FROM client_password_reset WHERE created_at < ?").run(cutoff);
}

/**
 * Servicedomain sync listener: gate — servicedomain_last_sync
 * within 30 days → false, NO write; else per-domain
 * syncExpirationDate (registrar calls; PINNED GAP — the TS runner
 * has no registrar client, so with domains present the timestamp is
 * still set but no per-domain sync occurs) then set
 * servicedomain_last_sync = now. Reference: 0 domains, gate closed
 * by default; parity crafts the stale + 0-domain case.
 */
async function syncServicedomainExpirationDates(): Promise<boolean> {
  const last = await getSetting("servicedomain_last_sync");
  if (last) {
    const lastMs = parseZoneDateTime(resolveZone(), last);
    if (lastMs !== null && Date.now() - lastMs < 30 * 86400_000) return false;
  }
  await setSettingValue("servicedomain_last_sync", new Date().toISOString().slice(0, 19).replace("T", " "));
  return true;
}

/**
 * Documented Before no-ops:
 * - Extension refresh (getExtensionsList): its only DB effect is
 *   pruning vanished-module rows on read; R4a deliberately does NOT
 *   prune on read, so implementing it would contradict R4a.
 * - SEO ping: Seo is NEITHER in Module::CORE_MODULES NOR installed
 *   (no mod_seo extension row), so its Before listener never
 *   registers on the reference — the timestamp is NOT set on PHP,
 *   and TS must NOT set it either.
 * - System GeoIP/cache: GeoIP updateDefaultDatabases is a no-op
 *   with bundled DBs present; cache prune covers only filesystem
 *   pools, which TS has none of.
 * - healSchemaDrift: TS does NOT heal (installer/importer concern);
 *   a schema problem surfaces as a job failure.
 */
async function runBeforeCronEffects(): Promise<void> {
  const effects: [string, () => Promise<unknown>][] = [
    ["activity_cleanup", cleanupActivityHistory],
    ["password_reset_900s_prune", pruneRecentPasswordResets],
    ["currency_rates", runCurrencyRatesBeforeCron],
    // extension_refresh: documented no-op (see comment above).
    // seo_ping: documented no-op (Seo not core, not installed).
    ["servicedomain_sync", syncServicedomainExpirationDates],
    // geoip_cache_prune: documented no-op (no filesystem pools).
  ];
  for (const [name, fn] of effects) {
    try {
      await fn();
    } catch (e) {
      console.error(`[cron] before ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// --- runner -------------------------------------------------------------------

/**
 * Cron\Service::runCrons, in PHP's fixed order:
 * 1. gate (runner message) — throws before any job, event, or
 *    last_cron_exec write;
 * 2. heal slot (documented no-op);
 * 3. Before effects (each try/caught);
 * 4. NON-isolated: pay_with_credits, then activate_paid — NO
 *    try/catch here (an exception aborts the run before
 *    last_cron_exec, exactly as PHP's _exec calls do);
 * 5. 11 isolated jobs in PHP order, each try/caught, failures
 *    collected (return values are IGNORED — a task returning false
 *    does NOT fail the run; only throws do);
 * 6. last_cron_exec = now (UTC in TS; PHP uses process-TZ wall
 *    time — equal under config UTC, pinned standing TZ gap);
 * 7. clearOldSessions (CONFIG.PHP security.session_lifespan, not a
 *    setting — read fresh from the config store via R5a);
 * 8. After effects (each try/caught);
 * 9. return false iff any isolated task failed, else true.
 * Practically unreachable in a clean run: no isolated task throws
 * on constructible input (all swallow per-item failures), and the
 * non-isolated callees swallow per-item failures internally — a
 * non-isolated abort needs a catastrophic failure. Parity proves
 * isolation via per-item fault tolerance + run=true, not faked
 * task failures (see findings-r5f.md).
 */
export async function runCronJobs(): Promise<boolean> {
  if (finalizationRequired()) throw new FbError(FINALIZATION_RUNNER_MESSAGE, 503);

  // healSchemaDrift slot: documented no-op (see comment above).

  await runBeforeCronEffects();

  // NON-isolated — deliberately uncaught.
  await runBatchPayWithCredits();
  await runBatchActivatePaid();

  const failedTasks: string[] = [];
  const isolated: [string, () => Promise<unknown>][] = [
    ["invoice_batch_generate", runBatchGenerate],
    ["invoice_batch_send_reminders", doBatchRemindersSend],
    ["invoice_batch_invoke_due_event", () => runBatchInvokeDueEvent()],
    ["order_batch_send_suspension_warnings", runBatchSendSuspensionWarnings],
    ["order_batch_suspend_expired", runBatchSuspendExpired],
    ["order_batch_cancel_suspended", runBatchCancelSuspended],
    ["order_batch_cancel_unpaid", runBatchCancelUnpaid],
    ["support_batch_ticket_auto_close", runBatchTicketAutoClose],
    ["client_batch_expire_password_reminders", runBatchExpirePasswordReminders],
    ["cart_batch_expire", runBatchExpireCarts],
    ["email_batch_sendmail", batchSendMail],
  ];
  for (const [name, fn] of isolated) {
    try {
      await fn();
    } catch (e) {
      failedTasks.push(name);
      console.error(`[cron] ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  await setSettingValue("last_cron_exec", new Date().toISOString().slice(0, 19).replace("T", " "));
  await clearOldSessions();

  const after: [string, () => Promise<unknown>][] = [
    ["invoice_journal_heal", healInvoiceJournal],
    ["expired_unpaid_removal", removeExpiredUnpaidInvoices],
  ];
  for (const [name, fn] of after) {
    try {
      await fn();
    } catch (e) {
      console.error(`[cron] after ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return failedTasks.length === 0;
}

/**
 * Cron\Service::clearOldSessions (exact): maxAge = now -
 * Config::getProperty('security.session_lifespan', 7200) — a
 * CONFIG.PHP property, NOT a setting; DELETE FROM session WHERE
 * lifetime < now OR created_at <= age. Lifetime/created_at are
 * INTEGER Unix timestamps. The TS config store (R5a) reads
 * config.php fresh every call, so the property is current.
 */
export async function clearOldSessions(): Promise<void> {
  const lifespanRaw = getConfigProperty("security.session_lifespan", 7200);
  const lifespan = typeof lifespanRaw === "number" ? lifespanRaw : parseInt(String(lifespanRaw ?? "7200"), 10) || 7200;
  const now = Math.floor(Date.now() / 1000);
  const age = now - lifespan;
  await getDbWrite()
    .prepare("DELETE FROM session WHERE lifetime < ? OR created_at <= ?")
    .run(now, age);
}

// --- endpoints ----------------------------------------------------------------

function cronPath(): string {
  const dbPath = process.env.FB_DATABASE_PATH ?? "";
  // <src>/data/fossbilling.sqlite -> <src>/cron.php
  return dbPath ? join(dirname(dirname(dbPath)), "cron.php") : "cron.php";
}

register("admin", "cron", "info", async (ctx: CallContext) => {
  requireAdmin(ctx);
  return {
    cron_path: cronPath(),
    last_cron_exec: await getSetting("last_cron_exec"),
  };
});

register("admin", "cron", "run", async (ctx: CallContext) => {
  requireAdmin(ctx);
  // Dispatcher layer first: an admin call when finalization is
  // required gets the dispatcher 503, never the runner's message.
  if (finalizationRequired()) throw new FbError(FINALIZATION_DISPATCHER_MESSAGE, 503);
  return await runCronJobs();
});

/**
 * Cron\Api\Guest::run. Reads the mod_cron EXTENSION config (NOT
 * settings — the old TS handler read settings cron_guest_enabled /
 * cron_hash, which do not exist on the reference, so it always
 * 403'd). guest_cron falsy → 403 permission message; cron_hash
 * empty → the DISTINCT empty-hash 403; provided hash non-string
 * or mismatch → 403 permission message. Throttle (guest only —
 * admin runs are NOT throttled): last_cron_exec non-null and
 * last >= now-60s (exactly 60s ago → throttled, 61s → runs) →
 * return false WITHOUT running and WITHOUT updating last_cron_exec.
 */
register("guest", "cron", "run", async (ctx: CallContext) => {
  const config = await readExtensionConfig("mod_cron");
  const guestEnabled = config["guest_cron"];
  if (guestEnabled === false || guestEnabled === null || guestEnabled === undefined || guestEnabled === 0 || guestEnabled === "0" || guestEnabled === "") {
    throw new FbError("You do not have permission to perform this action", 403);
  }
  const hash = config["cron_hash"];
  if (hash === null || hash === undefined || hash === "") {
    throw new FbError("Guest cron is enabled but no security hash has been configured", 403);
  }
  const provided = ctx.params["hash"];
  if (typeof provided !== "string" || provided !== String(hash)) {
    throw new FbError("You do not have permission to perform this action", 403);
  }
  const last = await getSetting("last_cron_exec");
  if (last) {
    // PHP compares DateTime objects: $t1 = new DateTime($last)
    // (second precision, microseconds 0) >= $t2 = new DateTime('-1min')
    // (current time WITH microseconds) → throttled. So the boundary
    // is age <= 60.000s in wall-clock terms, microsecond-sensitive
    // at exactly 60s — matched here with millisecond precision, not
    // second truncation (which would throttle up to ~1s too long).
    const lastMs = parseZoneDateTime(resolveZone(), last);
    if (lastMs !== null && Date.now() - lastMs <= 60_000) return false;
  }
  return await runCronJobs();
});

/**
 * PHP `!empty($v)` for a request value: undefined/null, false, 0,
 * `""`, `"0"`, and an empty array are empty; anything else — including
 * the string `"false"` and boolean true — is not. JSON posts carry
 * real types in rawParams; urlencoded posts carry strings in params —
 * prefer rawParams when the body was JSON, as extension config_save
 * does. (C-F6: save_settings' guest_cron flag.)
 */
function phpNotEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (v === false || v === 0) return false;
  if (v === "" || v === "0") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function freshCronHash(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Cron\Api\Admin::save_settings — NOT a stub: writes the mod_cron
 * extension config, managing the cron_hash lifecycle exactly as PHP
 * does. The endpoint is specific to the cron module: the stored
 * config is rebuilt as {ext, guest_cron, cron_hash} (setConfig
 * replaces the whole row, it does not merge). Enabling keeps an
 * existing non-empty hash and generates a fresh 64-hex hash only
 * when none exists; disabling clears the hash. Returns setConfig's
 * bool (true). A failed write (unkeyed encryption) throws, as
 * extension config_save does, rather than reporting success.
 */
register("admin", "cron", "save_settings", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const raw = ctx.rawParams;
  const value =
    raw && Object.keys(raw).length > 0 ? raw["guest_cron"] : ctx.params["guest_cron"];
  const guestCron = phpNotEmpty(value);
  let cronHash = "";
  if (guestCron) {
    const existing = await readExtensionConfig("mod_cron");
    const existingHash = existing["cron_hash"];
    cronHash =
      typeof existingHash === "string" && existingHash !== ""
        ? existingHash
        : freshCronHash();
  }
  const ok = await writeExtensionConfig("mod_cron", {
    ext: "mod_cron",
    guest_cron: guestCron,
    cron_hash: cronHash,
  });
  if (!ok) throw new FbError("Failed to encrypt extension configuration");
  return true;
});

/**
 * Cron\Api\Admin::regenerate_cron_hash — NOT a stub: reads the
 * existing mod_cron config, replaces cron_hash with a fresh 64-hex
 * hash, writes the whole config back (preserving guest_cron and any
 * other stored keys, as PHP's getConfig + setConfig round-trip
 * does), and returns {cron_hash}.
 */
register("admin", "cron", "regenerate_cron_hash", async (ctx: CallContext) => {
  requireAdmin(ctx);
  const config = await readExtensionConfig("mod_cron");
  const cronHash = freshCronHash();
  const ok = await writeExtensionConfig("mod_cron", {
    ...config,
    ext: "mod_cron",
    cron_hash: cronHash,
  });
  if (!ok) throw new FbError("Failed to encrypt extension configuration");
  return { cron_hash: cronHash };
});
