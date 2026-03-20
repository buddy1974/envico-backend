import { sendEmail, EmailTemplate } from './emailService';
import { logActivity } from './activityService';

export interface NotifyParams {
  type: EmailTemplate;
  recipient: string;
  subject: string;
  message: string;
  data?: Record<string, unknown>;
  entity?: string;
  entity_id?: number;
}

export async function notify(params: NotifyParams): Promise<void> {
  const { type, recipient, subject, message, data, entity = 'SYSTEM', entity_id = 0 } = params;

  try {
    const result = await sendEmail({
      to: recipient,
      subject,
      body: message,
      template: type,
      data,
    });

    await logActivity(
      entity,
      entity_id,
      'NOTIFICATION_SENT',
      JSON.stringify({ type, recipient, subject, success: result.success, error: result.error })
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[notificationService] Failed to notify:', msg);
    // Do NOT rethrow — notifications must never crash the main flow
    await logActivity(
      entity,
      entity_id,
      'NOTIFICATION_FAILED',
      JSON.stringify({ type, recipient, subject, error: msg })
    ).catch(() => {});
  }
}
