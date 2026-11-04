#!/usr/bin/env python3
"""Parity48 — money goldens replay (Phase 5 batch: goldens).

The executable proof for the goldens: replays the 19 committed
goldens against a FRESH disposable TS instance (scratch DB copy,
never the reference) and compares normalized envelopes + DB
deltas to the committed golden files.

Sections:
  A. Reference state before: invariants + config hash + :8080 /
     :3001 answering. FAILS FAST if the harness ports (:18081 /
     :3012) are up — another DB-mutating suite may be running.
  B. Golden replay: per golden, MATCH / MONEY-DIFF (with the
     diff) / NON-MONEY-DIFF (with the diff + disposition class) /
     COUNT-MISMATCH (added-row counts differed — no pairing
     guessed). Comparison is canonicalized (see the
     surrogate-id block below DOCUMENTED_VOLATILE): added rows
     pair nth-to-nth per table in sorted-id (= creation) order,
     replay ids map to golden ids field-aware (delta keys, bodies'
     id/FK fields, envelope id/FK fields), and wall-clock
     month-name dates in strings scrub on both sides. Money
     fields are never remapped. PLUS a per-scenario scope
     override for cron-run ONLY (see CRON_RUN_SCOPE): cart /
     cart_product purge removals + "Invoice Due" reminder
     additions are out of scope for that golden, reported in
     output, everything else exact. ANY diff fails the suite loudly:
     a money diff is a money abort (same rule as R6b — no
     tolerance); a non-money diff is behavior drift since the
     golden was recorded (TS-vs-golden non-money diffs are NOT
     the triaged TS-vs-PHP gaps — those live in the golden's
     php_review flag, and a replay MATCH re-confirms them, it
     does not re-litigate them).
  C. Guardrails (re-asserted, not assumed from R6b):
     VOLATILE_KEYS ∩ money fields = ∅; the _at rule touches
     timestamp fields only; every golden's metadata complete
     (generator, generated_at, ts_commit, oracle_version,
     oracle_config_hash == reference hash, normalization list,
     payload_sha256 valid — recomputed from the file, so a
     hand-edited golden fails here instead of silently passing;
     php_review present with verdict AGREES-WITH-PHP or
     TRIAGED-DIVERGENCE, never DIFFERS, never null); the golden
     set is exactly the 9 golden scenarios + the 10 included
     fixtures (no missing, no extra, no renamed files).
  D. Accounting: endpoint-accounting.py exit 0 with 548+31+0
     (goldens change no handler count — ANY move is a finding).
  E. Restore: reference invariants + config hash unchanged,
     :8080 + :3001 answering at the end, all disposable targets
     deleted in finally, :8081/:18025/:18026/:3003/:18081/:3012
     DOWN at batch end.

SKIPs: 0. The paths this suite does NOT replay (Stripe success,
Stripe JSON webhook, ClientBalance gateway, batch_pay_with_credits
ids-shape, partial-refund map-shape, anonymous-add-then-login cart
migration, invoice PDFs) are not skipped checks here — they are
documented exclusions in findings-goldens.md §1/§5 with their
reasons. Nothing in this suite is labeled SKIP to hide a gap.

This suite needs NO PHP: goldens replace the PHP comparison.
TS error envelopes are HTTP 200 by seam convention — envelopes
are compared, never HTTP status.

Run: python3 parity48.py  (long: 19 golden replays, ~3 min)
Negative control: python3 parity48.py --negative-control (one
golden replayed against the pristine golden plus three corrupted
copies; see run_negative_control — money corruption must report
MONEY-DIFF, body-id and dependent-table id corruption must report
NON-MONEY-DIFF, pristine vs drifted replay must MATCH).
Logs: run via nohup + log file under ~/scratch/fossbilling/r5-logs/.
"""

import hashlib
import importlib.util
import json
import pathlib
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
RUNTIME = pathlib.Path.home() / "scratch" / "fossbilling" / "runtime"
LOGS = pathlib.Path.home() / "scratch" / "fossbilling" / "r5-logs"
DB = RUNTIME / "src" / "data" / "fossbilling.sqlite"
CONFIG = RUNTIME / "src" / "config.php"
GOLDENS = HERE / "goldens"
SCENARIOS = HERE / "golden-scenarios.json"
FIXTURES = [pathlib.Path.home() / "scratch" / "fossbilling" / "phase0" /
            "fixtures-money.json",
            pathlib.Path.home() / "scratch" / "fossbilling" / "phase0" /
            "fixtures-tax.json"]

EXPECTED_HASH = "6e3c529673c1d089"
MONEY_TABLES = {"invoice", "invoice_item", "transaction", "client_order",
                "client_order_meta", "cart", "cart_product",
                "client_balance", "subscription"}
TRIAGED = {"invoice_event", "client_order_status", "email_queue",
           "setting"}
MONEY_FIELDS = {"amount", "total", "subtotal", "tax", "price", "quantity",
                "status", "balance", "currency_rate", "base_income",
                "base_refund", "gateway_id", "invoice_id", "client_id",
                "order_id", "credit", "refund", "income"}
DOCUMENTED_VOLATILE = sorted(["hash", "hash_expires_at", "created_at",
                              "updated_at", "due_at", "paid_at",
                              "reminded_at", "last_cron_exec", "group_id",
                              "ipn_hash"])

