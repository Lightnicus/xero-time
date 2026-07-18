# User and operator guide

## Record time

Choose **Add time**, a project, and a complete description. For **Hours and minutes**, select the work date/timezone and whole values. For **Start and finish**, enter both local values; the form shows current UTC offset and calculated duration and rejects ambiguous/nonexistent DST times. Entries are completed work only—V1 has no timer. Change the profile timezone to alter future defaults; existing entries retain their snapshot.

Unbilled entries can be edited, duplicated, or deleted. Reserved/exported entries show why they are locked; privileged users can open the export. Owners/admins must supply an audit reason for corrections and deletion.

## Invitations and login

Open the single-use invitation link and choose email/password or, when enabled, Xero identity. Xero acceptance must use the invitation-bound flow and the same verified normalized email. Xero never assigns the role. Password reset remains available independently. In Profile, link/unlink Xero with recent password confirmation and manage local external sessions; unlinking does not disconnect business accounting.

## Customers, projects, and rates

Owners/admins create local customers/projects in Admin. Customer currency and project currency must match. Use Customer mappings to search/select by Xero ContactID, import a Xero contact, link a local customer, or explicitly create one. Mapping is never inferred from a name. Remapping requires reason/confirmation. A project rate change affects new entries; use Projects and rates to preview/confirm retrospective recalculation of unbilled snapshots only.

## Billing and export

Owners/admins/billers filter eligible and blocked time, select rows/page/all matching/all uninvoiced, and review exact counts/minutes/value/invoice groups. Preview always shows every one-entry/one-line description, quantity, rate, tax, total, dates, contact, currency, and reference. Confirmation rejects changed data.

Background returns after durable dispatch. **Wait for Xero** uses the same job and may continue in background. Export detail shows state/history and supports safe cancel, refresh, reconciliation, verified existing-invoice acceptance, or linked replacement. Mapping/configuration blockers must be corrected and previewed again.

Only owner/admin can release a remotely verified deleted/voided invoice. The full invoice's entries return to the normal queue and replacement preserves lineage.
