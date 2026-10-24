/**
 * Registry bootstrap for TS-ported modules. Importing this file loads
 * every ported module's handlers into the dispatcher. Add new modules
 * here as phases port them.
 */
import "./system";
import "./currency";
import "./client";
import "./staff";
import "./activity";
import "./news";
import "./custompages";
import "./product";
import "./cart";
import "./invoice";
import "./order";
import "./cron";

export { findHandler, tsModulesEnabled } from "../dispatch";
