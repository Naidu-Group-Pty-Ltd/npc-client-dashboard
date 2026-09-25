-- The platform objects the builder-network migrations reference, and nothing more.
-- Used only by the behavioural SQL specs; never applied to a real database.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ select 'service_role' $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ select null::uuid $$;
CREATE TABLE public.feature_flags (key text PRIMARY KEY, value jsonb, description text, updated_at timestamptz default now());
CREATE TABLE public.custom_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), username text, email text, first_name text, last_name text, phone text, role text);
CREATE TABLE public.clients (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), primary_first_name text, primary_surname text, primary_email text);
CREATE TABLE public.portal_operational_events_log (id bigserial, name text, severity text, meta jsonb);
CREATE OR REPLACE FUNCTION public.record_portal_operational_event(
  p_event_name text, p_severity text, p_request_id uuid, p_ref text, p_actor_type text,
  p_a text, p_b text, p_c text, p_d text, p_e text, p_f text, p_success boolean, p_meta jsonb)
RETURNS void LANGUAGE sql AS $$ INSERT INTO public.portal_operational_events_log(name,severity,meta) VALUES (p_event_name,p_severity,p_meta) $$;
