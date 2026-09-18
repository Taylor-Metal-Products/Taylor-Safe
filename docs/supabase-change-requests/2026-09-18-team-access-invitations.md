# Team access: manually created accounts and copyable invitations

## Status, scope, and operator

**Proposed — not applied.** Operator and required backend reviewer: **@loufish727**. Related PR/source revision: record the reviewed `agent/team-access-invites` PR and immutable commit before execution; branch names are not execution approval. Intended environment: Taylor Safe's existing company project, not MaintainOps and not a new company.

This adds an administrator's **Create invitation → Copy invitation** flow and a recipient's **Sign in → Accept invitation** flow. Louie manually creates each individual Auth account. An app invitation authorizes one company role; it neither creates an Auth account nor sends an email. No shared Taylor account, platform-team invitation, service-key distribution, first-owner bootstrap, public signup, custom SMTP, Auth hook, Storage change, or Edge deployment is included.

The proposed first recipient needs `safety_manager` access to the existing company. This existing role is company-wide, including future locations; choosing a default location does not restrict it. Use `location_manager`, `supervisor`, or `worker` for restricted location scope; `auditor` is also company-wide and read-only under existing policies. The invitation flow cannot grant `corporate_admin` or change/reactivate an existing membership.

Keep real recipient addresses, Auth/company/location IDs, passwords, invite URLs, sessions and tokens in Louie's approved private operational record. They do not belong in this public change request, PR, issue, screenshots, or logs.

## Preconditions and impact

1. Confirm the intended project and approved private recipient identity. Confirm Louie has a working individual app sign-in with active `corporate_admin` membership in the existing company. Stop if ownership, identity, or company is ambiguous.
2. Review migration history and schema through `20260917183537_harden_public_function_execute_privileges.sql`, especially migration 011's unique active-company index and membership integrity/audit triggers. Do not blindly push every pending migration. Any missing prerequisite is a separate owner-reviewed change.
3. Confirm public signup remains disabled. This flow uses existing administrator-created email/password Auth users. Do not weaken confirmation, password, JWT, RLS, or grant settings to fix a failed invite.
4. Confirm a recent recovery point and record existing working frontend revision. This is additive: a new empty invitation table, indexes and functions; no business-data backfill or existing-user updates. Expected small catalog locks during installation; acceptance briefly locks the recipient Auth row, issuing administrator membership, invitation and selected location rows.
5. Verify `auth.users` has `email`, `email_confirmed_at`, `is_anonymous`, `deleted_at`, `banned_until`; `auth.sessions` has `id`, `user_id`, `not_after`. Current Auth sessions must include a valid `session_id` JWT claim. No custom objects are added to the Auth schema.

Run these **read-only** checks in Louie's SQL Editor; retain results privately:

```sql
select version from supabase_migrations.schema_migrations order by version;
select to_regclass('public.company_team_invitations') as proposed_table,
       to_regclass('public.company_memberships_one_active_company_per_user') as active_company_index;
select table_name, column_name from information_schema.columns
where table_schema = 'auth' and
  ((table_name = 'users' and column_name in
    ('id','email','email_confirmed_at','is_anonymous','deleted_at','banned_until'))
   or (table_name = 'sessions' and column_name in ('id','user_id','not_after')))
order by table_name, column_name;
select tgname, tgenabled from pg_trigger
where tgrelid = 'public.company_memberships'::regclass and not tgisinternal;
select company_id, user_id, role, active, default_location_id
from public.company_memberships where user_id = '<OWNER_AUTH_USER_ID>'::uuid;
select id, name, active from public.locations
where company_id = '<EXISTING_COMPANY_ID>'::uuid order by name;
```

Expected: proposed table absent on first installation; active-company index present; 11 listed Auth columns; enabled `company_memberships_integrity` and `company_memberships_audit`; exactly the intended active owner/company; review the current locations rather than assuming the original count. If the proposed table already exists, stop and establish whether this exact migration was applied; do not rerun partially or use `IF NOT EXISTS` to hide a mismatch.

## Exact proposed changes

Exact SQL: [`../../supabase/migrations/20260918181541_company_team_access_invitations.sql`](../../supabase/migrations/20260918181541_company_team_access_invitations.sql) relative to repository root is **`supabase/migrations/20260918181541_company_team_access_invitations.sql`**. Review the file from the approved immutable source revision. It is one explicit transaction, ending with PostgREST schema reload notification. It intentionally fails on duplicate installation instead of silently changing an unknown schema.

The migration adds:

