/**
 * seedUsers.ts
 *
 * Creates the default system accounts on first run.
 * Safe to call repeatedly — uses upsert so it never creates duplicates.
 *
 * Accounts created:
 *   admin@envicosl.co.uk   / Envico@Admin2024!   (ADMIN)
 *   manager@envicosl.co.uk / Envico@Mgr2024!     (MANAGER)
 *   staff@envicosl.co.uk   / Envico@Staff2024!   (STAFF)
 *
 * DEV-ONLY quick-access (only seeded when NODE_ENV !== 'production'):
 *   admin@test.com   / 12345678   (ADMIN)
 *   manager@test.com / 12345678   (MANAGER)
 *   staff@test.com   / 12345678   (STAFF)
 */

import bcrypt from 'bcrypt';
import prisma from '../db/prisma';

interface SeedUser {
  name:  string;
  email: string;
  password: string;
  role:  string;
}

const PRODUCTION_USERS: SeedUser[] = [
  { name: 'Envico Admin',   email: 'admin@envicosl.co.uk',   password: 'Envico@Admin2024!',  role: 'ADMIN'   },
  { name: 'Envico Manager', email: 'manager@envicosl.co.uk', password: 'Envico@Mgr2024!',    role: 'MANAGER' },
  { name: 'Envico Staff',   email: 'staff@envicosl.co.uk',   password: 'Envico@Staff2024!',  role: 'STAFF'   },
];

const DEV_USERS: SeedUser[] = [
  { name: 'Engelbert (CEO)',  email: 'admin@test.com',   password: '12345678', role: 'ADMIN'   },
  { name: 'Test Manager',     email: 'manager@test.com', password: '12345678', role: 'MANAGER' },
  { name: 'Test Staff',       email: 'staff@test.com',   password: '12345678', role: 'STAFF'   },
];

export async function seedUsers(): Promise<void> {
  const isDev = process.env.NODE_ENV !== 'production';
  const usersToSeed = isDev ? [...PRODUCTION_USERS, ...DEV_USERS] : PRODUCTION_USERS;

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
    // All users already exist — only log in dev to avoid noise
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
