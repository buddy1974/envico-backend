import { on } from '../utils/eventBus';
import { logActivity } from '../services/activityService';
import { createTask } from '../services/taskService';
import { broadcast } from '../realtime/socket';
import { notify } from '../services/notificationService';
import prisma from '../db/prisma';

interface TaskCreatedPayload {
  id: number;
  title: string;
  referral_id: string;
}

interface TaskAssignedPayload {
  taskId: number;
  staffId: number;
}

interface TaskStatusChangedPayload {
  taskId: number;
  from: string;
  to: string;
  referral_id: string;
}

interface ReferralCreatedPayload {
  id: number;
  referral_id: string;
  referrer_contact?: string;
  referrer_name?: string;
  service_user_name?: string;
  support_needs?: string;
}

interface IncidentCreatedPayload {
  id: number;
  service_user_id: number;
  type: string;
  severity: string;
  description: string;
  reported_by: string;
}

interface DbsExpiringPayload {
  staff_id: number;
  staff_name: string;
  staff_email: string;
  expiry_date: string;
  days_remaining: number;
}

interface TrainingOverduePayload {
  staff_id: number;
  staff_name: string;
  staff_email: string;
  training_name: string;
}

interface ComplianceActionPayload {
  id: number;
  title: string;
  check_type: string;
  assigned_to: string;
  due_date: string;
}

