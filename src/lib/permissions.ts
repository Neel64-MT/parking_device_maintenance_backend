import type { PermissionFlag, ScreenName } from '../types/api.js'

export const SCREENS: ScreenName[] = [
  'Dashboard',
  'Raise ticket',
  'Update ticket',
  'All tickets',
  'Work report',
  'Device list',
  'Add device',
  'Device history',
  'Scan QR',
  'Issue master',
  'Road master',
  'Users',
  'Roles & permissions',
]

export const PERM_FLAGS: PermissionFlag[] = ['v', 'c', 'e', 'a', 'x', 'd']

/** Role permission codes from frontend users.js */
export const DEFAULT_ROLE_PERMS: Record<string, { note: string; scope: 'all_roads' | 'assigned_roads'; p: Record<string, string> }> = {
  Admin: {
    note: 'Full control. At least one admin must always exist.',
    scope: 'all_roads',
    p: {
      Dashboard: 'v.....',
      'Raise ticket': 'vc....',
      'Update ticket': 'vce.x.',
      'All tickets': 'vceaxd',
      'Work report': 'v.....',
      'Device list': 'vce..d',
      'Add device': 'vc....',
      'Device history': 'v.....',
      'Scan QR': 'v.....',
      'Issue master': 'vce..d',
      'Road master': 'vce..d',
      Users: 'vce..d',
      'Roles & permissions': 'vce..d',
    },
  },
  'Project manager': {
    note: 'City-wide ops; can manage users and approve signups; cannot delete masters.',
    scope: 'all_roads',
    p: {
      Dashboard: 'v.....',
      'Raise ticket': 'vc....',
      'Update ticket': 'vce.x.',
      'All tickets': 'vcea.x',
      'Work report': 'v.....',
      'Device list': 'vce...',
      'Add device': 'vc....',
      'Device history': 'v.....',
      'Scan QR': 'v.....',
      'Issue master': 'vce...',
      'Road master': 'vce...',
      Users: 'vce...',
      'Roles & permissions': 'v.....',
    },
  },
  'Control room': {
    note: 'Raises and routes tickets across all roads, but never closes one.',
    scope: 'all_roads',
    p: {
      Dashboard: 'v.....',
      'Raise ticket': 'vc....',
      'Update ticket': 'v.....',
      'All tickets': 'vc.a..',
      'Work report': 'v.....',
      'Device list': 'v.....',
      'Add device': '......',
      'Device history': 'v.....',
      'Scan QR': 'v.....',
      'Issue master': 'v.....',
      'Road master': 'v.....',
      Users: '......',
      'Roles & permissions': '......',
    },
  },
  Technician: {
    note: 'Sees only devices and tickets on assigned roads, and tickets they hold. Cannot assign or reassign.',
    scope: 'assigned_roads',
    p: {
      Dashboard: '......',
      'Raise ticket': 'vc....',
      'Update ticket': 'vce.x.',
      'All tickets': 'v.....',
      'Work report': '......',
      'Device list': 'v.....',
      'Add device': '......',
      'Device history': 'v.....',
      'Scan QR': 'v.....',
      'Issue master': 'v.....',
      'Road master': '......',
      Users: '......',
      'Roles & permissions': '......',
    },
  },
  'Site attendant': {
    note: 'Can report a problem and nothing else.',
    scope: 'assigned_roads',
    p: {
      Dashboard: '......',
      'Raise ticket': 'vc....',
      'Update ticket': '......',
      'All tickets': 'v.....',
      'Work report': '......',
      'Device list': 'v.....',
      'Add device': '......',
      'Device history': '......',
      'Scan QR': 'v.....',
      'Issue master': 'v.....',
      'Road master': '......',
      Users: '......',
      'Roles & permissions': '......',
    },
  },
  'AMC officer': {
    note: 'View only, everywhere.',
    scope: 'all_roads',
    p: {
      Dashboard: 'v.....',
      'Raise ticket': '......',
      'Update ticket': '......',
      'All tickets': 'v.....',
      'Work report': 'v.....',
      'Device list': 'v.....',
      'Add device': '......',
      'Device history': 'v.....',
      'Scan QR': '......',
      'Issue master': 'v.....',
      'Road master': 'v.....',
      Users: '......',
      'Roles & permissions': '......',
    },
  },
}

export function codeToFlags(code: string) {
  const c = (code || '......').padEnd(6, '.')
  return {
    can_view: c[0] === 'v',
    can_create: c[1] === 'c',
    can_edit: c[2] === 'e',
    can_assign: c[3] === 'a',
    can_close: c[4] === 'x',
    can_delete: c[5] === 'd',
  }
}

export function flagsToCode(flags: {
  can_view: boolean
  can_create: boolean
  can_edit: boolean
  can_assign: boolean
  can_close: boolean
  can_delete: boolean
}) {
  return [
    flags.can_view ? 'v' : '.',
    flags.can_create ? 'c' : '.',
    flags.can_edit ? 'e' : '.',
    flags.can_assign ? 'a' : '.',
    flags.can_close ? 'x' : '.',
    flags.can_delete ? 'd' : '.',
  ].join('')
}

export function flagColumn(flag: PermissionFlag) {
  const map: Record<PermissionFlag, string> = {
    v: 'can_view',
    c: 'can_create',
    e: 'can_edit',
    a: 'can_assign',
    x: 'can_close',
    d: 'can_delete',
  }
  return map[flag]
}
