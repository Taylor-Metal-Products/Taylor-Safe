-- PROPOSED: Louie applies this after reviewing the accompanying change request.
-- Creates company invitations, not Auth accounts. Existing users and memberships
-- are not changed. No email sender, signup setting, or Auth hook is modified.
begin;

create table public.company_team_invitations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null check (
    email = lower(btrim(email)) and char_length(email) between 3 and 254
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  ),
  role public.safetyops_role not null check (role <> 'corporate_admin'),
  default_location_id uuid,
  location_ids uuid[] not null default '{}'::uuid[] check (
    cardinality(location_ids) <= 100 and array_position(location_ids, null) is null
  ),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_by uuid references auth.users(id),
  accepted_at timestamptz,
  revoked_by uuid references auth.users(id),
  revoked_at timestamptz,
  foreign key (company_id, default_location_id)
    references public.locations(company_id, id),
  check (expires_at = created_at + interval '7 days'),
  check ((status = 'accepted') = (accepted_by is not null and accepted_at is not null)),
  check ((status = 'revoked') = (revoked_by is not null and revoked_at is not null)),
  check (default_location_id is null or default_location_id = any(location_ids)),
  check (role in ('safety_manager', 'auditor') or
    (cardinality(location_ids) > 0 and default_location_id is not null))
);

create unique index company_team_invitations_one_pending_email
  on public.company_team_invitations(company_id, email) where status = 'pending';
create index company_team_invitations_company_created
  on public.company_team_invitations(company_id, created_at desc);
create index company_team_invitations_creator on public.company_team_invitations(created_by);
create index company_team_invitations_acceptor on public.company_team_invitations(accepted_by)
  where accepted_by is not null;
create index company_team_invitations_revoker on public.company_team_invitations(revoked_by)
  where revoked_by is not null;
create index company_team_invitations_default_location
  on public.company_team_invitations(company_id, default_location_id)
  where default_location_id is not null;

alter table public.company_team_invitations enable row level security;
-- No policies or direct API privileges: every operation goes through the
-- checked functions below, including reads. An invite UUID is NOT authority.
revoke all on public.company_team_invitations from public, anon, authenticated, service_role;

create function private.require_team_access_actor()
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  session_claim text := auth.jwt() ->> 'session_id';
begin
  if actor_id is null or session_claim is null
     or session_claim !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or not exists (
       select 1 from auth.users account
       where account.id = actor_id and account.email is not null
         and account.email_confirmed_at is not null
         and not coalesce(account.is_anonymous, false)
         and account.deleted_at is null
         and (account.banned_until is null or account.banned_until <= now())
     ) then
    raise exception 'A current verified sign-in is required.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from auth.sessions session_record
    where session_record.id = session_claim::uuid and session_record.user_id = actor_id
      and (session_record.not_after is null or session_record.not_after > now())
  ) then
    raise exception 'A current verified sign-in is required.' using errcode = '42501';
  end if;
  return actor_id;
end;
$$;

