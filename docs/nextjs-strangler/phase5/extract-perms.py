#!/usr/bin/env python3
"""Extract getModulePermissions() catalogs from FOSSBilling Service.php files.
Outputs JSON: { module_lower: { keys: [{key, type, display, options}],
hide_permissions: bool, can_always_access: bool } }.
Heuristic PHP-array parser: handles 'x'/'x' strings, [..] arrays,
__trans('literal') values, true/false/null/ints. Anything unparseable
is reported, not silently dropped.
"""
import json
import re
import sys
from pathlib import Path

SRC = Path("/home/hatch/scratch/fossbilling/repo/src/modules")


class ParseErr(Exception):
    pass


class P:
    def __init__(self, s):
        self.s = s
        self.i = 0

    def skip(self):
        s, n = self.s, len(self.s)
        while self.i < n:
            c = s[self.i]
            if c in " \t\r\n":
                self.i += 1
            elif s.startswith("//", self.i):
                j = s.find("\n", self.i)
                self.i = n if j < 0 else j + 1
            elif s.startswith("/*", self.i):
                j = s.find("*/", self.i + 2)
                self.i = n if j < 0 else j + 2
            else:
                break

    def peek(self):
        self.skip()
        return self.s[self.i] if self.i < len(self.s) else ""

    def expect(self, ch):
        self.skip()
        if self.i >= len(self.s) or self.s[self.i] != ch:
            raise ParseErr(f"expected {ch!r} at {self.i}: ...{self.s[max(0,self.i-20):self.i+20]!r}")
        self.i += 1

    def string(self):
        self.skip()
        q = self.s[self.i]
        if q not in "'\"":
            raise ParseErr(f"expected string at {self.i}")
        self.i += 1
        out = []
        while self.i < len(self.s):
            c = self.s[self.i]
            if c == "\\" and self.i + 1 < len(self.s):
                out.append(self.s[self.i + 1])
                self.i += 2
            elif c == q:
                self.i += 1
                return "".join(out)
            else:
                out.append(c)
                self.i += 1
        raise ParseErr("unterminated string")

    def value(self):
        self.skip()
        c = self.peek()
        if c in "'\"":
            return self.string()
        if c == "[":
            return self.array()
        if self.s.startswith("array", self.i):
            self.i += 5
            self.skip()
            if self.peek() == "(":
                self.i += 1
                return self.array_paren()
            raise ParseErr("array without (")
        m = re.match(r"[A-Za-z_\\][A-Za-z0-9_\\]*", self.s[self.i:])
        if m:
            name = m.group(0)
            self.i += len(name)
            self.skip()
            if self.peek() == "(":
                # function call: parse args, __trans first string arg wins
                self.i += 1
                args = []
                depth = 1
                first = None
                while depth > 0:
                    self.skip()
                    if self.i >= len(self.s):
                        raise ParseErr("unterminated call")
                    ch = self.s[self.i]
                    if ch in "'\"":
                        v = self.string()
                        if first is None:
                            first = v
                        args.append(v)
                    elif ch == "[":
                        args.append(self.array())
                    elif ch == "(":
                        depth += 1
                        self.i += 1
                    elif ch == ")":
                        depth -= 1
                        self.i += 1
                    elif ch == ",":
                        self.i += 1
                    else:
                        self.i += 1
                return first if name.endswith("trans") else None
            if name in ("true", "false"):
                return name == "true"
            if name == "null":
                return None
            return None  # constants etc.
        m = re.match(r"-?\d+(\.\d+)?", self.s[self.i:])
        if m:
            self.i += len(m.group(0))
            return m.group(0)
        raise ParseErr(f"cannot parse value at {self.i}: ...{self.s[self.i:self.i+30]!r}")

    def array(self):
        self.expect("[")
        return self.array_body("]")

    def array_paren(self):
        return self.array_body(")")

    def array_body(self, close):
        out = []  # list of (key, value) or (None, value)
        while True:
            self.skip()
            if self.i >= len(self.s):
                raise ParseErr("unterminated array")
            if self.s[self.i] == close:
                self.i += 1
                return out
            # try key => value
            save = self.i
            try:
                k = self.value()
            except ParseErr:
                k = None
                self.i = save
            self.skip()
            if self.s.startswith("=>", self.i):
                self.i += 2
                v = self.value()
                out.append((k, v))
            else:
                self.i = save
                out.append((None, self.value()))
            self.skip()
            if self.peek() == ",":
                self.i += 1


def assoc(arr):
    d = {}
    for k, v in arr:
        if k is not None:
            d[k] = v
    return d


catalog = {}
problems = []
for svc in sorted(SRC.glob("*/Service.php")):
    mod = svc.parent.name.lower()
    text = svc.read_text()
    m = re.search(r"function getModulePermissions\(\)", text)
    if not m:
        continue
    body = text[m.start():]
    rm = re.search(r"return\s*\[", body)
    if not rm:
        problems.append(f"{mod}: no return [ found")
        continue
    p = P(body[rm.start():])
    p.skip()
    assert p.s.startswith("return", p.i)
    p.i += 6
    try:
        arr = p.array()
    except ParseErr as e:
        problems.append(f"{mod}: {e}")
        continue
    d = assoc(arr)
    hide = d.get("hide_permissions") is True
    always = d.get("can_always_access") is True
    keys = []
    for k, v in arr:
        if k in (None, "hide_permissions", "can_always_access"):
            continue
        if not isinstance(v, list):
            problems.append(f"{mod}.{k}: non-array entry {v!r}")
            continue
        vd = assoc(v)
        typ = vd.get("type")
        opts = None
        if isinstance(vd.get("options"), list):
            opts = [ok for ok, _ in vd["options"] if ok is not None]
        keys.append(
            {
                "key": k,
                "type": typ if typ in ("bool", "select") else "bool",
                "display": vd.get("display_name") or k,
                "options": opts,
            }
        )
    catalog[mod] = {"keys": keys, "hide_permissions": hide, "can_always_access": always}

print(json.dumps({"catalog": catalog, "problems": problems}, indent=1, sort_keys=True))
print(f"// modules: {len(catalog)}, total keys: {sum(len(v['keys']) for v in catalog.values())}", file=sys.stderr)
