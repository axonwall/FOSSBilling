// FOSSBilling Phase 5 R4d — salt re-key tool (closes the R3b-deferred
// re-key item, D4-5). Re-encrypts the two at-rest-encrypted columns
// (extension_meta.meta_value, email_template.vars) from an OLD install
// salt to a NEW one, using the seam's crypt.ts (AES-256-CBC,
// PBKDF2-SHA256, 'v2:' prefix) and the seam's Db interface.
//
// SECRET DISCIPLINE: this tool handles secrets. It NEVER prints a salt,
// a decrypted value, or a ciphertext — output is counts + statuses
// only. Salts arrive via explicit env vars (FB_REKEY_OLD_SALT /
// FB_REKEY_NEW_SALT); the tool deliberately does NOT read the live
// FB_INFO_SALT as "old", because the operator may already have
// switched env — the operator steps are: backup, run with explicit
// salts, verify, THEN switch the env salt.
//
// SAFETY ORDER (deliberately better than the R3b importer's
// post-commit verification caveat — see findings-r4d):
//   1. Scan both columns; classify v2: vs non-v2: rows.
//   2. Pre-scan: decrypt EVERY v2: value with OLD. ANY failure
//      refuses BEFORE any write; the DB is left untouched.
//   3. Write + verify inside ONE transaction: re-encrypt with NEW,
//      update all v2: rows, re-read them inside the transaction,
//      decrypt with NEW and compare to the originals. Any mismatch
//      throws -> rollback -> refusal. Nothing commits unverified.
//   4. Zero v2: rows -> status VACUOUS, never PASS, no writes (the
//      R2e lesson: a vacuous check proves nothing about salt
//      correctness). VACUOUS exits non-zero so no operator script
//      can mistake it for a verified re-key.
// Non-v2: rows are left untouched, counted, and reported (R3b's
// verbatim precedent: crypt.ts returns null for non-v2: input, and
// the tool must not "fix" values it cannot prove are encrypted).
//
// Target: FB_DATABASE_URL set -> Postgres (own Pool, ended at the
// end — the createPgDb singleton cannot be ended from a script, R3b
// precedent); otherwise FB_DATABASE_PATH -> SQLite. Neither set is a
// refusal. Run the tool with the app server stopped (see operator
// steps in findings-r4d.md); it opens its own connection either way.
//
// Usage: node scripts/run-rekey-salt.mjs [--dry-run] [--help]
// Env: FB_REKEY_OLD_SALT, FB_REKEY_NEW_SALT, FB_DATABASE_URL or
//   FB_DATABASE_PATH. Exit: 0 verified/dry-run/help, 1 refusal,
//   2 vacuous.

import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { DbPg } from "../src/server/pg";
import { DbSqlite, type Db } from "../src/server/db";
import { decryptV2, encryptV2 } from "../src/server/crypt";

export class RekeyRefusal extends Error {}

export interface EncryptedColumn {
  table: string;
  column: string;
}

/** The two at-rest-encrypted columns (R3b survey, verified not guessed). */
export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  { table: "extension_meta", column: "meta_value" },
  { table: "email_template", column: "vars" },
];

export interface ColumnCounts {
  table: string;
  column: string;
  total: number;
  v2: number;
  nonV2: number;
}

interface V2Row {
  table: string;
  column: string;
  id: number;
  value: string;
}

interface Target {
  db: Db;
  close: () => Promise<void>;
}

function buildTarget(): Target {
  const pgUrl = process.env.FB_DATABASE_URL;
  if (pgUrl) {
    const pool = new Pool({ connectionString: pgUrl });
    return { db: new DbPg(pool), close: () => pool.end() };
  }
  const path = process.env.FB_DATABASE_PATH;
  if (path) {
    const conn = new DatabaseSync(path);
    return { db: new DbSqlite(conn), close: async () => conn.close() };
  }
  throw new RekeyRefusal(
    "no target database: set FB_DATABASE_URL (Postgres) or FB_DATABASE_PATH (SQLite)",
  );
}

async function scanColumns(db: Db): Promise<{ counts: ColumnCounts[]; v2rows: V2Row[] }> {
  const counts: ColumnCounts[] = [];
  const v2rows: V2Row[] = [];
  for (const { table, column } of ENCRYPTED_COLUMNS) {
    const rows = (await db
      .prepare(`SELECT id, ${column} FROM ${table}`)
      .all()) as { id: number; [k: string]: unknown }[];
    let v2 = 0;
    for (const row of rows) {
      const value = row[column];
      if (typeof value === "string" && value.startsWith("v2:")) {
        v2 += 1;
        v2rows.push({ table, column, id: Number(row["id"]), value });
      }
    }
    counts.push({ table, column, total: rows.length, v2, nonV2: rows.length - v2 });
  }
  return { counts, v2rows };
}

function printReport(status: string, counts: ColumnCounts[], extra: string[] = []): void {
  console.log(`rekey-salt: status=${status}`);
  for (const c of counts) {
    console.log(`  ${c.table}.${c.column}: total=${c.total} v2=${c.v2} non-v2=${c.nonV2}`);
  }
  for (const line of extra) console.log(`  ${line}`);
}