create function private.require_team_access_admin(target_company_id uuid, target_actor_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  -- FOR SHARE keeps a concurrent role removal/deactivation from committing
  -- between authorization and the invitation mutation in this transaction.
  perform 1 from public.company_memberships membership
  where membership.company_id = target_company_id and membership.user_id = target_actor_id
    and membership.active and membership.role = 'corporate_admin'
  for share;
  if not found then
    raise exception 'Company administrator access is required.' using errcode = '42501';
  end if;
end;
$$;

create function private.validate_team_invite_locations(
  target_company_id uuid, target_role public.safetyops_role,
  target_default_location_id uuid, target_location_ids uuid[]
)
returns uuid[] language plpgsql security definer set search_path = ''
as $$
declare
  normalized_ids uuid[];
  valid_count integer;
begin
  if target_role is null or target_role = 'corporate_admin' then
    raise exception 'Choose an available team role.' using errcode = '22023';
  end if;
  if cardinality(coalesce(target_location_ids, '{}'::uuid[])) > 100
     or array_position(target_location_ids, null) is not null then
    raise exception 'Choose valid active company locations.' using errcode = '22023';
  end if;
  select coalesce(array_agg(selected_id order by selected_id), '{}'::uuid[]) into normalized_ids
  from (select distinct unnest(coalesce(target_location_ids, '{}'::uuid[])) as selected_id) selected;
  if (target_default_location_id is not null and not target_default_location_id = any(normalized_ids))
     or (target_role not in ('safety_manager', 'auditor')
       and (cardinality(normalized_ids) = 0 or target_default_location_id is null)) then
    raise exception 'Choose valid active company locations and a default location.' using errcode = '22023';
  end if;
  -- Deterministic locks prevent deactivation while access is being granted.
  perform 1 from public.locations location_record
  where location_record.company_id = target_company_id and location_record.active
    and location_record.id = any(normalized_ids)
  order by location_record.id for share;
  get diagnostics valid_count = row_count;
  if valid_count <> cardinality(normalized_ids) then
    raise exception 'Choose valid active company locations.' using errcode = '22023';
  end if;
  return normalized_ids;
end;
$$;

create function private.team_invitation_summary(invitation public.company_team_invitations)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'id', invitation.id, 'email', invitation.email, 'role', invitation.role,
    'default_location_id', invitation.default_location_id, 'location_ids', invitation.location_ids,
    'status', case when invitation.status = 'pending' and invitation.expires_at <= now()
      then 'expired' else invitation.status end,
    'created_at', invitation.created_at, 'expires_at', invitation.expires_at
  );
$$;

create function private.list_company_team_access(target_company_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := private.require_team_access_actor();
  member_records jsonb;
  invitation_records jsonb;
begin
  perform private.require_team_access_admin(target_company_id, actor_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', membership.user_id, 'full_name', profile.full_name,
    'email', account.email, 'role', membership.role, 'active', membership.active,
    'default_location_id', membership.default_location_id,
    'location_ids', coalesce((select jsonb_agg(scope.location_id order by scope.location_id)
      from public.location_memberships scope
      where scope.company_id = membership.company_id and scope.user_id = membership.user_id), '[]'::jsonb)
  ) order by profile.full_name, membership.user_id), '[]'::jsonb) into member_records
  from public.company_memberships membership
  join public.profiles profile on profile.id = membership.user_id
  join auth.users account on account.id = membership.user_id
  where membership.company_id = target_company_id;
  select coalesce(jsonb_agg(private.team_invitation_summary(invitation)
    order by invitation.created_at desc, invitation.id), '[]'::jsonb) into invitation_records
  from public.company_team_invitations invitation where invitation.company_id = target_company_id;
  return jsonb_build_object('members', member_records, 'invitations', invitation_records);
end;
$$;

