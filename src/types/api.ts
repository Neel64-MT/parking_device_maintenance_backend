export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
  error?: string
  code?: string
  details?: unknown
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export type PermissionFlag = 'v' | 'c' | 'e' | 'a' | 'x' | 'd'

export type ScreenName =
  | 'Dashboard'
  | 'Raise ticket'
  | 'Update ticket'
  | 'All tickets'
  | 'Work report'
  | 'Device list'
  | 'Add device'
  | 'Device history'
  | 'Scan QR'
  | 'Issue master'
  | 'Road master'
  | 'Users'
  | 'Roles & permissions'

export type RoadScope = 'all_roads' | 'assigned_roads'

export interface AppNotification {
  id: string
  type: string
  title: string
  message: string
  relatedEntityType: string
  relatedEntityId: string
  data: Record<string, unknown>
  pushSentAt: Date | string | null
  readAt: Date | string | null
  isRead: boolean
  createdAt: Date | string
}

export interface PushConfig {
  available: boolean
  publicKey: string | null
  registered: boolean
}

export interface PushSubscriptionSummary {
  id: string
  createdAt: Date | string
  updatedAt: Date | string
}
