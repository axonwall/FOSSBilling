// FOSSBilling Phase 5 R4d — servicecustom plugin dispatch unit tests.
// Compiles src/server/servicecustom-plugin.ts (+ dispatch.ts) with the
// repo tsc into a scratch dir, then proves the dispatcher contract
// with TEST adapters registered in-process (test-only, never shipped
// in the server bundle — the shipped registry stays EMPTY, D4-4).
// This is the ONLY way to prove 3125 + successful dispatch without
// shipping a fake adapter; registered-adapter live HTTP dispatch is
// proven only when an operator registers one (see findings-r4d).
// Exit non-zero on any FAIL.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const TMP = path.join(HERE, ".tmp-plugin-test");

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra = "") {
  if (cond) { pass += 1; console.log(`PASS ${name}`); }
  else { fail += 1; failures.push(name); console.log(`FAIL ${name} ${extra}`); }
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}
async function throws(name, fn, code, message) {
  try { await fn(); ok(name, false, "(did not throw)"); }
  catch (e) {
    ok(name, e.code === code && e.message === message,
      `threw code=${e.code} message=${JSON.stringify(e.message)}`);
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
try {
  execSync(
    `npx tsc src/server/servicecustom-plugin.ts src/server/dispatch.ts ` +
      `--outDir ${TMP} --module esnext --target es2022 --moduleResolution bundler --skipLibCheck --declaration false`,
    { cwd: APP, stdio: "pipe" },
  );
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        let t = fs.readFileSync(p, "utf8");
        t = t.replace(/from "(\.[^\"]*)"/g, (m, spec) =>
          /\.(js|mjs|json)$/.test(spec) ? m : `from "${spec}.js"`);
        fs.writeFileSync(p, t);
      }
    }
  };
  walk(TMP);
  // Inputs share src/server as common root, so tsc mirrors them flat
  // under TMP (no src/server prefix, unlike the importer tests).
  const plug = await import(path.join(TMP, "servicecustom-plugin.js"));
  const {
    pluginRegistry, registerPlugin, dispatchCustomCall, customServiceApiArray,
    stripAdapterParams, parsePluginConfig, FORBIDDEN_PLUGIN_METHODS,
  } = plug;

  ok("registry ships empty", pluginRegistry.size === 0);
  eq("forbidden list (PHP order)", FORBIDDEN_PLUGIN_METHODS,
    ["delete", "cancel", "uncancel", "suspend", "unsuspend", "renew", "activate"]);

  // Test adapter (in-process only): records calls, echoes args.
  let factoryCalls = 0;
  let lastConfig = null;
  const seen = [];
  registerPlugin("Testplug", (config) => {
    factoryCalls += 1;
    lastConfig = config;
    return {
      do_thing: (service, order, params) => {
        seen.push(["do_thing", service, order, params]);
        return { echoed: true, serviceId: service.id, orderId: order.id, flag: params.flag };
      },
      returns_null: () => null,
      returns_string: () => "hello",
      delete: () => "must never run",
      DoThing: (service) => `capital:${service.id}`,
    };
  });
  const svc = { id: 7, client_id: 1, plugin: "Testplug", config: '{"a":1}', created_at: "2026-01-01 00:00:00", updated_at: "2026-01-02 00:00:00" };
  const svcData = customServiceApiArray(svc);
  const ordData = { id: 9, client_id: 1, status: "active" };

  // P1: supported action passes through exactly, with exact args.
  const r1 = await dispatchCustomCall({
    plugin: "Testplug", pluginConfig: '{"cfg":true}',
    serviceData: svcData, orderData: ordData, method: "do_thing", params: { flag: "x" },
  });
  eq("P1 passthrough return", r1, { echoed: true, serviceId: 7, orderId: 9, flag: "x" });
  eq("P1 adapter got (service, order, params)", seen[0].slice(1),
    [svcData, ordData, { flag: "x" }]);
  eq("P1 factory got parsed config", lastConfig, { cfg: true });
  ok("P1 factory called per call", factoryCalls === 1);
  await dispatchCustomCall({
    plugin: "Testplug", pluginConfig: '{"cfg":false}',
    serviceData: svcData, orderData: ordData, method: "returns_null", params: {},
  });
  ok("P1 factory called again per call", factoryCalls === 2);
  eq("P1 null passthrough", await dispatchCustomCall({
    plugin: "Testplug", pluginConfig: null,
    serviceData: svcData, orderData: ordData, method: "returns_null", params: {},
  }), null);
  eq("P1 string passthrough", await dispatchCustomCall({
    plugin: "Testplug", pluginConfig: "not-json{{",
    serviceData: svcData, orderData: ordData, method: "returns_string", params: {},
  }), "hello");
  eq("P1 invalid plugin_config -> {}", lastConfig, {});

  // P2: unsupported action -> 3125, exact substituted message.
  await throws("P2 unsupported -> 3125", () => dispatchCustomCall({
    plugin: "Testplug", pluginConfig: null,
    serviceData: svcData, orderData: ordData, method: "nosuch", params: {},
  }), 3125, "Plugin Testplug does not support action nosuch");

  // P3: forbidden beats dispatch (adapter HAS delete, still 403).
  await throws("P3 forbidden beats dispatch", () => dispatchCustomCall({
    plugin: "Testplug", pluginConfig: null,
    serviceData: svcData, orderData: ordData, method: "delete", params: {},
  }), 403, "Custom plugin method delete is forbidden");
  for (const m of FORBIDDEN_PLUGIN_METHODS) {
    await throws(`P3 forbidden ${m}`, () => dispatchCustomCall({
      plugin: "Testplug", pluginConfig: null,
      serviceData: svcData, orderData: ordData, method: m, params: {},
    }), 403, `Custom plugin method ${m} is forbidden`);
  }

  // P4: empty plugin -> null (null, '', '0' per PHP empty()).
  for (const p of [null, "", "0", undefined]) {
    eq(`P4 empty plugin ${JSON.stringify(p)} -> null`, await dispatchCustomCall({
      plugin: p, pluginConfig: null,
      serviceData: svcData, orderData: ordData, method: "do_thing", params: {},
    }), null);
  }

  // P5: missing adapter -> null (PHP's missing-file path).
  eq("P5 missing adapter -> null", await dispatchCustomCall({
    plugin: "Nosuchplug", pluginConfig: null,
    serviceData: svcData, orderData: ordData, method: "do_thing", params: {},
  }), null);

  // P6: no arguments object -> 7103.
  await throws("P6 no arguments -> 7103", () => dispatchCustomCall({
    plugin: "Testplug", pluginConfig: null,
    serviceData: svcData, orderData: ordData, method: "do_thing", params: undefined,
  }), 7103, "API call is missing arguments");

  // P8: case-insensitive method lookup; forbidden stays case-sensitive.
  eq("P8 method lookup case-insensitive (DO_THING -> do_thing)", await dispatchCustomCall({
    plugin: "Testplug", pluginConfig: null,
    serviceData: svcData, orderData: ordData, method: "DO_THING", params: {},
  }), { echoed: true, serviceId: 7, orderId: 9 });
  eq("P8 exact-case key wins (DoThing)", await dispatchCustomCall({
    plugin: "Testplug", pluginConfig: null,
    serviceData: svcData, orderData: ordData, method: "DoThing", params: {},
  }), "capital:7");
  eq("P8 'Delete' is NOT forbidden (PHP in_array is case-sensitive)", await dispatchCustomCall({
    plugin: "Testplug", pluginConfig: null,
    serviceData: svcData, orderData: ordData, method: "Delete", params: {},
  }), "must never run");

  // P9: CSRFToken stripping.
  const stripped = stripAdapterParams({ order_id: "1", CSRFToken: "tok", flag: 1 });
  eq("P9 CSRFToken stripped", stripped, { order_id: "1", flag: 1 });
  const orig = { a: 1, CSRFToken: "t" };
  stripAdapterParams(orig);
  eq("P9 input not mutated", orig, { a: 1, CSRFToken: "t" });

  // P10: service api array shape.
  eq("P10 service api array", svcData,
    { a: 1, id: 7, client_id: 1, plugin: "Testplug",
      updated_at: "2026-01-02 00:00:00", created_at: "2026-01-01 00:00:00" });
  eq("P10 invalid config -> no spread", customServiceApiArray({ ...svc, config: "broken{{" }),
    { id: 7, client_id: 1, plugin: "Testplug",
      updated_at: "2026-01-02 00:00:00", created_at: "2026-01-01 00:00:00" });

  // P11: plugin config parsing.
  eq("P11 parse valid", parsePluginConfig('{"k":2}'), { k: 2 });
  eq("P11 parse invalid", parsePluginConfig("xx"), {});
  eq("P11 parse empty", parsePluginConfig(""), {});
  eq("P11 parse null", parsePluginConfig(null), {});
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\nplugin-dispatch-test: ${pass} passed, ${fail} failed`);
if (fail) { console.log("failures:", failures.join(", ")); process.exitCode = 1; }
