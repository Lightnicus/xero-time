import { isRecord } from '@/lib/domain/validation'

export type ProjectXeroItemReference = {
  code: string
  id: string
  name: string
  tracked: boolean
}

export type ProjectXeroItemOption = ProjectXeroItemReference & {
  label: string
  value: string
}

/**
 * Convert a cached provider record into the exact subset a project may select.
 * ItemID is the durable mapping identity; ItemCode remains case-sensitive
 * provider data and is copied only as a display/export snapshot.
 */
export const activeSalesItemReference = (value: unknown): ProjectXeroItemReference | null => {
  if (
    !isRecord(value) ||
    value.resourceType !== 'item' ||
    value.status !== 'active' ||
    !isRecord(value.metadata) ||
    value.metadata.isSold !== true
  ) {
    return null
  }

  const id = typeof value.xeroId === 'string' ? value.xeroId.trim() : ''
  const code = typeof value.code === 'string' ? value.code.trim() : ''
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!id || !code || !name) return null

  return { code, id, name, tracked: value.metadata.isTrackedAsInventory === true }
}

export const buildProjectXeroItemOptions = (
  references: readonly unknown[],
): ProjectXeroItemOption[] =>
  references
    .flatMap((value) => {
      const item = activeSalesItemReference(value)
      return item
        ? [
            {
              ...item,
              label: `${item.code} — ${item.name}${item.tracked ? ' (tracked inventory)' : ''}`,
              value: item.id,
            },
          ]
        : []
    })
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code, 'en', { sensitivity: 'base' }) ||
        left.name.localeCompare(right.name),
    )
