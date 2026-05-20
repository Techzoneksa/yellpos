import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types';

type Client = SupabaseClient<Database>;

function createSupabaseClient(): Client | null {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

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

// Graceful proxy: returns a stub that warns on any operation if client is missing.
const stub = new Proxy({} as Client, {
  get(_, prop) {
    console.warn(`[Supabase] Cannot perform "${String(prop)}": Supabase client not initialized (missing env vars).`);
    return () => Promise.resolve({ data: null, error: new Error('Supabase not configured') });
  },
});

export const supabase = new Proxy({} as Client, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    if (!_supabase) return Reflect.get(stub, prop, stub);
    return Reflect.get(_supabase, prop, receiver);
  },
});

