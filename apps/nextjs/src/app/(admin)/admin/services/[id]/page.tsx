import Link from "next/link";
import { adminApi } from "@/lib/fossbilling";
import { sessionOpts } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Service detail, Phase 5 R2c. Services are order-addressed in
 * FOSSBilling: PHP itself renders them only via admin/order/service
 * for an order, so this route takes the ORDER id (not a service-row
 * id) and renders the order's service. Linked from the order detail
 * page and directly addressable.
 */

interface Order {
  id: number;
  title?: string;
  status?: string;
  service_id?: number | null;
  service_type?: string | null;
  client?: { first_name?: string; last_name?: string; email?: string };
}

type ServiceData = Record<string, unknown> | null;

function fmt(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function Fields({ pairs }: { pairs: [string, unknown][] }) {
  const shown = pairs.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (shown.length === 0) return null;
  return (
    <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
      {shown.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-500">{k}</dt>
          <dd>{fmt(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ListField({ label, items }: { label: string; items: unknown }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div className="mt-4">
      <h3 className="text-sm font-semibold">{label}</h3>
      <ul className="mt-1 list-inside list-disc text-sm">
        {items.map((v, i) => (
          <li key={i}>{fmt(v)}</li>
        ))}
      </ul>
    </div>
  );
}

export default async function AdminServiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opts = await sessionOpts();
  let o: Order | null = null;
  let svc: ServiceData = null;
  let error: string | null = null;
  try {
    o = (await adminApi.orderGet(id, opts)) as Order;
    svc = (await adminApi.orderService(id, opts)) as ServiceData;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const type = o?.service_type ?? "";
  return (
    <main className="mx-auto max-w-4xl p-8">
      <Link href={o ? `/admin/orders/${o.id}` : "/admin/orders"} className="text-sm text-blue-700 underline">
        ← Order
      </Link>
      {error || !o ? (
        <p className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          {error ?? "Order not found."} <Link href="/admin/login" className="underline">Sign in as staff</Link> if you are not logged in.
        </p>
      ) : !svc ? (
        <>
          <h1 className="mt-2 text-2xl font-semibold">{o.title ?? `Order ${o.id}`} — Service</h1>
          <p className="mt-4 rounded-lg border p-4 text-sm">
            {o.service_id === null || o.service_id === undefined
              ? "This order does not have a provisioned service yet."
              : "Service data is not available for this order."}
          </p>
        </>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-semibold">
            {o.title ?? `Order ${o.id}`} — {type} service
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            Order {o.id} ({o.status}){o.client ? ` · ${`${o.client.first_name ?? ""} ${o.client.last_name ?? ""}`.trim() || o.client.email}` : ""}
          </p>
          {type === "hosting" ? (
            <>
              <section className="mt-6">
                <h2 className="text-lg font-semibold">Account</h2>
                <Fields
                  pairs={[
                    ["Domain", svc["domain"]],
                    ["Username", svc["username"]],
                    ["IP", svc["ip"]],
                    ["Reseller", svc["reseller"]],
                    ["Domain order", svc["domain_order_id"]],
                  ]}
                />
              </section>
              {svc["server"] && typeof svc["server"] === "object" ? (
                <section className="mt-6">
                  <h2 className="text-lg font-semibold">Server</h2>
                  <Fields
                    pairs={(
                      [
                        ["Name", (svc["server"] as Record<string, unknown>)["name"]],
                        ["Hostname", (svc["server"] as Record<string, unknown>)["hostname"]],
                        ["IP", (svc["server"] as Record<string, unknown>)["ip"]],
                        ["Nameservers", [(svc["server"] as Record<string, unknown>)["ns1"], (svc["server"] as Record<string, unknown>)["ns2"], (svc["server"] as Record<string, unknown>)["ns3"], (svc["server"] as Record<string, unknown>)["ns4"]].filter(Boolean).join(", ")],
                        ["Control panel", (svc["server"] as Record<string, unknown>)["cpanel_url"]],
                        ["Manager", (svc["server"] as Record<string, unknown>)["manager"]],
                        ["Active", (svc["server"] as Record<string, unknown>)["active"]],
                      ] as [string, unknown][]
                    )}
                  />
                </section>
              ) : null}
              {svc["hosting_plan"] && typeof svc["hosting_plan"] === "object" ? (
                <section className="mt-6">
                  <h2 className="text-lg font-semibold">Hosting plan</h2>
                  <Fields
                    pairs={(
                      [
                        ["Name", (svc["hosting_plan"] as Record<string, unknown>)["name"]],
                        ["Quota", (svc["hosting_plan"] as Record<string, unknown>)["quota"]],
                        ["Bandwidth", (svc["hosting_plan"] as Record<string, unknown>)["bandwidth"]],
                        ["Max FTP", (svc["hosting_plan"] as Record<string, unknown>)["max_ftp"]],
                        ["Max SQL", (svc["hosting_plan"] as Record<string, unknown>)["max_sql"]],
                        ["Max POP", (svc["hosting_plan"] as Record<string, unknown>)["max_pop"]],
                        ["Max subdomains", (svc["hosting_plan"] as Record<string, unknown>)["max_sub"]],
                      ] as [string, unknown][]
                    )}
                  />
                </section>
              ) : null}
            </>
          ) : null}
          {type === "domain" ? (
            <>
              <section className="mt-6">
                <h2 className="text-lg font-semibold">Domain</h2>
                <Fields
                  pairs={[
                    ["Domain", svc["domain"]],
                    ["Nameservers", [svc["ns1"], svc["ns2"], svc["ns3"], svc["ns4"]].filter(Boolean).join(", ")],
                    ["Period", svc["period"]],
                    ["Privacy", svc["privacy"]],
                    ["Locked", svc["locked"]],
                    ["Registered", svc["registered_at"]],
                    ["Expires", svc["expires_at"]],
                    ["Synced", svc["synced_at"]],
                    ["Registrar", svc["registrar"]],
                    ["Transfer code", svc["transfer_code"]],
                  ]}
                />
              </section>
              {svc["contact"] && typeof svc["contact"] === "object" ? (
                <section className="mt-6">
                  <h2 className="text-lg font-semibold">Registrant contact</h2>
                  <Fields
                    pairs={(
                      [
                        ["Name", `${fmt((svc["contact"] as Record<string, unknown>)["first_name"])} ${fmt((svc["contact"] as Record<string, unknown>)["last_name"])}`.trim()],
                        ["Email", (svc["contact"] as Record<string, unknown>)["email"]],
                        ["Company", (svc["contact"] as Record<string, unknown>)["company"]],
                        ["Address", [fmt((svc["contact"] as Record<string, unknown>)["address1"]), fmt((svc["contact"] as Record<string, unknown>)["address2"])].filter(Boolean).join(", ")],
                        ["City", (svc["contact"] as Record<string, unknown>)["city"]],
                        ["State", (svc["contact"] as Record<string, unknown>)["state"]],
                        ["Postcode", (svc["contact"] as Record<string, unknown>)["postcode"]],
                        ["Country", (svc["contact"] as Record<string, unknown>)["country"]],
                        ["Phone", `+${fmt((svc["contact"] as Record<string, unknown>)["phone_cc"])} ${fmt((svc["contact"] as Record<string, unknown>)["phone"])}`.trim()],
                      ] as [string, unknown][]
                    )}
                  />
                </section>
              ) : null}
            </>
          ) : null}
          {type === "license" ? (
            <section className="mt-6">
              <h2 className="text-lg font-semibold">License</h2>
              <Fields
                pairs={[
                  ["License key", svc["license_key"]],
                  ["Validate IP", svc["validate_ip"]],
                  ["Validate host", svc["validate_host"]],
                  ["Validate version", svc["validate_version"]],
                  ["Validate path", svc["validate_path"]],
                  ["Pinged", svc["pinged_at"]],
                  ["Plugin", svc["plugin"]],
                ]}
              />
              <ListField label="Allowed IPs" items={svc["ips"]} />
              <ListField label="Allowed hosts" items={svc["hosts"]} />
              <ListField label="Allowed paths" items={svc["paths"]} />
              <ListField label="Allowed versions" items={svc["versions"]} />
            </section>
          ) : null}
          {type === "downloadable" ? (
            <section className="mt-6">
              <h2 className="text-lg font-semibold">Files</h2>
              {Array.isArray(svc["files"]) && svc["files"].length > 0 ? (
                <table className="mt-2 w-full text-left text-sm">
                  <thead>
                    <tr className="border-b text-zinc-500">
                      <th className="py-2">Label</th>
                      <th>Filename</th>
                      <th>Downloads</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(svc["files"] as { id: number; label?: string; filename?: string; description?: string; downloads?: number }[]).map((f) => (
                      <tr key={f.id} className="border-b">
                        <td className="py-2">{f.label}</td>
                        <td>{f.filename}</td>
                        <td>{fmt(f.downloads)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mt-2 text-sm text-zinc-500">No files attached.</p>
              )}
            </section>
          ) : null}
          {type === "custom" ? (
            <section className="mt-6">
              <h2 className="text-lg font-semibold">Configuration</h2>
              <Fields
                pairs={Object.entries(svc)
                  .filter(([k]) => !["id", "client_id", "plugin", "created_at", "updated_at"].includes(k))
                  .map(([k, v]) => [k, v] as [string, unknown])}
              />
              <Fields
                pairs={[
                  ["Plugin", svc["plugin"]],
                  ["Created", svc["created_at"]],
                  ["Updated", svc["updated_at"]],
                ]}
              />
            </section>
          ) : null}
          <p className="mt-6 text-sm text-zinc-500">View-only in R2c; service lifecycle actions live on the order page.</p>
        </>
      )}
    </main>
  );
}
