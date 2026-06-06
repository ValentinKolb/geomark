import type { Context } from "hono";

// ─── Result + ApiError ───────────────────────────────────────────────────────

type ApiError = {
  code: string;
  message: string;
  status: number;
};

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = <T = never>(error: ApiError): Result<T> => ({
  ok: false,
  error,
});

export const err = {
  badInput: (message: string): ApiError => ({
    code: "BAD_INPUT",
    message,
    status: 400,
  }),
  notFound: (message: string): ApiError => ({
    code: "NOT_FOUND",
    message,
    status: 404,
  }),
  notReady: (message: string): ApiError => ({
    code: "NOT_READY",
    message,
    status: 503,
  }),
  internal: (message: string): ApiError => ({
    code: "INTERNAL",
    message,
    status: 500,
  }),
};

// ─── respond helper ──────────────────────────────────────────────────────────

/**
 * Bridge between service-layer `Result<T>` and Hono's response. Mirrors
 * @valentinkolb/cloud's `respond()` shape but is local to keep this
 * package free of cloud-platform deps.
 */
export const respond = async <T>(
  c: Context,
  fn: () => Promise<Result<T>> | Result<T>,
  successStatus = 200,
): Promise<Response> => {
  let result: Result<T>;
  try {
    result = await fn();
  } catch (e) {
    console.error("[respond] uncaught error:", e);
    return c.json(
      { error: "internal error", code: "INTERNAL" },
      500,
    );
  }
  if (result.ok) {
    return c.json(result.data, successStatus as 200);
  }
  return c.json(
    { error: result.error.message, code: result.error.code },
    result.error.status as 400 | 404 | 500 | 503,
  );
};
