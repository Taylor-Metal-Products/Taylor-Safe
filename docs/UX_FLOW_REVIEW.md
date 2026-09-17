# SafetyOps user-flow review

Reviewed 2026-09-17 against the authenticated five-location manager experience, the current browser implementation, and the live Supabase tenant.

## Verdict

SafetyOps is a credible operational foundation, but it is not yet an end-to-end replacement for a SiteDocs-style safety workflow. The strongest complete paths are company sign-in, location-scoped records, employee setup, committee minutes, training assignment/completion when a course exists, employee form tablet handoff when an interactive form exists, private source-file review/download, and the location-specific OSHA reference.

The live tenant currently contains the company source archive but no published inspection templates, ready-to-use employee forms, training courses, controlled documents, inspections, incidents, actions, or committee meetings. The interface must therefore treat the archive as source material—not imply that those files are already operational forms.

## Path status

| User goal | Current destination | Status | Notes |
| --- | --- | --- | --- |
| Sign in and enter company workspace | Supabase Auth and tenant membership | Ready | Company and role are resolved server-side. |
| Switch among five locations | Persistent location selector | Ready | The selection now survives refreshes; global create flows require an explicit site. |
| Review company PDFs and source files | Company library → Forms → Source review | Ready | Folder/type/review filters, privacy scope, trace metadata, and authorized download are available. |
| Turn a source PDF into an operational form | Source review | Blocked | Review/download exists, but conversion, schema authoring, approval, applicability, and publication do not. This is the highest-priority product gap. |
| Run an inspection | Inspections | Conditional | Works only after a published current template with questions exists. The user chooses a template before starting. |
| Assign employee tablet form | Employee record or People | Conditional | Works only after a published, location-applicable interactive form exists. One-time handoff and retained receipt exist. |
| Assign and retain training | Training or employee record | Conditional | Assignment and completion receipts work when a published course exists. Course authoring/publication does not. |
| Record safety committee work | Safety committee | Ready | Draft minutes, attendees, decisions, linked actions, and finalization are supported. Attendees are no longer preselected. |
| Track corrective actions | Action items | Partial | Creation, owner, priority, and due date work. Evidence upload, completion, approval, and immutable closeout do not. |
| Report and investigate an incident | Incidents & near misses | Partial | Initial report and register work. Investigation ownership, evidence, causal analysis, and closeout do not. |
| Publish/read/acknowledge a controlled document | Policies & controlled documents | Blocked | Metadata can load, but there is no controlled reader/publication flow. Blind acknowledgement has been removed. |
| Upload or e-sign an employee PDF | Employee record | Partial | Prepare/upload/sign paths exist, but release remains dependent on the trusted malware-scanning service. |
| Trace requirements to OSHA | State OSHA reference | Partial | Oregon/Washington/California routing and source lineage exist. Location profile approval and provision-to-company-control mapping need an administrative workflow. |
| Search company content | Global search | Partial | People open directly and source-file results land in the matching Source review view. Other record types still land on their registers until record detail routes exist. |

## UX rules established by this review

1. An enabled control must perform a real operation or navigate to a real destination. Future work is shown as a status or prerequisite, not a clickable placeholder.
2. “Inspections” means operational, versioned checklists. “Company library” means source files, programs, and forms. These are separate stages of one lifecycle.
3. A source PDF is not a ready-to-use form. The intended lifecycle is `source review → convert/link template → applicability review → publish → assign/start → retain submission`.
4. Acknowledgement requires access to the exact version being acknowledged.
5. When the workspace is showing all locations, every create operation requires an explicit location choice.
6. Empty states explain the missing prerequisite and route to the closest real source material.

## Next implementation sequence

1. Build the controlled source-to-template promotion workflow. This unlocks inspection and employee-form use of the PDFs already in the tenant.
2. Add exact record detail routes for inspection submissions, incidents, actions, training receipts, and completed employee forms.
3. Complete the corrective-action and incident loops: evidence, status transitions, review, approval, and immutable closeout.
4. Add course authoring/publication and a controlled document reader with read-before-acknowledgement evidence.
5. Add location compliance-profile review and map each applicable provision to a company control and retained evidence.
6. Add employee/location administration: edit, deactivate, transfer, multi-location assignment, invitations, and credentials.

## Security observation

The live database audit found public execute access on 21 `SECURITY DEFINER` functions. Only the two one-time employee handoff functions are intended to be anonymous. The applied least-privilege migration now leaves only those two anonymous functions, preserves authenticated and service-role workflows, and hardens future default privileges.
