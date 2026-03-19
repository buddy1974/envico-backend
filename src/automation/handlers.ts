import { on } from '../utils/eventBus';
import { logActivity } from '../services/activityService';
import { createTask } from '../services/taskService';
import { broadcast } from '../realtime/socket';

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
}

export function registerHandlers(): void {
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

  on<ReferralCreatedPayload>('REFERRAL_CREATED', (payload) => {
    broadcast('REFERRAL_CREATED', payload);
  });
}
