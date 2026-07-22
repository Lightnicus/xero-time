# Operator runbooks

## Backup and restore

Confirm Atlas backup completion daily. For a drill, restore to a new non-production cluster, use isolated secrets/hostname, run index verification, compare record counts and a sample export lineage, then destroy the drill environment. Never point a preview at production during validation.

## Identity provider outage or compromised link

Disable Xero identity login/link/invite acceptance in Authentication Settings; email/password remains available. For a compromised link, deactivate the user or use the protected unlink/session actions, require a reason, review audit history, reset the password if needed, then explicitly relink after verifying the person. Xero logout is not attempted and accounting remains unchanged.

## Owner/password recovery

Use password reset through the verified sender. If the only owner's mailbox is inaccessible, keep the service protected, verify business authority out of band, restore a tested backup into an isolated environment if investigation is needed, and perform a separately reviewed database recovery procedure. Do not create an unaudited public bootstrap owner. Maintain a second active password-capable owner.

## Accounting secret, token, disconnect, or authorizer departure

Pause new exports and processing. Resolve `processing`, `reconciling`, `action-required`, or `manual-review` cases first. For token failure, use health/reconnect against the pinned tenant. For departure, use authorizer handover with password, reason, and exact same-tenant confirmation; the old grant remains until validation succeeds. For compromise, revoke remotely, protected-disconnect locally, rotate client/encryption material as applicable, and reconnect.

## Webhook failure

Keep the webhook endpoint deployed and key consistent with Xero. Inspect safe receipt counts, validate provider delivery, rotate a compromised key, then resume processing; receipts remain durable. Run status refresh for affected invoices. Never release entries solely from an event body.

## Stuck or duplicate-suspected export

Run the queue dispatcher and inspect the export/attempt timeline. A pre-send preparing/queued export may be cancelled or retried according to state. If a request may have been sent, keep entries reserved, run targeted reconciliation by InvoiceID/reference, and compare all material lines. Never issue a new POST merely because a request timed out. Accept a verified existing invoice or authorize a linked replacement only through the manual-resolution commands.

## Release and rebill

Refresh from Xero. Release the complete export only if the authoritative status is `DELETED` or `VOIDED`; the command checks Xero again before changing any time. Confirm all entries return to unbilled, then open the normal preselected rebill preview. Never edit original snapshots or release a draft/authorised/paid/inconclusive invoice.

## Safe pause and resume

`acceptingNewExports` stops new reservations; `processingEnabled` stops workers while preserving pending work; `waitForResultEnabled` disables synchronous waiting. Identity has separate flags. After remediation, verify connection/reference health, run the dispatcher/queue once, monitor old work, then reopen new exports.