export function registerHandlers(): void {

  // ─── Phase 1 handlers ────────────────────────────────────────────────────

  on<TaskCreatedPayload>('TASK_CREATED', (payload) => {
    broadcast('TASK_CREATED', payload);
  });

  on<TaskAssignedPayload>('TASK_ASSIGNED', async (payload) => {
    broadcast('TASK_ASSIGNED', payload);
    await logActivity('TASK', payload.taskId, 'NOTIFIED', JSON.stringify({ message: 'Staff notified' }));
  });

  on<TaskStatusChangedPayload>('TASK_STATUS_CHANGED', async (payload) => {
    broadcast('TASK_STATUS_CHANGED', payload);
    if (payload.to === 'COMPLETED') {
      const followUp = await createTask(payload.referral_id, `Follow-up for ${payload.referral_id}`);
      await logActivity(
        'TASK',
        payload.taskId,
        'FOLLOW_UP_CREATED',
        JSON.stringify({ follow_up_task_id: followUp.id })
      );
    }
  });

  on<ReferralCreatedPayload>('REFERRAL_CREATED', async (payload) => {
    broadcast('REFERRAL_CREATED', payload);

    // Send acknowledgement email to referrer
    if (payload.referrer_contact && payload.referrer_contact.includes('@')) {
      await notify({
        type: 'REFERRAL_ACK',
        recipient: payload.referrer_contact,
        subject: `Referral Received — ${payload.service_user_name ?? payload.referral_id}`,
        message: `Dear ${payload.referrer_name ?? 'Colleague'},\n\nThank you for submitting a referral to Envico Supported Living.\n\nWe have received your referral for ${payload.service_user_name ?? 'the individual'} (Ref: ${payload.referral_id}) and our team will review it within 2 working days.\n\nIf you have any urgent concerns, please contact us directly.\n\nKind regards,\nEnvico Admissions Team`,
        data: { referral_id: payload.referral_id, support_needs: payload.support_needs },
        entity: 'REFERRAL',
        entity_id: payload.id,
      });
    }
  });

  // ─── Phase 7 handlers ────────────────────────────────────────────────────

  on<IncidentCreatedPayload>('INCIDENT_CREATED', async (payload) => {
    broadcast('INCIDENT_CREATED', payload);

    // Get service user name
    let serviceUserName = `ID ${payload.service_user_id}`;
    try {
      const su = await prisma.serviceUser.findUnique({ where: { id: payload.service_user_id }, select: { first_name: true, last_name: true } });
      if (su) serviceUserName = `${su.first_name} ${su.last_name}`;
    } catch { /* non-fatal */ }

    // Get ADMIN/MANAGER emails
    const managers = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'MANAGER'] }, is_active: true },
      select: { email: true, name: true },
    });

    const severityLabel = payload.severity === 'CRITICAL' || payload.severity === 'HIGH' ? '🚨 URGENT' : 'ℹ️';

    for (const manager of managers) {
      await notify({
        type: 'INCIDENT_ALERT',
        recipient: manager.email,
        subject: `${severityLabel} Incident Report — ${serviceUserName} — ${payload.type}`,
        message: `An incident has been reported requiring your attention.\n\nService User: ${serviceUserName}\nType: ${payload.type}\nSeverity: ${payload.severity}\nReported By: ${payload.reported_by}\n\nDetails:\n${payload.description}\n\nPlease log into Envico CareOS to review and take action.`,
        data: { incident_id: payload.id, severity: payload.severity, type: payload.type },
        entity: 'INCIDENT',
        entity_id: payload.id,
      });
    }
  });

  on<DbsExpiringPayload>('DBS_EXPIRING', async (payload) => {
    // Notify the staff member
    await notify({
      type: 'DBS_EXPIRY',
      recipient: payload.staff_email,
      subject: `Action Required: Your DBS Certificate Expires in ${payload.days_remaining} Days`,
      message: `Dear ${payload.staff_name},\n\nYour DBS (Disclosure and Barring Service) certificate is due to expire on ${payload.expiry_date}.\n\nYou have ${payload.days_remaining} days to renew. Please contact your manager to arrange renewal as soon as possible.\n\nFailure to maintain a valid DBS may affect your ability to work.\n\nKind regards,\nEnvico HR Team`,
      entity: 'STAFF',
      entity_id: payload.staff_id,
    });

    // Notify managers
    const managers = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'MANAGER'] }, is_active: true },
      select: { email: true },
    });
    for (const m of managers) {
      await notify({
        type: 'DBS_EXPIRY',
        recipient: m.email,
        subject: `Staff Alert: ${payload.staff_name} DBS Expiring in ${payload.days_remaining} Days`,
        message: `This is an automated alert from Envico CareOS.\n\nStaff Member: ${payload.staff_name}\nDBS Expiry: ${payload.expiry_date}\nDays Remaining: ${payload.days_remaining}\n\nPlease arrange DBS renewal as a priority.`,
        entity: 'STAFF',
        entity_id: payload.staff_id,
      });
    }
  });

  on<TrainingOverduePayload>('TRAINING_OVERDUE', async (payload) => {
    await notify({
      type: 'TRAINING_REMINDER',
      recipient: payload.staff_email,
      subject: `Overdue Training: ${payload.training_name}`,
      message: `Dear ${payload.staff_name},\n\nOur records show that your training "${payload.training_name}" is now overdue.\n\nPlease complete this training as soon as possible. Some training (including Oliver McGowan) is a legal requirement under UK care regulations.\n\nPlease contact your manager to arrange this training immediately.\n\nKind regards,\nEnvico Training Team`,
      entity: 'STAFF',
      entity_id: payload.staff_id,
    });

    const managers = await prisma.user.findMany({
      where: { role: { in: ['ADMIN', 'MANAGER'] }, is_active: true },
      select: { email: true },
    });
    for (const m of managers) {
      await notify({
        type: 'TRAINING_REMINDER',
        recipient: m.email,
        subject: `Training Overdue: ${payload.staff_name} — ${payload.training_name}`,
        message: `Staff Member: ${payload.staff_name}\nTraining: ${payload.training_name}\nStatus: OVERDUE\n\nPlease ensure this is resolved promptly. Overdue mandatory training is a CQC compliance risk.`,
        entity: 'STAFF',
        entity_id: payload.staff_id,
      });
    }
  });

  on<ComplianceActionPayload>('COMPLIANCE_ACTION_REQUIRED', async (payload) => {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', is_active: true },
      select: { email: true },
    });
    for (const admin of admins) {
      await notify({
        type: 'COMPLIANCE_ALERT',
        recipient: admin.email,
        subject: `Compliance Action Required: ${payload.title}`,
        message: `A compliance check requires immediate attention.\n\nCheck: ${payload.title}\nType: ${payload.check_type}\nAssigned To: ${payload.assigned_to}\nDue: ${payload.due_date}\n\nThis item is flagged as ACTION_REQUIRED and must be resolved before your next CQC review.\n\nPlease log into Envico CareOS to manage this item.`,
        data: { compliance_id: payload.id, check_type: payload.check_type },
        entity: 'COMPLIANCE',
        entity_id: payload.id,
      });
    }
  });
}
