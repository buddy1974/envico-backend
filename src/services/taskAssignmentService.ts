import prisma from '../db/prisma';
import { logActivity } from './activityService';
import { emit } from '../utils/eventBus';

export async function assignTask(taskId: number, staffId: number) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) return { error: 'TASK_NOT_FOUND' } as const;

  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) return { error: 'STAFF_NOT_FOUND' } as const;

  const [assignment] = await prisma.$transaction([
    prisma.taskAssignment.create({
      data: { task_id: taskId, staff_id: staffId, status: 'ASSIGNED' },
    }),
    prisma.task.update({
      where: { id: taskId },
      data: { status: 'ASSIGNED' },
    }),
  ]);

  await logActivity('TASK', taskId, 'ASSIGNED', JSON.stringify({ staff_id: staffId }));
  emit('TASK_ASSIGNED', { taskId, staffId });

  return { assignment } as const;
}

export async function getAssignmentsByTask(taskId: number) {
  return prisma.taskAssignment.findMany({
    where: { task_id: taskId },
    include: { staff: true },
    orderBy: { assigned_at: 'desc' },
  });
}