# --- Surrogate-id canonicalization (goldens fix, 2026-11-04) ---
# Goldens record RAW autoincrement ids, and sqlite_sequence never goes
# back on delete, so any reference-touching suite run advances
# sequences and breaks replay: golden email_queue row 530 replays as
# 536, golden cloned client 493 replays as 551, while row bodies are
# otherwise identical. The product behavior is correct; the comparison
# was sequence-fragile. The fix is comparison-side ONLY, here in
# parity48.py: golden files, PHP verdicts, and payload hashes are
# untouched (no regenerate, no re-review).
#
# Mechanism (per golden, added rows only):
#   1. Pair the nth golden added row with the nth replay added row,
#      per table, in sorted-id order. Added rows are scenario
#      creations (baseline rows are excluded by construction: the
#      harness dumps the baseline AFTER seeds, BEFORE steps), and
#      every DIFF_TABLE id is INTEGER PRIMARY KEY AUTOINCREMENT
#      (verified against the reference schema), so SQLite assigns
#      ids monotonically in creation order and never reuses them —
#      sorted-by-id IS creation order. If added-row counts differ
#      for any table, the golden FAILS LOUDLY with the table + both
#      counts (COUNT-MISMATCH) — never guessed, never padded.
#   2. Build a replay-id -> golden-id map per table from that
#      pairing, PLUS foreign-key maps derived from the paired rows
#      themselves: for each paired added row, any FK field whose
#      golden and replay values differ records replay-FK ->
#      golden-FK in that FK table's map. The FK derivation is what
#      covers seed-created ids (e.g. the tax goldens' cloned client
#      493/551: the clone is a SEED row, hence in the baseline, hence
#      in NO delta — but the paired invoice rows carry it as
#      client_id, so the invoice pairing yields the client map).
#      A conflicting derivation (one replay FK -> two golden FKs)
#      fails the golden loudly as an ambiguous mapping.
#      CONSTRAINT (load-bearing, added after the negative control
#      caught it): an FK derivation fires ONLY when the replay FK
#      value is NOT an id in the pre-seed snapshot for that table.
#      Seed/scenario-created ids (cloned client 551, fresh cart ids)
#      are absent from the snapshot, so they derive; BASELINE ids
#      (client 1, gateway rows, ...) are present, so a differing
#      baseline FK NEVER derives — a real FK bug (TS links an
#      invoice to the wrong baseline client) surfaces as a diff
#      instead of being mapped away, and a corrupted golden FK
#      cannot poison envelopes/deltas through the map. Without
#      this constraint, corrupting one email row's client_id to
#      99999 derived client 1 -> 99999 and faked envelope + invoice
#      diffs — the control that proved the constraint necessary.
#   3. Apply the maps FIELD-AWARE, never by regex over values: to
#      added-row keys, to added-row bodies' own "id" field, to
#      declared FK fields in delta bodies (FK_TABLE) and in changed
#      rows' post values, and to declared id fields in envelopes
#      (FK_TABLE fields anywhere, OBJ_TABLE nested {"client": {"id"}}
#      shapes, and result.id / result.list[].id / scalar result via
#      the step's module table). A value maps ONLY if it exactly
#      equals a replay added-row (or derived FK) id — baseline ids
#      (1, 2, 3, ...) are never in a map, so they pass through
#      untouched, and an unmapped value is never rewritten.
# HARD RULES: money fields are NEVER canonicalized, remapped, or
# normalized — every money column compares exactly after id-mapping
# (the negative control proves a corrupted invoice total still
# reports MONEY-DIFF). Embedded ids inside STRING fields are NOT
# mapped: string contents compare exactly, and a string id diff
# surfaces loudly. (One established exception, same class as the
# harness's ISO-datetime scrub: wall-clock MONTH-NAME dates inside
# strings — "Nov 1, 2026" vs "Nov 4, 2026" in email prose — are
# scrubbed on BOTH sides during comparison only, because the harness
# already normalizes every wall-clock date field (created_at,
# updated_at, due_at, paid_at, ...) and ISO datetimes in strings;
# the month-name format was the one gap. Amounts in the same strings
# ("$105.00") are untouched by the date regex and still compare.)
FK_TABLE = {
    "client_id": "client",
    "invoice_id": "invoice",
    "order_id": "client_order",
    "transaction_id": "transaction",
    "cart_id": "cart",
    "subscription_id": "subscription",
    # Invoice note/link FKs (all reference invoice ids; mapped only
    # when invoice ids themselves drift — today they match).
    "credit_note_for_invoice_id": "invoice",
    "debit_note_for_invoice_id": "invoice",
    "replaces_invoice_id": "invoice",
    "replaced_by_invoice_id": "invoice",
    "refunded_item_id": "invoice_item",
}
# Deliberately NOT mapped: gateway_id, product_id, service_id,
# admin_id, and other baseline references — those are stable
# catalog ids, not surrogate sequence ids, and mapping them would
# hide real linkage bugs. Money fields are never in this list.
OBJ_TABLE = {
    "client": "client",
    "invoice": "invoice",
    "order": "client_order",
    "transaction": "transaction",
    "cart": "cart",
    "subscription": "subscription",
}
MODULE_TABLE = {
    "invoice": "invoice",
    "order": "client_order",
    "cart": "cart",
    "transaction": "transaction",
    "subscription": "subscription",
    "client": "client",
}
MONTH_DATE = re.compile(
    r"\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|"
    r"Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|"
    r"Nov(?:ember)?|Dec(?:ember)?) \d{1,2}, \d{4}\b")


def scrub_month_dates(v):
    """Comparison-time only (never touches files): replace wall-clock
    month-name dates in strings with a placeholder, on both sides.
    Amounts and all other content pass through untouched."""
    if isinstance(v, dict):
        return {k: scrub_month_dates(val) for k, val in v.items()}
    if isinstance(v, list):
        return [scrub_month_dates(x) for x in v]
    if isinstance(v, str):
        return MONTH_DATE.sub("*DATE*", v)
    return v


def _sort_key(k):
    """Numeric ids sort numerically (JSON round-trip makes delta keys
    strings); a non-numeric key sorts after, by string — never crash
    the pairing on an unexpected key shape."""
    s = str(k)
    return (0, int(s)) if s.lstrip("-").isdigit() else (1, s)


