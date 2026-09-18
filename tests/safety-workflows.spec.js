const { test, expect } = require("@playwright/test");
const {
  WORKSPACE_FIXTURE,
  configureAuthenticatedWorkspace
} = require("./helpers/authenticated-workspace");

const EMPLOYEE = WORKSPACE_FIXTURE.employees.unlinked;
const LOCATION = WORKSPACE_FIXTURE.locations[0];

async function openWorkspace(page, options = {}) {
  await configureAuthenticatedWorkspace(page, { programFixture: true, ...options });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
}

async function navigateTo(page, view, heading) {
  const control = page.locator(`[data-action="navigate"][data-view="${view}"]`).first();
  await expect(control).toHaveCount(1);
  await control.evaluate((element) => element.click());
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

async function openEmployeeRecord(page) {
  await navigateTo(page, "people", "Employees & credentials");
  const employeeRow = page.getByRole("row").filter({ hasText: EMPLOYEE.fullName });
  await employeeRow.getByRole("button", { name: "Open record" }).click();
  await expect(page.getByRole("dialog", { name: EMPLOYEE.fullName })).toBeVisible();
  return page.getByRole("dialog", { name: EMPLOYEE.fullName });
}

function fixturePdf(name) {
  return {
    name,
    mimeType: "application/pdf",
    buffer: Buffer.from(
      "%PDF-1.7\n1 0 obj\n<</Type /Catalog /Pages 2 0 R>>\nendobj\n"
      + "2 0 obj\n<</Type /Pages /Kids [3 0 R] /Count 1>>\nendobj\n"
      + "3 0 obj\n<</Type /Page /Parent 2 0 R>>\nendobj\n%%EOF\n"
    )
  };
}

function futureIsoDate(daysFromToday) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
}

test.beforeEach(async ({ page }, testInfo) => {
  await openWorkspace(page, {
    cleanEmployeeDocument: testInfo.title.includes("scanned-clean")
  });
});

