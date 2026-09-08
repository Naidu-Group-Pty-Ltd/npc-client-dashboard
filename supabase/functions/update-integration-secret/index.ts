import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyAuth, createCorsHeaders, createUnauthorizedResponse, createForbiddenResponse } from '../_shared/auth.ts';
import { enforceCsrf, csrfDenied } from "../_shared/csrfGuard.ts";
import { requireStepUp } from '../_shared/stepUp.ts';
import { ALLOWED_INTEGRATION_SECRETS } from '../_shared/integrationSecrets.ts';
import { listingsPipelineRefusal } from '../_shared/listingsPipelineSecrets.pure.ts';
import { internalError } from '../_shared/errorResponse.ts';
import { recordActivity } from '../_shared/activityAudit.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id, x-step-up-token',
  'Access-Control-Expose-Headers': 'x-correlation-id, x-tokens-used, x-tokens-reserved, x-tokens-estimated, x-duration-ms',
};

// Allowlist of secrets that can be updated via this endpoint.
// Derived from the Integrations registry rather than hand-maintained: the previous
// hand-typed list covered 27 of the registry's 240 credential fields, so "Sync to
// Supabase" was rejected for most of the 141 integrations the page offers.
const ALLOWED_SECRETS = ALLOWED_INTEGRATION_SECRETS;

// Validation schemas
const SECRET_NAME_REGEX = /^[A-Z][A-Z0-9_]{2,50}$/;
const MAX_SECRET_VALUE_LENGTH = 2000;

interface UpdateSecretRequest {
  secrets: { name: string; value: string }[];
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  const corsHeaders = createCorsHeaders(origin);
  
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // SEC5-CSRF: reject cross-site cookie-authenticated mutations (exact-origin).
  // No-op for GET/HEAD/OPTIONS and any request without the session cookie.
  const __csrf = enforceCsrf(req);
  if (!__csrf.ok) return csrfDenied(corsHeaders, __csrf);

