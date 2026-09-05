import { closeDb, query } from './pool.js'
import { hashPassword } from '../lib/auth.js'
import { DEFAULT_ROLE_PERMS, SCREENS, codeToFlags } from '../lib/permissions.js'

const DEMO_PASSWORD = 'Password123'

function emailFromName(name: string) {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
  return `${slug}@yopmail.com`
}

const ISSUE_MASTER = [
  {
    name: 'Mechanical',
    subs: [
      ['Flap plate bent', 'Critical'],
      ['Hinge or pivot worn', 'Major'],
      ['Motor failure', 'Critical'],
      ['Gearbox or worm failure', 'Critical'],
      ['Limit switch faulty', 'Major'],
      ['Spring or damper', 'Minor'],
      ['Jammed by debris', 'Major'],
    ],
  },
  {
    name: 'Electrical',
    subs: [
      ['Controller board failure', 'Critical'],
      ['Wiring or connector loose', 'Major'],
      ['Fuse blown', 'Major'],
      ['Short circuit due to water', 'Critical'],
    ],
  },
  {
    name: 'Power',
    subs: [
      ['Mains supply cut', 'Critical'],
      ['Power supply / SMPS failure', 'Critical'],
      ['Power cable damaged', 'Critical'],
      ['MCB tripped', 'Major'],
    ],
  },
  {
    name: 'Communication',
    subs: [
      ['Network cable disconnected', 'Major'],
      ['Communication module faulty', 'Major'],
      ['Server sync failure', 'Major'],
      ['Weak network at site', 'Minor'],
    ],
  },
  {
    name: 'Sensor',
    subs: [
      ['Sensor not detecting vehicle', 'Critical'],
      ['Sensor misalignment', 'Major'],
      ['Sensor dirty or blocked', 'Minor'],
    ],
  },
  {
    name: 'QR / payment',
    subs: [
      ['QR plate damaged', 'Major'],
      ['QR plate missing', 'Critical'],
      ['Bollard broken', 'Major'],
      ['Payment gateway issue', 'Critical'],
    ],
  },
  {
    name: 'External damage',
    subs: [
      ['Vehicle hit the flap', 'Critical'],
      ['Two-wheeler forced entry', 'Major'],
      ['Vandalism', 'Critical'],
      ['Theft of parts', 'Critical'],
    ],
  },
  {
    name: 'Civil',
    subs: [
      ['Foundation loose', 'Major'],
      ['Paver settlement', 'Minor'],
      ['Water ingress in pit', 'Critical'],
      ['Cable cut by other agency', 'Critical'],
    ],
  },
  {
    name: 'Operational',
    subs: [
      ['User misuse', 'Minor'],
      ['Wrong operation by attendant', 'Minor'],
      ['False complaint', 'Minor'],
    ],
  },
] as const

const PARTS = [
  'Flap plate',
  'Hinge assembly',
  'Motor',
  'Gearbox',
  'Limit switch',
  'Controller board',
  'SMPS / power supply',
  'Sensor',
  'QR plate',
  'Wiring harness',
  'MCB',
  'Spring / damper',
]

