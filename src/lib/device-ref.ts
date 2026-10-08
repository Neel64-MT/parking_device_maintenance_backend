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

/**
 * Slot Label (`slot_number`) ascending, shared by every slot-ordered list.
 * Sorted in SQL so the order holds across every page (LIMIT/OFFSET), not just
 * within a page. Blank labels go last, `public_id` is the stable tie-break so
 * paginating never repeats or skips a row when two labels are equal.
 * Pass an empty alias for unqualified columns (e.g. a CTE projection).
 *
 * `natural`: digit runs compare by value (3-2 < 3-12 < 3-121), needed because synced
 * SmartPark labels are not zero-padded. Without it, plain text order (Device list).
 */
export function slotLabelOrderBy(alias = '', opts: { natural?: boolean } = {}) {
  const p = alias ? `${alias}.` : ''
  const label = `${p}slot_number`
  const key = opts.natural
    ? `(SELECT string_agg(CASE WHEN m.part[1] ~ '^[0-9]+$' THEN lpad(m.part[1], 20, '0') ELSE m.part[1] END, '' ORDER BY m.ord)
        FROM regexp_matches(${label}, '[0-9]+|[^0-9]+', 'g') WITH ORDINALITY AS m(part, ord)), `
    : ''
  return `ORDER BY (${label} = ''), ${key}${label}, ${p}public_id`
}
