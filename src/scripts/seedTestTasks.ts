import prisma from '../db/prisma';

const HOUR = 1000 * 60 * 60;
const now = Date.now();

const testTasks = [
  {
    title: 'TEST — CRITICAL: printer down',
    referral_id: 'TEST-REF-001',
    status: 'OPEN',
    created_at: new Date(now - 80 * HOUR),
  },
  {
    title: 'TEST — HIGH: pending approval',
    referral_id: 'TEST-REF-002',
    status: 'OPEN',
    created_at: new Date(now - 50 * HOUR),
  },
  {
    title: 'TEST — MEDIUM: waiting on docs',
    referral_id: 'TEST-REF-003',
    status: 'OPEN',
    created_at: new Date(now - 30 * HOUR),
  },
];

async function seed() {
  for (const task of testTasks) {
    const created = await prisma.task.create({ data: task });
    console.log(`Inserted: [${created.id}] "${created.title}" — created_at: ${created.created_at.toISOString()}`);
  }
  console.log('Seed complete. Run cleanTestTasks.ts to remove when done.');
  await prisma.$disconnect();
}

seed().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
