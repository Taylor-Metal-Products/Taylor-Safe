# Safety calendar

Implemented 2026-09-17. The layout follows the familiar month, week, and schedule
patterns described in [Google Calendar Help](https://support.google.com/calendar/answer/6110849?co=GENIE.Platform%3DDesktop&hl=en),
using SafetyOps styling and records. It does not connect to a Google account.

## User flow

Calendar is available in the main sidebar and mobile navigation. Desktop starts
in Month; phones start in Agenda. Today, previous/next period, and Go to date
control the visible period. Week shows seven dated activity columns; Agenda
lists the current month's dated work. A selected day exposes every matching
event, including entries hidden behind the month grid's “more” control.

Location, employee, activity type, and status filters combine. Committee employee
filtering includes both the chair and attendees. Completed/resolved items retain
their source status and remain on their original date. Undated records stay in
their existing registers. Company-wide meetings are included in each location
view as well as All locations, and are explicitly labeled Company-wide.

Selecting an event opens its actual record details. Open record takes the user
to the exact training, action, meeting, or inspection row and focuses it. Employee
forms and signature requests open the employee record at the matching item.
Training completion remains available to authorized managers from its detail.

Add activity opens the existing committee, corrective-action, training,
employee-form, or document-signature workflow. It carries the selected date into that workflow and
returns to the calendar after a successful save. Existing publication,
location, employee, and role prerequisites still apply. The committee path
records meeting notes; it is not a separate meeting invitation service.

## Source contract

| Activity | Source date | Employee filter |
| --- | --- | --- |
| Training | Assignment due_at | Assigned employee |
| Committee | meeting_date | Chair and attendees |
| Action item | due_at | Assigned employee, or linked assigned user |
| Employee form | due_at | Assigned employee |
| Inspection | scheduled_for | None: inspection creator is not an assignee |
| Document signature | signature_due_at for signature_request only | Assigned employee |

There is no duplicate calendar database or independently editable event copy.
The calendar derives from the existing authorized workspace records. It inherits
the existing collection query limits; it is not an exhaustive paginated history
view. A visible incomplete-calendar notice appears when a calendar source reaches
its query limit. No database migration or additional anonymous access is required.

## Dates and interaction

- A date-only meeting value is preserved as a literal date, not shifted from UTC.
- Timestamp dates use the source location's IANA time zone. The all-location view
  identifies this convention; scheduled inspections show time and zone and sort
  chronologically after the date's all-day work.
- Newly created training, action, form, and signature deadlines are converted to
  the selected facility's end of day, including daylight-saving offsets.
- Source-register deadline labels use the same location zone as the calendar.
- Month arithmetic clamps month-end dates and uses UTC day arithmetic to avoid
  daylight-saving drift in calendar navigation.
- Keyboard event dialogs contain focus, close with Escape, and restore focus to
  the original event. Navigation alone creates no database records.

## Verification and limits

Calendar browser tests cover six real record types with synthetic fixtures,
combined filtering, attendee matching, prior-year/undated exclusions, month-end
and year navigation, crowded days, record links, selected-date creation, auditor
controls, company-wide meetings, chronological inspection times, required form
and signature deadlines, nested-dialog keyboard focus, responsive overflow, and
a UTC browser creating Pacific deadlines across the November daylight-saving
transition.

These are browser-contract tests, not additional proof of database RLS or hosted
record creation. No company example events are seeded. Invitations, reminders,
recurrence, arbitrary appointments, Google synchronization, drag-to-reschedule,
and hourly time-slot scheduling are outside this first calendar release.
