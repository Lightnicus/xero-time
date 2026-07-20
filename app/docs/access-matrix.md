# Access matrix

| Resource or command                  | Member                | Biller             | Admin                        | Owner                          | Machine                    |
| ------------------------------------ | --------------------- | ------------------ | ---------------------------- | ------------------------------ | -------------------------- |
| Own unbilled time create/edit/delete | Yes                   | No                 | Yes, reasoned correction     | Yes, reasoned correction       | Protected transition only  |
| Other users' time                    | No                    | Billing queue only | Read/correct unbilled        | Read/correct unbilled          | Scoped jobs                |
| Rates and financial snapshots        | No                    | Read in billing    | Manage                       | Manage                         | Resolve/snapshot           |
| Customers/projects                   | Active directory only | Read               | Manage/archive/map           | Manage/archive/map             | Mapping refresh only       |
| Billing queue/preview/export         | No                    | Yes                | Yes                          | Yes                            | Execute persisted jobs     |
| Xero invoice defaults                | No                    | Read setup status  | Select and update            | Select and update              | No                         |
| Release/rebill                       | No                    | No                 | Verified deleted/voided only | Verified deleted/voided only   | No autonomous release      |
| Payload Admin                        | No                    | No                 | Yes                          | Yes                            | N/A                        |
| Invitations/users                    | No                    | No                 | Non-owner roles              | All roles and owner transition | Cleanup only               |
| Own Xero identity/session            | Link/unlink/revoke    | Link/unlink/revoke | Link/unlink/revoke           | Link/unlink/revoke             | Validate/expire only       |
| Accounting connection/mapping        | No                    | No                 | Password-confirmed           | Password-confirmed             | Health/token/jobs only     |
| Audit events                         | No                    | No                 | Read                         | Read                           | Append only                |
| Tokens, state, hashes, raw payloads  | No                    | No                 | No                           | No                             | Narrow server-only service |

Collection and field access, custom route guards, command guards, and transaction contexts enforce this matrix. `overrideAccess: true` is permitted only inside an exact trusted workflow and never converts a UI role into authority.