- `public.company_team_invitations`: normalized email, role, default and assigned locations, issuing administrator, seven-day expiry, terminal accepted/revoked/expired state. RLS enabled with **no direct API policies or grants**, including no service-role table grant.
- Four authenticated public `SECURITY INVOKER` RPC wrappers over private `SECURITY DEFINER` implementations, each with empty pinned search path and explicit privileges: `list_company_team_access(uuid)`, `create_company_team_invite(uuid,text,safetyops_role,uuid,uuid[])`, `revoke_company_team_invite(uuid)`, `accept_company_team_invite(uuid)`.
- Active exact-company `corporate_admin` authorization for list/create/revoke, not `safety_manager`. Recipient acceptance requires current confirmed, nonanonymous, nondeleted, unbanned Auth identity, matching live session, matching **database Auth email**, an unexpired/unrevoked invitation, still-active administrator issuer, and still-valid location scope. Client-side email/role/tenant claims do not authorize acceptance.
- Unique pending company/email and per-account acceptance locking; no replacing existing active or inactive company membership. The existing one-active-company index remains the final concurrency constraint.
- An accepted invitation can only confirm the same unchanged existing grant on a lost-response retry before expiry. It never restores removed access, changes roles, adds locations or grants a second membership.
- Creation/revocation/acceptance audit events without invite URLs or email copies. Existing membership triggers record the accepting user as the actual `invited_by` actor; the separate acceptance event records `issued_by`, preserving both identities without forging claims.
- A missing profile is created with an empty display name. Existing profiles and user-supplied metadata never determine permissions; existing names are not overwritten. Creating app access does not automatically create an employee/personnel record.

Existing business RLS policies, account recovery/email behavior, membership policies and other RPCs are unchanged. In particular, existing `company_memberships` INSERT/UPDATE/DELETE remain corporate-admin-only through RLS (DELETE excludes self); existing `location_memberships` INSERT/DELETE remain available to corporate administrators/safety managers and to location managers/supervisors within their existing location scope. This proposal does not remove or expand those established management powers: explicit recipient acceptance is a guarantee of the **new invitation path**, not a replacement for every existing administrator/operator access-management mechanism. The new invitation table is intentionally not exposed for direct browser queries. No configuration values or secrets change.

Acceptance also rechecks that the issuing administrator's Auth identity is confirmed, nonanonymous, not deleted and not currently banned, in addition to the active administrator membership check. It does not require the issuer to remain signed in. The issuer Auth state is read without taking a second Auth-user lock, avoiding recipient/issuer lock inversion; for deliberate access removal, revoke outstanding invitations and deactivate the issuer membership rather than relying on a sign-out or a race with an in-progress acceptance.

## Louie's execution and rollout order

### 1. Review and install the backend

1. Obtain explicit approval of this change request and exact migration revision. Keep this proposal marked not applied until evidence is recorded.
2. Complete the read-only preflight above and make sure no concurrent provisioning/role-change work is underway.
3. In the **correct project's SQL Editor**, open a new query, paste the **complete reviewed migration file**, and run it once. Do not paste credentials, replace claims, simulate an administrator JWT, or invoke first-owner/new-company setup. If any statement fails, the transaction rolls back: stop, capture only a redacted error, and review before retrying.
4. Run post-install checks below, then the owner-authorized hosted security/negative tests. Record migration execution in your approved migration-history process; dashboard SQL execution alone does not automatically create a CLI migration-history entry. Do not fake history or rerun an installed migration via `db push`.
5. Review database Security/Performance Advisors for this change. An invitation-table RLS-with-no-policy advisory is deliberate: table grants are revoked and only checked RPCs are used. Any unexpected function, schema, table-access or search-path warning is a stop condition.

For the developer's full local Supabase environment, the discovered CLI commands are `npx --yes supabase@2.117.0 db advisors --local --type security --fail-on error` and `npx --yes supabase@2.117.0 migration list --local`. They are **not** approval to target a hosted project. Do not put a database URL/password on a shared command line.

### 2. Manually create each person's individual account

1. Louie verifies the employee and exact work email privately, then opens **Authentication → Users** in the correct project and searches for an existing account. Do not create a duplicate or reset an existing person's password just to add company access.
2. For a genuinely new account, use **Add user → Create new user** (manual creation, not an emailed invitation). Enter the verified work email and a unique password directly in the dashboard. Current dashboard labels can change; if only an email-invite option is available, stop rather than assume a message was delivered.
3. Because this path does not rely on an email-confirmation message, Louie must verify control of the recipient's company email through an approved company process before marking that **individual account** email-confirmed. This is not a global confirmation-setting change. An unconfirmed account cannot accept an app invitation.
4. Have the recipient choose their own password privately during Louie-supervised account creation. Do not send it in ordinary email/chat, paste it into an AI task, save it in a document, or reuse a shared company password. **This feature does not add an ordinary signed-in password-change screen or enforce automatic first-login password rotation.** If the recipient cannot privately set their password, stop onboarding until a separate secure password-setup/delivery process is approved; do not substitute a shared or administrator-retained permanent password.
5. Confirm the account exists and can sign in, without granting platform-team or project credentials. Sign-in alone grants no company membership. Do not manually insert a membership as well as issuing an app invitation: the existing-membership guard will deliberately reject the invitation.

