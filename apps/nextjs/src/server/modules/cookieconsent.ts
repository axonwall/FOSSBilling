import { readExtensionConfig } from "../crypt";
import { isModuleActive } from "../db";
import { FbError, register } from "../dispatch";

/**
 * Cookieconsent module — TS port of Cookieconsent/Api/Guest.php,
 * behind the module-active gate: on the reference install
 * cookieconsent is NOT installed, so PHP answers 715 and so does
 * this handler. The real logic behind the gate (config message or
 * the built-in default) is implemented but unverified-live.
 */

register("guest", "cookieconsent", "message", () => {
  if (!isModuleActive("cookieconsent")) {
    throw new FbError("FOSSBilling module cookieconsent is not installed/activated", 715);
  }
  const config = readExtensionConfig("mod_cookieconsent");
  return (
    (config["message"] as string | undefined) ??
    "This website uses cookies. By continuing to use this website, you consent to our use of these cookies."
  );
});
