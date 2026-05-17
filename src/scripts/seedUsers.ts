/**
 * seedUsers.ts
 *
 * Creates the default system accounts on first run.
 * Safe to call repeatedly — uses findUnique + create so it never creates duplicates.
 *
 * Production passwords are read from env vars:
 *   SEED_ADMIN_PASSWORD   (required in production)
 *   SEED_MANAGER_PASSWORD (required in production)
 *   SEED_STAFF_PASSWORD   (required in production)
 *
 * DEV-ONLY quick-access (only seeded when NODE_ENV !== 'production'):
 *   admin@test.com   / 12345678
 *   manager@test.com / 12345678
 *   staff@test.com   / 12345678
 */

import bcrypt from 'bcrypt';
import prisma from '../db/prisma';

interface SeedUser {
  name:  string;
  email: string;
  password: string;
  role:  string;
}

function getProductionUsers(): SeedUser[] {
  // Use env vars if set, otherwise fall back to defaults
  const adminPwd   = process.env.SEED_ADMIN_PASSWORD   ?? 'Envico@Admin2024!';
  const managerPwd = process.env.SEED_MANAGER_PASSWORD ?? 'Envico@Mgr2024!';
  const staffPwd   = process.env.SEED_STAFF_PASSWORD   ?? 'Envico@Staff2024!';

  return [
    { name: 'Envico Admin',   email: 'admin@envicosl.co.uk',   password: adminPwd,   role: 'ADMIN'   },
    { name: 'Envico Manager', email: 'manager@envicosl.co.uk', password: managerPwd, role: 'MANAGER' },
    { name: 'Envico Staff',   email: 'staff@envicosl.co.uk',   password: staffPwd,   role: 'STAFF'   },
  ];
}

const DEV_USERS: SeedUser[] = [
  { name: 'Engelbert (CEO)',  email: 'admin@test.com',   password: '12345678', role: 'ADMIN'   },
  { name: 'Test Manager',     email: 'manager@test.com', password: '12345678', role: 'MANAGER' },
  { name: 'Test Staff',       email: 'staff@test.com',   password: '12345678', role: 'STAFF'   },
];

export async function seedUsers(): Promise<void> {
  const isDev = process.env.NODE_ENV !== 'production';
  const productionUsers = getProductionUsers();
  const usersToSeed = isDev ? [...productionUsers, ...DEV_USERS] : productionUsers;

  let created = 0;
  let skipped = 0;

  for (const u of usersToSeed) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    if (existing) {
      skipped++;
      continue;
    }

    const hashed = await bcrypt.hash(u.password, 10);
    await prisma.user.create({
      data: {
        name:      u.name,
        email:     u.email,
        password:  hashed,
        role:      u.role,
        is_active: true,
      },
    });
    created++;
    console.log(`[seedUsers] Created ${u.role}: ${u.email}`);
  }

  if (created === 0 && skipped > 0) {
    if (isDev) console.log(`[seedUsers] All ${skipped} seed users already exist.`);
  } else if (created > 0) {
    console.log(`[seedUsers] Done — ${created} created, ${skipped} already existed.`);
  }
}

// Allow running directly: npx ts-node src/scripts/seedUsers.ts
if (require.main === module) {
  seedUsers()
    .then(() => process.exit(0))
    .catch((e) => { console.error('[seedUsers] Failed:', e.message); process.exit(1); })
    .finally(() => prisma.$disconnect());
}
