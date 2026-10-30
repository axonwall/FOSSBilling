// FOSSBilling Phase 5 R5j: operator CLI for the update-finalization
// state machine (src/server/update-finalization.ts). The R5f cron gate
// refuses while finalization is pending; this tool is what moves a
// pending state to complete. It does NOT resurrect the removed admin API
// endpoints (settled R1 decision).
//
// The tool operates on an EXISTING install: the DB connection comes from
// the install's own config.php (db driver + sqlite path, or Postgres
// host/port/name/user/password). MySQL targets are refused (TS has no
// MySQL target; legacy MySQL patches are out by definition).
//
// Commands (default: finalize-and-complete, the PHP CLI path):
//   status                 Show the state + whether finalization is required.
//   finalize               Run finalizePendingUpdate (pending -> finalized).
//   complete               Run completeFinalization (finalized -> complete).
//   finalize-and-complete  Both steps, under one lock (plus ensure() when
//                          no state exists at all).
// Flags: --install-root DIR (required), --config-path FILE (default
//   <root>/config.php), --json.
// Exit codes: 0 ok, 1 error (including a finalize that fails mid-patches
//   — the state stays pending and maintenance stays ON by design).
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { DbSqlite, type Db } from "../src/server/db";
import { DbPg } from "../src/server/pg";
import { readConfigFile } from "../src/server/config-store";
import {
  completeFinalization,
  finalizeAndComplete,
  finalizePendingUpdate,
  isCompleteForCurrentVersion,
  readState,
  stateRequiresFinalization,
  type FinalizationState,
} from "../src/server/update-finalization";

function usage(): void {
  console.log(
    "Usage: node scripts/run-finalize-update.mjs [status|finalize|complete|finalize-and-complete]\n" +
      "  --install-root DIR [--config-path FILE] [--json]",
  );
}

export async function main(argv: string[]): Promise<number> {
  let command = "finalize-and-complete";
  let installRoot: string | null = null;
  let configPath: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help") { usage(); return 0; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--install-root" && i + 1 < argv.length) { installRoot = argv[++i]!; continue; }
    if (arg === "--config-path" && i + 1 < argv.length) { configPath = argv[++i]!; continue; }
    if (!arg.startsWith("--") && ["status", "finalize", "complete", "finalize-and-complete"].includes(arg)) {
      command = arg;
      continue;
    }
    console.error(`finalize-update FAILED: unexpected argument: ${arg}`);
    return 1;
  }
  if (!installRoot) {
    console.error("finalize-update FAILED: --install-root is required.");
    return 1;
  }
  const resolvedConfig = configPath ?? path.join(installRoot, "config.php");
  if (!fs.existsSync(resolvedConfig)) {
    console.error(`finalize-update FAILED: config file not found: ${resolvedConfig}`);
    return 1;
  }
  try {
    const config = readConfigFile(resolvedConfig);
    const dbConfig = config["db"] as Record<string, unknown> | undefined;
    const driver = dbConfig?.["driver"];
    let db: Db;
    let platform: "sqlite" | "postgres";
    let closeDb: () => Promise<void>;
    if (driver === "pdo_sqlite") {
      const dbPath = dbConfig?.["path"];
      if (typeof dbPath !== "string" || dbPath === "") {
        console.error("finalize-update FAILED: sqlite config has no db.path.");
        return 1;
      }
      const conn = new DatabaseSync(dbPath);
      db = new DbSqlite(conn);
      platform = "sqlite";
      closeDb = async () => { conn.close(); };
    } else if (driver === "pdo_pgsql") {
      const pool = new Pool({
        host: typeof dbConfig?.["host"] === "string" ? (dbConfig["host"] as string) : "127.0.0.1",
        port: typeof dbConfig?.["port"] === "number" ? (dbConfig["port"] as number) : 5432,
        database: typeof dbConfig?.["name"] === "string" ? (dbConfig["name"] as string) : "fossbilling",
        user: typeof dbConfig?.["user"] === "string" ? (dbConfig["user"] as string) : "fossbilling",
        password: typeof dbConfig?.["password"] === "string" ? (dbConfig["password"] as string) : "",
      });
      db = new DbPg(pool);
      platform = "postgres";
      closeDb = async () => { await pool.end(); };
    } else {
      console.error(`finalize-update FAILED: Unsupported database driver.`);
      return 1;
    }
    try {
      if (command === "status") {
        const state = readState(installRoot);
        const maintenance = config["maintenance_mode"] as Record<string, unknown> | undefined;
        const report = {
          state,
          requiresFinalization: stateRequiresFinalization(state),
          completeForCurrentVersion: isCompleteForCurrentVersion(state),
          maintenanceEnabled: maintenance?.["enabled"] ?? false,
        };
        if (json) console.log(JSON.stringify(report, null, 2));
        else {
          console.log(`state: ${state === null ? "(none)" : state.status}`);
          console.log(`requires finalization: ${report.requiresFinalization}`);
          console.log(`complete for current version: ${report.completeForCurrentVersion}`);
          console.log(`maintenance enabled: ${report.maintenanceEnabled}`);
        }
        return 0;
      }
      let state: FinalizationState | null;
      if (command === "finalize") {
        state = await finalizePendingUpdate(installRoot, resolvedConfig, db, platform);
      } else if (command === "complete") {
        state = completeFinalization(installRoot, resolvedConfig);
      } else {
        state = await finalizeAndComplete(installRoot, resolvedConfig, db, platform);
      }
      if (json) console.log(JSON.stringify({ command, state }, null, 2));
      else console.log(`${command}: state is now ${state === null ? "(none)" : state.status}`);
      return 0;
    } finally {
      await closeDb();
    }
  } catch (e) {
    console.error(`finalize-update FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