create function private.create_company_team_invite(
  target_company_id uuid, target_email text, target_role public.safetyops_role,
  target_default_location_id uuid, target_location_ids uuid[]
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := private.require_team_access_actor();
  normalized_email text := lower(btrim(target_email));
  normalized_ids uuid[];
  invitation public.company_team_invitations;
begin
  perform private.require_team_access_admin(target_company_id, actor_id);
  if normalized_email is null or char_length(normalized_email) not between 3 and 254
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    raise exception 'Enter a valid email address.' using errcode = '22023';
  end if;
  normalized_ids := private.validate_team_invite_locations(
    target_company_id, target_role, target_default_location_id, target_location_ids);
  -- Serializes duplicate creation for this company/email only; does not query
  -- whether an unrelated Auth account exists (no account enumeration).
  perform pg_advisory_xact_lock(hashtextextended(target_company_id::text || ':' || normalized_email, 81815));
  if exists (
    select 1 from public.company_memberships membership
    join auth.users account on account.id = membership.user_id
    where membership.company_id = target_company_id and lower(btrim(account.email)) = normalized_email
  ) then
    raise exception 'This person already has a company access record. Ask the owner to review it.' using errcode = '23505';
  end if;
  -- Expiry is enforced on every use, even if no new invitation ever follows.
  update public.company_team_invitations set status = 'expired'
  where company_id = target_company_id and email = normalized_email
    and status = 'pending' and expires_at <= now();
  if exists (
    select 1 from public.company_team_invitations
    where company_id = target_company_id and email = normalized_email and status = 'pending'
  ) then
    raise exception 'A pending invitation already exists. Copy or revoke it first.' using errcode = '23505';
  end if;
  insert into public.company_team_invitations (
    company_id, email, role, default_location_id, location_ids, created_by
  ) values (target_company_id, normalized_email, target_role, target_default_location_id, normalized_ids, actor_id)
  returning * into invitation;
  insert into public.audit_events (company_id, actor_user_id, entity_type, entity_id, action, details)
  values (target_company_id, actor_id, 'company_team_invitation', invitation.id, 'team_invitation_created',
    jsonb_build_object('role', invitation.role, 'default_location_id', invitation.default_location_id,
      'location_ids', invitation.location_ids, 'expires_at', invitation.expires_at));
  return private.team_invitation_summary(invitation);
end;
$$;

create function private.revoke_company_team_invite(target_invite_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := private.require_team_access_actor();
  invitation public.company_team_invitations;
begin
  select * into invitation from public.company_team_invitations where id = target_invite_id;
  if not found then
    raise exception 'This invitation is unavailable.' using errcode = '42501';
  end if;
  -- Keep admin-before-invitation lock order shared with accept.
  perform private.require_team_access_admin(invitation.company_id, actor_id);
  select * into invitation from public.company_team_invitations where id = target_invite_id for update;
  if invitation.status <> 'pending' then
    raise exception 'This invitation is unavailable.' using errcode = '42501';
  end if;
  update public.company_team_invitations set status = 'revoked', revoked_by = actor_id, revoked_at = now()
  where id = invitation.id;
  insert into public.audit_events (company_id, actor_user_id, entity_type, entity_id, action, details)
  values (invitation.company_id, actor_id, 'company_team_invitation', invitation.id, 'team_invitation_revoked', '{}');
end;
$$;

create function private.accept_company_team_invite(target_invite_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor_id uuid := private.require_team_access_actor();
  actor_email text;
  invitation public.company_team_invitations;
  selected_ids uuid[];
begin
  -- The Auth row serializes all concurrent accepts by this account, including
  -- different companies/invitations. Recheck account/session after acquiring it.
  select lower(btrim(account.email)) into actor_email from auth.users account
  where account.id = actor_id for update;
  perform private.require_team_access_actor();
  select * into invitation from public.company_team_invitations where id = target_invite_id;
  if not found or invitation.email <> actor_email then
    raise exception 'This invitation is unavailable for this account.' using errcode = '42501';
  end if;
  -- Signing out does not cancel an administrator's invitation, but disabling
  -- that administrator's Auth identity must prevent a new grant. Deliberately
  -- do not lock a second Auth user row (recipient-to-issuer lock inversion).
  if not exists (
    select 1 from auth.users issuer where issuer.id = invitation.created_by
      and issuer.email is not null and issuer.email_confirmed_at is not null
      and not coalesce(issuer.is_anonymous, false) and issuer.deleted_at is null
      and (issuer.banned_until is null or issuer.banned_until <= now())
  ) then
    raise exception 'This invitation is unavailable for this account.' using errcode = '42501';
  end if;
  -- Do not reveal company, role, or issuer to an invalid recipient.
  begin
    perform private.require_team_access_admin(invitation.company_id, invitation.created_by);
  exception when insufficient_privilege then
    raise exception 'This invitation is unavailable for this account.' using errcode = '42501';
  end;
  select * into invitation from public.company_team_invitations where id = target_invite_id for update;
  if invitation.email <> actor_email or invitation.expires_at <= now()
     or invitation.status not in ('pending', 'accepted') then
    raise exception 'This invitation is unavailable for this account.' using errcode = '42501';
  end if;
  begin
    selected_ids := private.validate_team_invite_locations(invitation.company_id, invitation.role,
      invitation.default_location_id, invitation.location_ids);
  exception when invalid_parameter_value then
    raise exception 'This invitation is unavailable for this account.' using errcode = '42501';
  end;
  if invitation.status = 'accepted' then
    -- A lost-response retry may confirm the same unchanged grant, never restore
    -- revoked access, escalate a changed role, or create another membership.
    if invitation.accepted_by = actor_id and exists (
      select 1 from public.company_memberships membership
      where membership.company_id = invitation.company_id and membership.user_id = actor_id
        and membership.active and membership.role = invitation.role
        and membership.default_location_id is not distinct from invitation.default_location_id
    ) and selected_ids = coalesce((
      select array_agg(scope.location_id order by scope.location_id) from public.location_memberships scope
      where scope.company_id = invitation.company_id and scope.user_id = actor_id
    ), '{}'::uuid[]) then
      return jsonb_build_object('company_id', invitation.company_id, 'role', invitation.role, 'status', 'accepted');
    end if;
    raise exception 'This invitation is unavailable for this account.' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.company_memberships membership where membership.user_id = actor_id
      and (membership.company_id = invitation.company_id or membership.active)
  ) then
    raise exception 'This invitation is unavailable for this account.' using errcode = '42501';
  end if;
  -- No raw_user_meta_data is used as authority or to replace an existing name.
  insert into public.profiles (id, full_name) values (actor_id, '') on conflict (id) do nothing;
  insert into public.company_memberships (company_id, user_id, role, active, default_location_id)
  values (invitation.company_id, actor_id, invitation.role, true, invitation.default_location_id);
  insert into public.location_memberships (company_id, location_id, user_id)
  select invitation.company_id, location_id, actor_id from unnest(selected_ids) location_id;
  update public.company_team_invitations set status = 'accepted', accepted_by = actor_id, accepted_at = now()
  where id = invitation.id;
  -- Existing membership audit correctly identifies the recipient as the actual
  -- actor. This separate event preserves the approving administrator as issuer.
  insert into public.audit_events (company_id, actor_user_id, entity_type, entity_id, action, details)
  values (invitation.company_id, actor_id, 'company_team_invitation', invitation.id, 'team_invitation_accepted',
    jsonb_build_object('issued_by', invitation.created_by, 'subject_user_id', actor_id,
      'role', invitation.role, 'default_location_id', invitation.default_location_id, 'location_ids', selected_ids));
  return jsonb_build_object('company_id', invitation.company_id, 'role', invitation.role, 'status', 'accepted');
end;
$$;

-- Only these four non-definer facades are exposed through the public API.
create function public.list_company_team_access(target_company_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.list_company_team_access(target_company_id); $$;
create function public.create_company_team_invite(
  target_company_id uuid, target_email text, target_role public.safetyops_role,
  target_default_location_id uuid, target_location_ids uuid[]
)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.create_company_team_invite(target_company_id, target_email, target_role,
  target_default_location_id, target_location_ids); $$;
create function public.revoke_company_team_invite(target_invite_id uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.revoke_company_team_invite(target_invite_id); $$;
create function public.accept_company_team_invite(target_invite_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.accept_company_team_invite(target_invite_id); $$;

revoke all on function private.require_team_access_actor() from public, anon, authenticated, service_role;
revoke all on function private.require_team_access_admin(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function private.validate_team_invite_locations(uuid, public.safetyops_role, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.team_invitation_summary(public.company_team_invitations) from public, anon, authenticated, service_role;

revoke all on function private.list_company_team_access(uuid) from public, anon, authenticated, service_role;
revoke all on function private.create_company_team_invite(uuid, text, public.safetyops_role, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function private.revoke_company_team_invite(uuid) from public, anon, authenticated, service_role;
revoke all on function private.accept_company_team_invite(uuid) from public, anon, authenticated, service_role;
grant execute on function private.list_company_team_access(uuid),
  private.create_company_team_invite(uuid, text, public.safetyops_role, uuid, uuid[]),
  private.revoke_company_team_invite(uuid), private.accept_company_team_invite(uuid) to authenticated;

revoke all on function public.list_company_team_access(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_company_team_invite(uuid, text, public.safetyops_role, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.revoke_company_team_invite(uuid) from public, anon, authenticated, service_role;
revoke all on function public.accept_company_team_invite(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_company_team_access(uuid),
  public.create_company_team_invite(uuid, text, public.safetyops_role, uuid, uuid[]),
  public.revoke_company_team_invite(uuid), public.accept_company_team_invite(uuid) to authenticated;

comment on table public.company_team_invitations is
  'Email-bound, seven-day, single-grant company invitations. Does not create Auth users; owner creates accounts manually.';
notify pgrst, 'reload schema';
commit;
