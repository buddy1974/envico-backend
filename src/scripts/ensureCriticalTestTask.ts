import prisma from '../db/prisma';

const CRITICAL_THRESHOLD_MS = 72 * 60 * 60 * 1000; // 72 hours
const CRITICAL_REFERRAL_ID = 'TEST-REF-CRIT-001';

export async function ensureCriticalTestTask(): Promise<void> {
  const cutoff = new Date(Date.now() - CRITICAL_THRESHOLD_MS);

  // Check for an existing OPEN CRITICAL task (age > 72h)
  const existing = await prisma.task.findFirst({
    where: {
      status: 'OPEN',
      created_at: { lt: cutoff },
    },
  });

  if (existing) {
    // Already have a CRITICAL OPEN task — nothing to do
    return;
  }

  // Check for a COMPLETED task that was previously CRITICAL (old enough)
  const completedCritical = await prisma.task.findFirst({
    where: {
      created_at: { lt: cutoff },
      status: 'COMPLETED',
    },
  });

  if (completedCritical) {
    await prisma.task.update({
      where: { id: completedCritical.id },
      data: { status: 'OPEN' },
    });
    console.log(`[SEED] CRITICAL TEST TASK UPDATED — id=${completedCritical.id} "${completedCritical.title}"`);
    return;
  }

  // None found — create one with created_at backdated 80 hours
  const backdated = new Date(Date.now() - 80 * 60 * 60 * 1000);
  const created = await prisma.task.create({
    data: {
      title: 'TEST — CRITICAL: system failure',
      referral_id: CRITICAL_REFERRAL_ID,
      status: 'OPEN',
      created_at: backdated,
    },
  });
  console.log(`[SEED] CRITICAL TEST TASK CREATED — id=${created.id} "${created.title}"`);
}
