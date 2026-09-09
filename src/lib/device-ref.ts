/** Prefer Slot Id for API display / links; fall back to public_id for legacy seed rows. */
export function deviceDisplayId(row: {
  slot_id?: unknown
  public_id: string
}): string {
  if (row.slot_id != null && row.slot_id !== '') return String(row.slot_id)
  return row.public_id
}

/** Resolve device by public_id, UUID, or slot_id text. */
export function deviceLookupWhere(alias = 'd', param = 1) {
  return `(${alias}.public_id = $${param} OR ${alias}.id::text = $${param} OR CAST(${alias}.slot_id AS TEXT) = $${param})`
}
