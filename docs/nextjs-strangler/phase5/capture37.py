#!/usr/bin/env python3
"""Phase 5 R5a capture: PHP (:8080) reference corpus for the six deferred
system endpoints + update_params validation, saved under captures37/.
Read-only except the explicitly round-tripped writes, all restored in
finally (setting rows + config.php bytes + config.old.php state).

Captured:
  01-04  super reads: localization_settings, error_reporting_enabled,
         last_error_reporting_change, instance_id
  05-11  update_params invalid invoice_starting_number (urlencoded):
         0, -5, 1.5, abc, empty, PHP_INT_MAX, 12abc
  12-16  update_params invalid invoice_reminder_send_time: 25:00,
         9:00, 24:00, 12:60, banana
  17-19  update_params valid writes (restored): reminder 09:30,
         starting 1, starting PHP_INT_MAX-1 (+ stored values via sqlite)
  20-21  combined invalid, both orders (first error wins)
  22     validate-then-write: probe param + invalid starting -> error,
         probe row absent afterwards
  23     toggle_error_reporting round-trip (flipped, then restored)
  24     update_localization round-trip: de_DE + "0", then "" + "banana"
         (locale unchanged, auto_detect defaults true)
  25     logged-out 201s for the six endpoints + update_params
  26     mixed-case key Invoice_Starting_Number: 0 -> starting error
  27-30  JSON-body cases: null/true/5.5 starting -> error; 5 starting
         valid (+ stored value); null reminder valid (+ stored value)
  31     baselines: setting rows for the two invoice params (pre-run)

SECRET HYGIENE: no config.php content is dumped. Only endpoint
envelopes and the two invoice setting values (+ locale/auto_detect/
report_errors key presence via the endpoints themselves) are stored.
The config backup lives only in memory during the run and is restored
in finally; instance_id is an admin-API return value, not a secret.
"""
import hashlib
import http.cookiejar
import json
import pathlib
import re
import sqlite3
import urllib.error
import urllib.parse
import urllib.request

PHP = "http://127.0.0.1:8080"
DBP = "/home/hatch/scratch/fossbilling/runtime/src/data/fossbilling.sqlite"
CFG = "/home/hatch/scratch/fossbilling/runtime/src/config.php"
SUPER_EMAIL = "admin@phase0.local"
SUPER_PASS = "Phase1-Admin!42"
OUT = pathlib.Path(__file__).resolve().parent / "captures37"
OUT.mkdir(exist_ok=True)
MAX_MINUS_1 = "9223372036854775806"
MAX_VAL = "9223372036854775807"


def setting_row(param):
    d = sqlite3.connect(DBP)
    r = d.execute("SELECT param, value FROM setting WHERE param = ?", (param,)).fetchone()
    d.close()
    return list(r) if r else None