  try {
    const sbMgmt = Deno.env.get('SB_MANAGEMENT_ACCESS_TOKEN');
    const legacyMgmt = Deno.env.get('SUPABASE_ACCESS_TOKEN');
    const supabaseAccessToken = sbMgmt ?? legacyMgmt;
    const projectRef = Deno.env.get('SUPABASE_URL')?.match(/https:\/\/([^.]+)/)?.[1];

    if (!supabaseAccessToken) {
      console.error('Management access token not configured');
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'SB_MANAGEMENT_ACCESS_TOKEN not configured. Please add your Supabase personal access token to the secrets.',
          setupRequired: true
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!projectRef) {
      console.error('Could not determine project reference');
      return new Response(
        JSON.stringify({ success: false, error: 'Could not determine project reference' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // SECURITY: Verify authentication and superadmin role
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: UpdateSecretRequest = await req.json();
    
    const authResult = await verifyAuth(supabase, req.headers, body);
    if (authResult.error) {
      console.log('[update-integration-secret] Auth failed:', authResult.error);
      return createUnauthorizedResponse(authResult.error, corsHeaders);
    }
    
    // Check if user has superadmin role
    const { data: roleData, error: roleError } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', authResult.userId)
      .eq('role', 'superadmin')
      .single();

    if (roleError || !roleData) {
      console.warn(`User ${authResult.userId} attempted to update integration secrets without superadmin role.`);
      return createForbiddenResponse('Forbidden: Superadmin access required', corsHeaders);
    }
    console.log(`Superadmin ${authResult.userId} is updating integration secrets.`);

    // WP-11C — Require recent reauth for secret rotation (dark-launch via STEP_UP_ENFORCED).
    const stepUpGate = await requireStepUp(supabase, {
      userId: authResult.userId,
      capability: 'secrets.update',
      req,
      body,
      logAudit: true,
    });
    if (stepUpGate) return stepUpGate;

    if (!body.secrets || !Array.isArray(body.secrets) || body.secrets.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'No secrets provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Validate all secrets before updating
    const validationErrors: string[] = [];
    const validSecrets: { name: string; value: string }[] = [];

    for (const secret of body.secrets) {
      // Validate secret name format
      if (!SECRET_NAME_REGEX.test(secret.name)) {
        validationErrors.push(`Invalid secret name format: ${secret.name}`);
        continue;
      }

      // The Listings pipeline's names are refused BEFORE the allowlist, and
      // said in the operator's terms: "not in allowlist" reads as a typo, and
      // this is a rule. See listingsPipelineSecrets.pure.ts.
      const managed = listingsPipelineRefusal(secret.name);
      if (managed) {
        validationErrors.push(managed);
        continue;
      }

      // Check if secret is in allowlist
      if (!ALLOWED_SECRETS.has(secret.name)) {
        validationErrors.push(`Secret not in allowlist: ${secret.name}`);
        continue;
      }

      // Validate secret value length
      if (secret.value && secret.value.length > MAX_SECRET_VALUE_LENGTH) {
        validationErrors.push(`Secret value too long: ${secret.name} (max ${MAX_SECRET_VALUE_LENGTH} chars)`);
        continue;
      }

      // Only include non-empty secrets
      if (secret.value && secret.value.trim()) {
        validSecrets.push({
          name: secret.name,
          value: secret.value.trim()
        });
      }
    }

    if (validSecrets.length === 0) {
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: 'No valid secrets to update',
          validationErrors 
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const tokenSource = sbMgmt ? 'SB_MANAGEMENT_ACCESS_TOKEN' : 'SUPABASE_ACCESS_TOKEN';
    console.log(`[update-integration-secret] Calling Management API`, {
      projectRef,
      names: validSecrets.map(s => s.name),
      tokenSource,
    });

    // Call Supabase Management API to update secrets
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/secrets`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validSecrets),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[update-integration-secret] Management API error', {
        status: response.status,
        body: errorText,
        tokenSource,
        names: validSecrets.map(s => s.name),
      });

      if (response.status === 401) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `Invalid management token (source: ${tokenSource}). Rotate at https://supabase.com/dashboard/account/tokens and re-save via the Secrets form.`,
            setupRequired: true,
            managementApiStatus: response.status,
            managementApiBody: errorText,
          }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify({
          success: false,
          error: `Management API ${response.status}: ${errorText}`,
          managementApiStatus: response.status,
          managementApiBody: errorText,
          attemptedNames: validSecrets.map(s => s.name),
        }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Record the change in the audit trail.
    //
    // This used to pass `entity_type: 'settings'`, which is not one of the 26
    // values of the `activity_entity_type` enum, and discarded the insert's
    // error — so every credential change ever made here failed to record who
    // changed which secret while still answering `success: true`. `system` is
    // the enum's value for a platform-level change. Secret NAMES only: a value
    // must never reach an audit row.
    const audit = await recordActivity(supabase, {
      user_id: authResult.userId,
      username: authResult.username,
      action_type: 'update',
      entity_type: 'system',
      entity_name: 'Integration Secrets',
      metadata: {
        updated_secrets: validSecrets.map(s => s.name),
        validation_warnings: validationErrors.length > 0 ? validationErrors : undefined
      }
    });

    console.log(`Successfully updated ${validSecrets.length} secrets`);

    // The secrets ARE written at this point, so a failed audit row must not
    // fail the request — but it must not be invisible either. The operator is
    // told the change landed and the record of it did not.
    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `Successfully updated ${validSecrets.length} secret(s)`,
        updatedSecrets: validSecrets.map(s => s.name),
        validationWarnings: validationErrors.length > 0 ? validationErrors : undefined,
        auditLogged: audit.ok,
        ...(audit.ok ? {} : { auditError: audit.reason })
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error updating secrets:', error);
    return new Response(
      JSON.stringify({ ...internalError(error, 'update-integration-secret'), success: false }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