function printUsage(): void {
  console.log(
    "Usage: node scripts/run-rekey-salt.mjs [--dry-run] [--help]\n" +
      "Env: FB_REKEY_OLD_SALT, FB_REKEY_NEW_SALT (both required, must differ),\n" +
      "  FB_DATABASE_URL (Postgres) or FB_DATABASE_PATH (SQLite).\n" +
      "Re-encrypts extension_meta.meta_value + email_template.vars from the\n" +
      "old salt to the new salt. Dry-run reports counts and writes nothing.\n" +
      "See findings-r4d.md for the operator steps (backup first).",
  );
}

/**
 * Run the re-key. Returns a process exit code (0 verified / dry-run /
 * help, 1 refusal, 2 vacuous). Prints counts + statuses only — never
 * salts, plaintexts, or ciphertexts.
 */
export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help")) {
    printUsage();
    return 0;
  }
  const dryRun = argv.includes("--dry-run");
  for (const a of argv) {
    if (a.startsWith("--") && a !== "--dry-run" && a !== "--help") {
      console.log(`rekey-salt: status=REFUSED reason=unknown flag: ${a}`);
      return 1;
    }
  }
  const oldSalt = process.env.FB_REKEY_OLD_SALT;
  const newSalt = process.env.FB_REKEY_NEW_SALT;
  if (!oldSalt) {
    console.log("rekey-salt: status=REFUSED reason=FB_REKEY_OLD_SALT is not set");
    return 1;
  }
  if (!newSalt) {
    console.log("rekey-salt: status=REFUSED reason=FB_REKEY_NEW_SALT is not set");
    return 1;
  }
  if (oldSalt === newSalt) {
    console.log("rekey-salt: status=REFUSED reason=old and new salts are identical");
    return 1;
  }

  const savedInfoSalt = process.env.FB_INFO_SALT;
  let target: Target | undefined;
  try {
    try {
      target = buildTarget();
    } catch (e) {
      if (e instanceof RekeyRefusal) {
        console.log(`rekey-salt: status=REFUSED reason=${e.message}`);
        return 1;
      }
      throw e;
    }
    const db = target.db;
    const { counts, v2rows } = await scanColumns(db);
    const totalV2 = v2rows.length;
    if (totalV2 === 0) {
      // VACUOUS, never PASS: with no v2: rows nothing about salt
      // correctness was proven, and nothing was written.
      printReport("VACUOUS", counts, [
        "no v2: rows found — nothing verified, nothing written",
      ]);
      return 2;
    }
    if (dryRun) {
      printReport("DRY_RUN", counts, ["dry run — no writes"]);
      return 0;
    }

    // Pre-scan: decrypt EVERY v2: value with OLD before any write.
    process.env.FB_INFO_SALT = oldSalt;
    const plaintexts = new Map<string, string>();
    const failures = new Map<string, number>();
    for (const row of v2rows) {
      const plain = decryptV2(row.value);
      if (plain === null) {
        failures.set(`${row.table}.${row.column}`, (failures.get(`${row.table}.${row.column}`) ?? 0) + 1);
      } else {
        plaintexts.set(`${row.table}.${row.column}:${row.id}`, plain);
      }
    }
    if (failures.size > 0) {
      const detail = [...failures.entries()].map(([c, n]) => `${c} failed=${n}`).join(", ");
      printReport("REFUSED", counts, [
        `pre-scan decrypt with old salt failed (${detail}) — no writes`,
      ]);
      return 1;
    }

    // Write + verify inside ONE transaction; any failure rolls back.
    process.env.FB_INFO_SALT = newSalt;
    try {
      await db.withTransaction(async (tx) => {
        for (const row of v2rows) {
          const plain = plaintexts.get(`${row.table}.${row.column}:${row.id}`)!;
          const enc = encryptV2(plain);
          if (!enc) throw new RekeyRefusal("encryption with new salt failed (unkeyed)");
          const r = await tx
            .prepare(`UPDATE ${row.table} SET ${row.column} = ? WHERE id = ?`)
            .run(enc, row.id);
          if (r.changes !== 1) {
            throw new RekeyRefusal(`update affected ${r.changes} rows, expected 1`);
          }
        }
        // Verify inside the transaction, before commit: re-read every
        // rewritten row through the tx handle and decrypt with NEW.
        for (const { table, column } of ENCRYPTED_COLUMNS) {
          const rows = (await tx.prepare(`SELECT id, ${column} FROM ${table}`).all()) as {
            id: number;
            [k: string]: unknown;
          }[];
          for (const r of rows) {
            const key = `${table}.${column}:${Number(r["id"])}`;
            const want = plaintexts.get(key);
            if (want === undefined) continue; // non-v2 row: untouched by construction
            const got = decryptV2(r[column] as string | null);
            if (got !== want) {
              throw new RekeyRefusal(`round-trip verification failed for ${table}.${column}`);
            }
          }
        }
      });
    } catch (e) {
      if (e instanceof RekeyRefusal) {
        printReport("REFUSED", counts, [`${e.message} — transaction rolled back, no writes committed`]);
        return 1;
      }
      throw e;
    }
    printReport("VERIFIED", counts, [`rewritten=${totalV2} (round-trip verified inside the transaction)`]);
    return 0;
  } finally {
    if (savedInfoSalt === undefined) delete process.env.FB_INFO_SALT;
    else process.env.FB_INFO_SALT = savedInfoSalt;
    if (target) await target.close();
  }
}