def main():
    cfg_bytes = pathlib.Path(CFG).read_bytes()
    cfg_hash = hashlib.sha256(cfg_bytes).hexdigest()
    oldp = pathlib.Path(CFG.replace("config.php", "config.old.php"))
    old_bytes = oldp.read_bytes() if oldp.exists() else None
    orig_start = setting_row("invoice_starting_number")
    orig_remind = setting_row("invoice_reminder_send_time")
    baselines = {"invoice_starting_number": orig_start,
                 "invoice_reminder_send_time": orig_remind,
                 "config_sha256": cfg_hash}

    cj = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))
    page = op.open(f"{PHP}/login", timeout=20).read().decode("utf-8", "replace")
    token = re.search(r'name="CSRFToken"[^>]*value="([^"]+)"', page).group(1)

    def call(role, module, method, data=None, as_json=False):
        if as_json:
            # PHP strips CSRFToken before dispatch (R4a probe); the token
            # must ride inside the JSON body or PHP answers CSRF 403.
            payload = {"CSRFToken": token}
            payload.update(data or {})
            body = json.dumps(payload).encode()
            req = urllib.request.Request(
                f"{PHP}/api/{role}/{module}/{method}", data=body, method="POST",
                headers={"Content-Type": "application/json"})
        else:
            payload = dict(data or {})
            payload["CSRFToken"] = token
            body = urllib.parse.urlencode(payload).encode()
            req = urllib.request.Request(
                f"{PHP}/api/{role}/{module}/{method}", data=body, method="POST")
        try:
            with op.open(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode())

    def save(name, env):
        (OUT / name).write_text(json.dumps(env, indent=1, sort_keys=True) + "\n")
        print(f"saved {name}")

    save("31-baselines.json", baselines)

    login = call("guest", "staff", "login", {"email": SUPER_EMAIL, "password": SUPER_PASS})
    assert login.get("error") is None, login

    try:
        save("01-localization-settings.json",
             call("admin", "system", "localization_settings"))
        save("02-error-reporting-enabled.json",
             call("admin", "system", "error_reporting_enabled"))
        save("03-last-error-reporting-change.json",
             call("admin", "system", "last_error_reporting_change"))
        save("04-instance-id.json", call("admin", "system", "instance_id"))

        for i, v in enumerate(["0", "-5", "1.5", "abc", "", MAX_VAL, "12abc"]):
            save(f"{5 + i:02d}-start-invalid-{i}.json",
                 call("admin", "system", "update_params",
                      {"invoice_starting_number": v}))
        for i, v in enumerate(["25:00", "9:00", "24:00", "12:60", "banana"]):
            save(f"{12 + i:02d}-remind-invalid-{i}.json",
                 call("admin", "system", "update_params",
                      {"invoice_reminder_send_time": v}))

        save("17-remind-valid-0930.json",
             call("admin", "system", "update_params",
                  {"invoice_reminder_send_time": "09:30"}))
        save("17b-remind-stored.json",
             {"stored": setting_row("invoice_reminder_send_time")})
        save("18-start-valid-1.json",
             call("admin", "system", "update_params",
                  {"invoice_starting_number": "1"}))
        save("18b-start-stored.json",
             {"stored": setting_row("invoice_starting_number")})
        save("19-start-valid-maxminus1.json",
             call("admin", "system", "update_params",
                  {"invoice_starting_number": MAX_MINUS_1}))
        save("19b-start-stored.json",
             {"stored": setting_row("invoice_starting_number")})

        save("20-combined-start-first.json",
             call("admin", "system", "update_params",
                  {"invoice_starting_number": "0",
                   "invoice_reminder_send_time": "25:00"}))
        save("21-combined-remind-first.json",
             call("admin", "system", "update_params",
                  {"invoice_reminder_send_time": "25:00",
                   "invoice_starting_number": "0"}))
        save("22-validate-then-write.json",
             call("admin", "system", "update_params",
                  {"r5a_probe_param": "probe-val",
                   "invoice_starting_number": "0"}))
        save("22b-probe-absent.json",
             {"stored": setting_row("r5a_probe_param")})

        en0 = call("admin", "system", "error_reporting_enabled")
        save("23-toggle-1.json",
             call("admin", "system", "toggle_error_reporting"))
        en1 = call("admin", "system", "error_reporting_enabled")
        save("23-toggle-2.json",
             call("admin", "system", "toggle_error_reporting"))
        en2 = call("admin", "system", "error_reporting_enabled")
        save("23-toggle-states.json",
             {"before": en0, "after_toggle_1": en1, "after_toggle_2": en2})

        loc0 = call("admin", "system", "localization_settings")
        save("24-loc-write.json",
             call("admin", "system", "update_localization_settings",
                  {"locale": "de_DE", "auto_detect_locale": "0"}))
        loc1 = call("admin", "system", "localization_settings")
        save("24-loc-write-empty-banana.json",
             call("admin", "system", "update_localization_settings",
                  {"locale": "", "auto_detect_locale": "banana"}))
        loc2 = call("admin", "system", "localization_settings")
        save("24-loc-states.json",
             {"before": loc0, "after_write": loc1, "after_empty_banana": loc2})

        cj2 = http.cookiejar.CookieJar()
        op2 = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj2))
        logged_out = {}
        for m in ("localization_settings", "update_localization_settings",
                  "error_reporting_enabled", "toggle_error_reporting",
                  "last_error_reporting_change", "instance_id", "update_params"):
            body = urllib.parse.urlencode({}).encode()
            req = urllib.request.Request(
                f"{PHP}/api/admin/system/{m}", data=body, method="POST")
            try:
                with op2.open(req, timeout=60) as resp:
                    logged_out[m] = json.loads(resp.read().decode())
            except urllib.error.HTTPError as e:
                logged_out[m] = json.loads(e.read().decode())
        save("25-logged-out.json", logged_out)

        save("26-mixed-case-key.json",
             call("admin", "system", "update_params",
                  {"Invoice_Starting_Number": "0"}))

        save("27-json-null-start.json",
             call("admin", "system", "update_params",
                  {"invoice_starting_number": None}, as_json=True))
        save("28-json-true-start.json",
             call("admin", "system", "update_params",
                  {"invoice_starting_number": True}, as_json=True))
        save("29-json-55-start.json",
             call("admin", "system", "update_params",
                  {"invoice_starting_number": 5.5}, as_json=True))
        save("30-json-5-start.json",
             call("admin", "system", "update_params",
                  {"invoice_starting_number": 5}, as_json=True))
        save("30b-json-5-stored.json",
             {"stored": setting_row("invoice_starting_number")})
        save("30-json-null-remind.json",
             call("admin", "system", "update_params",
                  {"invoice_reminder_send_time": None}, as_json=True))
        save("30c-json-null-remind-stored.json",
             {"stored": setting_row("invoice_reminder_send_time")})
    finally:
        d = sqlite3.connect(DBP)
        for param, orig in (("invoice_starting_number", orig_start),
                            ("invoice_reminder_send_time", orig_remind)):
            if orig is None:
                d.execute("DELETE FROM setting WHERE param = ?", (param,))
            else:
                d.execute("UPDATE setting SET value = ? WHERE param = ?",
                          (orig[1], param))
        d.execute("DELETE FROM setting WHERE param = 'r5a_probe_param'")
        d.commit()
        d.close()
        pathlib.Path(CFG).write_bytes(cfg_bytes)
        if old_bytes is None:
            if oldp.exists():
                oldp.unlink()
        else:
            oldp.write_bytes(old_bytes)
        after = hashlib.sha256(pathlib.Path(CFG).read_bytes()).hexdigest()
        print(f"capture37: config restored: {after == cfg_hash}, "
              f"start={setting_row('invoice_starting_number') == orig_start}, "
              f"remind={setting_row('invoice_reminder_send_time') == orig_remind}")


if __name__ == "__main__":
    main()
