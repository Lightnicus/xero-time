# ADR 0002: MongoDB

Status: accepted

Use MongoDB because its document model aligns with Payload and immutable invoice snapshots. Every environment must use a replica set so reservation, identity-link, audit, and release operations can commit atomically. Production requires Atlas Flex or better with backups.
