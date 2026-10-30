/**
 * Public origin for URL construction (R6a, decision D6-8).
 *
 * Replaces FOSSBILLING_URL (deleted with the PHP proxy). The old
 * variable named the PHP origin the seam proxied to; every site that
 * read it built user-facing URLs (gateway callbacks, invoice-email
 * base URLs, navigation links, system/company www) against that
 * origin. Post-cutover those URLs must name the Next origin instead.
 *
 * Resolution order (R5-2: env > config for deployment values):
 *   1. FB_PUBLIC_URL, when set and non-empty (trailing slashes
 *      stripped). This is the deployment's public origin; the
 *      deployment MUST set it to the Next origin (or update the
 *      config url below to the same value).
 *   2. PHP SYSTEM_URL semantics (src/load.php): scheme from config
 *      security.force_https (default TRUE) + config `url` with
 *      schemes stripped. Deliberate difference from load.php: the
 *      request-isSecure() term is dropped — TS URL construction
 *      runs in request-less contexts too (cron, email queue), so
 *      the origin is deployment-configured, not request-derived
 *      (same precedent as R5i's webserver check).
 *   3. If neither FB_PUBLIC_URL nor a config url exists, throws —
 *      silently generating URLs against a guessed origin would
 *      break gateway callbacks and email links. A real install
 *      always has a config url (the R5j installer requires --url),
 *      so this is a misconfiguration error, not a normal path.
 *
 * Returns the origin WITHOUT a trailing slash; callers add "/" or a
 * path exactly as the old sites did (email __baseUrl appends "/",
 * systemUrl() appends "/", callback builders append paths).
 */
import { FbError } from "./dispatch";
import { getConfigProperty, phpNormalizeBoolean } from "./config-store";

function stripTrailingSlashes(s: string): string {
  return s.replace(/\/+$/, "");
}

export function publicOrigin(): string {
  const env = (process.env.FB_PUBLIC_URL ?? "").trim();
  if (env) return stripTrailingSlashes(env);
  const forceHttps = phpNormalizeBoolean(
    getConfigProperty("security.force_https", true),
    true,
  );
  const rawUrl = String(getConfigProperty("url", "") ?? "");
  const hostPath = stripTrailingSlashes(
    rawUrl.replace(/^https?:\/\//, ""),
  );
  if (!hostPath) {
    throw new FbError(
      "Public URL is not configured: set FB_PUBLIC_URL or the config url.",
    );
  }
  return `${forceHttps ? "https" : "http"}://${hostPath}`;
}
