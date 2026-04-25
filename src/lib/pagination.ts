import type { Context } from "hono";

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

export function paginationParams(c: Context): { page: number; perPage: number; offset: number } {
  const offsetRaw = c.req.query("offset");
  const limitRaw = c.req.query("limit");

  if (offsetRaw !== undefined || limitRaw !== undefined) {
    const perPage = Math.min(100, Math.max(1, Number(limitRaw ?? 20)));
    const offset = Math.max(0, Number(offsetRaw ?? 0));
    const page = Math.floor(offset / perPage) + 1;
    return { page, perPage, offset };
  }

  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const perPage = Math.min(100, Math.max(1, Number(c.req.query("per_page") ?? 20)));
  return { page, perPage, offset: (page - 1) * perPage };
}
