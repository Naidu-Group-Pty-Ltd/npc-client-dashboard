-- Upstream fixture for Builder Portal Phase 1 verification.
--
-- The repository's full migration corpus is not replayable from scratch on a
-- plain PostgreSQL cluster (282 historical migrations fail on Supabase-managed
-- extensions, realtime publications, or objects created outside the corpus).
-- Those cascading failures mean the Solicitor Phase 3 and Phase 15 tables that
-- Builder Phase 1 generalises never get created locally.
--
-- This fixture recreates exactly those upstream objects, byte-faithful to the
-- migrations that own them and verified against the production schema through
-- the Supabase MCP connection on project dduzbchuswwbefdunfct:
--
--   supabase/migrations/20260730110751_*.sql   solicitor_firms, solicitor_portal_users
--   supabase/migrations/20260730190000_*.sql   portal_terms_versions/_acceptances
--   supabase/migrations/20260730221326_*.sql   cross_portal_* cutover control plane
--   supabase/migrations/20251224033443_*.sql   dashboard_modules
--   supabase/migrations/20260612120538_*.sql   feature_flags (the network mirror
--                                              migration seeds its flag row here)
--
-- It is a TEST HARNESS only. It is never applied to any hosted environment and
-- is not part of supabase/migrations.

-- --------------------------------------------------------------------------
-- Command Centre internal permission surface
-- --------------------------------------------------------------------------
-- Production shape read from dduzbchuswwbefdunfct via information_schema:
-- key PK, jsonb value, both NOT NULL. The network mirror migration
-- (20261121000000) seeds builder_network_enabled here ON CONFLICT (key).
CREATE TABLE IF NOT EXISTS public.feature_flags (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.dashboard_modules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key text NOT NULL UNIQUE,
  module_name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'general',
  icon text,
  route text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.custom_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  full_name text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  module_id uuid NOT NULL REFERENCES public.dashboard_modules(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT true,
  can_edit boolean NOT NULL DEFAULT false,
  can_delete boolean NOT NULL DEFAULT false,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, module_id)
);

-- --------------------------------------------------------------------------
-- Solicitor identity (from 20260730110751)
-- --------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.solicitor_portal_role AS ENUM
    ('principal','solicitor','conveyancer','paralegal','assistant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.solicitor_firms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  trading_name text,
  abn text,
  licence_number text,
  contact_email text,
  contact_phone text,
  website text,
  address_line1 text, address_line2 text, suburb text, state text, postcode text,
  practising_states text[] NOT NULL DEFAULT ARRAY['NSW','VIC','QLD']::text[],
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.solicitor_portal_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES public.solicitor_firms(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text NOT NULL,
  phone text,
  position text,
  portal_role public.solicitor_portal_role NOT NULL DEFAULT 'solicitor',
  password_hash text,
  must_change_password boolean NOT NULL DEFAULT false,
  invite_token text, invite_token_expires_at timestamptz, invite_accepted_at timestamptz,
  invited_by uuid, invited_at timestamptz,
  reset_token text, reset_token_expires_at timestamptz, reset_attempts integer NOT NULL DEFAULT 0,
  session_token text, session_expires_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  revoked_at timestamptz,
  has_accepted_terms boolean NOT NULL DEFAULT false,
  has_completed_onboarding boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.solicitor_portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  solicitor_user_id uuid NOT NULL REFERENCES public.solicitor_portal_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz, revoked_reason text,
  ip_hash text, user_agent_hash text, device_label text, legacy_migrated_at timestamptz,
  CONSTRAINT solicitor_portal_sessions_expiry_order CHECK (idle_expires_at <= absolute_expires_at)
);
ALTER TABLE public.solicitor_portal_sessions ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------------------------
-- Portal terms, pre-generalisation (from 20260730190000)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_terms_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal text NOT NULL CHECK (portal IN ('solicitor')),
  version text NOT NULL,
  title text NOT NULL,
  content_markdown text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  effective_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portal, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS portal_terms_one_current_idx
  ON public.portal_terms_versions(portal) WHERE retired_at IS NULL;

CREATE TABLE IF NOT EXISTS public.portal_terms_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  terms_version_id uuid NOT NULL REFERENCES public.portal_terms_versions(id),
  portal text NOT NULL CHECK (portal = 'solicitor'),
  solicitor_user_id uuid NOT NULL REFERENCES public.solicitor_portal_users(id) ON DELETE CASCADE,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text, user_agent_hash text,
  UNIQUE (terms_version_id, solicitor_user_id)
);
ALTER TABLE public.portal_terms_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_terms_acceptances ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------------------------
-- Cutover control plane, pre-generalisation (from 20260730221326)
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cross_portal_feature_definitions (
  feature_key text PRIMARY KEY,
  description text NOT NULL,
  default_mode text NOT NULL CHECK (default_mode IN ('off','shadow','dual_read','dual_write','cutover','rollback')),
  legacy_removal_target text NOT NULL,
  minimum_stable_days integer NOT NULL DEFAULT 7 CHECK (minimum_stable_days BETWEEN 1 AND 90),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cross_portal_firm_rollouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES public.solicitor_firms(id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES public.cross_portal_feature_definitions(feature_key),
  mode text NOT NULL CHECK (mode IN ('off','shadow','dual_read','dual_write','cutover','rollback')),
  reason text NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  stable_since timestamptz,
  UNIQUE (firm_id, feature_key)
);

CREATE TABLE IF NOT EXISTS public.cross_portal_rollout_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES public.solicitor_firms(id),
  feature_key text NOT NULL,
  from_mode text, to_mode text NOT NULL, reason text NOT NULL, changed_by uuid,
  readiness_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cross_portal_dual_read_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES public.solicitor_firms(id),
  feature_key text NOT NULL, subject_type text NOT NULL, subject_id uuid,
  legacy_hash text NOT NULL CHECK (legacy_hash ~ '^[0-9a-f]{64}$'),
  target_hash text NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  matches boolean NOT NULL,
  mismatch_fields text[] NOT NULL DEFAULT '{}',
  correlation_id uuid NOT NULL,
  compared_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feature_key, firm_id, subject_type, subject_id, correlation_id)
);

