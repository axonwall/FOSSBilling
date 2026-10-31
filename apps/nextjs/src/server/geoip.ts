import * as fs from "node:fs";
import * as path from "node:path";
import maxmind from "maxmind";
import { FbError } from "./dispatch";
import { GEOIP_CURRENCIES } from "./geoip-currencies";

/**
 * GeoIP lookups — TS port of FOSSBilling\GeoIP\Reader + Country + ASN
 * (src/library/FOSSBilling/GeoIP/) for the security ip_lookup endpoint.
 *
 * Database files (vendored at R6c into apps/nextjs/vendor/geoip when
 * the fork src/ tree was deleted — the PHP tree's copies are gone, so
 * there is no duplication left in the tree):
 *   CC0-Country.mmdb  6,534,834 bytes (~6.2 MiB)
 *   PDDL-ASN.mmdb     8,806,141 bytes (~8.4 MiB)
 * Reading the same files keeps TS and PHP byte-identical (same records
 * for every IP, proven by parity42 and re-proven by parity46).
 * Resolution:
 *   FB_GEOIP_DB_DIR (explicit; a set-but-missing dir errors loudly,
 *   as before), else the vendored dir (exists-checked so non-server
 *   contexts such as probes keep the old null behavior).
 *
 * Readers are opened FRESH per lookup (no reader or result caching):
 * PHP constructs a new ASN Reader per lookupIP call, and its country
 * Reader is per-request (each API call is one request) — so per-call
 * opens match PHP's observable behavior exactly, including picking up
 * a replaced database file on the next call. These are admin-only,
 * rare calls; the open cost is acceptable.
 *
 * Country construction mirrors GeoIP/Country.php exactly: the CC0
 * country record carries ONLY iso_code (no names) — the name comes
 * from the standards library (CLDR region names via ext-intl), the
 * flag from regional indicators, the currencies from the
 * CountryAlpha2 table (geoip-currencies.ts, derived from the vendor
 * tree). TS uses Intl.DisplayNames (same CLDR family as ext-intl)
 * with the config locale (default en_US), falling back to the ISO
 * code exactly as PHP does when ext-intl is unavailable. An iso_code
 * missing from the record OR unknown to the standards table yields []
 * (PHP's IncompleteRecord path), never a partial object.
 *
 * Missing database (PHP behavior vs TS spec): PHP's MaxMind Reader
 * constructor throws InvalidArgumentException ('The file "..." does
 * not exist or is not readable.' — proven by constructor probe), which
 * lookupIP does not catch (only IncompleteRecord is caught), so PHP
 * surfaces the sanitized generic 9999 with no filename. TS instead
 * throws an explicit error NAMING the file (R5-8 spec) — the one
 * deliberate improvement over PHP here. A corrupt database still
 * surfaces the generic 9999 on both stacks (PHP's
 * InvalidDatabaseException propagates uncaught; TS maps reader
 * open/get failures to the same generic message).
 */

export const GEOIP_COUNTRY_DB = "CC0-Country.mmdb";
export const GEOIP_ASN_DB = "PDDL-ASN.mmdb";

const GENERIC = "An unexpected error occurred. Please try again later.";

export function resolveGeoipDir(): string | null {
  const override = process.env.FB_GEOIP_DB_DIR;
  if (override !== undefined && override !== "") return override;
  const vendored = path.join(process.cwd(), "vendor", "geoip");
  return fs.existsSync(vendored) ? vendored : null;
}

function flagEmoji(iso: string): string {
  return [...iso]
    .map((ch) => String.fromCodePoint(0x1f1e6 + (ch.charCodeAt(0) - 65)))
    .join("");
}

function countryName(iso: string, language: string): string {
  try {
    const name = new Intl.DisplayNames([language], { type: "region" }).of(iso);
    return name ?? iso;
  } catch {
    return iso;
  }
}

export interface GeoipResult {
  ip: { address: string; type: string };
  country: { name: string; flag: string; currencies: readonly string[] } | [];
  asn: { asnNumber: number; asnOrg: string } | [];
}

export async function lookupGeoip(
  ip: string,
  type: string,
  locale: string,
): Promise<GeoipResult> {
  const dir = resolveGeoipDir();
  const countryPath = dir === null ? null : path.join(dir, GEOIP_COUNTRY_DB);
  if (countryPath === null || !fs.existsSync(countryPath)) {
    throw new FbError(
      `GeoIP database file not found: ${countryPath ?? `${GEOIP_COUNTRY_DB} (no database directory configured; set FB_GEOIP_DB_DIR)`}`,
    );
  }
  const asnPath = dir === null ? null : path.join(dir, GEOIP_ASN_DB);
  if (asnPath === null || !fs.existsSync(asnPath)) {
    throw new FbError(
      `GeoIP database file not found: ${asnPath ?? `${GEOIP_ASN_DB} (no database directory configured; set FB_GEOIP_DB_DIR)`}`,
    );
  }

  let countryRecord: unknown;
  let asnRecord: unknown;
  try {
    const countryReader = await maxmind.open<Record<string, unknown>>(countryPath);
    countryRecord = countryReader.get(ip);
    const asnReader = await maxmind.open<Record<string, unknown>>(asnPath);
    asnRecord = asnReader.get(ip);
  } catch (e) {
    if (e instanceof FbError) throw e;
    throw new FbError(GENERIC);
  }

  // Country: record.country.iso_code only (registered_country is
  // ignored, as in Reader::country). Missing/unknown iso -> [].
  let country: GeoipResult["country"] = [];
  const iso =
    countryRecord !== null && typeof countryRecord === "object"
      ? (countryRecord as Record<string, unknown>)["country"]
      : null;
  const isoCode =
    iso !== null && typeof iso === "object"
      ? (iso as Record<string, unknown>)["iso_code"]
      : null;
  if (typeof isoCode === "string" && isoCode !== "" && isoCode in GEOIP_CURRENCIES) {
    const language = locale.includes("_") ? locale.split("_")[0]! : locale;
    country = {
      name: countryName(isoCode, language || "en"),
      flag: flagEmoji(isoCode),
      currencies: GEOIP_CURRENCIES[isoCode]!,
    };
  }

  // ASN: key-existence check, mirroring PHP's array_key_exists (a null
  // value would pass in PHP; MMDB records never carry nulls here).
  let asn: GeoipResult["asn"] = [];
  if (
    asnRecord !== null &&
    typeof asnRecord === "object" &&
    "autonomous_system_number" in (asnRecord as Record<string, unknown>) &&
    "autonomous_system_organization" in (asnRecord as Record<string, unknown>)
  ) {
    const rec = asnRecord as Record<string, unknown>;
    asn = {
      asnNumber: rec["autonomous_system_number"] as number,
      asnOrg: rec["autonomous_system_organization"] as string,
    };
  }

  return { ip: { address: ip, type }, country, asn };
}
