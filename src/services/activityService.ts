import prisma from '../db/prisma';

export async function logActivity(
  entity: string,
  entity_id: number,
  action: string,
  details: string
): Promise<void> {
  await prisma.activityLog.create({
    data: { entity, entity_id, action, details },
  });
}
