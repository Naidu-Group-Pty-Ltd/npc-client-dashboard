/**
 * The deployment's email identity, read from where it lives.
 *
 * The rules are in `emailIdentity.pure.ts`; this file only gathers the facts
 * those rules decide from:
 *
 *   - the sender, from `getBrandConfig()`, the rule every email already
 *     follows (`brand-config.ts` is read, never changed, by this module);
 *   - the organisation and contact details the tenant configured, from
 *     `global_report_settings.contact_details` and `whitelabel_settings`;
 *   - what Mission Control provisioned: `MISSION_CONTROL_AGENCY_NAME`,
 *     `RESEND_FROM_EMAIL` and the application origin.
 *
 * A settings read that FAILS is not an empty table. It is logged, it is never
 * cached, and the identity falls back to what Mission Control provisioned,
 * which can only ever name this deployment. It never falls back to the
 * prime's details, which is where the previous fallbacks went.
 */

// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- @ts-expect-error would be an unused directive under Deno, where this import resolves.
// @ts-ignore Deno-only esm.sh import; not resolvable under Node type-checking.
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getBrandConfig, resendFromEmail } from './brand-config.ts';
import {
  resolveEmailIdentity,
  type ContactDetailsLike,
  type EmailIdentity,
  type WhitelabelLike,
} from './emailIdentity.pure.ts';

export * from './emailIdentity.pure.ts';

/** Same window as brand-config: one report run, and an admin's edit shows within a minute. */
const CACHE_TTL_MS = 60_000;

let cached: { identity: EmailIdentity; at: number } | null = null;

function env(name: string): string | null {
  try {
    return Deno.env.get(name) ?? null;
  } catch {
    // No Deno.env in a test harness: treat as unset.
    return null;
  }
}

type Read<T> = { value: T | null; failed: boolean };

async function readContactDetails(client: SupabaseClient): Promise<Read<ContactDetailsLike>> {
  try {
    const { data, error } = await client
      .from('global_report_settings')
      .select('setting_value')
      .eq('setting_key', 'contact_details')
      .maybeSingle();
    if (error) {
      console.warn('[email-identity] contact_details could not be read:', error.message);
      return { value: null, failed: true };
    }
    const value = data?.setting_value;
    return { value: value && typeof value === 'object' ? (value as ContactDetailsLike) : null, failed: false };
  } catch (e) {
    console.warn('[email-identity] contact_details could not be read:', e);
    return { value: null, failed: true };
  }
}

async function readWhitelabel(client: SupabaseClient): Promise<Read<WhitelabelLike>> {
  try {
    const { data, error } = await client
      .from('whitelabel_settings')
      .select(
        'company_name, email_signature_email, email_signature_phone, email_signature_website, email_signature_address',
      )
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn('[email-identity] whitelabel_settings could not be read:', error.message);
      return { value: null, failed: true };
    }
    return { value: (data as WhitelabelLike | null) ?? null, failed: false };
  } catch (e) {
    console.warn('[email-identity] whitelabel_settings could not be read:', e);
    return { value: null, failed: true };
  }
}

/**
 * The identity every non-recovery Resend email is sent under.
 *
 * Pass the function's own service-role client where it has one; without one,
 * a client is made from this deployment's environment, as `getBrandConfig()`
 * does.
 */
export async function getEmailIdentity(supabase?: SupabaseClient): Promise<EmailIdentity> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.identity;

  const client: SupabaseClient =
    supabase ?? createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!);

  const [brand, contact, whitelabel] = await Promise.all([
    getBrandConfig(client),
    readContactDetails(client),
    readWhitelabel(client),
  ]);

  const identity = resolveEmailIdentity({
    supabaseUrl: env('SUPABASE_URL'),
    senderAddress: brand.senderEmail,
    provisionedSender: resendFromEmail(),
    workspaceName: env('MISSION_CONTROL_AGENCY_NAME'),
    provisionedOrigins: [env('PUBLIC_APP_URL'), env('APP_URL'), env('APP_BASE_URL')],
    contactDetails: contact.value,
    whitelabel: whitelabel.value,
  });

  if (!contact.failed && !whitelabel.failed) cached = { identity, at: now };
  return identity;
}

/** Force-clear the cache. For tests, and after an admin edits the branding. */
export function clearEmailIdentityCache(): void {
  cached = null;
}