test("committee notes create a traceable action with an employee owner", async ({ page }) => {
  await navigateTo(page, "committee", "Safety committee");
  await page.getByRole("button", { name: "New meeting" }).click();

  const meetingDialog = page.getByRole("dialog");
  await meetingDialog.getByLabel("Meeting title").fill("August safety committee");
  await meetingDialog.getByLabel("Location", { exact: true }).selectOption(LOCATION.id);
  await expect(meetingDialog.getByLabel("Department", { exact: true })).toHaveValue("Safety Committee");
  await meetingDialog.getByLabel("Department", { exact: true }).fill("Production safety committee");
  await meetingDialog.getByLabel("Meeting date").fill("2026-08-03");
  await meetingDialog.getByLabel("Time", { exact: true }).fill("09:30");
  await meetingDialog.getByLabel("Next meeting", { exact: true }).fill("2026-09-03");
  await expect(meetingDialog.getByLabel("Chair", { exact: true })).toHaveValue("");
  await meetingDialog.getByLabel("Chair", { exact: true }).selectOption(WORKSPACE_FIXTURE.employees.owner.id);
  const attendees = meetingDialog.getByLabel("Employees in attendance", { exact: true });
  await expect(attendees).toHaveAttribute("multiple", "");
  await expect(attendees).toHaveAttribute("required", "");
  expect(await attendees.locator("option:checked").count()).toBe(0);
  await attendees.selectOption([
    WORKSPACE_FIXTURE.employees.owner.id,
    EMPLOYEE.id
  ]);
  await expect(meetingDialog.getByLabel("Agenda", { exact: true })).toHaveCount(0);
  await meetingDialog.getByLabel("Subjects and topics discussed", { exact: true }).fill("The committee reviewed the press guarding observation.");
  await meetingDialog.getByLabel("Accidents / near misses", { exact: true }).fill("A cart passed close to the marked pedestrian aisle.");
  await meetingDialog.getByLabel("Employee suggestions, comments, or concerns", { exact: true }).fill("Add a mirror at the blind corner.");
  await meetingDialog.getByLabel("Discussion over concerns from previous meeting", { exact: true }).fill("The replacement aisle markings are complete.");
  await meetingDialog.getByLabel("Decisions / recommendations", { exact: true }).fill("Replace the damaged guard before the next production run.");
  await meetingDialog.getByRole("button", { name: "Save meeting notes" }).click();

  await expect(page.getByText("Committee notes saved", { exact: true })).toBeVisible();
  const meetingCard = page.locator(".meeting-card").filter({ hasText: "August safety committee" });
  await expect(meetingCard).toContainText("The committee reviewed the press guarding observation.");
  await meetingCard.getByRole("button", { name: "Add action" }).click();

  const actionDialog = page.getByRole("dialog");
  await actionDialog.getByLabel("Action").fill("Replace press guard");
  await actionDialog.getByLabel("Owner").selectOption(EMPLOYEE.id);
  await actionDialog.getByLabel("Priority").selectOption({ label: "High" });
  await actionDialog.getByLabel("Due date").fill(futureIsoDate(14));
  await actionDialog.getByRole("button", { name: "Create action" }).click();

  await expect(page.getByText("Corrective action created", { exact: true })).toBeVisible();
  await navigateTo(page, "committee", "Safety committee");
  await expect(meetingCard).toContainText("Replace press guard");
  await expect(meetingCard).toContainText(EMPLOYEE.fullName);
  await expect(meetingCard).toContainText("Safety task list");
  await expect(meetingCard).toContainText("Person taking care of this");
  await expect(meetingCard).toContainText("Possible actions");
  await expect(meetingCard).toContainText("Done / status");
  await meetingCard.getByRole("button", { name: "Finalize minutes" }).click();
  await expect(page.getByText("Committee minutes finalized", { exact: true })).toBeVisible();
  await expect(meetingCard).toContainText("Finalized");
  const traceability = meetingCard.locator("details").filter({ hasText: "Final minutes SHA-256" });
  await expect(traceability).toHaveCount(1);
  await expect(traceability).not.toHaveAttribute("open", "");
  await expect(traceability.locator("code")).not.toBeVisible();
  await traceability.locator("summary").click();
  await expect(traceability.locator("code")).toBeVisible();

  const evidence = await page.evaluate(() => ({
    meetingCall: window.__safetyOpsFakeDb.calls.find((call) => (
      call.method === "rpc" && call.name === "create_safety_committee_meeting"
    )),
    actionCall: window.__safetyOpsFakeDb.calls.find((call) => (
      call.method === "rpc" && call.name === "create_employee_corrective_action"
    )),
    finalizeCall: window.__safetyOpsFakeDb.calls.find((call) => (
      call.method === "rpc" && call.name === "finalize_safety_committee_meeting"
    )),
    meeting: window.__safetyOpsFakeDb.tables.safety_committee_meetings[0],
    action: window.__safetyOpsFakeDb.tables.corrective_actions[0]
  }));
  expect(evidence.meetingCall.payload).toMatchObject({
    target_location_id: LOCATION.id,
    target_meeting_date: "2026-08-03",
    target_chair_employee_id: WORKSPACE_FIXTURE.employees.owner.id,
    target_attendee_ids: expect.arrayContaining([WORKSPACE_FIXTURE.employees.owner.id, EMPLOYEE.id]),
    target_agenda: null,
    target_decisions: "Replace the damaged guard before the next production run."
  });
  expect(evidence.meetingCall.payload.target_attendee_ids).toHaveLength(2);
  for (const text of [
    "Department", "Production safety committee", "Time", "09:30", "Next meeting", "2026-09-03",
    "Subjects and topics discussed", "The committee reviewed the press guarding observation.",
    "Accidents / near misses", "A cart passed close to the marked pedestrian aisle.",
    "Employee suggestions, comments, or concerns", "Add a mirror at the blind corner.",
    "Discussion over concerns from previous meeting", "The replacement aisle markings are complete."
  ]) {
    expect(evidence.meetingCall.payload.target_notes).toContain(text);
  }
  expect(() => JSON.parse(evidence.meetingCall.payload.target_notes)).toThrow();
  // Next meeting is a retained planning reference, not a new scheduled event.
  expect(evidence.meetingCall.payload.target_next_meeting_at ?? null).toBeNull();
  expect(evidence.meeting.next_meeting_at).toBeNull();
  expect(evidence.meeting.notes).toBe(evidence.meetingCall.payload.target_notes);
  expect(evidence.actionCall.payload.target_employee_id).toBe(EMPLOYEE.id);
  expect(evidence.finalizeCall.payload.target_meeting_id).toBe(evidence.meeting.id);
  expect(evidence.meeting).toMatchObject({
    status: "finalized",
    minutes_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
  });
  expect(evidence.action).toMatchObject({
    source_type: "committee_meeting",
    source_id: evidence.meeting.id,
    committee_meeting_id: evidence.meeting.id,
    assigned_employee_id: EMPLOYEE.id,
    assigned_to: null
  });
});

