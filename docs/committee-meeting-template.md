# Familiar safety committee meeting sheet

## Scope

The committee entry screen follows the headings and order of the existing company
meeting-notes sheet, reviewed read-only on 2026-09-18. The original source stays
private and unchanged; no source workbook, location roster, or Drive identifier
is embedded in the public application.

The form captures location, department, meeting date, local meeting time, next
meeting reference, and employees in attendance. Its discussion sections are:

1. Subjects and topics discussed
2. Accidents / near misses
3. Employee suggestions, comments, or concerns
4. Discussion over concerns from previous meeting

Meeting title and chair remain explicit application fields. Decisions /
recommendations remain an additional optional field so existing functionality is
not lost. The form requires explicit chair and attendee selection, including the
chair in attendance. This prevents the existing RPC's automatic chair-attendee
insertion from adding an unconfirmed attendee through this form. It does not
change server-side validation for other clients.

## Compatibility and traceability

**No Supabase migration, configuration, Auth, Storage, or hosted data operation is
required or performed by this change.**

The existing `create_safety_committee_meeting` RPC remains the only meeting-create
operation. Location, title, date, chair, and attendees retain their existing
parameters. The new template sections and metadata are serialized as labeled,
human-readable paragraphs in `target_notes`. Decisions use `target_decisions`.
New meetings send a null agenda; old agendas and free-text notes remain stored
unchanged and readable. The browser does not parse or rewrite prior minutes.

Blank optional sections are labeled `Not recorded.` rather than asserted as no
accidents or no concerns. Users can explicitly record `None reported` themselves.
Department and meaningful discussion text are required.

Meeting time is retained as local wall-clock text. Next meeting is retained as a
date-only planning reference in the notes, not converted to an invented timestamp
or used to schedule another meeting. `target_next_meeting_at` remains null for
this form. The interface states this limitation beside the field.

The saved minutes display preserves line breaks and escapes user text. Existing
finalization continues to include the complete notes in the server-owned minutes
manifest; record-verification details remain accessible in a collapsed disclosure.
This UI test coverage does not prove hosted RPC, hash, or authorization behavior.

## Separate safety task list

After saving notes, use **Add action** to create a linked corrective action with
its owner and due date. Meeting cards show familiar task-list labels: possible
actions, person taking care of this, due date, and done / status. Status is the
existing action state, not an unconnected checkbox. No completed task, employee
training, or attendance is inferred from the text.

## Boundaries and release

- Saved draft-note editing, transcription, recording, document import, automatic
  carry-forward, new reminders, and action closeout are not introduced here.
  The form discloses that saved notes cannot yet be edited.
- Existing location authorization and immutable finalized-minute rules are
  unchanged. No private company records are written during validation.
- Backend-dependent improvements require a separate proposed change request for
  Louie, following `DEVELOPMENT_HANDOFF.md`.
- This source change requires fresh owner release approval/attestation before
  deployment. The existing attestation does not cover this candidate. Company
  Pages remains disabled; no hostname or Supabase cutover is part of this change.
- Frontend rollback needs no data reversal: the preceding frontend can read the
  same plain-text notes and decisions. Preserve saved records and their hashes.