CREATE TABLE IF NOT EXISTS public.cross_portal_cutover_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES public.solicitor_firms(id),
  feature_key text NOT NULL,
  approved_by uuid NOT NULL,
  approval_type text NOT NULL CHECK (approval_type IN ('technical','security','operations','business_owner')),
  evidence_reference text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE (firm_id, feature_key, approval_type)
);

CREATE TABLE IF NOT EXISTS public.cross_portal_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid REFERENCES public.solicitor_firms(id),
  feature_key text,
  status text NOT NULL CHECK (status IN ('running','passed','failed')),
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  initiated_by uuid
);

-- ---------------------------------------------------------------------------
-- Shared immutable-document processing (Solicitor Phase 9).
--
-- Reproduced here because the Builder document-safety migration GENERALISES
-- this queue rather than forking it, exactly as the rollout migration
-- generalises cross_portal_firm_rollouts. Column shape verified against the
-- live production table so the fixture cannot drift from what deploys.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid,
  legal_matter_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_record_id uuid NOT NULL REFERENCES public.document_records(id) ON DELETE CASCADE,
  version_number integer NOT NULL,
  storage_bucket text NOT NULL DEFAULT 'legal-matter-documents',
  storage_path text NOT NULL,
  declared_mime_type text,
  declared_byte_size bigint,
  malware_scan_status text NOT NULL DEFAULT 'pending'
    CHECK (malware_scan_status IN ('pending','scanning','clean','infected','error','legacy_unverified')),
  lifecycle_status text NOT NULL DEFAULT 'upload_pending'
    CHECK (lifecycle_status IN ('upload_pending','quarantined','scanning','available','reviewed','superseded','retained','legal_hold','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_record_id, version_number)
);

CREATE TABLE IF NOT EXISTS public.document_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL UNIQUE REFERENCES public.document_versions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','succeeded','failed','dead_lettered')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The Solicitor claim function, preserved verbatim so the Builder migration's
-- "signature unchanged" assertion is exercised rather than skipped.
CREATE OR REPLACE FUNCTION public.claim_document_processing_jobs(_worker_id text, _limit integer DEFAULT 10)
RETURNS TABLE (job_id uuid, version_id uuid, storage_bucket text, storage_path text,
               declared_mime_type text, declared_byte_size bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fixture$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    UPDATE public.document_processing_jobs j
    SET status='processing', attempts=j.attempts+1, locked_by=_worker_id, locked_at=now(), updated_at=now()
    WHERE j.id IN (SELECT j2.id FROM public.document_processing_jobs j2
                   WHERE j2.status IN ('queued','failed') AND j2.attempts < 5
                   ORDER BY j2.available_at FOR UPDATE SKIP LOCKED LIMIT COALESCE(_limit,10))
    RETURNING j.id, j.document_version_id)
  SELECT c.id, v.id, v.storage_bucket, v.storage_path, v.declared_mime_type, v.declared_byte_size
  FROM claimed c JOIN public.document_versions v ON v.id = c.document_version_id;
END $fixture$;

INSERT INTO public.cross_portal_feature_definitions(feature_key,description,default_mode,legacy_removal_target) VALUES
 ('solicitor_matter_access_v2','Explicit matter-scoped authorization','cutover','Client-level Solicitor authorization and OR-merged permissions'),
 ('solicitor_cookie_sessions_v2','Hashed cookie-only Solicitor sessions','cutover','Plaintext Solicitor session columns'),
 ('transaction_case_backbone','Canonical cross-domain case identity','cutover','One-sided link mutation paths')
ON CONFLICT (feature_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.resolve_cross_portal_feature_mode(_firm_id uuid,_feature_key text)
RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path=public AS $$
  SELECT COALESCE(
    (SELECT mode FROM public.cross_portal_firm_rollouts WHERE firm_id=_firm_id AND feature_key=_feature_key),
    (SELECT default_mode FROM public.cross_portal_feature_definitions WHERE feature_key=_feature_key),
    'off');
$$;

ALTER TABLE public.cross_portal_feature_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cross_portal_firm_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cross_portal_rollout_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cross_portal_dual_read_comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cross_portal_cutover_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cross_portal_reconciliation_runs ENABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------------------------
-- Finance-owned tables the Builder Portal must never reach
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS public.client_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  build_price numeric, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS public.build_progress_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES public.client_deals(id) ON DELETE CASCADE,
  stage_number integer NOT NULL, stage_name text NOT NULL,
  is_commission_trigger boolean DEFAULT false);

CREATE TABLE IF NOT EXISTS public.builder_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL REFERENCES public.client_deals(id) ON DELETE CASCADE,
  invoice_amount numeric, commission_amount numeric);

