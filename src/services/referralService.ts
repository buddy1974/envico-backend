import prisma from '../db/prisma';
import { generateReferralId } from '../utils/generateReferralId';
import { logActivity } from './activityService';
import { emit } from '../utils/eventBus';
import { analyzeReferral } from '../ai/aiService';

export interface CreateReferralInput {
  service_user_name: string;
  dob: Date;
  referral_source: string;
  referrer_name: string;
  referrer_contact: string;
  support_needs: string;
  urgency_level: string;
}

export async function createReferral(input: CreateReferralInput) {
  let referral_id = generateReferralId();

  // Ensure uniqueness — retry on collision (extremely rare)
  let attempts = 0;
  while (attempts < 5) {
    const existing = await prisma.referral.findUnique({ where: { referral_id } });
    if (!existing) break;
    referral_id = generateReferralId();
    attempts++;
  }

  // AI analysis (deterministic rule engine)
  const analysis = analyzeReferral({
    support_needs: input.support_needs,
    urgency_level: input.urgency_level,
    referral_source: input.referral_source,
  });

  const { referral, task, staff } = await prisma.$transaction(async (tx) => {
    const created = await tx.referral.create({
      data: {
        referral_id,
        service_user_name: input.service_user_name,
        dob: input.dob,
        referral_source: input.referral_source,
        referrer_name: input.referrer_name,
        referrer_contact: input.referrer_contact,
        support_needs: input.support_needs,
        urgency_level: input.urgency_level,
        status: 'NEW',
        priority_score: analysis.priority_score,
        risk_flags: analysis.risk_flags,
      },
    });

    const createdTask = await tx.task.create({
      data: {
        title: `Review referral — ${referral_id}`,
        status: 'OPEN',
        referral_id,
        ai_generated: false,
      },
    });

    const assignedStaff = await tx.staff.findFirst();
    if (!assignedStaff) throw new Error('No staff available to assign task');

    await tx.taskAssignment.create({
      data: {
        task_id: createdTask.id,
        staff_id: assignedStaff.id,
        status: 'ASSIGNED',
      },
    });

    return { referral: created, task: createdTask, staff: assignedStaff };
  });

  await logActivity('REFERRAL', referral.id, 'CREATED', JSON.stringify({ referral_id: referral.referral_id }));
  await logActivity('TASK', task.id, 'CREATED', JSON.stringify({ title: task.title, referral_id }));
  await logActivity('TASK', task.id, 'ASSIGNED', JSON.stringify({ staff_id: staff.id }));
  await logActivity(
    'REFERRAL',
    referral.id,
    'AI_ANALYZED_REFERRAL',
    JSON.stringify({ priority_score: analysis.priority_score, risk_flags: analysis.risk_flags })
  );

  emit('REFERRAL_CREATED', { id: referral.id, referral_id: referral.referral_id });
  emit('TASK_CREATED', { id: task.id, title: task.title, referral_id });
  emit('TASK_ASSIGNED', { taskId: task.id, staffId: staff.id });

  // Auto-create AI-suggested tasks (skip the first — it's the base review task already created)
  const aiTasks = analysis.suggested_tasks.slice(1);
  for (const title of aiTasks) {
    const aiTask = await prisma.task.create({
      data: { title, status: 'OPEN', referral_id, ai_generated: true },
    });
    await logActivity('TASK', aiTask.id, 'AI_CREATED_TASK', JSON.stringify({ title, referral_id }));
    emit('TASK_CREATED', { id: aiTask.id, title: aiTask.title, referral_id });
  }

  return { ...referral, ai_analysis: analysis };
}