const ROADS = [
  {
    code: 'RD-01',
    name: 'Science City',
    stretch_from: 'Sector 1',
    stretch_to: 'Sector 4',
    zone: 'West Zone',
    ward: 'Ward 12',
    length_text: '2.8 km',
    side: 'Both sides',
    surveyed_slots: 640,
    devices_sanctioned: 595,
    vehicle_type: 'Four-wheeler only',
    parking_rate: '20 per hour',
    slot_prefix: 'S',
    operating_hours: '08:00 to 22:00',
    status: 'Operational',
  },
  {
    code: 'RD-02',
    name: 'CG Road',
    stretch_from: 'Panchvati',
    stretch_to: 'Swastik',
    zone: 'West Zone',
    ward: 'Ward 8',
    length_text: '1.6 km',
    side: 'Both sides',
    surveyed_slots: 165,
    devices_sanctioned: 150,
    vehicle_type: 'Four-wheeler only',
    parking_rate: '20 per hour',
    slot_prefix: 'CG',
    operating_hours: '08:00 to 22:00',
    status: 'Operational',
  },
  {
    code: 'RD-03',
    name: 'Makarba',
    stretch_from: 'Police HQ',
    stretch_to: 'Sarkhej Highway',
    zone: 'South West Zone',
    ward: 'Ward 21',
    length_text: '2.1 km',
    side: 'Both sides',
    surveyed_slots: 140,
    devices_sanctioned: 130,
    vehicle_type: 'Four-wheeler only',
    parking_rate: '20 per hour',
    slot_prefix: 'MK',
    operating_hours: '08:00 to 22:00',
    status: 'Operational',
  },
  {
    code: 'RD-04',
    name: 'Sobo – Marigold',
    stretch_from: 'Sobo Circle',
    stretch_to: 'Marigold Circle',
    zone: 'West Zone',
    ward: 'Ward 9',
    length_text: '1.2 km',
    side: 'Both sides',
    surveyed_slots: 80,
    devices_sanctioned: 75,
    vehicle_type: 'Four-wheeler only',
    parking_rate: '20 per hour',
    slot_prefix: 'SM',
    operating_hours: '08:00 to 22:00',
    status: 'On hold',
  },
  {
    code: 'RD-05',
    name: 'Sindhu Bhavan Road',
    stretch_from: 'Pakwan',
    stretch_to: 'Ratnaakar',
    zone: 'West Zone',
    ward: 'Ward 12',
    length_text: '1.4 km',
    side: 'Both sides',
    surveyed_slots: 55,
    devices_sanctioned: 50,
    vehicle_type: 'Four-wheeler only',
    parking_rate: '20 per hour',
    slot_prefix: 'SB',
    operating_hours: '08:00 to 22:00',
    status: 'Operational',
  },
]

const DEVICES = [
  { public_id: 'PD-0117', road: 'CG Road', slot: 'CG-33', installed: '2026-03-12' },
  { public_id: 'PD-0233', road: 'Sobo – Marigold', slot: 'SM-08', installed: '2026-02-28' },
  { public_id: 'PD-0304', road: 'CG Road', slot: 'CG-61', installed: '2026-03-14' },
  { public_id: 'PD-0428', road: 'Science City', slot: 'S2-114', installed: '2026-04-02' },
  { public_id: 'PD-0500', road: 'Science City', slot: 'S2-186', installed: '2026-04-02' },
  { public_id: 'PD-0571', road: 'Science City', slot: 'S1-206', installed: '2026-03-29' },
  { public_id: 'PD-0692', road: 'Science City', slot: 'S3-047', installed: '2026-04-08' },
  { public_id: 'PD-0740', road: 'Science City', slot: 'S3-095', installed: '2026-04-08' },
  { public_id: 'PD-0805', road: 'Makarba', slot: 'MK-12', installed: '2026-04-19' },
  { public_id: 'PD-0861', road: 'Makarba', slot: 'MK-68', installed: '2026-04-19' },
  { public_id: 'PD-0946', road: 'Sindhu Bhavan Road', slot: 'SB-21', installed: '2026-05-06' },
  { public_id: 'PD-0988', road: 'Sindhu Bhavan Road', slot: 'SB-44', installed: '2026-05-06' },
]