-- Seed the pre-generalisation state so the Phase 1 migrations exercise a real
-- backfill rather than an empty table.
DO $$
DECLARE firm uuid; suser uuid; tv uuid;
BEGIN
  INSERT INTO public.solicitor_firms(name, trading_name, is_active)
  VALUES ('Fixture Legal Pty Ltd','Fixture Legal', true) RETURNING id INTO firm;

  INSERT INTO public.solicitor_portal_users(firm_id, email, name, portal_role)
  VALUES (firm, 'fixture.solicitor@example.test','Fixture Solicitor','solicitor') RETURNING id INTO suser;

  INSERT INTO public.portal_terms_versions(portal, version, title, content_markdown)
  VALUES ('solicitor','v1.0','Solicitor Portal Terms','# Terms') RETURNING id INTO tv;

  INSERT INTO public.portal_terms_acceptances(terms_version_id, portal, solicitor_user_id)
  VALUES (tv, 'solicitor', suser);

  INSERT INTO public.cross_portal_firm_rollouts(firm_id, feature_key, mode, reason)
  VALUES (firm, 'solicitor_matter_access_v2', 'cutover', 'fixture baseline');

  INSERT INTO public.cross_portal_rollout_history(firm_id, feature_key, from_mode, to_mode, reason)
  VALUES (firm, 'solicitor_matter_access_v2', 'shadow', 'cutover', 'fixture baseline');

  INSERT INTO public.cross_portal_cutover_approvals(firm_id, feature_key, approved_by, approval_type, evidence_reference)
  VALUES (firm, 'solicitor_matter_access_v2', gen_random_uuid(), 'technical', 'fixture-evidence');

  INSERT INTO public.cross_portal_reconciliation_runs(firm_id, feature_key, status)
  VALUES (firm, 'solicitor_matter_access_v2', 'passed');

  INSERT INTO public.cross_portal_dual_read_comparisons(
    firm_id, feature_key, subject_type, subject_id, legacy_hash, target_hash, matches, correlation_id)
  VALUES (firm, 'solicitor_matter_access_v2','matter_access', gen_random_uuid(),
    repeat('a',64), repeat('a',64), true, gen_random_uuid());
