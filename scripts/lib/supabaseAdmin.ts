/**
 * Supabase client for backend scripts. Uses the service-role key, so it
 * bypasses RLS and can write to all tables. Never import this from the
 * browser bundle.
 */
import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. ' +
      'Copy .env.example to .env and fill them in.',
  );
}

export const supabaseAdmin: SupabaseClient = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