def snapshot_id_sets(snapshot_path):
    """Pre-seed snapshot ids per FK-target table (read-only). Used
    to constrain FK derivation to seed/scenario-created ids: a
    replay FK present here is a baseline id and must never derive
    a mapping (see header constraint)."""
    con = sqlite3.connect(f"file:{snapshot_path}?mode=ro", uri=True)
    out = {}
    try:
        for t in sorted(set(FK_TABLE.values())):
            try:
                out[t] = {str(r[0]) for r in
                          con.execute(f'SELECT id FROM "{t}"')}
            except sqlite3.Error:
                out[t] = set()
    finally:
        con.close()
    return out


def build_id_maps(golden_deltas, replay_deltas, snapshot_ids=None):
    """Returns (maps, mismatches, conflicts).
    maps[table] = {replay_id_str: golden_id_str} from nth-to-nth
    sorted added-row pairing, PLUS FK maps derived from paired rows'
    differing FK fields (see header). mismatches = [(table, n_golden,
    n_replay)] for added-count differences. conflicts = [(table,
    replay_fk, golden_fk_a, golden_fk_b)] for ambiguous derivations.
    snapshot_ids (from snapshot_id_sets) constrains FK derivation:
    a replay FK present in the snapshot is a baseline id and never
    derives; with snapshot_ids None, NO FK derivation happens
    (fail-closed — seed-drift goldens then fail loudly rather than
    risk masking a real FK bug).
    """
    maps = {}
    mismatches = []
    conflicts = []
    for t in sorted(set(golden_deltas) | set(replay_deltas)):
        g_added = golden_deltas.get(t, {}).get("added", {})
        r_added = replay_deltas.get(t, {}).get("added", {})
        g_keys = sorted(g_added.keys(), key=_sort_key)
        r_keys = sorted(r_added.keys(), key=_sort_key)
        if len(g_keys) != len(r_keys):
            mismatches.append((t, len(g_keys), len(r_keys)))
            continue
        maps[t] = {str(rk): str(gk) for gk, rk in zip(g_keys, r_keys)}
    # FK derivation from the paired rows (only tables whose counts
    # matched — unpaired tables have no pairing to derive from),
    # constrained to non-snapshot replay FKs (seed/scenario ids).
    fk_maps = {}
    if snapshot_ids is not None:
        for t in maps:
            g_added = golden_deltas.get(t, {}).get("added", {})
            r_added = replay_deltas.get(t, {}).get("added", {})
            for gk, rk in zip(sorted(g_added.keys(), key=_sort_key),
                              sorted(r_added.keys(), key=_sort_key)):
                grow, rrow = g_added[gk], r_added[rk]
                if not isinstance(grow, dict) or not isinstance(rrow, dict):
                    continue
                for f, ft in FK_TABLE.items():
                    gv, rv = grow.get(f), rrow.get(f)
                    if gv is None or rv is None or gv == rv:
                        continue
                    if str(rv) in snapshot_ids.get(ft, set()):
                        continue  # baseline id: never derive
                    cur = fk_maps.setdefault(ft, {})
                    if str(rv) in cur and cur[str(rv)] != str(gv):
                        conflicts.append((ft, rv, cur[str(rv)], gv))
                    else:
                        cur[str(rv)] = str(gv)
    for ft, m in fk_maps.items():
        maps.setdefault(ft, {}).update(m)
    return maps, mismatches, conflicts


def remap_value(table, value, maps):
    """Map a replay id to its golden id, ONLY if it is exactly a
    mapped replay id. Baseline ids, unknown ids, bools, and
    non-id values pass through untouched."""
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return value
    m = maps.get(table)
    if not m:
        return value
    gv = m.get(str(value))
    if gv is None:
        return value
    return int(gv) if isinstance(value, int) else gv


def apply_id_maps_to_delta(delta, maps):
    """Apply maps to a replay delta: added-row keys renamed, added
    bodies' own "id" + FK fields mapped, changed rows' POST values'
    FK fields mapped. Removed rows are baseline ids — untouched."""
    out = {}
    for t, dd in delta.items():
        entry = {}
        if "added" in dd:
            m = maps.get(t, {})
            new_added = {}
            for rk, body in dd["added"].items():
                gk = m.get(str(rk), rk)
                nb = dict(body) if isinstance(body, dict) else body
                if isinstance(nb, dict):
                    if "id" in nb:
                        nb["id"] = remap_value(t, nb["id"], maps)
                    for f, ft in FK_TABLE.items():
                        if f in nb:
                            nb[f] = remap_value(ft, nb[f], maps)
                new_added[gk] = nb
            entry["added"] = new_added
        if "removed" in dd:
            entry["removed"] = dd["removed"]
        if "changed" in dd:
            new_changed = {}
            for k, fields in dd["changed"].items():
                nf = {}
                for f, pair in fields.items():
                    old, new = pair
                    if f in FK_TABLE:
                        new = remap_value(FK_TABLE[f], new, maps)
                    nf[f] = [old, new]
                new_changed[k] = nf
            entry["changed"] = new_changed
        out[t] = entry
    return out


