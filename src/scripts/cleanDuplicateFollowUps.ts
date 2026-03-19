import prisma from '../db/prisma';

async function cleanDuplicateFollowUps() {
  const followUps = await prisma.task.findMany({
    where: { title: { contains: 'Follow-up', mode: 'insensitive' } },
    orderBy: { id: 'asc' },
  });

  // Group by referral_id
  const byReferral = new Map<string, typeof followUps>();
  for (const task of followUps) {
    const group = byReferral.get(task.referral_id!) ?? [];
    group.push(task);
    byReferral.set(task.referral_id!, group);
  }

  let deleted = 0;
  for (const [referral_id, tasks] of byReferral) {
    if (tasks.length <= 1) continue;

    // Keep lowest ID (oldest), delete the rest
    const [keep, ...duplicates] = tasks;
    console.log(`Referral ${referral_id}: keeping task ${keep.id}, removing ${duplicates.length} duplicate(s)`);

    for (const task of duplicates) {
      await prisma.task.delete({ where: { id: task.id } });
      console.log('DELETED DUPLICATE TASK', task.id);
      deleted++;
    }
  }

  console.log(`Done. ${deleted} duplicate(s) removed.`);
  await prisma.$disconnect();
}

cleanDuplicateFollowUps().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
