-- ===========================================================================
-- Network-standalone fixture for the Builder Portal extraction.
--
-- 01-upstream-fixture.sql answers "can the builder migrations apply against a
-- faithful copy of the prime objects they name?". THIS file answers the
-- opposite question: "can they apply against a database that will never hold
-- the prime at all?" — the Builders Network, one central Supabase project
-- serving every workspace at builders.aurixasystems.com.au.
--
-- It is consumed only by network-standalone-check.mjs and is a TEST HARNESS:
-- never applied to a hosted environment, not part of supabase/migrations.
--
-- Two kinds of object live here, and the distinction is the deliverable:
--
--   PART 1 — TRAVELS. Shared services the portal genuinely uses, which the
--   network must own for itself (terms, the document-processing queue,
--   feature flags, operational events, the outbox's dead-letter ledger).
--   These are provided in the shape the builder migrations expect and are
--   RESHAPED by the Phase 2 squash (builder-only, other portals' columns
--   gone), never dropped.
--
--   PART 2 — SHIMS. Prime objects the builder migrations name today whose
--   referencing SQL is DELETED by the Phase 2 squash. Each shim states which
--   entanglement it stands in for. The shim list IS the squash's edit list:
--   when the squash is done, applying the squashed baseline to a database
--   containing only PART 1 must succeed, and this file shrinks to Part 1.
--
-- Where a table was generalised by a NON-builder-named migration
-- (20260801000300_portal_terms_multi_portal, 20260801000400_cross_portal_
-- rollout_org_generalisation), it is provided here ALREADY GENERALISED,
-- because those migrations are outside the builder corpus this harness
-- replays — the same reason the boundary is enumerated from pg_constraint
-- and never from filenames.
-- ===========================================================================


-- ===========================================================================
-- PART 1 — TRAVELS TO THE NETWORK
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Terms of use (E5). Provided post-generalisation (portal may be 'builder',
-- builder_user_id present). Phase 2 reshapes to builder_terms_versions /
-- builder_terms_acceptances with builder_user_id NOT NULL and the solicitor
-- column gone — the network never holds another portal's consent record. The
-- FK to builder_portal_users cannot be declared here because the fixture runs
-- before Phase 1 creates that table; the squash restores it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_terms_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal text NOT NULL CHECK (portal IN ('solicitor','builder')),
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
  portal text NOT NULL CHECK (portal IN ('solicitor','builder')),
  solicitor_user_id uuid,          -- gone in Phase 2 (MIG-01's one-way drop stays in the CLONE)
  builder_user_id uuid,            -- NOT NULL + FK to builder_portal_users after Phase 2
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_hash text, user_agent_hash text,
  UNIQUE (terms_version_id, solicitor_user_id),
  UNIQUE (terms_version_id, builder_user_id),
  CHECK (
    (portal = 'solicitor' AND solicitor_user_id IS NOT NULL AND builder_user_id IS NULL) OR
    (portal = 'builder'   AND builder_user_id  IS NOT NULL AND solicitor_user_id IS NULL)
  )
);
ALTER TABLE public.portal_terms_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.portal_terms_acceptances ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Immutable-document processing queue. Provided PRE-generalisation on purpose:
-- 20260810000200_builder_document_quarantine_scanning is in the corpus and
-- performs the generalisation itself (portal discriminator +
-- builder_document_version_id), so the harness exercises that migration's
-- real work. document_records / document_versions are the SOLICITOR document
-- store the queue was born against — in Phase 2 the queue is reshaped
-- builder-only (document_version_id and these two tables go).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES public.document_records(id) ON DELETE CASCADE,
  storage_bucket text NOT NULL DEFAULT 'legal-documents',
  storage_path text NOT NULL DEFAULT '',
  declared_mime_type text,
  declared_byte_size bigint,
  created_at timestamptz NOT NULL DEFAULT now()
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

-- ---------------------------------------------------------------------------
-- Feature flags. The network has its own flag table; the clone keeps its own
-- (builder_stock_marketplace stays a CLONE flag gating the clone's
-- marketplace surface). Shape verified against production.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.feature_flags (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT 'false'::jsonb,
  description text,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Operational events + outbox dead letters. The observability spine travels:
-- the network's own workers need the same "record a critical event and throw"
-- contract the clone's cross-portal outbox enforces. Shapes verified against
-- production.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_operational_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name text NOT NULL,
  severity text NOT NULL,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_id text,
  actor_type text NOT NULL DEFAULT 'system',
  actor_id uuid,
  portal text NOT NULL DEFAULT 'builder',
  case_id uuid, matter_id uuid, firm_id uuid,
  duration_ms integer,
  success boolean,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.portal_operational_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.portal_operational_events(id) ON DELETE CASCADE,
  alert_type text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  summary text NOT NULL,
  acknowledged_by uuid, acknowledged_at timestamptz,
  resolved_by uuid, resolved_at timestamptz,
  resolution_notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.integration_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.integration_dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  replayed_by uuid
);


-- ===========================================================================
-- PART 2 — SHIMS DELETED BY THE PHASE 2 SQUASH
-- Every object below exists only so an UNMODIFIED builder migration can
-- apply. The squash deletes the SQL that names it; nothing below reaches the
-- network's schema.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- SHIM (E2 / E3): the clone's client register. builder_transactions.client_id
-- and builder_stock_selections.client_id become (connection_id,
-- remote_client_ref) in the network — an opaque per-connection uuid minted by
-- the workspace, never a foreign key across a database boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- SHIM (E1): the transaction-case spine. The fourth domain slot
-- (transaction_case_links.builder_transaction_id) and the widened guard STAY
-- IN THE CLONE, re-pointed at the clone-side mirror
-- builder_network_transactions; the network never holds a case. The guard's
-- sibling reads (client_deals, legal_matters, purchase_files) resolve at
-- runtime, but the deletion-lifecycle migrations name these tables directly,
-- so the shims carry the columns those statements touch.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.client_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.legal_matters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.purchase_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transaction_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transaction_case_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.transaction_cases(id) ON DELETE CASCADE,
  legal_matter_id uuid REFERENCES public.legal_matters(id) ON DELETE SET NULL,
  purchase_file_id uuid REFERENCES public.purchase_files(id) ON DELETE SET NULL,
  client_deal_id uuid REFERENCES public.client_deals(id) ON DELETE SET NULL,
  link_source text NOT NULL DEFAULT 'command_centre',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transaction_case_link_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid,
  domain_type text NOT NULL,
  domain_id uuid,
  action text NOT NULL DEFAULT 'linked',
  actor uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- SHIM (admin plane): the Command Centre's module registry.
-- 20260801000500_builder_portal_admin_module registers builder_portal_admin
-- as a Command Centre module — a surface the multi-vendor model deletes
-- outright (an agency no longer administers a builder's organisation), so
-- the registration goes with it.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- SHIM (E6): the cross-portal release-control plane, provided ALREADY
-- GENERALISED (builder_organisation_id present, firm ownership optional)
-- because the generalisation migration, 20260801000400, is not builder-named
-- and therefore outside this corpus. A central platform does not need
-- per-organisation portal rollout — builder_organisations.status covers what
-- the flag gated — so Phase 2 deletes the builder branches and none of this
-- reaches the network. The builder_organisation_id FKs are added by the
-- corpus migrations themselves where they are added at all.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cross_portal_feature_definitions (
  feature_key text PRIMARY KEY,
  portal text NOT NULL DEFAULT 'solicitor' CHECK (portal IN ('solicitor','builder')),
  description text NOT NULL,
  default_mode text NOT NULL CHECK (default_mode IN ('off','shadow','dual_read','dual_write','cutover','rollback')),
  legacy_removal_target text NOT NULL,
  minimum_stable_days integer NOT NULL DEFAULT 7 CHECK (minimum_stable_days BETWEEN 1 AND 90),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 20260801000400_cross_portal_rollout_org_generalisation (non-corpus) seeds
-- builder_portal_identity_v1 at 'off'; the Phase 2 migration only ASSERTS it.
-- Seeded here for the same reason the tables above are pre-generalised.
INSERT INTO public.cross_portal_feature_definitions(feature_key, portal, description, default_mode, legacy_removal_target)
VALUES ('builder_portal_identity_v1', 'builder',
        'Builder Portal external identity surface', 'off',
        'No legacy surface — greenfield gate')
ON CONFLICT (feature_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.cross_portal_firm_rollouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal text NOT NULL DEFAULT 'solicitor',
  firm_id uuid,
  builder_organisation_id uuid,
  feature_key text NOT NULL REFERENCES public.cross_portal_feature_definitions(feature_key),
  mode text NOT NULL CHECK (mode IN ('off','shadow','dual_read','dual_write','cutover','rollback')),
  reason text NOT NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  stable_since timestamptz,
  CHECK (num_nonnulls(firm_id, builder_organisation_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS cross_portal_firm_rollouts_firm_key
  ON public.cross_portal_firm_rollouts(firm_id, feature_key) WHERE firm_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cross_portal_firm_rollouts_builder_key
  ON public.cross_portal_firm_rollouts(builder_organisation_id, feature_key) WHERE builder_organisation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.cross_portal_rollout_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal text NOT NULL DEFAULT 'solicitor',
  firm_id uuid,
  builder_organisation_id uuid,
  feature_key text NOT NULL,
  from_mode text, to_mode text NOT NULL, reason text NOT NULL, changed_by uuid,
  readiness_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cross_portal_dual_read_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal text NOT NULL DEFAULT 'solicitor',
  firm_id uuid,
  builder_organisation_id uuid,
  feature_key text NOT NULL, subject_type text NOT NULL, subject_id uuid,
  legacy_hash text NOT NULL CHECK (legacy_hash ~ '^[0-9a-f]{64}$'),
  target_hash text NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  matches boolean NOT NULL,
  mismatch_fields text[] NOT NULL DEFAULT '{}',
  correlation_id uuid NOT NULL,
  compared_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cross_portal_cutover_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal text NOT NULL DEFAULT 'solicitor',
  firm_id uuid,
  builder_organisation_id uuid,
  feature_key text NOT NULL,
  approved_by uuid NOT NULL,
  approval_type text NOT NULL CHECK (approval_type IN ('technical','security','operations','business_owner')),
  evidence_reference text NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.cross_portal_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portal text NOT NULL DEFAULT 'solicitor',
  firm_id uuid,
  builder_organisation_id uuid,
  feature_key text,
  status text NOT NULL CHECK (status IN ('running','passed','failed')),
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  initiated_by uuid
);

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
