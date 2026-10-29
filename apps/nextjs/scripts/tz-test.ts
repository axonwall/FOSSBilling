// R5d tz module test (driver-test precedent): zone-calendar math for
// fixed instants (incl. overnight + month-boundary + DST transitions)
// and resolveZone precedence (env > config > UTC). Run via
// scripts/run-tz-test.mjs, which compiles this + tz.ts +
// config-store.ts + dispatch.ts with the repo tsc into a scratch dir.
// Config variations use FB_CONFIG_PATH pointing at scratch config
// copies — the real reference config is never touched.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addZoneDays,
  addZoneMonths,
  formatZoneDate,
  formatZoneDateTime,
  isValidZone,
  parseZoneDateTime,
  resolveZone,
  zoneMidnightMs,
  zoneMonthStartMs,
} from "../src/server/tz";

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) {
    failures++;
    console.log(`FAIL ${name} ${detail}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function eq(name: string, got: unknown, want: unknown): void {
  check(name, got === want, `got=${got} want=${want}`);
}

const U = Date.UTC;

export function main(): number {
  // --- Zone math (fixed instants; no clock dependence) ---
  eq("U1 utc midnight", zoneMidnightMs("UTC", U(2026, 9, 29, 2, 0, 0)), U(2026, 9, 29, 0, 0, 0));
  // 2026-10-29 02:00 UTC = 2026-10-28 21:00 CDT: Chicago date is Oct 28.
  eq("U2 chicago overnight midnight", zoneMidnightMs("America/Chicago", U(2026, 9, 29, 2, 0, 0)), U(2026, 9, 28, 5, 0, 0));
  // 2026-11-01 02:00 UTC = 2026-10-31 21:00 CDT: Chicago month is October.
  eq("U3 chicago month-start", zoneMonthStartMs("America/Chicago", U(2026, 10, 1, 2, 0, 0)), U(2026, 9, 1, 5, 0, 0));
  // DST fall-back 2026 (Nov 1, 25-hour day): calendar steps, 25h gap.
  const fall0 = zoneMidnightMs("America/Chicago", U(2026, 9, 30, 12, 0, 0));
  eq("U4a fall day0", fall0, U(2026, 9, 30, 5, 0, 0));
  const fall1 = addZoneDays("America/Chicago", fall0, 1);
  eq("U4b fall day1", fall1, U(2026, 9, 31, 5, 0, 0));
  const fall2 = addZoneDays("America/Chicago", fall1, 1);
  eq("U4c fall day2", fall2, U(2026, 10, 1, 5, 0, 0));
  const fall3 = addZoneDays("America/Chicago", fall2, 1);
  eq("U4d fall day3", fall3, U(2026, 10, 2, 6, 0, 0));
  eq("U4e fall 25h gap", (fall3 - fall2) / 1000, 90000);
  // DST spring-forward 2026 (Mar 8, 23-hour day).
  const spr0 = zoneMidnightMs("America/Chicago", U(2026, 2, 7, 12, 0, 0));
  eq("U5a spring day0", spr0, U(2026, 2, 7, 6, 0, 0));
  const spr1 = addZoneDays("America/Chicago", spr0, 1);
  eq("U5b spring day1", spr1, U(2026, 2, 8, 6, 0, 0));
  const spr2 = addZoneDays("America/Chicago", spr1, 1);
  eq("U5c spring day2", spr2, U(2026, 2, 9, 5, 0, 0));
  eq("U5d spring 23h gap", (spr2 - spr1) / 1000, 82800);
  eq("U6 kiritimati date", formatZoneDate("Pacific/Kiritimati", U(2026, 9, 29, 14, 0, 0)), "2026-10-30");
  eq("U7 chicago datetime", formatZoneDateTime("America/Chicago", U(2026, 9, 29, 7, 0, 0)), "2026-10-29 02:00:00");
  eq("U8a parse date", parseZoneDateTime("America/Chicago", "2026-11-03"), U(2026, 10, 3, 6, 0, 0));
  eq("U8b parse datetime", parseZoneDateTime("UTC", "2026-11-03 15:30:00"), U(2026, 10, 3, 15, 30, 0));
  eq("U8c parse garbage", parseZoneDateTime("UTC", "garbage"), null);
  eq("U9 add months", addZoneMonths("America/Chicago", U(2026, 9, 29, 14, 0, 0), -1), U(2026, 8, 29, 14, 0, 0));
  check("U10a valid chicago", isValidZone("America/Chicago"));
  check("U10b valid utc", isValidZone("UTC"));
  check("U10c invalid zone", !isValidZone("No/Such_Zone"));
  check("U10d empty invalid", !isValidZone(""));

  // --- resolveZone precedence (scratch configs via FB_CONFIG_PATH) ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r5d-tz-"));
  const writeCfg = (tz: string | null): string => {
    const p = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.php`);
    const inner = tz === null ? "" : `  'i18n' => ['timezone' => '${tz}'],\n`;
    fs.writeFileSync(p, `<?php return [\n${inner}];\n`);
    return p;
  };
  const cfgChicago = writeCfg("America/Chicago");
  const cfgUtc = writeCfg("UTC");
  const cfgMissing = writeCfg(null);
  const cfgInvalid = writeCfg("No/Such_Zone");
  const savedTz = process.env.TZ;
  const savedCfg = process.env.FB_CONFIG_PATH;
  try {
    process.env.TZ = "America/Chicago";
    process.env.FB_CONFIG_PATH = cfgUtc;
    eq("P1 env wins over config", resolveZone(), "America/Chicago");
    delete process.env.TZ;
    process.env.FB_CONFIG_PATH = cfgChicago;
    eq("P2 config wins over default", resolveZone(), "America/Chicago");
    process.env.FB_CONFIG_PATH = cfgMissing;
    eq("P3 missing key -> UTC", resolveZone(), "UTC");
    process.env.TZ = "No/Such_Zone";
    process.env.FB_CONFIG_PATH = cfgChicago;
    eq("P4 invalid env falls through", resolveZone(), "America/Chicago");
    delete process.env.TZ;
    process.env.FB_CONFIG_PATH = cfgInvalid;
    eq("P5 invalid config -> UTC", resolveZone(), "UTC");
    process.env.TZ = "";
    process.env.FB_CONFIG_PATH = cfgChicago;
    eq("P6 empty env falls through", resolveZone(), "America/Chicago");
    process.env.TZ = "Pacific/Kiritimati";
    process.env.FB_CONFIG_PATH = cfgChicago;
    eq("P7 env kiritimati wins", resolveZone(), "Pacific/Kiritimati");
  } finally {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
    if (savedCfg === undefined) delete process.env.FB_CONFIG_PATH;
    else process.env.FB_CONFIG_PATH = savedCfg;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${checks} checks, ${failures} failures`);
  return failures === 0 ? 0 : 1;
}