test("committee template preserves entered text and line breaks after saved records reload", async ({ page }) => {
  await navigateTo(page, "committee", "Safety committee");
  await page.getByRole("button", { name: "New meeting" }).click();
  const dialog = page.getByRole("dialog");
  const topics = 'Review guards & pedestrian routes.\n<img src=x onerror="window.__committeeInjected = true">';
  const concerns = "Keep employee wording: <review required> & follow up.\nSecond concern on a separate line.";
  await dialog.getByLabel("Meeting title").fill("Template wording and line breaks");
  await dialog.getByLabel("Chair", { exact: true }).selectOption(WORKSPACE_FIXTURE.employees.owner.id);
  await dialog.getByLabel("Subjects and topics discussed", { exact: true }).fill(topics);
  await dialog.getByLabel("Employee suggestions, comments, or concerns", { exact: true }).fill(concerns);
  await dialog.getByLabel("Employees in attendance", { exact: true }).selectOption(WORKSPACE_FIXTURE.employees.owner.id);
  await dialog.getByRole("button", { name: "Save meeting notes" }).click();
  await expect(page.getByText("Committee notes saved", { exact: true })).toBeVisible();

  const savedTables = await page.evaluate(() => ({
    safety_committee_meetings: window.__safetyOpsFakeDb.tables.safety_committee_meetings,
    safety_committee_attendees: window.__safetyOpsFakeDb.tables.safety_committee_attendees
  }));
  const savedMeeting = savedTables.safety_committee_meetings[0];
  expect(savedMeeting.notes).toContain(topics);
  expect(savedMeeting.notes).toContain(concerns);
  // The test backend is memory-only. Re-seed its saved response to exercise the
  // application's reload/rehydration path without claiming hosted persistence.
  await configureAuthenticatedWorkspace(page, { programFixture: true, tableOverrides: savedTables });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Safety committee", exact: true })).toBeVisible();
  const card = page.locator(".meeting-card").filter({ hasText: "Template wording and line breaks" });
  const notes = card.locator("p").filter({ hasText: "Review guards & pedestrian routes." });
  expect(await notes.textContent()).toBe(savedMeeting.notes);
  expect(await notes.evaluate((element) => getComputedStyle(element).whiteSpace)).toMatch(/pre-wrap|pre-line|break-spaces/);
  await expect(card.locator("img, script")).toHaveCount(0);
  expect(await page.evaluate(() => window.__committeeInjected)).toBeUndefined();
});

