import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

type Client = SupabaseClient<Database>;

function createSupabaseClient(): Client | null {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ['NEXT_PUBLIC_SUPABASE_URL'] : []),
      ...(!SUPABASE_PUBLISHABLE_KEY ? ['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'] : []),
    ];
    console.warn(`[Supabase] Missing environment variable(s): ${missing.join(', ')}. Auth/DB features disabled until set.`);
    return null;
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: typeof window !== 'undefined' ? localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
    }
  });
}

let _supabase: Client | null | undefined;

const ERR = new Error('Supabase not configured');

// Recursive stub that handles all access patterns safely:
//   const { data: sub } = supabase.auth.onAuthStateChange(cb)  — sync destructuring
//   await supabase.from('t').select('*').eq('id',x).single()  — async chain
//   supabase.auth.getSession().then(...)                       — .then() chain
//   supabase.auth.getSession()                                 — bare call (no await)
function makeStub(depth = 0): any {
  if (depth > 5) return makeStub(0);
  // Base value: callable, thenable, with .data/.error for direct destructure
  const fn: any = () => makeStub(depth + 1);
  fn.data = null;
  fn.error = ERR;
  fn.then = (resolve: any) => resolve({ data: null, error: ERR });
  return new Proxy(fn, {
    get(target, prop) {
      // Yield the real values for these well-known props
      if (prop === 'then') return target.then;
      if (prop === 'data' || prop === 'error') return target[prop];
      return makeStub(depth + 1);
    },
    apply(_target, _thisArg, _args) {
      return makeStub(depth + 1);
    },
  });
}

const stub = makeStub();

export const supabase = new Proxy({} as Client, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    if (!_supabase) return Reflect.get(stub, prop, stub);
    return Reflect.get(_supabase, prop, receiver);
  },
});

