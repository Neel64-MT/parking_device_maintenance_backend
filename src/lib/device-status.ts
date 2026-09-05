/** Derive operational device status from open tickets + severity. */
export type DerivedStatus = 'Working' | 'Under repair' | 'Not working'

export function deriveDeviceStatus(args: {
  openTicketStatus: string | null
  assigneeId: string | null
  severity: string | null
}): DerivedStatus {
  if (!args.openTicketStatus || args.openTicketStatus === 'Closed') return 'Working'
  if (args.openTicketStatus === 'Waiting for spare' || args.openTicketStatus === 'Under repair') {
    return 'Under repair'
  }
  if (args.assigneeId) return 'Under repair'
  // Unassigned open/new
  if (args.severity === 'Minor') return 'Working'
  return 'Not working'
}

export function statusTone(status: DerivedStatus) {
  if (status === 'Working') return 'ok'
  if (status === 'Under repair') return 'warn'
  return 'bad'
}
