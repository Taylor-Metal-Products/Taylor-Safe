const { test, expect } = require("@playwright/test");
const { AUTH_USER, WORKSPACE_FIXTURE, configureAuthenticatedWorkspace } = require("./helpers/authenticated-workspace");

const INVITE_ID = "b0000000-0000-4000-8000-000000000001";
const INVITEE_EMAIL = "new.teammate@example.test";
const LOCATIONS = WORKSPACE_FIXTURE.locations;

async function openSettings(page, options = {}) {
  await configureAuthenticatedWorkspace(page, { teamAccess: true, ...options });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await page.locator('[data-action="navigate"][data-view="settings"]').first().evaluate((element) => element.click());
  await expect(page.getByRole("heading", { name: "Workspace settings", exact: true })).toBeVisible();
}

async function openTeamAccess(page, options = {}) {
  await openSettings(page, options);
  await page.getByRole("button", { name: "Manage team access", exact: true }).click();
  await expect(page.locator("#team-invite-form")).toBeVisible();
  return page.locator("#team-invite-form");
}

async function callsNamed(page, name) {
  return page.evaluate((rpcName) => window.__safetyOpsFakeDb.calls.filter((call) => call.name === rpcName), name);
}

async function openJoin(page, options = {}) {
  await configureAuthenticatedWorkspace(page, { teamAccess: true, noMembership: true, ...options });
  await page.goto(`/?join=${INVITE_ID}`);
}

async function expectNoAutomaticAccountOrEmail(page) {
  expect(await page.evaluate(() => window.__safetyOpsFakeDb.calls.filter((call) =>
    ["signUp", "resetPassword", "inviteUserByEmail", "function"].includes(call.method)
  ))).toEqual([]);
}

test("administrator creates a company invitation without creating an account or sending email", async ({ page }) => {
  const form = await openTeamAccess(page);
  await expect(form.getByLabel("Role", { exact: true })).toHaveValue("safety_manager");
  await expect(form.getByLabel("Role", { exact: true }).locator('option[value="corporate_admin"]')).toHaveCount(0);
  await form.getByLabel("Email", { exact: true }).fill(INVITEE_EMAIL);
  await form.getByLabel("Default location", { exact: true }).selectOption(LOCATIONS[1].id);
  await form.getByRole("button", { name: "Create invitation", exact: true }).click();
  await expect.poll(() => callsNamed(page, "create_company_team_invite")).toHaveLength(1);
  const [created] = await callsNamed(page, "create_company_team_invite");
  expect(created.payload).toEqual({
    target_company_id: WORKSPACE_FIXTURE.company.id,
    target_email: INVITEE_EMAIL,
    target_role: "safety_manager",
    target_default_location_id: LOCATIONS[1].id,
    target_location_ids: LOCATIONS.map((location) => location.id)
  });
  await expect(page.getByText(INVITEE_EMAIL, { exact: true })).toBeVisible();
  await expect(page.getByText(/no email is sent|email is not sent|does not send email/i).first()).toBeVisible();
  await expectNoAutomaticAccountOrEmail(page);
});

test("copy invitation remains available when clipboard permission is denied", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("Permission denied", "NotAllowedError"); } }
    });
  });
  await openTeamAccess(page);
  await page.getByRole("button", { name: "Copy invite", exact: true }).first().click();
  const copyText = page.getByLabel("Copyable invitation", { exact: true });
  await expect(copyText).toBeVisible();
  await expect(copyText).toHaveAttribute("readonly", "");
  const invitation = await copyText.inputValue();
  expect(invitation).toContain(AUTH_USER.email);
  expect(invitation).toContain(`?join=${INVITE_ID}`);
  expect(invitation).not.toMatch(/password\s*[:=]|access_token|refresh_token|service_role/i);
  expect(invitation).not.toMatch(/invitation (?:email )?(?:was |has been )?sent/i);
  await expectNoAutomaticAccountOrEmail(page);
});