END $$;

INSERT INTO public.dashboard_modules(module_key, module_name, description, category, icon, route, sort_order, is_active)
VALUES ('finance_portal_admin','Finance Portal','Administer the Finance Portal','admin','Landmark','/admin/finance-portal',120,true)
ON CONFLICT (module_key) DO NOTHING;

-- --------------------------------------------------------------------------
-- The transaction-case backbone (Phase 5 upstream).
--
-- Reproduced faithfully from 20260730213826_*.sql: the three existing domain
-- slots, the same-client guard and its trigger, and the link history CHECK. The
-- Builder transactions migration REPLACES the guard and the trigger, so this
-- fixture must carry the pre-Builder versions for that replacement to be a real
-- replacement rather than a first creation.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_matters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  matter_reference text, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS public.purchase_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS public.transaction_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id),
  case_type text NOT NULL DEFAULT 'property_purchase'
    CHECK (case_type IN ('property_purchase','property_sale','refinance','construction','commercial','other')),
  canonical_property_id uuid, property_address_normalized text, jurisdiction text,
  shared_lifecycle_status text NOT NULL DEFAULT 'open'
    CHECK (shared_lifecycle_status IN ('open','on_hold','completed','cancelled')),
  risk_level text NOT NULL DEFAULT 'standard' CHECK (risk_level IN ('standard','elevated','high')),
  row_version bigint NOT NULL DEFAULT 1, created_by uuid,
  opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS public.transaction_case_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL UNIQUE REFERENCES public.transaction_cases(id) ON DELETE CASCADE,
  legal_matter_id uuid UNIQUE REFERENCES public.legal_matters(id) ON DELETE SET NULL,
  purchase_file_id uuid UNIQUE REFERENCES public.purchase_files(id) ON DELETE SET NULL,
  client_deal_id uuid UNIQUE REFERENCES public.client_deals(id) ON DELETE SET NULL,
  link_source text NOT NULL
    CHECK (link_source IN ('legacy_explicit','legacy_reverse','command_centre','system')),
  linked_by uuid, linked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS public.transaction_case_link_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.transaction_cases(id) ON DELETE CASCADE,
  domain_type text NOT NULL
    CHECK (domain_type IN ('legal_matter','purchase_file','client_deal')),
  domain_record_id uuid NOT NULL, action text NOT NULL CHECK (action IN ('linked','unlinked')),
  link_source text NOT NULL, actor_user_id uuid, reason text,
  occurred_at timestamptz NOT NULL DEFAULT now());

CREATE OR REPLACE FUNCTION public.guard_transaction_case_links() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $fx$
DECLARE case_client uuid; domain_client uuid;
BEGIN
  SELECT client_id INTO case_client FROM public.transaction_cases WHERE id = NEW.case_id;
  IF case_client IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CASE_NOT_FOUND'; END IF;
  IF NEW.legal_matter_id IS NOT NULL THEN
    domain_client := NULL;
    SELECT client_id INTO domain_client FROM public.legal_matters WHERE id = NEW.legal_matter_id;
    IF domain_client IS DISTINCT FROM case_client THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_CLIENT_CASE_LINK'; END IF;
  END IF;
  IF NEW.purchase_file_id IS NOT NULL THEN
    domain_client := NULL;
    SELECT client_id INTO domain_client FROM public.purchase_files WHERE id = NEW.purchase_file_id;
    IF domain_client IS DISTINCT FROM case_client THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_CLIENT_CASE_LINK'; END IF;
  END IF;
  IF NEW.client_deal_id IS NOT NULL THEN
    domain_client := NULL;
    SELECT client_id INTO domain_client FROM public.client_deals WHERE id = NEW.client_deal_id;
    IF domain_client IS DISTINCT FROM case_client THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='CROSS_CLIENT_CASE_LINK'; END IF;
  END IF;
  RETURN NEW;
END $fx$;

DROP TRIGGER IF EXISTS trg_guard_transaction_case_links ON public.transaction_case_links;
CREATE TRIGGER trg_guard_transaction_case_links
  BEFORE INSERT OR UPDATE OF case_id, legal_matter_id, purchase_file_id, client_deal_id
  ON public.transaction_case_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_transaction_case_links();
