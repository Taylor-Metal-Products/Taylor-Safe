// Executes the real proposed SQL in PostgreSQL/WASM; no hosted connection.
// Auth schemas/JWTs are synthetic fixtures, not proof of hosted Auth or RLS.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
let serial = 1;
const uuid = () => `00000000-0000-4000-8000-${String(serial++).padStart(12, '0')}`;
const root = new URL('../', import.meta.url);
const initial = await readFile(new URL('supabase/migrations/202607300001_initial_safetyops.sql', root), 'utf8');
const integrity = await readFile(new URL('supabase/migrations/202607310011_auth_and_tenant_integrity.sql', root), 'utf8');
const migration = await readFile(new URL('supabase/migrations/20260918181541_company_team_access_invitations.sql', root), 'utf8');

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create schema private;
  grant usage on schema private, public, auth to authenticated;
  create table auth.users (
    id uuid primary key, email text, email_confirmed_at timestamptz,
    is_anonymous boolean default false, deleted_at timestamptz,
    banned_until timestamptz, raw_user_meta_data jsonb default '{}'
  );
  create table auth.sessions (id uuid primary key, user_id uuid references auth.users(id), not_after timestamptz);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb; $$;
  create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid; $$;
  create function auth.role() returns text language sql stable as $$ select auth.jwt()->>'role'; $$;
