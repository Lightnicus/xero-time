import { ownerAdminField, systemFieldWrite } from '@/access/domain'
import { isRecord } from '@/lib/domain/validation'

import type { CollectionBeforeChangeHook, Field } from 'payload'

export const attributionFields: Field[] = [
  {
    name: 'createdBy',
    type: 'relationship',
    relationTo: 'users',
    maxDepth: 0,
    access: { create: systemFieldWrite, read: ownerAdminField, update: systemFieldWrite },
    admin: { allowCreate: false, allowEdit: false, readOnly: true },
  },
  {
    name: 'updatedBy',
    type: 'relationship',
    relationTo: 'users',
    maxDepth: 0,
    access: { create: systemFieldWrite, read: ownerAdminField, update: systemFieldWrite },
    admin: { allowCreate: false, allowEdit: false, readOnly: true },
  },
]

export const attributeChange: CollectionBeforeChangeHook = ({ data, operation, req }) => {
  const userID = isRecord(req.user) ? req.user.id : undefined
  if (typeof userID !== 'string' && typeof userID !== 'number') return data

  data.updatedBy = userID
  if (operation === 'create') data.createdBy = userID
  return data
}