def apply_id_maps_to_envelope(env, step, maps):
    """Apply maps to a replay envelope, field-aware only: FK fields
    anywhere, OBJ_TABLE nested {"x": {"id"}} shapes, and result.id /
    result.list[].id / scalar result via the step's module table."""
    module = None
    call = step.get("call") if isinstance(step, dict) else None
    if call:
        parts = call.split("/")
        module = parts[1] if len(parts) > 1 else None

    def walk(v):
        if isinstance(v, dict):
            out = {}
            for k, val in v.items():
                if (k in FK_TABLE and isinstance(val, (int, str))
                        and not isinstance(val, bool)):
                    out[k] = remap_value(FK_TABLE[k], val, maps)
                elif (k in OBJ_TABLE and isinstance(val, dict)
                        and "id" in val):
                    nv = dict(val)
                    nv["id"] = remap_value(OBJ_TABLE[k], val["id"], maps)
                    out[k] = walk(nv)
                else:
                    out[k] = walk(val)
            return out
        if isinstance(v, list):
            return [walk(x) for x in v]
        return v

    env = walk(env)
    table = MODULE_TABLE.get(module) if module else None
    if table and isinstance(env, dict):
        res = env.get("result")
        if isinstance(res, dict):
            res = dict(res)
            if ("id" in res and isinstance(res["id"], (int, str))
                    and not isinstance(res["id"], bool)):
                res["id"] = remap_value(table, res["id"], maps)
            lst = res.get("list")
            if isinstance(lst, list):
                new_list = []
                for item in lst:
                    if (isinstance(item, dict) and "id" in item
                            and isinstance(item["id"], (int, str))
                            and not isinstance(item["id"], bool)):
                        item = dict(item)
                        item["id"] = remap_value(table, item["id"], maps)
                    new_list.append(walk(item))
                res["list"] = new_list
            env = dict(env)
            env["result"] = res
        elif (isinstance(res, (int, str)) and not isinstance(res, bool)):
            env = dict(env)
            env["result"] = remap_value(table, res, maps)
    return env


# --- Per-scenario scope override: cron-run ONLY (narrowing, 2026-11-04) ---
# The cron golden is date-pinned: cart_batch_expire purges abandoned
# carts older than today-7, and invoice_batch_send_reminders queues
# "Invoice Due" emails for invoices due in the window — so any replay
# days after generation diverges on purge counts + reminder counts,
# while money tables match exactly (proven 2026-11-04: replay cart
# removed 248 vs golden 113, replay email_queue added 12 vs golden 0,
# money tables NO diff). Regenerating re-pins the date (treadmill);
# freezing the clock is heavier harness surgery. The principled
# narrowing, comparison-side ONLY, here in parity48.py, for cron-run:
#   * cart + cart_product REMOVED rows are out of scope: purge
#     cleanup of abandoned carts. Column-proven money-valueless:
#     cart = {id, session_id, currency_id, promo_id, created_at,
#     updated_at}; cart_product = {id, product_id, config, cart_id}
#     (schema + golden removed rows + replay data, 2026-11-04
#     diagnostic). The purge creates no invoice, charge,
#     transaction, or order. NOTE the classification technicality:
#     cart/cart_product ARE in the harness's MONEY_TABLES by blanket
#     rule (cart operations feed money flows) — this override is
#     explicit about that: these rows carry no money values and
#     have no money effect, and the actual money signal (invoice,
#     invoice_item, transaction, client_order) still compares
#     exactly. Only REMOVED rows drop: a future cart added/changed
#     row would still compare.
#   * email_queue ADDED rows whose subject contains "Invoice Due"
#     are out of scope: date-window due-reminder notification
#     counts, not money movements. The 12 replay rows on 2026-11-04
#     are uniformly this kind (verified from replay data, not from
#     the fix report); they reference due invoices but move no
#     money — the matching 12 invoice reminded_at touches are
#     volatile-only, and no invoice/transaction/order row is
#     created or changed by them. The pattern is explicit, not a
#     blanket email_queue exclusion: any other added kind surfaces
#     loudly. email_queue CHANGED rows (send attempts) still
#     compare exactly.
# Applied symmetrically to BOTH sides (golden + replay), in memory
# only, and REPORTED in the runner output for the golden, so a
# future reader sees what is not checked. Golden files are never
# modified; money fields are never remapped by this override.
CRON_RUN_SCOPE_TABLES_REMOVED = ("cart", "cart_product")
CRON_RUN_SCOPE_EMAIL_SUBJECT = "Invoice Due"


def apply_cron_scope(g_delta, r_delta):
    """Apply the cron-run scope override to both deltas. Returns
    (filtered_golden, filtered_replay, report_lines). Drops are
    symmetric (both sides) and in-memory only. A table whose only
    kind was removed rows disappears from that side's delta, which
    diff_deltas treats as no diff (empty == empty)."""
    def drop_removed(delta):
        out = {}
        dropped = {}
        for t, dd in delta.items():
            if t in CRON_RUN_SCOPE_TABLES_REMOVED and dd.get("removed"):
                dropped[t] = len(dd["removed"])
                rest = {k: v for k, v in dd.items() if k != "removed"}
                if any(v for v in rest.values()):
                    out[t] = rest
            else:
                out[t] = dd
        return out, dropped

    def drop_reminder_added(delta):
        dd = delta.get("email_queue")
        if not dd or not dd.get("added"):
            return delta, 0
        kept = {}
        dropped = 0
        for k, row in dd["added"].items():
            subj = row.get("subject") if isinstance(row, dict) else None
            if isinstance(subj, str) and \
                    CRON_RUN_SCOPE_EMAIL_SUBJECT in subj:
                dropped += 1
            else:
                kept[k] = row
        if dropped == 0:
            return delta, 0
        nd = dict(dd)
        nd["added"] = kept
        out = dict(delta)
        out["email_queue"] = nd
        return out, dropped

    g_filt, g_rem = drop_removed(g_delta)
    r_filt, r_rem = drop_removed(r_delta)
    g_filt, g_em = drop_reminder_added(g_filt)
    r_filt, r_em = drop_reminder_added(r_filt)
    lines = []
    for t in CRON_RUN_SCOPE_TABLES_REMOVED:
        lines.append(
            f"{t} removed rows excluded (golden {g_rem.get(t, 0)}, "
            f"replay {r_rem.get(t, 0)}) — purge cleanup, no money "
            f"columns, no money effect")
    lines.append(
        f"email_queue added rows with subject containing "
        f"'{CRON_RUN_SCOPE_EMAIL_SUBJECT}' excluded (golden {g_em}, "
        f"replay {r_em}) — date-window reminder counts, not money")
    return g_filt, r_filt, lines