test("administrator can revoke a pending invitation and cannot copy it afterward", async ({ page }) => {
  await openTeamAccess(page);
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Revoke invitation", exact: true }).first().click();
  await expect.poll(() => callsNamed(page, "revoke_company_team_invite")).toHaveLength(1);
  expect((await callsNamed(page, "revoke_company_team_invite"))[0].payload).toEqual({ target_invite_id: INVITE_ID });
  await expect(page.getByRole("button", { name: "Copy invite", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Revoke invitation", exact: true })).toHaveCount(0);
  await expect(page.locator(".team-invitation")).toContainText("Revoked");
});

test("scoped invitations retain the draft while changing role and limit location access", async ({ page }) => {
  const form = await openTeamAccess(page);
  await form.getByLabel("Email", { exact: true }).fill(INVITEE_EMAIL);
  await form.getByLabel("Role", { exact: true }).selectOption("worker");
  await expect(form.getByLabel("Email", { exact: true })).toHaveValue(INVITEE_EMAIL);
  for (const location of LOCATIONS) {
    await form.getByRole("checkbox", { name: location.name, exact: true }).uncheck();
  }
  await form.getByRole("checkbox", { name: LOCATIONS[1].name, exact: true }).check();
  await form.getByLabel("Default location", { exact: true }).selectOption(LOCATIONS[1].id);
  await form.getByRole("button", { name: "Create invitation", exact: true }).click();
  await expect.poll(() => callsNamed(page, "create_company_team_invite")).toHaveLength(1);
  expect((await callsNamed(page, "create_company_team_invite"))[0].payload).toMatchObject({
    target_email: INVITEE_EMAIL,
    target_role: "worker",
    target_default_location_id: LOCATIONS[1].id,
    target_location_ids: [LOCATIONS[1].id]
  });
});

test("scoped invitation cannot be submitted without an authorized default location", async ({ page }) => {
  const form = await openTeamAccess(page);
  await form.getByLabel("Email", { exact: true }).fill(INVITEE_EMAIL);
  await form.getByLabel("Role", { exact: true }).selectOption("worker");
  for (const location of LOCATIONS) {
    await form.getByRole("checkbox", { name: location.name, exact: true }).uncheck();
  }
  await form.getByRole("button", { name: "Create invitation", exact: true }).click();
  await expect(form).toBeVisible();
  expect(await callsNamed(page, "create_company_team_invite")).toHaveLength(0);
});

test("missing team-access backend leaves the rest of the workspace usable", async ({ page }) => {
  await openSettings(page, { teamAccessUnavailable: true });
  await page.getByRole("button", { name: "Manage team access", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Team access setup required", exact: true })).toBeVisible();
  const create = page.getByRole("button", { name: "Create invitation", exact: true });
  if (await create.count()) await expect(create).toBeDisabled();
  await page.locator('[data-action="navigate"][data-view="dashboard"]').first().evaluate((element) => element.click());
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  expect(await callsNamed(page, "create_company_team_invite")).toHaveLength(0);
});

for (const role of ["safety_manager", "worker"]) {
  test(`${role} cannot manage company invitations`, async ({ page }) => {
    await openSettings(page, { role });
    await expect(page.getByRole("button", { name: "Manage team access", exact: true })).toHaveCount(0);
    await expect(page.locator("#team-invite-form")).toHaveCount(0);
    expect(await callsNamed(page, "list_company_team_access")).toHaveLength(0);
  });
}

test("signed-out invitation uses an existing account and never enables public signup", async ({ page }) => {
  await openJoin(page, { signedOut: true });
  await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Create account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create secure account" })).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill(AUTH_USER.email);
  await page.getByLabel("Password", { exact: true }).fill("Fixture!8");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Join your company", exact: true })).toBeVisible();
  expect(await callsNamed(page, "accept_company_team_invite")).toHaveLength(0);
  await expectNoAutomaticAccountOrEmail(page);
});

test("an authenticated invitation requires explicit acceptance before loading company records", async ({ page }) => {
  await openJoin(page);
  await expect(page.getByRole("heading", { name: "Join your company", exact: true })).toBeVisible();
  expect(await callsNamed(page, "accept_company_team_invite")).toHaveLength(0);
  expect(await page.evaluate(() => window.__safetyOpsFakeDb.calls.filter((call) => call.method === "from"))).toEqual([]);
  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  expect((await callsNamed(page, "accept_company_team_invite"))[0].payload).toEqual({ target_invite_id: INVITE_ID });
  expect(new URL(page.url()).searchParams.has("join")).toBe(false);
  await expectNoAutomaticAccountOrEmail(page);
});

test("continuing without invitation does not join or change membership", async ({ page }) => {
  await openJoin(page, { noMembership: false });
  await expect(page.getByRole("heading", { name: "Join your company", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue without invitation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  expect(await callsNamed(page, "accept_company_team_invite")).toHaveLength(0);
  expect(new URL(page.url()).searchParams.has("join")).toBe(false);
});

for (const failure of ["expired", "revoked", "wrong-email"]) {
  test(`${failure} invitation failure stays generic and allows retry without company data`, async ({ page }) => {
    await openJoin(page, { teamAcceptError: `${failure}: secret-account@example.test internal policy detail` });
    await expect(page.getByRole("heading", { name: "Join your company", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect.poll(() => callsNamed(page, "accept_company_team_invite")).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Accept invitation", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("secret-account@example.test");
    await expect(page.locator("body")).not.toContainText("internal policy detail");
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.__safetyOpsFakeDb.calls.filter((call) => call.method === "from"))).toEqual([]);
    await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
    await expect.poll(() => callsNamed(page, "accept_company_team_invite")).toHaveLength(2);
  });
}

test("malformed invitation IDs never trigger acceptance or expose public signup", async ({ page }) => {
  await configureAuthenticatedWorkspace(page, { teamAccess: true, signedOut: true });
  await page.goto("/?join=not-a-uuid");
  await expect(page.getByText(/^Invalid invitation link/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept invitation", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Create account" })).toHaveCount(0);
  expect(await callsNamed(page, "accept_company_team_invite")).toHaveLength(0);
});

test("a delayed team list cannot restore private data after sign out", async ({ page }) => {
  await openSettings(page, { delayTeamList: true });
  await page.getByRole("button", { name: "Manage team access", exact: true }).click();
  await expect.poll(() => callsNamed(page, "list_company_team_access")).toHaveLength(1);
  await page.evaluate(async () => {
    await window.__emitSafetyOpsAuthState("SIGNED_OUT", null);
    window.__resolveSafetyOpsTeamList();
  });
  await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
  await expect(page.locator("#team-invite-form")).toHaveCount(0);
  await expect(page.getByText(AUTH_USER.email, { exact: true })).toHaveCount(0);
});

test("a delayed successful acceptance cannot reopen workspace after sign out", async ({ page }) => {
  await openJoin(page, { delayTeamAccept: true });
  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await expect.poll(() => callsNamed(page, "accept_company_team_invite")).toHaveLength(1);
  await page.evaluate(async () => {
    await window.__emitSafetyOpsAuthState("SIGNED_OUT", null);
    window.__resolveSafetyOpsTeamAccept();
  });
  await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toHaveCount(0);
  await expect(page.getByText(AUTH_USER.email, { exact: true })).toHaveCount(0);
});

test("password recovery takes priority over a company invitation without accepting it", async ({ page }) => {
  await openJoin(page);
  await expect(page.getByRole("heading", { name: "Join your company", exact: true })).toBeVisible();
  await page.evaluate((user) => window.__emitSafetyOpsAuthState("PASSWORD_RECOVERY", { user }), {
    ...AUTH_USER,
    email_confirmed_at: "2026-07-30T16:00:00.000Z"
  });
  await expect(page.getByRole("heading", { name: "Choose a new password", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept invitation", exact: true })).toHaveCount(0);
  await page.getByLabel("New password", { exact: true }).fill("Fixture!8");
  await page.getByLabel("Confirm new password", { exact: true }).fill("Fixture!8");
  await page.getByRole("button", { name: "Set password and continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Join your company", exact: true })).toBeVisible();
  expect(await callsNamed(page, "accept_company_team_invite")).toHaveLength(0);
  expect(new URL(page.url()).searchParams.get("join")).toBe(INVITE_ID);
});

test("an old acceptance response cannot replace a different signed-in user", async ({ page }) => {
  await openJoin(page, { delayTeamAccept: true });
  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await expect.poll(() => callsNamed(page, "accept_company_team_invite")).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Joining…", exact: true })).toBeDisabled();
  const nextUser = {
    id: "00000000-0000-4000-8000-000000000099",
    email: "different.person@example.test",
    email_confirmed_at: "2026-07-30T16:00:00.000Z",
    user_metadata: { full_name: "Different Person" }
  };
  await page.evaluate(async (user) => {
    await window.__emitSafetyOpsAuthState("SIGNED_IN", { user });
    window.__resolveSafetyOpsTeamAccept();
  }, nextUser);
  await expect(page.getByRole("heading", { name: "Join your company", exact: true })).toBeVisible();
  await expect(page.locator(".auth-card")).toContainText(nextUser.email);
  await expect(page.locator(".auth-card")).not.toContainText(AUTH_USER.email);
  await expect(page.getByRole("button", { name: "Accept invitation", exact: true })).toBeEnabled();
  expect(new URL(page.url()).searchParams.get("join")).toBe(INVITE_ID);
  expect(await page.evaluate(() => window.__safetyOpsFakeDb.calls.filter((call) => call.method === "from"))).toEqual([]);
});
