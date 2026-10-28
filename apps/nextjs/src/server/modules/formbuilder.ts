import {
  countFormFields,
  countFormFieldsNamed,
  deleteFormCascade,
  deleteFormFieldRow,
  findForm,
  findFormField,
  insertForm,
  insertFormField,
  listFormFields,
  listFormPairs,
  listFormsWithCounts,
  updateFormFieldRow,
  updateFormRow,
  type FormFieldRow,
} from "../db";
import { FbError, register, requireAdmin, requireParam, type CallContext } from "../dispatch";

/**
 * Formbuilder module — TS port of Formbuilder/Api/Admin.php + Guest.php
 * and Service.php. Pinned by capture26.py + parity23.py.
 *
 * Fidelity notes:
 * - PHP json_decode(..., true) turns objects with keys exactly
 *   '0'..'n-1' into JSON arrays on re-encode (e.g. a checkbox
 *   default_value '{"0":"a","1":"b"}' reads back as ["a","b"]);
 *   phpJsonDecodeAssoc reproduces that, while get_field's plain
 *   json_decode keeps objects as objects.
 * - addNewField forces default options for select/checkbox/radio
 *   and default textarea dimensions; updateField overwrites every
 *   column with the provided value or NULL, and never touches the
 *   type column.
 * - updateField runs slugify BEFORE the field lookup, so a bad name
 *   beats an unknown id; missing values/labels/textarea arrays
 *   surface as PHP TypeError text with code 9998.
 */

const FIELD_TYPES: Record<string, string> = {
  text: "Text Input",
  url: "URL Input",
  select: "Dropdown",
  radio: "Radio Select",
  checkbox: "Checkbox",
  textarea: "Text Area",
};

const DEFAULT_SELECT_OPTIONS = '{"First option":"1", "Second option": "2", "Third option":"3"}';
const DEFAULT_TEXTAREA_OPTIONS = '{"height":"100", "width": "300"}';

/** PHP (int) cast: leading optional sign + digits, else 0. */
export function phpInt(v: unknown): number {
  if (typeof v === "number") return Math.trunc(v);
  const m = /^\s*[+-]?\d+/.exec(String(v ?? ""));
  return m ? parseInt(m[0], 10) : 0;
}

/** PHP json_decode(..., true) with assoc-list semantics, recursively. */
export function phpJsonDecodeAssoc(text: string | null | undefined): unknown {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return assocConvert(parsed);
}

function assocConvert(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(assocConvert);
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    const keys = entries.map(([k]) => k);
    if (keys.length > 0 && keys.every((k, i) => k === String(i))) {
      return entries.map(([, val]) => assocConvert(val));
    }
    return Object.fromEntries(entries.map(([k, val]) => [k, assocConvert(val)]));
  }
  return v;
}