def compare_golden(h, golden, replay_envs, replay_delta, steps,
                   snapshot_ids=None):
    """Compare one golden against a fresh replay. Returns
    (verdict, detail, env_diff, db_diff) with verdict in MATCH,
    MONEY-DIFF, NON-MONEY-DIFF, or COUNT-MISMATCH. COUNT-MISMATCH
    means an added-row count differed (table + counts in detail) —
    no pairing was guessed for that table; the diff below it is
    still reported for diagnosis. Canonicalization (id maps +
    month-date scrub) applies to BOTH sides in memory only; the
    golden file is never modified and money fields are never
    remapped (only id/FK fields from the declared lists).
    snapshot_ids (from snapshot_id_sets) constrains FK derivation
    to seed/scenario ids; None disables FK derivation (fail-closed)."""
    g_envs = [scrub_month_dates(e) for e in golden["envelopes"]]
    r_envs = [scrub_month_dates(e) for e in replay_envs]
    g_delta = scrub_month_dates(golden["deltas"])
    r_delta = scrub_month_dates(replay_delta)
    if golden.get("id") == "cron-run":
        # Scope override (see CRON_RUN_SCOPE): applied to both
        # sides, in memory only, and REPORTED — a MATCH for
        # cron-run is only honest if the reader sees what was not
        # checked (main prints "MATCH cron-run" without detail).
        g_delta, r_delta, scope_lines = apply_cron_scope(
            g_delta, r_delta)
        for line in scope_lines:
            print(f"  SCOPE cron-run: {line}")
    maps, mismatches, conflicts = build_id_maps(
        g_delta, r_delta, snapshot_ids)
    r_delta_mapped = apply_id_maps_to_delta(r_delta, maps)
    r_envs_mapped = [apply_id_maps_to_envelope(e, st, maps)
                     for e, st in zip(r_envs, steps)]
    env_diff = h.diff_envelopes(g_envs, r_envs_mapped, steps)
    db_diff = h.diff_deltas(g_delta, r_delta_mapped)
    money = h.is_money_diff(env_diff, db_diff, steps)
    tables = sorted(db_diff.keys())
    env_fields = sorted({x for d in env_diff
                         for x in d.get("diff_fields", [])})
    parts = []
    for (t, ng, nr) in mismatches:
        parts.append(f"COUNT-MISMATCH table {t}: golden added {ng} "
                     f"vs replay added {nr}")
    for (ft, rv, ga, gb) in conflicts:
        parts.append(f"AMBIGUOUS-MAP table {ft}: replay id {rv} -> "
                     f"golden {ga} and {gb}")
    if env_fields:
        parts.append(f"env_fields={env_fields}")
    if tables:
        parts.append(f"db_tables={tables}")
    detail = "; ".join(parts)
    if mismatches or conflicts:
        return "COUNT-MISMATCH", detail, env_diff, db_diff
    if not env_diff and not db_diff:
        return "MATCH", "", env_diff, db_diff
    cls = "MONEY-DIFF" if money else "NON-MONEY-DIFF"
    disp = ("money abort (R6b rule, no tolerance)" if money else
            ("triaged-known tables only"
             if set(tables) <= TRIAGED and not env_diff
             else "untriaged behavior drift"))
    return cls, f"{disp}; {detail}", env_diff, db_diff


