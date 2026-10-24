import { listActivity } from "../db";
import { register, requireAdmin, type CallContext } from "../dispatch";
import { paginate } from "../util";

/**
 * Activity module (admin) — TS port of Activity/Api/Admin.php
 * log_get_list over the activity_system table. The API default is
 * min_priority=6 (priority <= 6). Items keep the flat join columns and
 * gain nested staff/client objects when the row references them,
 * exactly as the PHP API assembles them.
 *
 * Note: the activity log is append-only live data — entries created by
 * the PHP side (logins, mutations) appear here in real time, which is
 * the point of the shared-DB model.
 */
register("admin", "activity", "log_get_list", (ctx: CallContext) => {
  requireAdmin(ctx);
  const rows = listActivity({
    priority: ctx.params["priority"],
    minPriority: ctx.params["min_priority"] ?? (ctx.params["priority"] ? undefined : "6"),
    userFilter: ctx.params["user_filter"],
    adminId: ctx.params["admin_id"],
    clientId: ctx.params["client_id"],
    ip: ctx.params["ip"],
    search: ctx.params["search"],
  });
  const items = rows.map((r) => {
    const item: Record<string, unknown> = {
      id: r.id,
      priority: r.priority,
      admin_id: r.admin_id,
      client_id: r.client_id,
      message: r.message,
      ip: r.ip,
      created_at: r.created_at,
      staff_id: r.staff_id,
      staff_email: r.staff_email,
      staff_name: r.staff_name,
      client_name: r.client_name ?? "",
      client_email: r.client_email,
    };
    if (r.staff_id !== null && r.staff_id !== undefined) {
      item["staff"] = { id: r.staff_id, name: r.staff_name, email: r.staff_email };
    }
    if (r.client_id !== null && r.client_id !== undefined) {
      item["client"] = { id: r.client_id, name: r.client_name, email: r.client_email };
    }
    return item;
  });
  return paginate(items, ctx.params);
});
