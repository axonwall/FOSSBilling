/** Minimal slugifier approximating PHP Tools::slug (Cocur) for ASCII titles. */
export function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Shared pager envelope in the PHP pager's shape. */
export function paginate<T>(items: T[], params: Record<string, string | undefined>, defaultPerPage = 100) {
  const perPage = parseInt(params["per_page"] ?? String(defaultPerPage), 10) || defaultPerPage;
  const page = parseInt(params["page"] ?? "1", 10) || 1;
  const total = items.length;
  const list = items.slice((page - 1) * perPage, page * perPage);
  return { pages: Math.max(1, Math.ceil(total / perPage)), page, per_page: perPage, total, list };
}
