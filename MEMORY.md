# Memory — Implementation State

## Completed

- Phase 0–11 — foundation through forgot-password / password_version
- Phase 12 — Ticket visibility (assignee/raiser) + Project manager Users `vce...` for signup approval
- Phase 13 — Role-based ticket scope consistency: dashboard (already), devices open-ticket/history, work report reuse `ticket-access.ts`

## Currently Working On

- (idle — ticket scope consistency complete)

## Pending

### FRONTEND CHANGE REQUIRED (do not implement until authorized)

- Feature screens still on mocks / partial wiring
- When wiring Dashboard / All Tickets / Devices / Work report, trust API ticket scope — no client-side role filters
- Signup success copy: “Admin” → “Admin or Project manager” (optional; API already unlocks Approve for PM)

## Important Decisions

- Ticket visibility privileged roles: only `Admin` and `Project manager`
- Other roles: `assignee_id = me OR raised_by_user_id = me` in SQL + `assertTicketAccess`
- Same helper scopes dashboard ticket metrics, device ticket overlays/history, and work report rows
- Assign stays road-only (`assertRoadAccess`) for Control room routing; list/detail/dashboard/devices/reports stay visibility-scoped
- PM Users permission: `vce...` (approve Pending via existing PATCH); Roles matrix remains view-only
- No separate signup-request table
- Control room is scoped like other non-privileged roles for viewing (per product requirement)