async function seed() {
  console.log('Seeding…')

  // Clear in dependency order
  await query('TRUNCATE ticket_assignments, ticket_events, tickets, devices, user_roads, password_reset_tokens, users, role_permissions, roles, issue_subcategories, issue_categories, parts, roads, token_denylist, id_counters RESTART IDENTITY CASCADE')

  const roleIds: Record<string, string> = {}
  for (const [name, def] of Object.entries(DEFAULT_ROLE_PERMS)) {
    const r = await query<{ id: string }>(
      `INSERT INTO roles (name, scope, note) VALUES ($1, $2, $3) RETURNING id`,
      [name, def.scope, def.note],
    )
    roleIds[name] = r.rows[0].id
    for (const screen of SCREENS) {
      const flags = codeToFlags(def.p[screen] || '......')
      await query(
        `INSERT INTO role_permissions
         (role_id, screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          roleIds[name],
          screen,
          flags.can_view,
          flags.can_create,
          flags.can_edit,
          flags.can_assign,
          flags.can_close,
          flags.can_delete,
        ],
      )
    }
  }

  const roadIds: Record<string, string> = {}
  for (const road of ROADS) {
    const r = await query<{ id: string }>(
      `INSERT INTO roads (
        code, name, stretch_from, stretch_to, zone, ward, length_text, side,
        surveyed_slots, devices_sanctioned, vehicle_type, parking_rate, slot_prefix,
        operating_hours, status, go_live_date
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'2026-03-01')
      RETURNING id`,
      [
        road.code,
        road.name,
        road.stretch_from,
        road.stretch_to,
        road.zone,
        road.ward,
        road.length_text,
        road.side,
        road.surveyed_slots,
        road.devices_sanctioned,
        road.vehicle_type,
        road.parking_rate,
        road.slot_prefix,
        road.operating_hours,
        road.status,
      ],
    )
    roadIds[road.name] = r.rows[0].id
  }

  const catIds: Record<string, string> = {}
  const subIds: Record<string, string> = {}
  let order = 0
  for (const cat of ISSUE_MASTER) {
    const c = await query<{ id: string }>(
      `INSERT INTO issue_categories (name, sort_order) VALUES ($1, $2) RETURNING id`,
      [cat.name, order++],
    )
    catIds[cat.name] = c.rows[0].id
    for (const [subName, severity] of cat.subs) {
      const s = await query<{ id: string }>(
        `INSERT INTO issue_subcategories (category_id, name, severity) VALUES ($1,$2,$3) RETURNING id`,
        [catIds[cat.name], subName, severity],
      )
      subIds[`${cat.name}::${subName}`] = s.rows[0].id
    }
  }

  for (const part of PARTS) {
    await query(`INSERT INTO parts (name) VALUES ($1)`, [part])
  }

  const users = [
    { name: 'Alkesh Patel', mobile: '9825012345', role: 'Project manager', roads: [] as string[] },
    { name: 'Admin User', mobile: '9000000001', role: 'Admin', roads: [] },
    { name: 'Ramesh Vaghela', mobile: '9099941128', role: 'Technician', roads: ['Science City'] },
    { name: 'Jignesh Solanki', mobile: '9428033471', role: 'Technician', roads: ['CG Road', 'Sindhu Bhavan Road'] },
    { name: 'Mahesh Thakor', mobile: '9712955620', role: 'Technician', roads: ['Makarba'] },
    { name: 'Nilesh Chauhan', mobile: '9016374408', role: 'Site attendant', roads: ['Science City'] },
    { name: 'Kiran Bhatt', mobile: '9377720914', role: 'Site attendant', roads: ['CG Road'] },
    { name: 'Control Room — Shift A', mobile: '7990011002', role: 'Control room', roads: [] },
    { name: 'Dy. Engineer, AMC', mobile: '9879060013', role: 'AMC officer', roads: [] },
    { name: 'Sanjay Rathod', mobile: '9687440225', role: 'Technician', roads: ['Sobo – Marigold'], status: 'Inactive' },
  ]

  const passwordHash = await hashPassword(DEMO_PASSWORD)
  const userIds: Record<string, string> = {}
  for (const u of users) {
    const r = await query<{ id: string }>(
      `INSERT INTO users (full_name, mobile, email, password_hash, role_id, status, last_active_at)
       VALUES ($1,$2,$3,$4,$5,$6, NOW()) RETURNING id`,
      [
        u.name,
        u.mobile,
        emailFromName(u.name),
        passwordHash,
        roleIds[u.role],
        (u as { status?: string }).status || 'Active',
      ],
    )
    userIds[u.name] = r.rows[0].id
    for (const roadName of u.roads) {
      await query(`INSERT INTO user_roads (user_id, road_id) VALUES ($1,$2)`, [
        userIds[u.name],
        roadIds[roadName],
      ])
    }
  }

  const deviceIds: Record<string, string> = {}
  for (const d of DEVICES) {
    const qr = `QR-${d.public_id.replace('-', '')}`
    const r = await query<{ id: string }>(
      `INSERT INTO devices (public_id, qr_code, road_id, slot_number, side_of_road, model, installed_on, install_status)
       VALUES ($1,$2,$3,$4,'Left','Flap barrier — 4 wheeler',$5,'Working') RETURNING id`,
      [d.public_id, qr, roadIds[d.road], d.slot, d.installed],
    )
    deviceIds[d.public_id] = r.rows[0].id
  }

  // Counters after seeded IDs
  await query(`INSERT INTO id_counters (name, value) VALUES ('RD', 5), ('PD', 988), ('TK', 1102)`)

  // Open ticket TK-1042 on PD-0428
  const t1042 = await query<{ id: string }>(
    `INSERT INTO tickets (
      public_id, device_id, status, priority, reporter_type, description,
      reported_category_id, reported_subcategory_id,
      found_category_id, found_subcategory_id,
      raised_by_user_id, assignee_id, raised_at
    ) VALUES (
      'TK-1042', $1, 'Waiting for spare', 'Critical — attend today', 'Site attendant',
      'Flap not opening after payment. Two vehicles waiting.',
      $2, $3, $4, $5, $6, $7, '2026-08-24 09:15:00+05:30'
    ) RETURNING id`,
    [
      deviceIds['PD-0428'],
      catIds.Electrical,
      subIds['Electrical::Controller board failure'],
      catIds.Mechanical,
      subIds['Mechanical::Motor failure'],
      userIds['Nilesh Chauhan'],
      userIds['Ramesh Vaghela'],
    ],
  )
  const ticket1042 = t1042.rows[0].id

  await query(
    `INSERT INTO ticket_events (ticket_id, event_type, title, body, status_label, actor_user_id, category_id, subcategory_id, created_at)
     VALUES ($1,'raised','Ticket raised','Flap not opening after payment.','Open',$2,$3,$4,'2026-08-24 09:15:00+05:30')`,
    [ticket1042, userIds['Nilesh Chauhan'], catIds.Electrical, subIds['Electrical::Controller board failure']],
  )
  await query(
    `INSERT INTO ticket_events (ticket_id, event_type, title, body, status_label, actor_user_id, created_at)
     VALUES ($1,'assigned','Assigned to technician','Ticket assigned to Ramesh Vaghela.','Still open',$2,'2026-08-24 12:00:00+05:30')`,
    [ticket1042, userIds['Control Room — Shift A']],
  )
  await query(
    `INSERT INTO ticket_events (ticket_id, event_type, title, body, status_label, actor_user_id, category_id, subcategory_id, meta, created_at)
     VALUES ($1,'reclassified','Issue reclassified','Board healthy; motor not responding.','Still open',$2,$3,$4,$5,'2026-08-25 10:30:00+05:30')`,
    [
      ticket1042,
      userIds['Ramesh Vaghela'],
      catIds.Mechanical,
      subIds['Mechanical::Motor failure'],
      JSON.stringify({
        changedFrom: 'Electrical › Controller board failure',
        changedTo: 'Mechanical › Motor failure',
      }),
    ],
  )
  await query(
    `INSERT INTO ticket_events (ticket_id, event_type, title, body, status_label, actor_user_id, work_done, cost, created_at)
     VALUES ($1,'visit_open','Site visit — not resolved','Gearbox seized. Slot barricaded.','Still open',$2,$3,0,'2026-08-26 15:45:00+05:30')`,
    [
      ticket1042,
      userIds['Ramesh Vaghela'],
      'Opened the housing and confirmed the gearbox is seized.',
    ],
  )
  await query(
    `INSERT INTO ticket_events (ticket_id, event_type, title, body, status_label, actor_user_id, next_visit_at, cost, created_at)
     VALUES ($1,'waiting_spare','Waiting for spare','Motor assembly indented from OEM.','Still open',$2,'2026-09-03',0,'2026-08-30 11:20:00+05:30')`,
    [ticket1042, userIds['Ramesh Vaghela']],
  )

  await query(
    `INSERT INTO ticket_assignments (ticket_id, from_user_id, to_user_id, reason, created_at)
     VALUES
     ($1, NULL, $2, 'Left unassigned', '2026-08-24 09:15:00+05:30'),
     ($1, $3, $2, 'First assignment', '2026-08-24 12:00:00+05:30'),
     ($1, $2, $4, 'Electrical opinion', '2026-08-26 16:05:00+05:30'),
     ($1, $4, $2, 'Fault is mechanical', '2026-08-27 09:10:00+05:30')`,
    [
      ticket1042,
      userIds['Ramesh Vaghela'],
      userIds['Control Room — Shift A'],
      userIds['Jignesh Solanki'],
    ],
  )

  // Additional sample tickets
  const extras: Array<{
    id: string
    device: string
    status: string
    assignee?: string
    raised: string
    cat: string
    sub: string
    foundCat?: string
    foundSub?: string
  }> = [
    {
      id: 'TK-1051',
      device: 'PD-0117',
      status: 'Under repair',
      assignee: 'Jignesh Solanki',
      raised: '2026-08-25 18:40:00+05:30',
      cat: 'Power',
      sub: 'Mains supply cut',
      foundCat: 'Power',
      foundSub: 'Power supply / SMPS failure',
    },
    {
      id: 'TK-1063',
      device: 'PD-0692',
      status: 'Open',
      assignee: 'Ramesh Vaghela',
      raised: '2026-08-26 07:05:00+05:30',
      cat: 'External damage',
      sub: 'Vehicle hit the flap',
      foundCat: 'External damage',
      foundSub: 'Vehicle hit the flap',
    },
    {
      id: 'TK-1070',
      device: 'PD-0805',
      status: 'Under repair',
      assignee: 'Mahesh Thakor',
      raised: '2026-08-27 11:22:00+05:30',
      cat: 'QR / payment',
      sub: 'QR plate damaged',
      foundCat: 'QR / payment',
      foundSub: 'QR plate damaged',
    },
    {
      id: 'TK-1078',
      device: 'PD-0233',
      status: 'Open',
      raised: '2026-08-28 02:00:00+05:30',
      cat: 'Communication',
      sub: 'Network cable disconnected',
    },
    {
      id: 'TK-1090',
      device: 'PD-0571',
      status: 'Under repair',
      assignee: 'Ramesh Vaghela',
      raised: '2026-08-30 16:10:00+05:30',
      cat: 'Mechanical',
      sub: 'Jammed by debris',
      foundCat: 'Mechanical',
      foundSub: 'Limit switch faulty',
    },
    {
      id: 'TK-1094',
      device: 'PD-0946',
      status: 'Open',
      assignee: 'Jignesh Solanki',
      raised: '2026-08-31 08:45:00+05:30',
      cat: 'Civil',
      sub: 'Water ingress in pit',
    },
    {
      id: 'TK-1099',
      device: 'PD-0304',
      status: 'Open',
      raised: '2026-09-01 09:30:00+05:30',
      cat: 'Sensor',
      sub: 'Sensor not detecting vehicle',
    },
    {
      id: 'TK-1101',
      device: 'PD-0740',
      status: 'New',
      raised: '2026-09-01 10:00:00+05:30',
      cat: 'Mechanical',
      sub: 'Jammed by debris',
    },
    {
      id: 'TK-0904',
      device: 'PD-0428',
      status: 'Closed',
      assignee: 'Ramesh Vaghela',
      raised: '2026-07-11 16:40:00+05:30',
      cat: 'Electrical',
      sub: 'Fuse blown',
      foundCat: 'Power',
      foundSub: 'Power supply / SMPS failure',
    },
  ]

  for (const t of extras) {
    const closed = t.status === 'Closed'
    await query(
      `INSERT INTO tickets (
        public_id, device_id, status, reporter_type, description,
        reported_category_id, reported_subcategory_id,
        found_category_id, found_subcategory_id,
        raised_by_user_id, assignee_id, raised_at, closed_at, total_cost
      ) VALUES ($1,$2,$3,'Site attendant',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        t.id,
        deviceIds[t.device],
        t.status,
        'Seed ticket',
        catIds[t.cat],
        subIds[`${t.cat}::${t.sub}`],
        t.foundCat ? catIds[t.foundCat] : null,
        t.foundSub && t.foundCat ? subIds[`${t.foundCat}::${t.foundSub}`] : null,
        userIds['Nilesh Chauhan'],
        t.assignee ? userIds[t.assignee] : null,
        t.raised,
        closed ? '2026-07-12 18:00:00+05:30' : null,
        closed ? 2300 : 0,
      ],
    )
  }

  console.log('Seed complete')
  console.log(`Demo login: 9825012345 or alkesh.patel@yopmail.com / ${DEMO_PASSWORD}`)
  await closeDb()
}

seed().catch((err) => {
  console.error(err)
  process.exit(1)
})
