"use client";

export function useServerFn(fn: any) {
  // Phase 3: Call Next.js RPC endpoint instead of TanStack Start's useServerFn
  return async (args?: any) => {
    const fnName = fn?.__fnName;
    if (!fnName) throw new Error("Server function not registered");

    const res = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fnName, data: args?.data ?? args }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `RPC call failed (${res.status})`);
    }

    return res.json();
  };
}
