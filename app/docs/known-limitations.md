# V1 known limitations

- Single business and one pinned Xero organisation; no tenant migration workflow.
- Manual completed-time entry only; no timer, approvals, expenses, payroll, or timesheets.
- One project/customer currency; one draft invoice per ContactID/currency and one line per entry.
- Xero creation is draft-only. The application does not send/approve/pay invoices.
- Release is full-export only after authoritative deleted/voided verification.
- Account/tax/tracking configuration uses cached Xero identifiers and may require manual refresh.
- No implicit customer matching/contact creation and no automatic release from webhooks.
- Email deliverability, Atlas/Vercel provisioning, monitoring recipients, live Xero contract checks, and restore exercises are environment/operator responsibilities.
