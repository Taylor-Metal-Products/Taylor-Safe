-- PostgreSQL grants EXECUTE on newly created functions to PUBLIC by default.
-- Supabase also has explicit default grants for API roles in some projects.
-- Remove both paths so public-schema RPC access is always deliberate.
revoke execute on all functions in schema public from public, anon;

-- The tablet handoff is the only unauthenticated RPC surface. Both functions
-- validate a short-lived, one-time token before returning or accepting data.
grant execute on function public.get_employee_form_handoff(text)
  to anon;
grant execute on function public.submit_employee_form_handoff(
  text,
  jsonb,
  text,
  boolean,
  boolean
) to anon;

-- These worker RPCs are invoked only by the employee-document Edge Function's
-- service-role client. Keep authenticated browser sessions out even though the
-- function bodies also enforce auth.role() = 'service_role'.
revoke execute on function public.attest_employee_document_malware_rejection_internal(
  uuid,
  uuid,
  bigint,
  text,
  jsonb,
  jsonb
) from authenticated;
revoke execute on function public.attest_employee_document_malware_scan_internal(
  uuid,
  text,
  jsonb
) from authenticated;
revoke execute on function public.claim_employee_document_upload_internal(uuid)
  from authenticated;
revoke execute on function public.commit_employee_document_upload_internal(
  uuid,
  uuid,
  text,
  bigint,
  text,
  jsonb
) from authenticated;
revoke execute on function public.reject_employee_document_upload_internal(
  uuid,
  uuid,
  text
) from authenticated;
revoke execute on function public.expire_employee_form_handoffs_internal()
  from authenticated;

-- Preserve the intended Edge Function capability explicitly rather than
-- relying on inherited or project-level default privileges.
grant execute on function public.attest_employee_document_malware_rejection_internal(
  uuid,
  uuid,
  bigint,
  text,
  jsonb,
  jsonb
) to service_role;
grant execute on function public.attest_employee_document_malware_scan_internal(
  uuid,
  text,
  jsonb
) to service_role;
grant execute on function public.claim_employee_document_upload_internal(uuid)
  to service_role;
grant execute on function public.commit_employee_document_upload_internal(
  uuid,
  uuid,
  text,
  bigint,
  text,
  jsonb
) to service_role;
grant execute on function public.reject_employee_document_upload_internal(
  uuid,
  uuid,
  text
) to service_role;
grant execute on function public.expire_employee_form_handoffs_internal()
  to service_role;

-- PostgreSQL's built-in PUBLIC function grant is global, so it must be revoked
-- globally. The schema-scoped revoke also removes any Supabase-provisioned
-- public-schema default grant to PUBLIC or anon. Authenticated and service-role
-- defaults are intentionally left unchanged.
alter default privileges for role postgres
  revoke execute on functions from public, anon;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon;

-- Fail the migration if a later edit leaves any other public function callable
-- by anon, or exposes a worker-only function to authenticated browser sessions.
do $$
declare
  unexpected_anon_functions text;
  unexpected_authenticated_functions text;
  missing_service_functions text;
begin
  select string_agg(procedure_record.oid::regprocedure::text, ', ' order by procedure_record.oid::regprocedure::text)
  into unexpected_anon_functions
  from pg_catalog.pg_proc procedure_record
  join pg_catalog.pg_namespace namespace_record
    on namespace_record.oid = procedure_record.pronamespace
  where namespace_record.nspname = 'public'
    and pg_catalog.has_function_privilege('anon', procedure_record.oid, 'EXECUTE')
    and procedure_record.oid not in (
      'public.get_employee_form_handoff(text)'::regprocedure,
      'public.submit_employee_form_handoff(text,jsonb,text,boolean,boolean)'::regprocedure
    );

  if unexpected_anon_functions is not null then
    raise exception 'Unexpected anonymous public-function access remains: %',
      unexpected_anon_functions;
  end if;

  if not pg_catalog.has_function_privilege(
    'anon',
    'public.get_employee_form_handoff(text)'::regprocedure,
    'EXECUTE'
  ) or not pg_catalog.has_function_privilege(
    'anon',
    'public.submit_employee_form_handoff(text,jsonb,text,boolean,boolean)'::regprocedure,
    'EXECUTE'
  ) then
    raise exception 'Anonymous employee-form handoff access is incomplete';
  end if;

  select string_agg(worker_function::regprocedure::text, ', ' order by worker_function::regprocedure::text)
  into unexpected_authenticated_functions
  from unnest(array[
    'public.attest_employee_document_malware_rejection_internal(uuid,uuid,bigint,text,jsonb,jsonb)'::regprocedure::oid,
    'public.attest_employee_document_malware_scan_internal(uuid,text,jsonb)'::regprocedure::oid,
    'public.claim_employee_document_upload_internal(uuid)'::regprocedure::oid,
    'public.commit_employee_document_upload_internal(uuid,uuid,text,bigint,text,jsonb)'::regprocedure::oid,
    'public.reject_employee_document_upload_internal(uuid,uuid,text)'::regprocedure::oid,
    'public.expire_employee_form_handoffs_internal()'::regprocedure::oid
  ]) as worker_functions(worker_function)
  where pg_catalog.has_function_privilege(
    'authenticated',
    worker_function,
    'EXECUTE'
  );

  if unexpected_authenticated_functions is not null then
    raise exception 'Worker-only function access remains for authenticated: %',
      unexpected_authenticated_functions;
  end if;

  select string_agg(worker_function::regprocedure::text, ', ' order by worker_function::regprocedure::text)
  into missing_service_functions
  from unnest(array[
    'public.attest_employee_document_malware_rejection_internal(uuid,uuid,bigint,text,jsonb,jsonb)'::regprocedure::oid,
    'public.attest_employee_document_malware_scan_internal(uuid,text,jsonb)'::regprocedure::oid,
    'public.claim_employee_document_upload_internal(uuid)'::regprocedure::oid,
    'public.commit_employee_document_upload_internal(uuid,uuid,text,bigint,text,jsonb)'::regprocedure::oid,
    'public.reject_employee_document_upload_internal(uuid,uuid,text)'::regprocedure::oid,
    'public.expire_employee_form_handoffs_internal()'::regprocedure::oid
  ]) as worker_functions(worker_function)
  where not pg_catalog.has_function_privilege(
    'service_role',
    worker_function,
    'EXECUTE'
  );

  if missing_service_functions is not null then
    raise exception 'Worker-only function access is missing for service_role: %',
      missing_service_functions;
  end if;
end;
$$;
