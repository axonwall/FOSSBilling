// FOSSBilling at-rest encryption, mirrored from PHP's Crypt class
// (library/FOSSBilling/Crypt.php): AES-256-CBC, PBKDF2-SHA256 with
// 100k iterations over the install salt, salt string 'fossbilling_salt',
// IV prepended, base64, 'v2:' prefix. The passphrase is the install
// salt (config.php `info.salt`), which the sandbox passes as
// FB_CALLBACK_SALT; a dedicated FB_INFO_SALT wins when set.
// Without a passphrase, decryption returns null and encryption
// returns null — callers fall back to the PHP-equivalent empty
// value rather than storing unreadable plaintext.

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { getDb, getDbWrite, nowTimestamp } from "./db";

function passphrase(): string | null {
  return process.env.FB_INFO_SALT ?? process.env.FB_CALLBACK_SALT ?? null;
}

function key(pass: string): Buffer {
  return pbkdf2Sync(pass, "fossbilling_salt", 100000, 32, "sha256");
}

/** Decrypt a `v2:` ciphertext; null when undecryptable or unkeyed. */
export function decryptV2(text: string | null | undefined): string | null {
  if (!text || !text.startsWith("v2:")) return null;
  const pass = passphrase();
  if (!pass) return null;
  try {
    const raw = Buffer.from(text.slice(3), "base64");
    if (raw.length <= 16) return null;
    const iv = raw.subarray(0, 16);
    const data = raw.subarray(16);
    const decipher = createDecipheriv("aes-256-cbc", key(pass), iv);
    const out = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
    // PHP's isPlausiblePlaintext: valid UTF-8, no control chars.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(out)) return null;
    return out.trim();
  } catch {
    return null;
  }
}

/** Encrypt to the `v2:` format; null when unkeyed. */
export function encryptV2(text: string): string | null {
  const pass = passphrase();
  if (!pass) return null;
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key(pass), iv);
  const data = Buffer.concat([cipher.update(text, "utf-8"), cipher.final()]);
  return "v2:" + Buffer.concat([iv, data]).toString("base64");
}

/** Write an extension config row (extension_meta, meta_key 'config'),
 * mirroring Extension Service::setConfig: the full config object
 * (including its 'ext' key) is JSON-encoded then v2-encrypted; an
 * existing row is updated (updated_at bumped), otherwise inserted.
 * Returns false when unkeyed (no salt) — callers then cannot store
 * readable config, mirroring PHP's encrypt failure rather than
 * writing plaintext. */
export function writeExtensionConfig(ext: string, config: Record<string, unknown>): boolean {
  const encrypted = encryptV2(JSON.stringify(config));
  if (!encrypted) return false;
  const db = getDbWrite();
  const row = db
    .prepare("SELECT id FROM extension_meta WHERE extension = ? AND meta_key = 'config'")
    .get(ext) as { id: number } | undefined;
  if (row) {
    db.prepare("UPDATE extension_meta SET meta_value = ?, updated_at = ? WHERE id = ?")
      .run(encrypted, nowTimestamp(), row.id);
  } else {
    const ts = nowTimestamp();
    db.prepare(
      "INSERT INTO extension_meta (extension, meta_key, meta_value, created_at, updated_at) VALUES (?, 'config', ?, ?, ?)",
    ).run(ext, encrypted, ts, ts);
  }
  return true;
}

/** Read an extension config row (extension_meta, meta_key 'config'). */
export function readExtensionConfig(ext: string): Record<string, unknown> {
  const row = getDb()
    .prepare("SELECT meta_value FROM extension_meta WHERE extension = ? AND meta_key = 'config'")
    .get(ext) as unknown as { meta_value: string | null } | undefined;
  if (!row?.meta_value) return {};
  const plain = decryptV2(row.meta_value);
  if (!plain) return {};
  try {
    const parsed = JSON.parse(plain) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
