import prisma from '../db/prisma';
import { isValidStatusTransition } from '../utils/taskStatusValidator';
import { logActivity } from './activityService';
import { emit } from '../utils/eventBus';

// ─── SLA deadlines per priority (Task 17) ────────────────────────────────────
function computeDeadline(priority: string): Date {
  const now = Date.now();
  const MS = { CRITICAL: 60 * 60 * 1000, HIGH: 6 * 60 * 60 * 1000, NORMAL: 24 * 60 * 60 * 1000 };
  return new Date(now + (MS[priority as keyof typeof MS] ?? MS.NORMAL));
}

// ─── Auto-assignment per priority (Task 16) ───────────────────────────────────
function autoAssign(priority: string): string {
  if (priority === 'CRITICAL') return 'admin';
  if (priority === 'HIGH') return 'ops';
  return 'staff';
}

// ─── Task 1 / Task 3: Create task from n8n webhook payload ───────────────────
export async function createTaskFromWebhook(payload: {
  title: string;
  description?: string;
  priority: string;
  referral_id?: string;
  escalation_id?: number;
}) {
  const priority = payload.priority ?? 'NORMAL';
  const urgent = priority === 'CRITICAL';
  const assignedTo = autoAssign(priority);
  const deadline = computeDeadline(priority);

  if (urgent) {
    console.log(`[ENVICO] CRITICAL ALERT — task incoming: ${payload.title}`);
  }

  const task = await prisma.task.create({
    data: {
      title: payload.title,
      description: payload.description ?? null,
      priority,
      status: 'PENDING',
      assignedTo,
      referral_id: payload.referral_id ?? null,
      deadline,
      urgent,
      source: 'N8N',
    },
  });

  // Task 10 — log every workflow execution
  await prisma.log.create({
    data: {
      message: `Task created from n8n: ${task.title}`,
      level: urgent ? 'CRITICAL' : priority === 'HIGH' ? 'WARNING' : 'INFO',
      payload: { task_id: task.id, priority, assignedTo, escalation_id: payload.escalation_id },
      source: 'N8N',
    },
  });

  await logActivity('TASK', task.id, 'CREATED', JSON.stringify({ title: task.title, priority, source: 'N8N' }));
  emit('TASK_CREATED', { id: task.id, title: task.title, referral_id: task.referral_id });

  return task;
}

// ─── Existing: create task from referral flow ─────────────────────────────────
export async function createTask(referral_id: string, title?: string, ai_generated = false) {
  const task = await prisma.task.create({
    data: {
      title: title ?? `Review referral — ${referral_id}`,
      status: 'PENDING',
      priority: 'NORMAL',
      referral_id,
      ai_generated,
      assignedTo: 'staff',
      deadline: computeDeadline('NORMAL'),
      source: 'MANUAL',
    },
  });

  await logActivity('TASK', task.id, 'CREATED', JSON.stringify({ title: task.title, referral_id }));
  emit('TASK_CREATED', { id: task.id, title: task.title, referral_id });

  return task;
}

// ─── Existing: update task status ────────────────────────────────────────────
export async function updateTaskStatus(taskId: number, newStatus: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });

  if (!task) return { error: 'NOT_FOUND' } as const;

  if (!isValidStatusTransition(task.status, newStatus)) {
    return { error: 'INVALID_TRANSITION', current: task.status, requested: newStatus } as const;
  }

  const updated = await prisma.task.update({
    where: { id: taskId },
    data: { status: newStatus },
  });

  await logActivity('TASK', taskId, 'STATUS_CHANGED', JSON.stringify({ from: task.status, to: newStatus }));
  emit('TASK_STATUS_CHANGED', { taskId, from: task.status, to: newStatus, referral_id: task.referral_id });

  // Escalation engine (Task 18) — if not done, escalate after SLA breach
  if (newStatus !== 'DONE' && task.deadline && new Date() > task.deadline) {
    const newPriority =
      task.priority === 'NORMAL' ? 'HIGH' :
      task.priority === 'HIGH' ? 'CRITICAL' : 'CRITICAL';

    await prisma.task.update({ where: { id: taskId }, data: { priority: newPriority } });
    await prisma.log.create({
      data: {
        message: `Task ${taskId} escalated: ${task.priority} → ${newPriority}`,
        level: 'CRITICAL',
        payload: { task_id: taskId, from: task.priority, to: newPriority },
        source: 'SYSTEM',
      },
    });
    console.log(`[ENVICO] ESCALATION ENGINE — Task ${taskId}: ${task.priority} → ${newPriority}`);
  }

  if (newStatus === 'DONE' && task.referral_id) {
    const lowerTitle = task.title.toLowerCase();

    if (lowerTitle.includes('follow-up')) {
      console.log('AUTO TASK SKIPPED — end of workflow', { taskId, title: task.title });
    } else if (lowerTitle.includes('review referral')) {
      const existing = await prisma.task.findFirst({
        where: {
          referral_id: task.referral_id,
          title: { contains: 'Follow-up', mode: 'insensitive' },
        },
      });

      if (!existing) {
        const newTask = await prisma.task.create({
          data: {
            title: `Follow-up for ${task.referral_id}`,
            status: 'PENDING',
            priority: 'NORMAL',
            referral_id: task.referral_id,
            assignedTo: 'staff',
            deadline: computeDeadline('NORMAL'),
            source: 'MANUAL',
          },
        });
        console.log('AUTO FOLLOW-UP CREATED', newTask);
        await logActivity('TASK', newTask.id, 'CREATED', JSON.stringify({ auto: true, referral_id: newTask.referral_id }));
        emit('TASK_CREATED', { id: newTask.id, title: newTask.title, referral_id: newTask.referral_id });
      }
    }
  }

  return { task: updated } as const;
}
