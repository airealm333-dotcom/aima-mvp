/**
 * Minimal Odoo JSON-RPC client (authenticate + execute_kw).
 * @see https://www.odoo.com/documentation/master/developer/reference/external_api.html
 */

export type OdooJsonRpcConfig = {
  baseUrl: string;
  db: string;
  username: string;
  password: string;
  timeoutMs: number;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: "call";
  params: {
    service: string;
    method: string;
    args: unknown[];
  };
  id: number;
};

type JsonRpcSuccess = { jsonrpc: "2.0"; id: number; result: unknown };
type JsonRpcError = {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
};

function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export class OdooJsonRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, options?: { code?: number; data?: unknown }) {
    super(message);
    this.name = "OdooJsonRpcError";
    this.code = options?.code;
    this.data = options?.data;
  }
}

export class OdooJsonRpcClient {
  private readonly jsonRpcUrl: string;

  constructor(private readonly cfg: OdooJsonRpcConfig) {
    this.jsonRpcUrl = `${trimBaseUrl(cfg.baseUrl)}/jsonrpc`;
  }

  private async rawCall(
    service: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const body: JsonRpcRequest = {
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Math.floor(Math.random() * 1_000_000_000),
    };

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(this.jsonRpcUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new OdooJsonRpcError(`HTTP ${res.status} from Odoo JSON-RPC`);
      }

      const payload = (await res.json()) as JsonRpcSuccess | JsonRpcError;

      if ("error" in payload && payload.error) {
        const e = payload.error;
        throw new OdooJsonRpcError(e.message ?? "Odoo JSON-RPC error", {
          code: e.code,
          data: e.data,
        });
      }

      if ("result" in payload) {
        return payload.result;
      }

      throw new OdooJsonRpcError("Invalid Odoo JSON-RPC response");
    } catch (err) {
      if (err instanceof OdooJsonRpcError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new OdooJsonRpcError(
          `Odoo JSON-RPC timeout after ${this.cfg.timeoutMs}ms`,
        );
      }
      const msg = err instanceof Error ? err.message : "unknown_error";
      throw new OdooJsonRpcError(msg);
    } finally {
      clearTimeout(t);
    }
  }

  /** Returns numeric user id or throws if authentication fails. */
  async authenticate(): Promise<number> {
    const result = await this.rawCall("common", "authenticate", [
      this.cfg.db,
      this.cfg.username,
      this.cfg.password,
      {},
    ]);

    if (typeof result === "number" && Number.isFinite(result) && result > 0) {
      return result;
    }

    throw new OdooJsonRpcError(
      "Odoo authentication failed (invalid credentials?)",
    );
  }

  /**
   * Odoo `execute_kw` for a model method.
   * @param model e.g. `res.partner`
   * @param method e.g. `search_read`
   * @param args positional args after model/method (e.g. domain array for search_read)
   * @param kwargs e.g. `{ fields: [...], limit: 50 }`
   */
  async executeKw(
    uid: number,
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.rawCall("object", "execute_kw", [
      this.cfg.db,
      uid,
      this.cfg.password,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  async searchReadPartners(
    uid: number,
    domain: unknown[],
    fields: string[],
    limit: number,
  ): Promise<Record<string, unknown>[]> {
    const result = await this.executeKw(
      uid,
      "res.partner",
      "search_read",
      [domain],
      { fields, limit },
    );

    if (!Array.isArray(result)) {
      throw new OdooJsonRpcError("search_read did not return an array");
    }

    return result as Record<string, unknown>[];
  }
}
