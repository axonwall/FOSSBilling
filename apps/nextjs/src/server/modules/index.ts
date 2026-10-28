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
import "./email";
import "./support";
import "./extension";
import "./profile";
import "./stats";
import "./massmailer";
import "./notification";
import "./servicecustom";
import "./servicelicense";
import "./servicedownloadable";
import "./servicehosting";
import "./servicedomain";
import "./formbuilder";
import "./security";
import "./redirect";
import "./antispam";
import "./widgets";
import "./seo";
import "./serviceapikey";
import "./cookieconsent";
import "./page";
import "./indexmod";
import "./theme";

export { findHandler, tsModulesEnabled } from "../dispatch";
