// Servicecustom plugin runtime (Phase 5 R4d) — TS port of
// src/modules/Servicecustom/Service.php::customCall/callOnAdapter.
//
// PHP loads operator-provided plugin classes from Plugin/<name>/<name>.php
// at call time and constructs one per call with the service row's JSON
// plugin config. TS cannot load PHP code, so operators register in-tree
// adapter FACTORIES here instead; the dispatcher calls the factory per
// call with the row's parsed plugin config, mirroring PHP's per-call
// `new $plugin($config)`. The registry ships EMPTY (D4-4): no built-in
// adapters exist, and inventing a default adapter would change
// servicecustom behavior. Operators add adapters at the documented
// point below (registerPlugin), in-tree only.
//
// Adapter action methods receive exactly what PHP passes:
//   adapter[method](serviceData, orderData, params)
// where serviceData is Service::toApiArray (config fields + id,
// client_id, plugin, updated_at, created_at), orderData is the order
// API array, and params is the call's data (CSRFToken stripped, as
// PHP's ApiController strips it before dispatch). The adapter's
// return value passes through to the API response verbatim, as in
// PHP (callOnAdapter returns $adapter->$method(...) directly).
//
// Operator registration point (in-tree adapters only):
//   import { registerPlugin } from "./servicecustom-plugin";
//   registerPlugin("MyPlugin", (config) => ({
//     my_action: (service, order, params) => { ... },
//   }));
// The factory receives the service row's parsed plugin_config object
// (invalid JSON -> {}, mirroring PHP's `?? []`).

import { FbError } from "./dispatch";

/** One adapter action: (serviceData, orderData, params) -> result. */
export type PluginAction = (
  service: Record<string, unknown>,
  order: Record<string, unknown>,
  params: Record<string, unknown>,
) => unknown | Promise<unknown>;

/** An adapter object: action name -> action method. */
export type PluginAdapter = Record<string, PluginAction>;

/** Factory: plugin config object -> adapter object (per call). */
export type PluginFactory = (config: Record<string, unknown>) => PluginAdapter;

/** The registry. Ships EMPTY by design (D4-4). */
export const pluginRegistry = new Map<string, PluginFactory>();

export function registerPlugin(name: string, factory: PluginFactory): void {
  pluginRegistry.set(name, factory);
}

/**
 * PHP Service::customCall's forbidden list, in PHP's order. The check
 * is case-sensitive (PHP in_array without strict flag still compares
 * strings case-sensitively) and fires BEFORE plugin resolution, so a
 * forbidden method is refused even when the plugin is empty or the
 * adapter would support it.
 */
export const FORBIDDEN_PLUGIN_METHODS = [
  "delete",
  "cancel",
  "uncancel",
  "suspend",
  "unsuspend",
  "renew",
  "activate",
];

/** Parse a plugin_config JSON string; invalid or empty -> {} (PHP `?? []`). */
export function parsePluginConfig(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface ServiceCustomRowLike {
  id: number;
  client_id: number;
  plugin: string | null;
  config: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/**
 * Mirror of Service::toApiArray: the service row's config JSON spread,
 * then id / client_id / plugin / updated_at / created_at (which win
 * over same-named config keys, as PHP sets them after the spread).
 */
export function customServiceApiArray(row: ServiceCustomRowLike): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  if (row.config) {
    try {
      const parsed: unknown = JSON.parse(row.config);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      /* keep {} — PHP's json_decode ?? [] */
    }
  }
  return {
    ...config,
    id: row.id,
    client_id: row.client_id,
    plugin: row.plugin,
    updated_at: row.updated_at,
    created_at: row.created_at,
  };
}

/** Copy of params without CSRFToken (PHP's ApiController unsets it). */
export function stripAdapterParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (k !== "CSRFToken") out[k] = v;
  }
  return out;
}

export interface DispatchCustomCallArgs {
  /** service_custom.plugin (null/''/'0' all count as empty, per PHP empty()). */
  plugin: string | null | undefined;
  /** service_custom.plugin_config, raw JSON string. */
  pluginConfig: string | null | undefined;
  serviceData: Record<string, unknown>;
  orderData: Record<string, unknown>;
  method: string;
  /**
   * The call's data. `undefined` means NO arguments object was passed
   * at all — the only shape that raises 7103. Over HTTP the dispatcher
   * always wraps [$data], so 7103 cannot fire via HTTP (probed live:
   * empty params yield 'Order ID is required', never 7103); the 7103
   * branch is proven at unit level (plugin-dispatch-test).
   */
  params: Record<string, unknown> | undefined;
}

/**
 * TS port of Service::customCall + callOnAdapter, in PHP's order:
 *  1. arguments present (7103) — see DispatchCustomCallArgs.params.
 *  2. forbidden method (403, message with the method substituted —
 *     PHP's Exception translates ':method' via __trans/strtr).
 *  3. empty plugin -> null (never an error).
 *  4. unregistered adapter -> debug log + null (PHP: missing plugin
 *     file -> InformationException 3124, logged at debug level only
 *     when DEBUG, never thrown; TS mirrors with console.debug).
 *  5. adapter lacks the action -> 3125, message with plugin + action
 *     substituted (PHP's Exception translation, same mechanism).
 *  6. otherwise the adapter action's return passes through verbatim.
 * Adapter method lookup is case-insensitive, mirroring PHP's
 * method_exists (while the forbidden check in step 2 stays
 * case-sensitive, mirroring PHP's in_array).
 */
export async function dispatchCustomCall(args: DispatchCustomCallArgs): Promise<unknown> {
  if (args.params === undefined) {
    throw new FbError("API call is missing arguments", 7103);
  }
  if (FORBIDDEN_PLUGIN_METHODS.includes(args.method)) {
    throw new FbError(`Custom plugin method ${args.method} is forbidden`, 403);
  }
  const plugin = args.plugin;
  if (!plugin || plugin === "0") {
    return null;
  }
  const factory = pluginRegistry.get(plugin);
  if (!factory) {
    // PHP's missing-file path: log at debug level, return null, never throw.
    console.debug(`[servicecustom] No adapter registered for plugin: ${plugin}`);
    return null;
  }
  const adapter = factory(parsePluginConfig(args.pluginConfig));
  const key = Object.keys(adapter).find((k) => k.toLowerCase() === args.method.toLowerCase());
  if (!key) {
    throw new FbError(`Plugin ${plugin} does not support action ${args.method}`, 3125);
  }
  return await adapter[key](args.serviceData, args.orderData, args.params);
}
