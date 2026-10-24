import { dirname, join } from "node:path";
import { getDb, getSetting, setSettingValue, nowTimestamp } from "../db";
import { FbError, register, requireAdmin, type CallContext } from "../dispatch";
import { runBatchActivatePaid, runBatchSendReminders } from "./invoice";
import {
  runBatchCancelSuspended,
  runBatchCancelUnpaid,
  runBatchSuspendExpired,
} from "./order";

/**
 * Cron module (Phase 3 batch 4) — admin info/run plus the guest
 * trigger. PHP's runCrons walks every module's batch jobs in a fixed
 * order; the TS runner covers the money-path jobs it owns (invoice
 * activation/reminders/generation, order expiry sweeps) and records
 * last_cron_exec. Jobs belonging to PHP-only modules (support
 * auto-close, email queue) still run under PHP cron during the
 * strangler period — the endpoints agree on the shared state.
 */

function cronPath(): string {
  const dbPath = process.env.FB_DATABASE_PATH ?? "";
  // <src>/data/fossbilling.sqlite -> <src>/cron.php
  return dbPath ? join(dirname(dirname(dbPath)), "cron.php") : "cron.php";
}

export function runCronJobs(): void {
  runBatchActivatePaid();
  runBatchSendReminders();
  runBatchSuspendExpired();
  runBatchCancelSuspended();
  runBatchCancelUnpaid();
  void getDb;
  setSettingValue("last_cron_exec", nowTimestamp());
}

register("admin", "cron", "info", (ctx: CallContext) => {
  requireAdmin(ctx);
  return {
    cron_path: cronPath(),
    last_cron_exec: getSetting("last_cron_exec"),
  };
});

register("admin", "cron", "run", (ctx: CallContext) => {
  requireAdmin(ctx);
  runCronJobs();
  return true;
});

register("guest", "cron", "run", (ctx: CallContext) => {
  // Mirrors PHP: the guest trigger needs the module's guest_cron
  // setting enabled AND the configured security hash.
  const enabled = getSetting("cron_guest_enabled");
  const hash = getSetting("cron_hash");
  if (enabled !== "1" || !hash) {
    throw new FbError("You do not have permission to perform this action", 403);
  }
  if ((ctx.params["hash"] ?? "") !== hash) {
    throw new FbError("You do not have permission to perform this action", 403);
  }
  runCronJobs();
  return true;
});