`);
// Use the actual role/table/foreign-key definitions and actual membership
// triggers instead of replacing their provenance/integrity behavior in a mock.
await db.exec(initial.slice(initial.indexOf('create type public.safetyops_role'), initial.indexOf('create table public.form_templates')));
await db.exec(initial.slice(initial.indexOf('create table public.audit_events'), initial.indexOf('create index company_memberships_user_idx')));
await db.exec(`create unique index company_memberships_one_active_company_per_user on public.company_memberships(user_id) where active;`);
await db.exec(integrity.slice(integrity.indexOf('create or replace function private.protect_company_membership_integrity()'), integrity.indexOf('-- Migration 002 used valid_to')));
await db.exec(migration);
after(async () => { await db.close(); });

async function scalar(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows[0]?.result;
}
async function account(label, changes = {}) {
  const user = { id: uuid(), session: uuid(), email: `${label}-${serial}@example.invalid`, ...changes };
  await db.query(`insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
    values ($1,$2,now(),'{"full_name":"Untrusted supplied name","role":"corporate_admin"}')`, [user.id, user.email]);
  await db.query('insert into auth.sessions(id,user_id) values ($1,$2)', [user.session, user.id]);
  return user;
}
async function member(user, company, role = 'corporate_admin', active = true) {
  await db.query(`insert into public.profiles(id,full_name) values($1,$2) on conflict do nothing`, [user.id, `Fixture ${role}`]);
  await db.query(`insert into public.company_memberships(company_id,user_id,role,active) values($1,$2,$3,$4)`, [company, user.id, role, active]);
}
async function company(owner, label) {
  const id = uuid();
  await db.query('insert into public.companies(id,name,slug,created_by) values($1,$2,$3,$4)', [id, label, `fixture-${serial}`, owner.id]);
  await member(owner, id);
  return id;
}
async function location(companyId, owner, active = true) {
  const id = uuid();
  await db.query('insert into public.locations(id,company_id,name,code,created_by,active) values($1,$2,$3,$4,$5,$6)',
    [id, companyId, `Fixture location ${serial}`, `L${serial}`, owner.id, active]);
  return id;
}
async function asRole(role, user, sql, params = [], extraClaims = {}) {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: user?.id, session_id: user?.session, role, ...extraClaims })]);
  await db.exec(`set role ${role}`);
  try { return await scalar(sql, params); }
  finally { await db.exec('reset role'); await db.exec(`select set_config('request.jwt.claims','',false)`); }
}
const call = (user, sql, params = [], extraClaims = {}) => asRole('authenticated', user, sql, params, extraClaims);
const owner = await account('owner');
const otherOwner = await account('other-owner');
const companyId = await company(owner, 'Synthetic company A');
const otherCompanyId = await company(otherOwner, 'Synthetic company B');
const siteA = await location(companyId, owner);
const siteB = await location(companyId, owner);
const foreignSite = await location(otherCompanyId, otherOwner);
const inactiveSite = await location(companyId, owner, false);
const manager = await account('safety-manager');
await member(manager, companyId, 'safety_manager');
const invite = (email, role = 'safety_manager', defaultSite = siteA, sites = [siteA, siteB], actor = owner, tenant = companyId) =>
  call(actor, 'select public.create_company_team_invite($1,$2,$3,$4,$5) as result', [tenant, email, role, defaultSite, sites]);
const accept = (user, id, claims = {}) => call(user, 'select public.accept_company_team_invite($1) as result', [id], claims);
const invitationRow = (id) => scalar('select to_jsonb(invitation) as result from public.company_team_invitations invitation where id=$1', [id]);
const rejects = async (promise, message) => assert.rejects(promise, (error) => message.test(error.message));
const unavailable = /This invitation is unavailable for this account\./;

test('public RPCs are invoker-only; private code has pinned empty search paths', async () => {
  const { rows } = await db.query(`select n.nspname, p.proname, p.prosecdef, p.proconfig from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where p.proname in
    ('list_company_team_access','create_company_team_invite','revoke_company_team_invite','accept_company_team_invite')`);
  assert.equal(rows.length, 8);
  for (const fn of rows) {
    assert.equal(fn.prosecdef, fn.nspname === 'private');
    assert.ok(fn.proconfig.includes('search_path=""'));
  }
});

test('anonymous and service roles cannot call invitation RPCs', async () => {
  for (const role of ['anon', 'service_role']) {
    for (const [sql, params] of [
      ['select public.list_company_team_access($1) as result', [companyId]],
      ['select public.create_company_team_invite($1,$2,$3,$4,$5) as result', [companyId,'none@example.invalid','worker',siteA,[siteA]]],
      ['select public.revoke_company_team_invite($1) as result', [uuid()]],
      ['select public.accept_company_team_invite($1) as result', [uuid()]],
    ]) await rejects(asRole(role, null, sql, params), /permission denied/);
  }
});

test('invitation table has RLS and no browser read/write or helper privileges', async () => {
  assert.equal(await scalar(`select relrowsecurity as result from pg_class where oid='public.company_team_invitations'::regclass`), true);
  for (const sql of [
    'select count(*) as result from public.company_team_invitations',
    `insert into public.company_team_invitations(company_id,email,role,created_by) values('${companyId}','forged@example.invalid','safety_manager','${owner.id}')`,
    `update public.company_team_invitations set role='corporate_admin'`,
    `delete from public.company_team_invitations`,
    `select private.require_team_access_admin('${companyId}','${owner.id}') as result`,
  ]) await rejects(call(owner, sql), /permission denied/);
});

test('list is company-admin-only and does not include other company members', async () => {
  const result = await call(owner, 'select public.list_company_team_access($1) as result', [companyId]);
  assert.equal(result.members.length, 2);
  assert.ok(!result.members.some((item) => item.user_id === otherOwner.id));
  await rejects(call(owner, 'select public.list_company_team_access($1) as result', [otherCompanyId]), /administrator access/);
  await rejects(call(manager, 'select public.list_company_team_access($1) as result', [companyId]), /administrator access/);
  await rejects(invite('denied@example.invalid','worker',siteA,[siteA],manager), /administrator access/);
  await rejects(call(manager, 'select private.list_company_team_access($1) as result', [companyId]), /administrator access/);
});

test('creation normalizes email, returns only safe summary fields, and refuses duplicates', async () => {
  const result = await invite(' New-Person@Example.Invalid ');
  assert.equal(result.email, 'new-person@example.invalid');
  assert.equal(result.status, 'pending');
  assert.equal(new Date(result.expires_at) - new Date(result.created_at), 7 * 86400000);
  assert.deepEqual(Object.keys(result).sort(), ['id','email','role','default_location_id','location_ids','status','created_at','expires_at'].sort());
  await rejects(invite('new-person@example.invalid'), /pending invitation already exists/);
  assert.equal(await scalar(`select count(*)::int as result from auth.users where email='new-person@example.invalid'`), 0);
});

test('rejects corporate admin escalation, malformed email and invalid location scope', async () => {
  await rejects(invite('escalate@example.invalid','corporate_admin'), /available team role/);
  await rejects(invite('missing-email'), /valid email/);
  for (const [role, primary, sites] of [
    ['worker',null,[]], ['supervisor',siteA,[]], ['location_manager',null,[siteA]],
    ['worker',siteA,[siteB]], ['worker',foreignSite,[foreignSite]], ['worker',inactiveSite,[inactiveSite]],
    ['worker',siteA,[siteA,null]], ['worker',siteA,Array(101).fill(siteA)],
  ]) await rejects(invite(`${uuid()}@example.invalid`,role,primary,sites), /valid active company locations/);
});

test('company-wide roles can have no location assignments; scoped roles normalize duplicate locations', async () => {
  const companywide = await invite('auditor@example.invalid','auditor',null,[]);
  assert.deepEqual(companywide.location_ids, []);
  const scoped = await invite('worker@example.invalid','worker',siteA,[siteA,siteA]);
  assert.deepEqual(scoped.location_ids, [siteA]);
});

test('manual account can be created after invite and accept produces one audited membership', async () => {
  const email = 'created-manually-later@example.invalid';
  const link = await invite(email, 'safety_manager');
  const user = await account('later', { email });
  const result = await accept(user, link.id);
  assert.deepEqual(result, { company_id: companyId, role: 'safety_manager', status: 'accepted' });
  const membership = await scalar('select to_jsonb(m) as result from public.company_memberships m where user_id=$1', [user.id]);
  assert.equal(membership.invited_by, user.id, 'real existing trigger records actual recipient actor');
  assert.equal(membership.role, 'safety_manager');
  assert.equal(await scalar('select full_name as result from public.profiles where id=$1', [user.id]), '');
  const audit = await scalar(`select details as result from public.audit_events where entity_id=$1 and action='team_invitation_accepted'`, [link.id]);
  assert.equal(audit.issued_by, owner.id);
  assert.equal(audit.subject_user_id, user.id);
  assert.deepEqual(audit.location_ids, [siteA, siteB]);
  assert.equal(JSON.stringify(audit).includes(email), false);
  assert.equal(JSON.stringify(audit).includes('?join='), false);
  const before = await scalar(`select count(*)::int as result from public.audit_events`);
  assert.deepEqual(await accept(user, link.id), result, 'lost-response retry is read-only');
  assert.equal(await scalar(`select count(*)::int as result from public.audit_events`), before);
  await rejects(invite(email), /already has a company access record/);
});

test('existing profile name is not overwritten by invite or user metadata', async () => {
  const user = await account('existing-profile');
  await db.query('insert into public.profiles(id,full_name) values($1,$2)', [user.id,'Existing approved display name']);
  const link = await invite(user.email, 'worker', siteA, [siteA]);
  await accept(user, link.id);
  assert.equal(await scalar('select full_name as result from public.profiles where id=$1',[user.id]), 'Existing approved display name');
});

test('wrong or unknown invite ids reveal no recipient/company and JWT email cannot override Auth email', async () => {
  const recipient = await account('recipient');
  const attacker = await account('attacker');
  const link = await invite(recipient.email);
  await rejects(accept(attacker, link.id, {email: recipient.email, user_metadata:{role:'corporate_admin',email:recipient.email}}), unavailable);
  await rejects(accept(attacker, uuid()), unavailable);
  assert.equal((await invitationRow(link.id)).status,'pending');
});

test('all non-admin roles are denied creating/listing/revoking invites', async () => {
  const link = await invite('role-denial@example.invalid');
  for (const role of ['safety_manager','location_manager','supervisor','worker','auditor']) {
    const user = await account(`denial-${role}`);
    await member(user, companyId, role);
    await rejects(invite(`${uuid()}@example.invalid`,'worker',siteA,[siteA],user), /administrator access/);
    await rejects(call(user,'select public.list_company_team_access($1) as result',[companyId]), /administrator access/);
    await rejects(call(user,'select public.revoke_company_team_invite($1) as result',[link.id]), /administrator access/);
  }
});

test('unconfirmed, anonymous, banned, soft-deleted and invalid-session accounts cannot accept', async () => {
  const cases = [
    ['unconfirmed', 'email_confirmed_at=null'], ['anonymous','is_anonymous=true'],
    ['banned', `banned_until=now()+interval '1 day'`], ['deleted','deleted_at=now()'],
  ];
  for (const [label, update] of cases) {
    const user = await account(label);
    const link = await invite(user.email);
    await db.query(`update auth.users set ${update} where id=$1`,[user.id]);
    await rejects(accept(user,link.id), /current verified sign-in/);
  }
  const user = await account('sessions');
  const link = await invite(user.email);
  await rejects(accept(user,link.id,{session_id:owner.session}), /current verified sign-in/);
  await rejects(accept(user,link.id,{session_id:'not-a-uuid'}), /current verified sign-in/);
  await rejects(accept(user,link.id,{session_id:null}), /current verified sign-in/);
  await db.query(`update auth.sessions set not_after=now()-interval '1 second' where id=$1`,[user.session]);
  await rejects(accept(user,link.id), /current verified sign-in/);
  await db.query('delete from auth.sessions where id=$1',[user.session]);
  await rejects(accept(user,link.id), /current verified sign-in/);
});

test('inactive membership cannot be reactivated; active membership in another company cannot be replaced', async () => {
  for (const [label, tenant, active] of [['inactive',companyId,false],['other-company',otherCompanyId,true]]) {
    const user = await account(label);
    const link = await invite(user.email);
    await member(user,tenant,'worker',active);
    await rejects(accept(user,link.id), unavailable);
    assert.equal((await invitationRow(link.id)).status,'pending');
    assert.equal(await scalar('select count(*)::int as result from public.company_memberships where user_id=$1',[user.id]),1);
    if (!active) await rejects(invite(user.email), /already has a company access record/);
  }
});

test('revocation is admin-scoped, audited, terminal and permits a new invitation', async () => {
  const user = await account('revoked');
  const link = await invite(user.email);
  await rejects(call(otherOwner,'select public.revoke_company_team_invite($1) as result',[link.id]), /administrator access/);
  await call(owner,'select public.revoke_company_team_invite($1) as result',[link.id]);
  await rejects(accept(user,link.id), unavailable);
  await rejects(call(owner,'select public.revoke_company_team_invite($1) as result',[link.id]), /invitation is unavailable/);
  assert.equal(await scalar(`select count(*)::int as result from public.audit_events where entity_id=$1 and action='team_invitation_revoked'`,[link.id]),1);
  assert.notEqual((await invite(user.email)).id,link.id);
});

test('expiry is checked without a scheduler and a replacement expires the old pending row', async () => {
  const user = await account('expired');
  const link = await invite(user.email);
  await db.query(`update public.company_team_invitations set created_at=now()-interval '8 days', expires_at=now()-interval '1 day' where id=$1`,[link.id]);
  await rejects(accept(user,link.id),unavailable);
  const listing = await call(owner,'select public.list_company_team_access($1) as result',[companyId]);
  assert.equal(listing.invitations.find(item=>item.id===link.id).status,'expired');
  await invite(user.email);
  assert.equal((await invitationRow(link.id)).status,'expired');
});

test('issuer role removal and location deactivation invalidate pending invites', async () => {
  const secondaryAdmin = await account('secondary-admin');
  await member(secondaryAdmin,companyId);
  const user = await account('removed-issuer');
  const link = await invite(user.email,'worker',siteA,[siteA],secondaryAdmin);
  await db.query(`update public.company_memberships set role='worker' where user_id=$1`,[secondaryAdmin.id]);
  await rejects(accept(user,link.id),unavailable);
  const changingSite = await location(companyId,owner);
  const another = await account('removed-site');
  const anotherLink = await invite(another.email,'worker',changingSite,[changingSite]);
  await db.query('update public.locations set active=false where id=$1',[changingSite]);
  await rejects(accept(another,anotherLink.id),unavailable);
  assert.equal(await scalar('select count(*)::int as result from public.company_memberships where user_id=$1',[another.id]),0);
});

test('replay cannot restore deactivated or changed access', async () => {
  for (const change of ['role', 'active', 'locations']) {
    const user = await account(`replay-${change}`);
    const link = await invite(user.email,'worker',siteA,[siteA]);
    await accept(user,link.id);
    if (change==='role') await db.query(`update public.company_memberships set role='supervisor' where user_id=$1`,[user.id]);
    if (change==='active') await db.query(`update public.company_memberships set active=false where user_id=$1`,[user.id]);
    if (change==='locations') await db.query('delete from public.location_memberships where user_id=$1',[user.id]);
    await rejects(accept(user,link.id),unavailable);
  }
});

test('disabled or unverified issuer Auth identity invalidates pending invitations', async () => {
  for (const [label, update] of [
    ['unconfirmed','email_confirmed_at=null'], ['anonymous','is_anonymous=true'],
    ['banned',`banned_until=now()+interval '1 day'`], ['deleted','deleted_at=now()'],
  ]) {
    const issuer = await account(`issuer-${label}`);
    await member(issuer,companyId);
    const user = await account(`recipient-${label}`);
    const link = await invite(user.email,'worker',siteA,[siteA],issuer);
    await db.query(`update auth.users set ${update} where id=$1`,[issuer.id]);
    await rejects(accept(user,link.id),unavailable);
    assert.equal((await invitationRow(link.id)).status,'pending');
    assert.equal(await scalar('select count(*)::int as result from public.company_memberships where user_id=$1',[user.id]),0);
  }
});

test('issuer sign-out alone does not cancel an otherwise valid invitation', async () => {
  const issuer = await account('signed-out-issuer');
  await member(issuer,companyId);
  const user = await account('signed-out-issuer-recipient');
  const link = await invite(user.email,'worker',siteA,[siteA],issuer);
  await db.query('delete from auth.sessions where id=$1',[issuer.session]);
  assert.deepEqual(await accept(user,link.id),{company_id:companyId,role:'worker',status:'accepted'});
});

test('failed final audit rolls back membership, profile, location grants and acceptance atomically', async () => {
  const user = await account('atomic-failure');
  const link = await invite(user.email,'worker',siteA,[siteA]);
  await db.exec(`create function private.fixture_fail_accept_audit() returns trigger language plpgsql as $$
    begin if new.action='team_invitation_accepted' then raise exception 'Synthetic audit failure'; end if; return new; end; $$;
    create trigger fixture_fail_audit before insert on public.audit_events for each row execute function private.fixture_fail_accept_audit();`);
  try { await rejects(accept(user,link.id),/Synthetic audit failure/); }
  finally { await db.exec('drop trigger fixture_fail_audit on public.audit_events; drop function private.fixture_fail_accept_audit();'); }
  assert.equal(await scalar('select count(*)::int as result from public.company_memberships where user_id=$1',[user.id]),0);
  assert.equal(await scalar('select count(*)::int as result from public.profiles where id=$1',[user.id]),0);
  assert.equal(await scalar('select count(*)::int as result from public.location_memberships where user_id=$1',[user.id]),0);
  assert.equal((await invitationRow(link.id)).status,'pending');
});