def run_negative_control(h, gen):
    """Repeatable negative control for the canonicalization (also
    runnable as: python3 parity48.py --negative-control).
    Replays invoice-pay-refund once on disposable TS, then compares
    the SAME replay against the pristine golden and three corrupted
    golden copies (in-memory copies only — committed goldens never
    modified):
      (a) one money field corrupted (invoice_item price 25 -> 26):
          MUST report MONEY-DIFF (money fields are never remapped).
      (b) one added-row body's "id" field corrupted (email_queue
          first row id -> 9999, key untouched): MUST report
          NON-MONEY-DIFF (a golden-side id difference surfaces, is
          not mapped away, and stays off money tables).
      (c) one id field corrupted on a dependent table (email_queue
          row client_id 1 -> 99999): MUST report NON-MONEY-DIFF
          (never MONEY-DIFF). The snapshot constraint is what makes
          this hold: baseline client 1 never derives a map, so the
          corruption cannot poison envelopes or invoice rows.
      (d) pristine golden vs the drifted replay (email keys
          530-532 vs fresh sequence ids, Nov 1 vs today prose
          dates): MUST MATCH — the "match via mapping" proof that
          surrogate-id drift + wall-clock prose dates do not fail
          a correct replay.
    NOTE on what is NOT asserted: corrupting a golden added-row KEY
    cannot MATCH — pairing is positional on sorted keys by design,
    so a shuffled key pairs the wrong bodies and correctly reports
    a body mismatch. Key corruption is a body-integrity tripwire,
    not a mapping case.
    Returns 0 iff all four assertions hold."""
    import copy
    import os
    if port_up(h.TS_PORT):
        print("refusing: harness TS port :3012 already up — another "
              "DB-mutating suite may be running")
        return 1
    gid = "invoice-pay-refund"
    golden = json.loads((GOLDENS / f"{gid}.json").read_text())
    sc = {"id": gid, "description": golden.get("description", ""),
          "seed_sql": golden["scenario"]["seed_sql"],
          "seed_ops": golden["scenario"]["seed_ops"],
          "steps": golden["scenario"]["steps"]}
    work = LOGS / f"parity48-negctl-{os.getpid()}"
    work.mkdir(parents=True, exist_ok=True)
    snapshot = work / "snapshot.sqlite"
    shutil.copy(h.REF_DB, snapshot)
    snap_ids = snapshot_id_sets(snapshot)
    proc, dbpath = h.setup_ts_disposable(work, snapshot)
    ok = True
    try:
        envs, delta, _ = h.run_scenario_on_stack("ts", sc, snapshot, dbpath)
        n_envs = [h.normalize(e, []) for e in envs]
        n_delta = json.loads(json.dumps(gen.normalize_delta(h, delta)))
        # (a) money corruption: first invoice_item added row, price.
        ga = copy.deepcopy(golden)
        ii_added = ga["deltas"]["invoice_item"]["added"]
        ik = sorted(ii_added.keys(), key=_sort_key)[0]
        old_price = ii_added[ik]["price"]
        ii_added[ik]["price"] = old_price + 1
        verdict, detail, _, _ = compare_golden(
            h, ga, n_envs, n_delta, sc["steps"], snap_ids)
        good = verdict == "MONEY-DIFF"
        ok = ok and good
        print(f"  {'PASS' if good else 'FAIL'} negative control (a) "
              f"money price {old_price} -> {old_price + 1}: {verdict} "
              f"{detail}")
        # (b) added-row body "id" field corruption (key untouched).
        gb = copy.deepcopy(golden)
        erow_b = next(iter(gb["deltas"]["email_queue"]["added"].values()))
        old_bid = erow_b["id"]
        erow_b["id"] = 9999
        verdict, detail, _, _ = compare_golden(
            h, gb, n_envs, n_delta, sc["steps"], snap_ids)
        good = verdict == "NON-MONEY-DIFF"
        ok = ok and good
        print(f"  {'PASS' if good else 'FAIL'} negative control (b) "
              f"email_queue body id {old_bid} -> 9999: {verdict} "
              f"{detail}")
        # (c) dependent-table id field corruption.
        gc = copy.deepcopy(golden)
        erow = next(iter(gc["deltas"]["email_queue"]["added"].values()))
        old_cid = erow["client_id"]
        erow["client_id"] = 99999
        verdict, detail, _, _ = compare_golden(
            h, gc, n_envs, n_delta, sc["steps"], snap_ids)
        good = verdict == "NON-MONEY-DIFF"
        ok = ok and good
        print(f"  {'PASS' if good else 'FAIL'} negative control (c) "
              f"email_queue client_id {old_cid} -> 99999: {verdict} "
              f"{detail}")
        # (d) pristine golden vs drifted replay: must MATCH.
        verdict, detail, _, _ = compare_golden(
            h, golden, n_envs, n_delta, sc["steps"], snap_ids)
        good = verdict == "MATCH"
        ok = ok and good
        print(f"  {'PASS' if good else 'FAIL'} negative control (d) "
              f"pristine golden vs drifted replay: {verdict} {detail}")
    finally:
        proc.send_signal(signal.SIGTERM)
        h.kill_port(h.TS_PORT)
        shutil.rmtree(work, ignore_errors=True)
    print(f"negative control: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1

def run_cron_money_control(h, gen):
    """Repeatable cron-money control for the narrowing (also
    runnable as: python3 parity48.py --cron-money-control).
    Replays cron-run once on disposable TS, then compares the SAME
    replay against the pristine golden and a money-corrupted copy
    (in-memory copies only — committed goldens never modified):
      (i) pristine golden vs replay: MUST MATCH, with the
          narrowing active (SCOPE lines print) — cart purge +
          reminder rows excluded, everything else exact.
      (ii) one money-behavior field corrupted (first invoice_item
          changed row's POST status executed -> pending_setup,
          i.e. 'the cron activation did not happen'): MUST report
          MONEY-DIFF. invoice_item is a money table and its
          activation status still compares exactly, so this proves
          the narrowing did not blind money. (The cron golden's
          money signal is the 106 pending_setup -> executed
          activations; its changed rows carry no price/amount
          columns, so status is the money field to corrupt. The
          12 invoice reminded_at touches are volatile-only and
          cannot serve as a money control.)
    Returns 0 iff both assertions hold."""
    import copy
    import os
    if port_up(h.TS_PORT):
        print("refusing: harness TS port :3012 already up — another "
              "DB-mutating suite may be running")
        return 1
    gid = "cron-run"
    golden = json.loads((GOLDENS / f"{gid}.json").read_text())
    sc = {"id": gid, "description": golden.get("description", ""),
          "seed_sql": golden["scenario"]["seed_sql"],
          "seed_ops": golden["scenario"]["seed_ops"],
          "steps": golden["scenario"]["steps"]}
    work = LOGS / f"parity48-cronctl-{os.getpid()}"
    work.mkdir(parents=True, exist_ok=True)
    snapshot = work / "snapshot.sqlite"
    shutil.copy(h.REF_DB, snapshot)
    snap_ids = snapshot_id_sets(snapshot)
    proc, dbpath = h.setup_ts_disposable(work, snapshot)
    ok = True
    try:
        envs, delta, _ = h.run_scenario_on_stack("ts", sc, snapshot, dbpath)
        n_envs = [h.normalize(e, []) for e in envs]
        n_delta = json.loads(json.dumps(gen.normalize_delta(h, delta)))
        # (i) pristine golden vs replay: must MATCH (narrowed).
        verdict, detail, _, _ = compare_golden(
            h, golden, n_envs, n_delta, sc["steps"], snap_ids)
        good = verdict == "MATCH"
        ok = ok and good
        print(f"  {'PASS' if good else 'FAIL'} cron-money control (i) "
              f"pristine vs replay: {verdict} {detail}")
        # (ii) money corruption: first invoice_item changed row.
        gc = copy.deepcopy(golden)
        ii_changed = gc["deltas"]["invoice_item"]["changed"]
        ik = sorted(ii_changed.keys(), key=_sort_key)[0]
        post = ii_changed[ik]["status"][1]
        assert post == "executed", post
        ii_changed[ik]["status"][1] = "pending_setup"
        verdict, detail, _, _ = compare_golden(
            h, gc, n_envs, n_delta, sc["steps"], snap_ids)
        good = verdict == "MONEY-DIFF"
        ok = ok and good
        print(f"  {'PASS' if good else 'FAIL'} cron-money control (ii) "
              f"invoice_item {ik} status executed -> pending_setup: "
              f"{verdict} {detail}")
    finally:
        proc.send_signal(signal.SIGTERM)
        h.kill_port(h.TS_PORT)
        shutil.rmtree(work, ignore_errors=True)
    print(f"cron-money control: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


PASS = FAIL = 0
RESULTS = []


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS {name}")
    else:
        FAIL += 1
        print(f"  FAIL {name} {detail}")


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def counts(table):
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        return {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                for t in table}
    finally:
        con.close()


def invariants_ok(label):
    print(f"[{label}] reference invariants")
    c = counts(["admin", "admin_group", "admin_group_member", "cart",
                "invoice", "client_order", "email_queue", "service_custom",
                "extension", "extension_meta", "setting", "currency",
                "client", "support_ticket", "tld", "activity_client_email",
                "invoice_event", "client_order_meta", "rate_limit_counter"])
    con0 = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        c["invoice_starting_number"] = con0.execute(
            "SELECT value FROM setting WHERE param='invoice_starting_number'"
        ).fetchone()[0]
    finally:
        con0.close()
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        qpend = con.execute(
            "SELECT COUNT(*) FROM email_queue WHERE status='pending'"
        ).fetchone()[0]
        qsend = con.execute(
            "SELECT COUNT(*) FROM email_queue WHERE status='sending'"
        ).fetchone()[0]
        cartseq = con.execute(
            "SELECT seq FROM sqlite_sequence WHERE name='cart'").fetchone()
        overdue = con.execute(
            "SELECT value FROM setting WHERE param='invoice_overdue_invoked'"
        ).fetchone()
        cron = con.execute(
            "SELECT COUNT(*) FROM setting WHERE param='last_cron_exec'"
        ).fetchone()[0]
    finally:
        con.close()
    h = hashlib.sha256(CONFIG.read_bytes()).hexdigest()[:16]
    check("admin 2", c["admin"] == 2, str(c["admin"]))
    check("admin_group 3", c["admin_group"] == 3, str(c["admin_group"]))
    check("admin_group_member 1", c["admin_group_member"] == 1,
          str(c["admin_group_member"]))
    check("cart 283", c["cart"] == 283, str(c["cart"]))
    check("cart seq floor >=318", cartseq and cartseq[0] >= 318,
          str(cartseq))
    check("invoice 323", c["invoice"] == 323, str(c["invoice"]))
    check("client_order 11", c["client_order"] == 11,
          str(c["client_order"]))
    check("email_queue 67 = 5 pending + 62 sending",
          c["email_queue"] == 67 and qpend == 5 and qsend == 62,
          f"{c['email_queue']} {qpend} {qsend}")
    check("service_custom 17", c["service_custom"] == 17,
          str(c["service_custom"]))
    check("extension 6", c["extension"] == 6, str(c["extension"]))
    check("extension_meta 3", c["extension_meta"] == 3,
          str(c["extension_meta"]))
    check("setting 38", c["setting"] == 38, str(c["setting"]))
    check("currency 1", c["currency"] == 1, str(c["currency"]))
    check("client 3", c["client"] == 3, str(c["client"]))
    check("support_ticket 2", c["support_ticket"] == 2,
          str(c["support_ticket"]))
    check("tld 1", c["tld"] == 1, str(c["tld"]))
    check("activity_client_email 0", c["activity_client_email"] == 0,
          str(c["activity_client_email"]))
    check("invoice_event 776", c["invoice_event"] == 776,
          str(c["invoice_event"]))
    check("client_order_meta 0", c["client_order_meta"] == 0,
          str(c["client_order_meta"]))
    check("rate_limit_counter 0", c["rate_limit_counter"] == 0,
          str(c["rate_limit_counter"]))
    check("invoice_starting_number 358",
          str(c["invoice_starting_number"]) == "358",
          str(c["invoice_starting_number"]))
    check("invoice_overdue_invoked 2026-10-24 05:31:25",
          overdue and overdue[0] == "2026-10-24 05:31:25", str(overdue))
    check("last_cron_exec absent", cron == 0, str(cron))
    check("config hash 6e3c", h == EXPECTED_HASH, h)


def port_up(port):
    s = socket.socket()
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


def url_up(url, timeout=5):
    try:
        import urllib.request
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    h = load_module("shadow_harness", HERE / "shadow-harness.py")
    gen = load_module("generate_goldens", HERE / "generate-goldens.py")
    if "--negative-control" in sys.argv:
        return run_negative_control(h, gen)
    if "--cron-money-control" in sys.argv:
        return run_cron_money_control(h, gen)

    print("[A] reference state before")
    invariants_ok("before")
    check(":8080 answering (TCP)", port_up(8080))
    check(":3001 answering (prime)",
          url_up("http://127.0.0.1:3001/api/fb/__prime"))
    check(":18081 DOWN (no other suite running)", not port_up(18081))
    check(":3012 DOWN (no other suite running)", not port_up(3012))
    if FAIL:
        print("ABORT: reference state, servers, or a running suite "
              "blocks the run; fix first, do not launch.")
        print(f"parity48: {PASS} passed, {FAIL} failed")
        return 1

    print("[B] golden replay on a fresh disposable TS instance")
    work = LOGS / f"parity48-work-{__import__('os').getpid()}"
    work.mkdir(parents=True, exist_ok=True)
    snapshot = work / "snapshot.sqlite"
    shutil.copy(h.REF_DB, snapshot)
    # Pre-seed snapshot ids, computed ONCE (the snapshot file is
    # never modified by replays — restore_db copies snapshot ->
    # dbpath, never the reverse). Constrains FK derivation to
    # seed/scenario ids (see build_id_maps).
    snap_ids = snapshot_id_sets(snapshot)
    proc, dbpath = h.setup_ts_disposable(work, snapshot)
    assert str(dbpath).startswith(str(work)), dbpath
    assert str(h.REF_DB) not in str(dbpath), dbpath
    assert "runtime" not in str(dbpath), dbpath
    print(f"  disposable TS on :{h.TS_PORT} db={dbpath}")
    try:
        scen_ids = [s["id"] for s in
                    json.loads(SCENARIOS.read_text())["scenarios"]]
        expected = set(scen_ids) | set(gen.INCLUDED_FIXTURES)
        files = sorted(GOLDENS.glob("*.json"))
        check("golden count 19", len(files) == 19, str(len(files)))
        check("golden ids == expected set",
              {f.stem for f in files} == expected,
              str(sorted({f.stem for f in files} ^ expected)))
        for f in files:
            golden = json.loads(f.read_text())
            gid = golden["id"]
            sc = {"id": gid,
                  "description": golden.get("description", ""),
                  "seed_sql": golden["scenario"]["seed_sql"],
                  "seed_ops": golden["scenario"]["seed_ops"],
                  "steps": golden["scenario"]["steps"]}
            envs, delta, _cap = h.run_scenario_on_stack(
                "ts", sc, snapshot, dbpath)
            n_envs = [h.normalize(e, []) for e in envs]
            n_delta = gen.normalize_delta(h, delta)
            # Golden keys are strings (JSON round-trip); fresh delta
            # keys are ints (sqlite ids). diff_deltas sorts changed
            # row keys, which crashes on mixed int/str — and plain
            # dict equality would mismatch the same rows. Round-trip
            # the fresh delta first (same fix as payload_sha).
            n_delta = json.loads(json.dumps(n_delta))
            # Canonicalized comparison (see header): id maps +
            # month-date scrub, both sides in memory only. Golden
            # files are never modified here; money fields are never
            # remapped (compare_golden maps id/FK fields only).
            verdict, detail, _env_diff, _db_diff = compare_golden(
                h, golden, n_envs, n_delta, sc["steps"], snap_ids)
            RESULTS.append((gid, verdict, detail))
            if verdict == "MATCH":
                print(f"  MATCH {gid}")
                check(f"replay {gid} MATCH", True)
            else:
                print(f"  {verdict} {gid} {detail}")
                check(f"replay {gid} MATCH", False,
                      f"{verdict} {detail}")
    finally:
        proc.send_signal(signal.SIGTERM)
        h.kill_port(h.TS_PORT)
        shutil.rmtree(work, ignore_errors=True)

    print("[C] guardrails (re-asserted)")
    check("VOLATILE_KEYS == documented 10",
          sorted(h.VOLATILE_KEYS) == DOCUMENTED_VOLATILE,
          str(sorted(h.VOLATILE_KEYS)))
    check("no money field normalized",
          not (set(h.VOLATILE_KEYS) & MONEY_FIELDS),
          str(set(h.VOLATILE_KEYS) & MONEY_FIELDS))
    check("no money field ends in _at",
          not any(fld.endswith("_at") for fld in MONEY_FIELDS))
    for f in sorted(GOLDENS.glob("*.json")):
        golden = json.loads(f.read_text())
        md = golden["metadata"]
        gid = golden["id"]
        check(f"metadata complete ({gid})",
              all(md.get(k) for k in ("generator", "generated_at",
                                      "ts_commit", "oracle_version",
                                      "oracle_config_hash",
                                      "normalization",
                                      "payload_sha256")),
              str(sorted(md.keys())))
        check(f"oracle_config_hash == reference ({gid})",
              md.get("oracle_config_hash") == EXPECTED_HASH,
              str(md.get("oracle_config_hash")))
        check(f"payload_sha256 valid ({gid})",
              gen.payload_sha(golden["envelopes"], golden["deltas"])
              == md.get("payload_sha256"))
        rev = golden.get("php_review")
        check(f"php_review reviewed, not DIFFERS ({gid})",
              rev is not None and rev.get("verdict") in (
                  "AGREES-WITH-PHP", "TRIAGED-DIVERGENCE"),
              str(rev and rev.get("verdict")))
        check(f"php_review money False ({gid})",
              rev is not None and rev.get("money_diff") is False,
              str(rev and rev.get("money_diff")))
        check(f"php_review envelope diffs 0 ({gid})",
              rev is not None and rev.get("envelope_diffs") == 0,
              str(rev and rev.get("envelope_diffs")))

    print("[D] accounting (goldens change no handler count)")
    acc = subprocess.run([sys.executable, str(HERE / "endpoint-accounting.py")],
                         capture_output=True, text=True)
    check("accounting exit 0", acc.returncode == 0,
          (acc.stdout + acc.stderr)[-300:])
    out = acc.stdout + acc.stderr
    check("accounting 548+31+0",
          "548" in out and "sum:" in out and "579" in out, out[-200:])

    print("[E] restore")
    invariants_ok("after")
    check(":8080 answering at end (TCP)", port_up(8080))
    check(":3001 answering at end (prime)",
          url_up("http://127.0.0.1:3001/api/fb/__prime"))
    for port, name in [(8081, ":8081 oracle"), (18025, ":18025 mock SMTP"),
                       (18026, ":18026 antispam mock"),
                       (3003, ":3003 forced"), (18081, ":18081 harness PHP"),
                       (3012, ":3012 harness TS")]:
        check(f"{name} DOWN at end", not port_up(port))
    check("disposable work dir deleted", not work.exists(), str(work))

    n_match = sum(1 for _, r, _ in RESULTS if r == "MATCH")
    print(f"  replay: {n_match}/{len(RESULTS)} MATCH")
    for gid, res, detail in RESULTS:
        if res != "MATCH":
            print(f"    {res} {gid} {detail}")
    print("  SKIPs: 0 (exclusions are documented in "
          "findings-goldens.md, not skipped checks here)")
    print(f"parity48: {PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
