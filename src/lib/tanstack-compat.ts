// Browser-safe compatibility stubs for @tanstack/react-start exports.
// Phase 3: Replaces createServerFn RPC with direct handler execution.

interface ServerFn {
  (args?: any): Promise<any>;
  _middleware: any[];
  _validator: ((input: any) => any) | undefined;
  _handler: ((opts: { data: any; context: any }) => any) | undefined;
  __fnName: string;
  middleware: (fn: any) => ServerFn;
  validator: (fn: (input: any) => any) => ServerFn;
  inputValidator: (fn: (input: any) => any) => ServerFn;
  handler: (fn: (opts: { data: any; context: any }) => any) => ServerFn;
}

export function createServerFn(_options: { method?: string }): ServerFn {
  const fn = function (args?: any): Promise<any> {
    const name = (fn as any).__fnName;
    if (!name) throw new Error("Server function not registered");
    return fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fnName: name, data: args?.data ?? args }),
    }).then((r) => {
      if (!r.ok) return r.json().then((b) => { throw new Error(b.error || "RPC failed"); });
      return r.json();
    });
  } as any;

  fn._middleware = [];
  fn._validator = undefined;
  fn._handler = undefined;
  fn.__fnName = "";
  fn.middleware = (m: any) => { fn._middleware.push(m); return fn; };
  fn.validator = (v: (input: any) => any) => { fn._validator = v; return fn; };
  fn.inputValidator = (v: (input: any) => any) => fn.validator(v);
  fn.handler = (h: (opts: { data: any; context: any }) => any) => { fn._handler = h; return fn; };

  return fn as ServerFn;
}

export function createMiddleware(_options?: { type?: string }) {
  return { server: (fn: any) => fn, client: (fn: any) => fn };
}

export const requireSupabaseAuth: any = async (ctx: any) => ctx;

/* ─── Registry: maps function name → createServerFn result ─── */
export const __fnRegistry = new Map<string, any>();

/** Register a server function so the RPC route can find & execute it. */
export function registerFn(name: string, fn: any) {
  fn.__fnName = name;
  __fnRegistry.set(name, fn);
}
