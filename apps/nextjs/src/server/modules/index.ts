/**
 * Registry bootstrap for TS-ported modules. Importing this file loads
 * every ported module's handlers into the dispatcher. Add new modules
 * here as phases port them.
 */
import "./system";
import "./currency";
import "./client";

export { findHandler, tsModulesEnabled } from "../dispatch";