### 3. Release the reviewed frontend and share the invitation

1. After backend verification, obtain fresh exact-tree release approval/signature and publish the approved frontend through the existing release process. Do not enable company Pages, move hostnames, or change Auth redirects as a side effect. The older frontend continues working with the new additive schema; the newer frontend must show the unavailable/setup state when RPCs are absent and must not simulate success.
2. Louie signs into the approved app, opens **Settings → Team access**, chooses the verified recipient email, `Safety manager` (for the approved first recipient), and desired default/assigned locations. Company-wide scope remains clearly disclosed. Click **Create invitation**, then **Copy invitation** and send the link through the normal approved company channel. The app does not send mail or create an Auth user.
3. The recipient opens the shared link on the released app, signs in with their manually created account, and explicitly chooses **Accept invitation**. Matching only the link, using another email, or having GitHub access is insufficient. Expired/revoked/incorrect-account links disclose no company or recipient details. A changed browser or cleared session requires opening the shared link again.
4. Confirm the person can open the intended company and locations, manage the approved safety records, and cannot administer team invitations as `safety_manager`. Add/maintain a separate employee record through the existing employee workflow if personnel tracking is needed.
5. Complete the app-access issue/checklist **only after** the Auth account, correct active membership, sign-in, allowed paths and denied paths have been verified. A checked checkbox, copied link, accepted PR or repository invitation is not evidence of app access. Record the operator and date; do not include live invitation links or personal data in the public issue.

Forgotten-password and other Auth-security emails still depend on the existing email delivery setup. Manual account creation and copyable company invitations do not fix SMTP or make the built-in sender unrestricted.

## Verification and evidence

Post-install read-only checks:

```sql
select relrowsecurity from pg_class
where oid = 'public.company_team_invitations'::regclass;
select role_name,
  has_table_privilege(role_name, 'public.company_team_invitations', 'SELECT') as can_select,
  has_table_privilege(role_name, 'public.company_team_invitations', 'INSERT') as can_insert,
  has_table_privilege(role_name, 'public.company_team_invitations', 'UPDATE') as can_update,
  has_table_privilege(role_name, 'public.company_team_invitations', 'DELETE') as can_delete
from unnest(array['anon','authenticated','service_role']) role_name;
select n.nspname, p.proname, p.prosecdef, p.proconfig,
  has_function_privilege('anon', p.oid, 'EXECUTE') as anonymous_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public','private') and p.proname in (
  'list_company_team_access','create_company_team_invite',
  'revoke_company_team_invite','accept_company_team_invite'
)
order by n.nspname, p.proname;
```

Expected: RLS true; every direct table permission false; eight functions, all empty `search_path`, only private implementations security-definer, anonymous/service execute false, authenticated execute true. Private helper functions must not have authenticated/anonymous execute.

Owner read-back after an authorized acceptance (fill placeholders privately):

```sql
select id, email_confirmed_at is not null as email_confirmed,
       not coalesce(is_anonymous, false) as nonanonymous,
       deleted_at is null as not_deleted,
       banned_until is null or banned_until <= now() as not_banned
from auth.users where id = '<RECIPIENT_AUTH_USER_ID>'::uuid;
select company_id, user_id, role, active, default_location_id
from public.company_memberships where user_id = '<RECIPIENT_AUTH_USER_ID>'::uuid;
select location_id from public.location_memberships
where company_id = '<EXISTING_COMPANY_ID>'::uuid
  and user_id = '<RECIPIENT_AUTH_USER_ID>'::uuid order by location_id;
select status, accepted_by, accepted_at, created_by, expires_at
from public.company_team_invitations where id = '<INVITATION_ID>'::uuid;
select action, actor_user_id, details, occurred_at from public.audit_events
where entity_type = 'company_team_invitation' and entity_id = '<INVITATION_ID>'::uuid
order by occurred_at;
```

Expected: all four account booleans true, exactly one active intended-company membership with reviewed role/default/scope, accepted invite and correct creator/recipient audit. Recipient email is matched against Auth, not editable profile metadata.

Before production sharing, run hosted tests with owner-approved **test accounts in a staging/test company**, not destructive changes to real employee records:

- Admin creates, copies, lists and revokes; all non-admin roles and other-company admins are denied managing that company's invitations. Direct table reads/writes and anonymous RPC calls are denied.
- Manual verified recipient accepts with matching email. An account created after invite issuance also works. Wrong email, altered role/tenant payload, unconfirmed/anonymous/banned/deleted user, signed-out/stale session, unknown/revoked/expired invitation are denied without revealing the intended recipient/company.
- Deactivating/demoting the test issuer, banning/deleting/unconfirming the issuer Auth identity, or deactivating a selected test location prevents acceptance. Signing the otherwise-valid issuer out alone does not cancel an invitation. Restore test fixtures through a reviewed process, not by modifying real company administrators.
- Existing inactive membership is not reactivated; another active company cannot be replaced. Duplicate pending invites fail. Retry after a lost response leaves one unchanged grant/audit; changed or removed access cannot be restored by replay.
- Use two independent database sessions/concurrent authenticated requests in the full integration environment to test same-invite acceptance, same-email creation and different-company invites for one user. Confirm no duplicate grants and safe retry after a serialization/deadlock failure. The embedded test harness does **not** prove multi-process concurrency.
- Confirm current frontend sign-in/recovery/record paths still work; verify desktop and tablet layout. Never treat synthetic browser or SQL fixture results as hosted proof.

Local evidence: `npm run test:team-access:db` executes the actual migration SQL, real baseline table definitions and existing membership integrity/audit trigger bodies in pinned PGlite PostgreSQL/WASM, with synthetic Auth users/session/JWT fixtures. Result: **20 passed, 0 failed**. It covers the new invitation privileges, scope, invalid identities/sessions, issuer state, replay, audit and rollback. The fixture does not replay all prior application RLS policies/grants and is not whole-system RLS proof. Full local Supabase Advisors and migration-list verification could not run: no local server on `127.0.0.1:54322`/Docker runtime. Hosted Auth, full-schema integration, platform advisors and two-session concurrency remain owner execution gates.

Execution record — leave pending until actually completed:

- Louie approval/operator: **pending**
- Approved commit / PR / migration checksum: **pending**
- Environment and execution UTC: **pending**
- Prerequisite/schema/advisor checks: **pending**
- Hosted positive, negative and concurrency checks: **pending**
- Frontend approved revision and live smoke test: **pending**
- First individual account and company access verified: **pending**
- Redacted result and rollback/recovery disposition: **pending**

## Rollback or forward recovery

Stop rollout if account identity, grants, authorization, schema checks or smoke tests differ from expected. Louie communicates the stop; no AI or merge applies a fallback.

Preferred containment preserves records. Return to the previously approved frontend, then Louie can run this exact transaction to disable **all four new entry points, including private implementations**, without deleting invitations/audit or affecting existing company members:

```sql
begin;
revoke execute on function public.list_company_team_access(uuid),
 public.create_company_team_invite(uuid,text,public.safetyops_role,uuid,uuid[]),
 public.revoke_company_team_invite(uuid), public.accept_company_team_invite(uuid)
 from public, anon, authenticated, service_role;
revoke execute on function private.list_company_team_access(uuid),
 private.create_company_team_invite(uuid,text,public.safetyops_role,uuid,uuid[]),
 private.revoke_company_team_invite(uuid), private.accept_company_team_invite(uuid)
 from public, anon, authenticated, service_role;
notify pgrst, 'reload schema';
commit;
```

Verify all eight functions are no longer executable by `authenticated`. Do not drop the invitation table or erase audit history. Disabling the feature does **not** remove already-granted company membership. If a specific erroneous grant needs revocation, separately identify the exact user/company, revoke that user's sessions through supported Auth administration, and deactivate only that reviewed membership through the owner-managed access-removal process. Do not delete Auth users or bulk-remove memberships as a rollback shortcut.

Forward recovery requires a new reviewed migration or exact correction, repeated hosted verification and Louie's approval before restoring only the original authenticated execution grants. Keep anonymous and service grants revoked. Database recovery restores are a last resort under the existing backup procedure; they can undo unrelated business work and are not implied by this change request.

## Documentation basis

Reviewed 2026-09-18: [Supabase changelog](https://supabase.com/changelog), [database function privileges and security](https://supabase.com/docs/guides/database/functions), [session identity and post-sign-out validation](https://supabase.com/docs/guides/auth/sessions), [administrator-created users](https://supabase.com/docs/reference/javascript/auth-admin-createuser), and [user management](https://supabase.com/docs/guides/auth/managing-user-data). No relevant breaking change requires altering this project's signup, SMTP, or Auth schema. Current Data API exposure changes reinforce the explicit no-table-grant design.
