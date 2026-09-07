# Memory — Implementation State

## Completed

- Phase 0–11 — foundation through forgot-password / password_version
- Phase 12 — Ticket visibility (assignee/raiser) + Project manager Users `vce...` for signup approval
- Phase 13 — Role-based ticket scope consistency: dashboard (already), devices open-ticket/history, work report reuse `ticket-access.ts`
- Phase 17 — QR scan canonical payload + seed lat/lng + `OPEN_TICKET_EXISTS.openTicketId`
- Phase 18 — Ticket status `New` removed; unassigned tickets use `Open` (`007_ticket_status_open.sql`)
- Phase 19 — Assign/reassign restricted to Control room, Admin, Project manager (no technician handover)
- Phase 20 — Ticket list `daysAfterClose` + tab `new` = unassigned only; list presents assigned+`Open` as `Under repair`
- Phase 21 — DB-level pagination for tickets + devices (`page`/`limit`, default 10, allowed 10/25/50/100)

## Currently Working On

- (idle — list pagination complete)

## Pending

### FRONTEND CHANGE REQUIRED (do not implement until authorized)

- Feature screens still on mocks / partial wiring
- Wire Scan QR to `GET /api/devices/scan?q=`; on raise `409 OPEN_TICKET_EXISTS` redirect via `details.openTicketId`
- When wiring Dashboard / All Tickets / Devices / Work report, trust API ticket scope — no client-side role filters
- TicketList: change default `limit` from 50/100 to allowed values; use `pagination` for pager UI
- All Tickets / detail status badge: show `Open`, never `New`
- Closed tickets list: use `daysAfterClose` (null when still open)
- Trust list `status` for Assigned-tab vs Under repair tile (do not remap assigned Open in the browser)
- Hide technician reassign / handover; only Control room, Admin, Project manager assign
- Signup success copy: “Admin” → “Admin or Project manager” (optional; API already unlocks Approve for PM)

## Important Decisions

- Ticket visibility privileged roles: only `Admin` and `Project manager`
- Other roles: `assignee_id = me OR raised_by_user_id = me` in SQL + `assertTicketAccess`
- Same helper scopes dashboard ticket metrics, device ticket overlays/history, and work report rows
- Assign / reassign: Control room, Admin, or Project manager only; technicians cannot `/assign` or `handoverToUserId`
- Assign stays road-only (`assertRoadAccess`) for Control room routing; list/detail/dashboard/devices/reports stay visibility-scoped
- Scan details stay on `GET /api/devices/scan?q=` (no `/scan-details` alias)
- One open ticket per device means `status <> 'Closed'`; unassigned stored status is `Open` (not `New`)
- List tab `new` = unassigned non-closed; list may show assigned+`Open` as `Under repair` without DB update
- Ticket list `daysAfterClose` is days since `closed_at` (`null` if open); list-only
- List pagination: `page`/`limit`, default limit **10**, allowed **10|25|50|100**, SQL LIMIT/OFFSET after scope/filters; shared `src/lib/pagination.ts`
- Pagination response shape stays `{ page, limit, total, totalPages }` (no hasNextPage)
- Duplicate raise 409 includes both `ticketId` and `openTicketId`
- Device lat/lng are TEXT strings; seed includes Ahmedabad-area dummies
- PM Users permission: `vce...` (approve Pending via existing PATCH); Roles matrix remains view-only
- No separate signup-request table
- Control room is scoped like other non-privileged roles for viewing (per product requirement)