/** PHP json_decode without assoc: objects stay objects, arrays stay arrays. */
function phpJsonDecodeLoose(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** PHP slugify(): non-letter/digit runs → '_', trim '_', transliterate
 * to ASCII, lowercase, strip anything but [-\\w]. Node approximates
 * iconv TRANSLIT with NFD + diacritic stripping (exact for ASCII and
 * Latin-accented input; other scripts may differ). */
export function slugify(text: unknown): string {
  let s = String(text ?? "").replace(/[^\p{L}\d]+/gu, "_");
  s = s.replace(/^_+|_+$/g, "");
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.toLowerCase().replace(/[^\-\w]+/g, "");
  if (s !== "" && /^[0-9]/.test(s)) {
    throw new FbError("Field name cannot start with number.", 1649);
  }
  if (s === "") {
    throw new FbError(
      "Field name cannot be empty. Please make sure it is not empty and does not contain special characters.",
      3502,
    );
  }
  return s;
}

/** Doctrine BOOLEAN storage: '1'/1/true → 1, '0'/0/false → 0, else null. */
function toBoolInt(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  return null;
}

function toTextSize(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  return phpInt(v);
}

/** Raw (un-stringified) value when the call was JSON, else the string param. */
function rawVal(ctx: CallContext, key: string): unknown {
  if (ctx.rawParams && key in ctx.rawParams) return ctx.rawParams[key];
  return ctx.params[key];
}

/** Collect key[N] form-bracket values in numeric order, or the JSON array. */
function bracketList(ctx: CallContext, key: string): unknown[] | undefined {
  const raw = rawVal(ctx, key);
  if (Array.isArray(raw)) return raw;
  const found: [number, string][] = [];
  const re = new RegExp(`^${key}\\[(\\d+)\\]$`);
  for (const [k, v] of Object.entries(ctx.params)) {
    const m = re.exec(k);
    if (m) found.push([Number(m[1]), v]);
  }
  if (found.length === 0) return undefined;
  found.sort(([a], [b]) => a - b);
  return found.map(([, v]) => v);
}

/** Collect key[sub] form-bracket pairs, or the JSON object. */
function bracketMap(ctx: CallContext, key: string): Record<string, unknown> | undefined {
  const raw = rawVal(ctx, key);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  let any = false;
  const re = new RegExp(`^${key}\\[(.*)\\]$`);
  for (const [k, v] of Object.entries(ctx.params)) {
    const m = re.exec(k);
    if (m) {
      out[m[1]] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

function isArrayUnique(values: unknown[]): boolean {
  const strs = values.map((v) => String(v));
  return new Set(strs).size === strs.length;
}

/** JSON_FORCE_OBJECT encoding: arrays become {"0":..} objects. */
function forceObject(v: unknown): string {
  if (Array.isArray(v)) {
    const obj: Record<string, unknown> = {};
    v.forEach((item, i) => {
      obj[String(i)] = item;
    });
    return JSON.stringify(obj);
  }
  return JSON.stringify(v);
}

function decodeFieldRowForForm(row: FormFieldRow): Record<string, unknown> {
  const options = phpJsonDecodeAssoc(row.options);
  const rawDefault = row.default_value;
  let def: unknown = "";
  if (rawDefault !== null && rawDefault !== undefined && rawDefault !== "" && rawDefault !== "0") {
    const parsed = phpJsonDecodeAssoc(rawDefault);
    def = parsed === null || parsed === undefined ? rawDefault : parsed;
  }
  return {
    ...row,
    options: options === null || options === undefined ? [] : options,
    default_value: def,
  };
}

async function addNewField(ctx: CallContext, field: Record<string, unknown>): Promise<number> {
  const formId = field["form_id"];
  const fieldNumber = await countFormFields(phpInt(formId)) + 1;
  const type = String(field["type"]);
  const label = (field["label"] as string | undefined) ?? `${FIELD_TYPES[type]} ${fieldNumber}`;
  const name = (field["name"] as string | undefined) ?? `${slugify(`new_${type}`)}_${fieldNumber}`;
  let options = field["options"] as unknown;
  if (type === "select" || type === "checkbox" || type === "radio") {
    options = DEFAULT_SELECT_OPTIONS;
  } else if (type === "textarea" && options === undefined) {
    options = DEFAULT_TEXTAREA_OPTIONS;
  } else if (Array.isArray(options)) {
    options = forceObject(options);
  } else if (options && typeof options === "object") {
    options = forceObject(options);
  }
  let defaultValue = field["default_value"] as unknown;
  if (Array.isArray(defaultValue)) defaultValue = forceObject(defaultValue);
  else if (defaultValue !== undefined && defaultValue !== null) defaultValue = String(defaultValue);
  return await insertFormField({
    form_id: phpInt(formId),
    name,
    label,
    hide_label: toBoolInt(field["hide_label"]),
    description: field["description"] == null ? null : String(field["description"]),
    type,
    default_value: defaultValue == null ? null : String(defaultValue),
    required: toBoolInt(field["required"]),
    hidden: toBoolInt(field["hidden"]),
    readonly: toBoolInt(field["readonly"]),
    options: options == null ? null : String(options),
    prefix: field["prefix"] == null ? null : String(field["prefix"]),
    suffix: field["suffix"] == null ? null : String(field["suffix"]),
    show_initial: field["show_initial"] == null ? null : String(field["show_initial"]),
    show_middle: field["show_middle"] == null ? null : String(field["show_middle"]),
    show_prefix: field["show_prefix"] == null ? null : String(field["show_prefix"]),
    show_suffix: field["show_suffix"] == null ? null : String(field["show_suffix"]),
    text_size: toTextSize(field["text_size"]),
  });
}

async function getForm(id: number): Promise<Record<string, unknown>> {
  const row = await findForm(id);
  if (!row) throw new FbError("Form was not found");
  let style: unknown = phpJsonDecodeAssoc(row.style);
  if (!style || typeof style !== "object" || Array.isArray(style)) {
    style = { type: "default", show_title: "1" };
  }
  return {
    id: row.id,
    name: row.name,
    style,
    created_at: row.created_at,
    updated_at: row.updated_at,
    fields: (await listFormFields(row.id)).map(decodeFieldRowForForm),
  };
}

function fieldInput(ctx: CallContext): Record<string, unknown> {
  // Scalars come from params; structured inputs from JSON or form brackets.
  const out: Record<string, unknown> = { ...ctx.params };
  for (const key of ["options", "default_value", "values", "labels", "textarea_option", "textarea_size"]) {
    const list = bracketList(ctx, key);
    if (list !== undefined) out[key] = list;
    else {
      const map = bracketMap(ctx, key);
      if (map !== undefined) out[key] = map;
    }
    if (ctx.rawParams && key in ctx.rawParams) out[key] = ctx.rawParams[key];
  }
  return out;
}

register("admin", "formbuilder", "create_form", async (ctx) => {
  requireAdmin(ctx);
  const name = requireParam(ctx.params, "name", "Form name was not provided");
  const type = ctx.params["type"];
  if (type !== undefined && !["horizontal", "default"].includes(type.toLowerCase())) {
    throw new FbError("Form style was not found in predefined list", 3657);
  }
  const style = JSON.stringify({ type: type ?? "horizontal", show_title: ctx.params["show_title"] ?? "0" });
  return await insertForm(name, style);
});

register("admin", "formbuilder", "add_field", async (ctx) => {
  requireAdmin(ctx);
  const type = requireParam(ctx.params, "type", "Form field type is invalid");
  const formId = requireParam(ctx.params, "form_id", "Form id was not passed");
  if (!FIELD_TYPES[type]) throw new FbError("Form field type is invalid", 2684);
  const input = fieldInput(ctx);
  const options = input["options"];
  if (Array.isArray(options) || (options && typeof options === "object")) {
    const vals = Object.values(options as Record<string, unknown>);
    if (!isArrayUnique(vals)) {
      throw new FbError("This input type must have unique values", 3658);
    }
  }
  return await addNewField(ctx, { ...input, type, form_id: formId });
});

register("admin", "formbuilder", "get_form", async (ctx) => {
  requireAdmin(ctx);
  const id = requireParam(ctx.params, "id", "Form id was not passed", 2391);
  return await getForm(phpInt(id));
});

register("guest", "formbuilder", "get", async (ctx) => {
  const id = requireParam(ctx.params, "id", "Form ID was not passed");
  return await getForm(phpInt(id));
});

register("admin", "formbuilder", "get_form_fields", async (ctx) => {
  requireAdmin(ctx);
  const formId = requireParam(ctx.params, "form_id", "Form id was not passed", 1822);
  return await listFormFields(phpInt(formId));
});

register("admin", "formbuilder", "get_field", async (ctx) => {
  requireAdmin(ctx);
  const id = requireParam(ctx.params, "id", "Field id was not passed", 3547);
  const row = await findFormField(phpInt(id));
  if (!row) throw new FbError("Field was not found");
  const out: Record<string, unknown> = { ...row };
  const opts = row.options;
  if (typeof opts === "string" && (opts.startsWith("{") || opts.startsWith("["))) {
    out["options"] = phpJsonDecodeLoose(opts);
  }
  return out;
});

register("admin", "formbuilder", "get_forms", async (ctx) => {
  requireAdmin(ctx);
  return await listFormsWithCounts();
});

register("admin", "formbuilder", "get_pairs", async (ctx) => {
  requireAdmin(ctx);
  const pairs = await listFormPairs();
  if (pairs.length === 0) return [];
  const out: Record<string, string> = {};
  for (const p of pairs) out[String(p.id)] = p.name ?? "";
  return out;
});

register("admin", "formbuilder", "delete_form", async (ctx) => {
  requireAdmin(ctx);
  const id = requireParam(ctx.params, "id", "Form id was not passed", 9958);
  await deleteFormCascade(phpInt(id));
  return true;
});

register("admin", "formbuilder", "delete_field", async (ctx) => {
  requireAdmin(ctx);
  const id = requireParam(ctx.params, "id", "Field id was not passed", 9959);
  const deleted = await deleteFormFieldRow(phpInt(id));
  if (deleted === 0) throw new FbError("Field was not found");
  return true;
});

register("admin", "formbuilder", "update_field", async (ctx) => {
  requireAdmin(ctx);
  const id = requireParam(ctx.params, "id", "Field id was not passed", 9958);
  const input = fieldInput(ctx);
  const options = input["options"];
  if (options !== undefined && options !== null) {
    const vals = Array.isArray(options) ? options : Object.values(options as Record<string, unknown>);
    if (!isArrayUnique(vals)) {
      throw new FbError("This input type must have unique values", 3658);
    }
  }
  const fieldId = phpInt(id);
  // slugify BEFORE the lookup, mirroring Service::updateField.
  const label = (input["label"] as string | undefined) ?? "New field";
  const name = slugify(input["name"]);
  const current = await findFormField(fieldId);
  if (!current) throw new FbError("Field was not found");
  const formId = current.form_id;
  if (await countFormFieldsNamed(formId, name, fieldId) > 0) {
    throw new FbError(
      "Unfortunately field with this name exists in this form already. Form must have different field names.",
      7628,
    );
  }
  let optionsOut: string;
  if (input["options"] !== undefined) {
    const o = input["options"];
    optionsOut = Array.isArray(o) ? JSON.stringify(o) : JSON.stringify(o);
  } else {
    optionsOut = "";
  }
  let defaultValue = input["default_value"] as unknown;
  if (Array.isArray(defaultValue)) defaultValue = forceObject(defaultValue);
  else if (defaultValue !== undefined && defaultValue !== null) defaultValue = String(defaultValue);
  const type = input["type"] as string | undefined;
  if (type === "checkbox" || type === "radio" || type === "select") {
    const values = bracketList(ctx, "values");
    const labels = bracketList(ctx, "labels");
    if (values === undefined) {
      throw new FbError("array_filter(): Argument #1 ($array) must be of type array, null given", 9998);
    }
    if (labels === undefined) {
      throw new FbError("array_filter(): Argument #1 ($array) must be of type array, null given", 9998);
    }
    const vals = values.filter((v) => String(v).length > 0);
    const labs = labels.filter((v) => String(v).length > 0);
    if (!isArrayUnique(vals)) {
      throw new FbError(`${type[0]!.toUpperCase() + type.slice(1)} values must be unique`, 1597);
    }
    if (!isArrayUnique(labs)) {
      throw new FbError(`${type[0]!.toUpperCase() + type.slice(1)} labels must be unique`, 1598);
    }
    if (labs.length !== vals.length) {
      throw new FbError(
        "array_combine(): Argument #1 ($keys) and argument #2 ($values) must have the same number of elements",
        9998,
      );
    }
    const combined: Record<string, unknown> = {};
    labs.forEach((lab, i) => {
      combined[String(lab)] = vals[i];
    });
    optionsOut = forceObject(combined);
  }
  if (type === "textarea") {
    const sizes = bracketList(ctx, "textarea_size");
    if (sizes === undefined) {
      throw new FbError("array_filter(): Argument #1 ($array) must be of type array, null given", 9998);
    }
    const isNumeric = (v: unknown): boolean => {
      if (typeof v === "number") return Number.isFinite(v);
      if (typeof v !== "string" || v.trim() === "") return false;
      return !Number.isNaN(Number(v));
    };
    if (sizes.length !== sizes.filter(isNumeric).length) {
      throw new FbError("Textarea size options must be integer values", 3510);
    }
    const opts = bracketList(ctx, "textarea_option");
    if (opts === undefined) {
      throw new FbError("array_combine(): Argument #1 ($keys) must be of type array, null given", 9998);
    }
    if (opts.length !== sizes.length) {
      throw new FbError(
        "array_combine(): Argument #1 ($keys) and argument #2 ($values) must have the same number of elements",
        9998,
      );
    }
    const combined: Record<string, unknown> = {};
    opts.forEach((opt, i) => {
      combined[String(opt)] = sizes[i];
    });
    optionsOut = forceObject(combined);
  }
  await updateFormFieldRow(fieldId, {
    name,
    label,
    hide_label: toBoolInt(input["hide_label"]),
    description: input["description"] == null ? null : String(input["description"]),
    default_value: defaultValue == null ? null : String(defaultValue),
    required: toBoolInt(input["required"]),
    hidden: toBoolInt(input["hidden"]),
    readonly: toBoolInt(input["readonly"]),
    options: optionsOut,
    prefix: input["prefix"] == null ? null : String(input["prefix"]),
    suffix: input["suffix"] == null ? null : String(input["suffix"]),
    show_initial: input["show_initial"] == null ? null : String(input["show_initial"]),
    show_middle: input["show_middle"] == null ? null : String(input["show_middle"]),
    show_prefix: input["show_prefix"] == null ? null : String(input["show_prefix"]),
    show_suffix: input["show_suffix"] == null ? null : String(input["show_suffix"]),
    text_size: toTextSize(input["text_size"]),
  });
  return fieldId;
});

register("admin", "formbuilder", "copy_form", async (ctx) => {
  requireAdmin(ctx);
  const formId = requireParam(ctx.params, "form_id", "Form id was not passed");
  const name = requireParam(ctx.params, "name", "Form name was not passed");
  const fields = await listFormFields(phpInt(formId));
  const newFormId = await insertForm(name, JSON.stringify({ type: "horizontal", show_title: "0" }));
  for (const f of fields) {
    await addNewField(ctx, { ...(f as unknown as Record<string, unknown>), form_id: newFormId });
  }
  return newFormId;
});

register("admin", "formbuilder", "update_form_settings", async (ctx) => {
  requireAdmin(ctx);
  const formId = requireParam(ctx.params, "form_id", "Form id was not passed");
  const formName = requireParam(ctx.params, "form_name", "Form name was not passed");
  const type = requireParam(ctx.params, "type", "Form type was not passed");
  if (type !== "horizontal" && type !== "default") {
    throw new FbError("Field type not supported", 3207);
  }
  const style = JSON.stringify({ type, show_title: ctx.params["show_title"] ?? "1" });
  await updateFormRow(phpInt(formId), formName, style);
  return true;
});