test("blank optional committee sections are not fabricated as none or future meetings", async ({ page }) => {
  await navigateTo(page, "committee", "Safety committee");
  await page.getByRole("button", { name: "New meeting" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Meeting title").fill("Routine committee review");
  await dialog.getByLabel("Chair", { exact: true }).selectOption(WORKSPACE_FIXTURE.employees.owner.id);
  const topics = dialog.getByLabel("Subjects and topics discussed", { exact: true });
  await expect(topics).toHaveAttribute("required", "");
  for (const label of [
    "Time", "Next meeting", "Accidents / near misses",
    "Employee suggestions, comments, or concerns",
    "Discussion over concerns from previous meeting", "Decisions / recommendations"
  ]) {
    const field = dialog.getByLabel(label, { exact: true });
    await expect(field).toHaveValue("");
    await expect(field).not.toHaveAttribute("required", "");
  }
  await topics.fill("Reviewed safe pedestrian routes with the committee.");
  await dialog.getByLabel("Employees in attendance", { exact: true }).selectOption(WORKSPACE_FIXTURE.employees.owner.id);
  await dialog.getByRole("button", { name: "Save meeting notes" }).click();
  await expect(page.getByText("Committee notes saved", { exact: true })).toBeVisible();
  const evidence = await page.evaluate(() => ({
    calls: window.__safetyOpsFakeDb.calls.filter((call) => call.method === "rpc"),
    meetings: window.__safetyOpsFakeDb.tables.safety_committee_meetings
  }));
  expect(evidence.meetings).toHaveLength(1);
  expect(evidence.calls.map((call) => call.name)).toEqual(["create_safety_committee_meeting"]);
  expect(evidence.meetings[0]).toMatchObject({ agenda: null, decisions: null, next_meeting_at: null });
  expect(evidence.meetings[0].notes).toContain("Safety Committee");
  expect(evidence.meetings[0].notes).toContain("Reviewed safe pedestrian routes with the committee.");
  expect(evidence.meetings[0].notes).toContain("Accidents / near misses:\nNot recorded.");
  expect(evidence.meetings[0].notes).toContain("Employee suggestions, comments, or concerns:\nNot recorded.");
  expect(evidence.meetings[0].notes).toContain("Discussion over concerns from previous meeting:\nNot recorded.");
  expect(evidence.meetings[0].notes).not.toMatch(/\bNone\b|\bN\/A\b|No (accidents|near misses|concerns|suggestions)/i);
});

test("committee template rejects whitespace-only topics and department before creating a record", async ({ page }) => {
  await navigateTo(page, "committee", "Safety committee");
  await page.getByRole("button", { name: "New meeting" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Meeting title").fill("Committee validation check");
  await dialog.getByLabel("Chair", { exact: true }).selectOption(WORKSPACE_FIXTURE.employees.owner.id);
  await dialog.getByLabel("Employees in attendance", { exact: true }).selectOption(WORKSPACE_FIXTURE.employees.owner.id);
  for (const entry of [
    { department: "Safety Committee", notes: "    \n    " },
    { department: "    ", notes: "Valid discussion notes with a missing department." }
  ]) {
    await dialog.getByLabel("Department", { exact: true }).fill(entry.department);
    await dialog.getByLabel("Subjects and topics discussed", { exact: true }).fill(entry.notes);
    await dialog.getByRole("button", { name: "Save meeting notes" }).click();
    await expect(page.getByText("Meeting notes not saved", { exact: true }).last()).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => window.__safetyOpsFakeDb.calls.filter((call) => (
      call.method === "rpc" && call.name === "create_safety_committee_meeting"
    )))).toHaveLength(0);
    expect(await page.evaluate(() => window.__safetyOpsFakeDb.tables.safety_committee_meetings)).toHaveLength(0);
  }
});

test("committee chair must be explicitly confirmed as attending before saving", async ({ page }) => {
  await navigateTo(page, "committee", "Safety committee");
  await page.getByRole("button", { name: "New meeting" }).click();
  const dialog = page.getByRole("dialog");
  const chair = dialog.getByLabel("Chair", { exact: true });
  const attendees = dialog.getByLabel("Employees in attendance", { exact: true });
  await expect(chair).toHaveValue("");
  await expect(chair).toHaveAttribute("required", "");
  expect(await attendees.locator("option:checked").count()).toBe(0);
  await dialog.getByLabel("Meeting title").fill("Explicit chair attendance");
  await dialog.getByLabel("Subjects and topics discussed", { exact: true }).fill("Review only the employees confirmed to have attended.");
  await chair.selectOption(WORKSPACE_FIXTURE.employees.owner.id);
  await attendees.selectOption(EMPLOYEE.id);
  await dialog.getByRole("button", { name: "Save meeting notes" }).click();
  await expect(page.getByText("Select the meeting chair and include them in Employees in attendance.", { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.__safetyOpsFakeDb.calls.filter((call) => (
    call.method === "rpc" && call.name === "create_safety_committee_meeting"
  )))).toHaveLength(0);
  expect(await page.evaluate(() => window.__safetyOpsFakeDb.tables.safety_committee_meetings)).toHaveLength(0);

  // Correct the chair to the person actually selected as attending. The earlier
  // chair choice must not be silently added by the existing backend RPC.
  await chair.selectOption(EMPLOYEE.id);
  await dialog.getByRole("button", { name: "Save meeting notes" }).click();
  await expect(page.getByText("Committee notes saved", { exact: true })).toBeVisible();
  const evidence = await page.evaluate(() => ({
    call: window.__safetyOpsFakeDb.calls.find((call) => (
      call.method === "rpc" && call.name === "create_safety_committee_meeting"
    )),
    attendees: window.__safetyOpsFakeDb.tables.safety_committee_attendees
  }));
  expect(evidence.call.payload.target_chair_employee_id).toBe(EMPLOYEE.id);
  expect(evidence.call.payload.target_attendee_ids).toEqual([EMPLOYEE.id]);
  expect(evidence.attendees.map((attendee) => attendee.employee_id)).toEqual([EMPLOYEE.id]);
});

test("changing committee location clears attendance and chair without losing typed notes", async ({ page }) => {
  await navigateTo(page, "committee", "Safety committee");
  await page.getByRole("button", { name: "New meeting" }).click();
  const dialog = page.getByRole("dialog");
  const chair = dialog.getByLabel("Chair", { exact: true });
  const attendees = dialog.getByLabel("Employees in attendance", { exact: true });
  const topics = dialog.getByLabel("Subjects and topics discussed", { exact: true });
  const noteText = "Keep this discussion when correcting the meeting location.";
  await chair.selectOption(WORKSPACE_FIXTURE.employees.owner.id);
  await attendees.selectOption([WORKSPACE_FIXTURE.employees.owner.id, EMPLOYEE.id]);
  await topics.fill(noteText);

  // The second synthetic location has no employees; stale first-site selections
  // must disappear and saving must stay unavailable until valid people exist.
  await dialog.getByLabel("Location", { exact: true }).selectOption(WORKSPACE_FIXTURE.locations[1].id);
  await expect(chair).toHaveValue("");
  expect(await attendees.locator("option:checked").count()).toBe(0);
  await expect(chair).toBeDisabled();
  await expect(attendees).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Save meeting notes" })).toBeDisabled();
  await expect(topics).toHaveValue(noteText);

  await dialog.getByLabel("Location", { exact: true }).selectOption(LOCATION.id);
  await expect(chair).toBeEnabled();
  await expect(attendees).toBeEnabled();
  await expect(chair).toHaveValue("");
  expect(await attendees.locator("option:checked").count()).toBe(0);
  await expect(topics).toHaveValue(noteText);
  expect(await page.evaluate(() => window.__safetyOpsFakeDb.tables.safety_committee_meetings)).toHaveLength(0);
});

test("existing free-text committee notes remain intact under the familiar template layout", async ({ page }) => {
  const legacyNotes = "Earlier free-text minutes.\nDiscussion over concerns from previous meeting was captured in prose, not structured fields.\nKeep <original> wording & punctuation.";
  const legacyMeeting = {
    id: "90000000-0000-4000-8000-000000000901",
    company_id: WORKSPACE_FIXTURE.company.id,
    location_id: LOCATION.id,
    scope: "location",
    title: "Earlier committee record",
    meeting_date: "2026-07-01",
    status: "draft",
    chair_employee_id: WORKSPACE_FIXTURE.employees.owner.id,
    agenda: "Original agenda remains stored.",
    notes: legacyNotes,
    decisions: "Original decisions remain stored.",
    next_meeting_at: null,
    prepared_by: WORKSPACE_FIXTURE.user.id,
    finalized_by: null,
    finalized_at: null,
    minutes_sha256: null,
    created_at: "2026-07-01T16:00:00.000Z",
    updated_at: "2026-07-01T16:00:00.000Z",
    safety_committee_attendees: []
  };
  await configureAuthenticatedWorkspace(page, {
    programFixture: true,
    tableOverrides: { safety_committee_meetings: [legacyMeeting] }
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
  await navigateTo(page, "committee", "Safety committee");
  const card = page.locator(".meeting-card").filter({ hasText: legacyMeeting.title });
  expect(await card.locator("p").filter({ hasText: "Earlier free-text minutes." }).textContent()).toBe(legacyNotes);
  await expect(card).toContainText(legacyMeeting.decisions);
  const evidence = await page.evaluate(() => ({
    row: window.__safetyOpsFakeDb.tables.safety_committee_meetings[0],
    writes: window.__safetyOpsFakeDb.calls.filter((call) => call.method === "rpc")
  }));
  expect(evidence.row.notes).toBe(legacyNotes);
  expect(evidence.row.agenda).toBe(legacyMeeting.agenda);
  expect(evidence.writes).toHaveLength(0);
});

test("training assignment records completion and a retention date", async ({ page }) => {
  await navigateTo(page, "training", "Training");
  await page.getByRole("button", { name: "Assign training", exact: true }).click();

  const assignmentDialog = page.getByRole("dialog");
  await assignmentDialog.getByLabel("Course").selectOption(WORKSPACE_FIXTURE.course.id);
  await assignmentDialog.getByLabel("Location").selectOption(LOCATION.id);
  await assignmentDialog.getByLabel("Employee(s)").selectOption(EMPLOYEE.id);
  await assignmentDialog.getByLabel("Due date").fill(futureIsoDate(30));
  await assignmentDialog.getByLabel("Requirement reason").fill("Powered truck operator authorization");
  await assignmentDialog.getByLabel("Renewal cadence (months)").fill("12");
  await assignmentDialog.getByLabel("Retention (months)").fill("60");
  await assignmentDialog.getByLabel(/Regulatory \/ policy basis/).fill(
    "Oregon OSHA 437-002-0227\nCompany Powered Industrial Truck Program section 4.2"
  );
  await assignmentDialog.getByRole("button", { name: "Assign training", exact: true }).click();

  await expect(page.getByText("Training assigned", { exact: true })).toBeVisible();
  const assignmentRow = page.getByRole("row").filter({
    hasText: `${EMPLOYEE.fullName}`
  }).filter({ hasText: WORKSPACE_FIXTURE.course.name });
  await expect(assignmentRow).toContainText("Powered truck operator authorization");
  await assignmentRow.getByRole("button", { name: "Record completion" }).click();

  const completionDialog = page.getByRole("dialog");
  await completionDialog.getByLabel("Completed date").fill("2026-08-03");
  await completionDialog.getByLabel("Completion method").selectOption("instructor_led");
  await completionDialog.getByLabel("Instructor / evaluator").fill("Morgan Reed");
  await completionDialog.getByLabel("Quiz score").fill("96");
  await completionDialog.getByRole("button", { name: "Record completion" }).click();

  await expect(page.getByText("Training completion retained", { exact: true })).toBeVisible();
  await expect(assignmentRow).toContainText("Complete");
  await expect(assignmentRow).not.toContainText("Policy review required");

  const evidence = await page.evaluate(() => ({
    assignmentCall: window.__safetyOpsFakeDb.calls.find((call) => (
      call.method === "rpc" && call.name === "assign_training_requirements"
    )),
    completionCall: window.__safetyOpsFakeDb.calls.find((call) => (
      call.method === "rpc" && call.name === "record_training_completion"
    )),
    requirement: window.__safetyOpsFakeDb.tables.training_requirements[0],
    assignment: window.__safetyOpsFakeDb.tables.training_assignments[0],
    completion: window.__safetyOpsFakeDb.tables.training_completions[0]
  }));
  expect(evidence.assignmentCall.payload).toMatchObject({
    target_employee_ids: [EMPLOYEE.id],
    target_course_id: WORKSPACE_FIXTURE.course.id,
    target_location_id: LOCATION.id,
    target_cadence_months: 12,
    target_retention_months: 60,
    target_regulatory_basis: [
      {
        citation: "Oregon OSHA 437-002-0227",
        traceStatus: "review_required",
        capturedBy: "manual_assignment_entry"
      },
      {
        citation: "Company Powered Industrial Truck Program section 4.2",
        traceStatus: "review_required",
        capturedBy: "manual_assignment_entry"
      }
    ]
  });
  expect(evidence.completionCall.payload.target_completion_method).toBe("instructor_led");
  expect(evidence.requirement.regulatory_basis).toEqual(
    evidence.assignmentCall.payload.target_regulatory_basis
  );
  expect(evidence.assignment).toMatchObject({
    employee_id: EMPLOYEE.id,
    status: "complete",
    retention_status: "calculated"
  });
  expect(evidence.completion).toMatchObject({
    employee_id: EMPLOYEE.id,
    completion_method: "instructor_led",
    retention_status: "calculated",
    completion_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
  });
  expect(evidence.completion.requirement_snapshot.regulatoryBasis).toEqual(
    evidence.assignmentCall.payload.target_regulatory_basis
  );
  expect(evidence.completion.retain_until).toMatch(/^2031-/);
});

test("an assigned employee form is completed in a single-use anonymous tablet handoff", async ({ page, context }) => {
  let employeeDrawer = await openEmployeeRecord(page);
  await employeeDrawer.getByRole("button", { name: "Assign employee form" }).click();

  const assignmentDialog = page.getByRole("dialog");
  await assignmentDialog.getByLabel("Form template").selectOption(
    WORKSPACE_FIXTURE.program.formVersionId
  );
  await assignmentDialog.getByLabel("Due date").fill(futureIsoDate(14));
  await assignmentDialog.getByLabel("Instructions").fill(
    "Hand the tablet to the employee and have them complete every required field."
  );
  await assignmentDialog.getByRole("button", { name: "Assign form" }).click();

  await expect(page.getByText("Employee form assigned", { exact: true })).toBeVisible();
  await navigateTo(page, "dashboard", "Today");
  const employeeFormsMetric = page.locator(".metric-card").filter({ hasText: "Awaiting employee" });
  await expect(employeeFormsMetric.locator(".metric-value, strong").first()).toHaveText("1");

  employeeDrawer = await openEmployeeRecord(page);
  const assignment = employeeDrawer.locator(".employee-document-row").filter({
    hasText: "Test safety acknowledgement"
  });
  await expect(assignment).toContainText(/Assigned|In progress/);

  const handoffPagePromise = context.waitForEvent("page");
  await assignment.getByRole("button", { name: "Start tablet form" }).click();
  const handoffPage = await handoffPagePromise;
  await handoffPage.waitForLoadState("domcontentloaded");
  await expect(handoffPage.getByText("Employee form", { exact: true })).toBeVisible();
  await expect(handoffPage).toHaveTitle(/^Taylor Safe(?: ·|$)/);
  await expect(handoffPage.getByText("What Taylor Safe records", { exact: true })).toBeVisible();
  expect(await handoffPage.evaluate(() => window.opener)).toBeNull();
  expect(await handoffPage.evaluate(async () => {
    const client = window.supabase.createClient(
      window.SAFETYOPS_SUPABASE_URL,
      window.SAFETYOPS_SUPABASE_ANON_KEY
    );
    return (await client.auth.getSession()).data.session;
  })).toBeNull();

  const handoffToken = await page.evaluate(() => window.__safetyOpsLastHandoffToken);
  expect(handoffToken).toMatch(/^[a-f0-9]{64}$/i);

  const employeeNameField = handoffPage.getByLabel(/Employee name/);
  await expect(employeeNameField).toHaveAttribute("required", "");
  await employeeNameField.fill(EMPLOYEE.fullName);
  const requiredAcknowledgement = handoffPage.getByRole("checkbox", {
    name: /Worker acknowledgement|I acknowledge this statement/i
  });
  await expect(requiredAcknowledgement).toHaveAttribute("required", "");
  // The visual choice tile intentionally layers the native input over its label;
  // click the tile so Playwright exercises the same full-size touch target as a user.
  await requiredAcknowledgement.locator("..").click();
  await expect(requiredAcknowledgement).toBeChecked();
  await handoffPage.getByLabel("Typed employee name").fill(EMPLOYEE.fullName);
  await handoffPage.getByText("I confirm these answers are mine and complete.", { exact: true }).click();
  await handoffPage.getByText(
    "I intend my typed name to be my electronic signature for this completed form.",
    { exact: true }
  ).click();
  await expect(handoffPage.getByRole("checkbox")).toHaveCount(3);
  for (const checkbox of await handoffPage.getByRole("checkbox").all()) {
    await expect(checkbox).toBeChecked();
  }
  await handoffPage.getByRole("button", { name: "Submit completed form" }).click();

  await expect(handoffPage.getByText(/Employee form complete|form was (completed|submitted)/i).first()).toBeVisible();
  const replay = await handoffPage.evaluate(async (token) => {
    const client = window.supabase.createClient(
      window.SAFETYOPS_SUPABASE_URL,
      window.SAFETYOPS_SUPABASE_ANON_KEY
    );
    const result = await client.rpc("submit_employee_form_handoff", {
      target_token: token,
      target_answers: {
        employee_name: "Avery Chen",
        worker_acknowledgement: true
      },
      target_typed_name: "Avery Chen",
      target_consent_confirmed: true,
      target_employee_attestation: true
    });
    return { data: result.data, error: result.error?.message || null };
  }, handoffToken);
  expect(replay.data).toBeNull();
  expect(replay.error).toMatch(/invalid|expired|already used/i);

  await page.bringToFront();
  await page.reload();
  await expect(page.getByText(WORKSPACE_FIXTURE.company.name, { exact: true })).toBeVisible();
  await navigateTo(page, "dashboard", "Today");
  const refreshedEmployeeFormsMetric = page.locator(".metric-card").filter({ hasText: "Awaiting employee" });
  await expect(refreshedEmployeeFormsMetric.locator(".metric-value, strong").first()).toHaveText("0");

  const evidence = await page.evaluate(() => ({
    assignment: window.__safetyOpsFakeDb.tables.employee_form_assignments[0],
    submission: window.__safetyOpsFakeDb.tables.employee_form_submissions[0],
    handoff: window.__safetyOpsFakeDb.tables.employee_form_handoff_sessions[0],
    calls: window.__safetyOpsFakeDb.calls,
    sharedState: localStorage.getItem("safetyops.fake.employee-form-workflow.v1")
  }));
  expect(evidence.assignment).toMatchObject({
    employee_id: EMPLOYEE.id,
    status: "completed",
    completed_at: expect.any(String)
  });
  expect(evidence.submission).toMatchObject({
    employee_id: EMPLOYEE.id,
    answers: {
      employee_name: EMPLOYEE.fullName,
      worker_acknowledgement: true
    },
    employee_name_snapshot: EMPLOYEE.fullName,
    facilitator_user_id: WORKSPACE_FIXTURE.user.id,
    employee_attestation: "I confirm these answers are mine and complete.",
    submission_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
  });
  expect(evidence.handoff).toMatchObject({
    status: "consumed",
    token_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    consumed_at: expect.any(String)
  });
  expect(evidence.handoff.token_sha256).not.toBe(handoffToken);
  expect(evidence.sharedState).not.toContain(handoffToken);
  expect(evidence.calls.some((call) => (
    call.method === "rpc" && call.name === "begin_employee_form_handoff"
  ))).toBe(true);
  expect(evidence.calls.filter((call) => (
    call.method === "rpc" && call.name === "submit_employee_form_handoff"
  ))).toHaveLength(2);
});

test("a safety user facilitates tablet signing of a scanned-clean employee PDF", async ({ page }) => {
  let employeeDrawer = await openEmployeeRecord(page);
  await navigateTo(page, "dashboard", "Today");
  const employeeFormsMetric = page.locator(".metric-card").filter({ hasText: "Awaiting employee" });
  await expect(employeeFormsMetric.locator(".metric-value, strong").first()).toHaveText("1");

  employeeDrawer = await openEmployeeRecord(page);
  let acknowledgement = employeeDrawer.locator(".employee-document-row").filter({
    hasText: WORKSPACE_FIXTURE.employeeDocument.title
  });
  await expect(acknowledgement).toContainText(/Awaiting signature/i);
  await expect(acknowledgement).not.toContainText("malware scanning is not configured");
  await acknowledgement.getByRole("button", { name: "Review & sign" }).click();

  const signDialog = page.getByRole("dialog");
  await signDialog.getByLabel("Typed employee name").fill(EMPLOYEE.fullName);
  await signDialog.getByLabel(/reviewed.*electronic acknowledgement/i).check();
  await signDialog.getByLabel(/employee is present/i).check();
  await signDialog.getByRole("button", { name: "Complete acknowledgement" }).click();

  await expect(page.getByText("Employee acknowledgement retained", { exact: true })).toBeVisible();
  employeeDrawer = await openEmployeeRecord(page);
  acknowledgement = employeeDrawer.locator(".employee-document-row").filter({
    hasText: WORKSPACE_FIXTURE.employeeDocument.title
  });
  await expect(acknowledgement).toContainText("Signed");
  await navigateTo(page, "dashboard", "Today");
  await expect(employeeFormsMetric.locator(".metric-value, strong").first()).toHaveText("0");

  const evidence = await page.evaluate(() => ({
    calls: window.__safetyOpsFakeDb.calls,
    documents: window.__safetyOpsFakeDb.tables.employee_documents,
    signatures: window.__safetyOpsFakeDb.tables.employee_document_signatures
  }));
  expect(evidence.calls.some((call) => (
    call.method === "rpc" && call.name === "sign_employee_document"
  ))).toBe(true);
  expect(evidence.documents).toHaveLength(1);
  expect(evidence.documents[0]).toMatchObject({
    id: WORKSPACE_FIXTURE.employeeDocument.id,
    status: "signed",
    malware_scan_status: "clean",
    document_sha256: WORKSPACE_FIXTURE.employeeDocument.sha256
  });
  expect(evidence.signatures).toHaveLength(1);
  expect(evidence.signatures[0]).toMatchObject({
    employee_id: EMPLOYEE.id,
    authenticated_actor_user_id: WORKSPACE_FIXTURE.user.id,
    facilitator_user_id: WORKSPACE_FIXTURE.user.id,
    signature_method: "facilitated_in_person_typed_ack",
    identity_verification_method: "in_person_facilitator_attestation",
    signer_name_snapshot: EMPLOYEE.fullName,
    signed_source_sha256: WORKSPACE_FIXTURE.employeeDocument.sha256,
    signature_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
  });
});

test("new employee PDF uploads stay quarantined until malware scanning is clean", async ({ page }) => {
  let employeeDrawer = await openEmployeeRecord(page);
  await employeeDrawer.getByRole("button", { name: /Request (PDF acknowledgement|e-signature)/ }).click();

  let documentDialog = page.getByRole("dialog");
  await documentDialog.getByLabel("PDF").setInputFiles(fixturePdf("lockout-acknowledgement.pdf"));
  await documentDialog.getByLabel("Document title").fill("Lockout tagout acknowledgement");
  await documentDialog.getByLabel("Signature due date").fill(futureIsoDate(14));
  await documentDialog.getByLabel("Retention (months)").fill("60");
  await documentDialog.getByLabel("Signature intent").fill(
    "I acknowledge that I received and reviewed this lockout tagout instruction."
  );
  await documentDialog.getByRole("button", { name: "Prepare secure upload" }).click();

  await expect(page.getByText("PDF quarantined for security review", { exact: true })).toBeVisible();
  employeeDrawer = page.getByRole("dialog", { name: EMPLOYEE.fullName });
  const acknowledgement = employeeDrawer.locator(".employee-document-row").filter({
    hasText: "Lockout tagout acknowledgement"
  });
  await expect(acknowledgement).toContainText(/Upload pending/i);
  await expect(acknowledgement).toContainText("malware scanning is not configured");
  await expect(acknowledgement.getByRole("button", { name: "Review & sign" })).toHaveCount(0);
  await expect(acknowledgement.getByRole("button", { name: "Download" })).toHaveCount(0);

  await employeeDrawer.getByRole("button", { name: "Upload signed PDF" }).click();
  documentDialog = page.getByRole("dialog");
  await documentDialog.getByLabel("PDF").setInputFiles(fixturePdf("signed-toolbox-talk.pdf"));
  await documentDialog.getByLabel("Document title").fill("Signed toolbox talk acknowledgement");
  await documentDialog.getByLabel("Retention (months)").fill("60");
  await documentDialog.getByRole("button", { name: "Prepare secure upload" }).click();

  await expect(page.getByText("PDF quarantined for security review", { exact: true })).toBeVisible();
  employeeDrawer = page.getByRole("dialog", { name: EMPLOYEE.fullName });
  const signedUpload = employeeDrawer.locator(".employee-document-row").filter({
    hasText: "Signed toolbox talk acknowledgement"
  });
  await expect(signedUpload).toContainText(/Upload pending/i);
  await expect(signedUpload).toContainText("malware scanning is not configured");
  await expect(signedUpload.getByRole("button", { name: "Download" })).toHaveCount(0);

  const evidence = await page.evaluate(() => ({
    calls: window.__safetyOpsFakeDb.calls,
    documents: window.__safetyOpsFakeDb.tables.employee_documents,
    signatures: window.__safetyOpsFakeDb.tables.employee_document_signatures
  }));
  expect(evidence.calls.filter((call) => (
    call.method === "function"
      && call.name === "employee-document-file"
      && call.options.body.action === "prepare"
  ))).toHaveLength(2);
  expect(evidence.calls.filter((call) => call.method === "uploadToSignedUrl")).toHaveLength(2);
  expect(evidence.calls.filter((call) => (
    call.method === "function"
      && call.name === "employee-document-file"
      && call.options.body.action === "complete"
  ))).toHaveLength(2);
  expect(evidence.documents).toHaveLength(2);
  expect(evidence.documents.every((item) => (
    item.status === "upload_pending"
      && item.validation_status === "format_verified"
      && item.malware_scan_status === "unavailable"
  ))).toBe(true);
  expect(evidence.signatures).toHaveLength(0);
});
