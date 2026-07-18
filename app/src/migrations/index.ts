import * as migration_20260718_001700_application_indexes from './20260718_001700_application_indexes'

export const migrations = [
  {
    down: migration_20260718_001700_application_indexes.down,
    name: '20260718_001700_application_indexes',
    up: migration_20260718_001700_application_indexes.up,
  },
]
