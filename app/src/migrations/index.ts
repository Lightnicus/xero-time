import * as migration_20260718_001700_application_indexes from './20260718_001700_application_indexes'
import * as migration_20260720_120000_customer_invoice_references from './20260720_120000_customer_invoice_references'

export const migrations = [
  {
    down: migration_20260718_001700_application_indexes.down,
    name: '20260718_001700_application_indexes',
    up: migration_20260718_001700_application_indexes.up,
  },
  {
    down: migration_20260720_120000_customer_invoice_references.down,
    name: '20260720_120000_customer_invoice_references',
    up: migration_20260720_120000_customer_invoice_references.up,
  },
]
