import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 're_placeholder'
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = process.env.FROM_EMAIL ?? 'ops@envicosl.co.uk';

export type EmailTemplate =
  | 'REFERRAL_ACK'
  | 'INCIDENT_ALERT'
  | 'INVOICE_CHASE'
  | 'DBS_EXPIRY'
  | 'TRAINING_REMINDER'
  | 'COMPLIANCE_ALERT'
  | 'GENERAL';

export interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  template?: EmailTemplate;
  data?: Record<string, unknown>;
}

function buildHtml(template: EmailTemplate, subject: string, body: string, data?: Record<string, unknown>): string {
  const colours: Record<EmailTemplate, string> = {
    REFERRAL_ACK:        '#2563eb',
    INCIDENT_ALERT:      '#dc2626',
    INVOICE_CHASE:       '#d97706',
    DBS_EXPIRY:          '#7c3aed',
    TRAINING_REMINDER:   '#0891b2',
    COMPLIANCE_ALERT:    '#dc2626',
    GENERAL:             '#1e293b',
  };

  const accent = colours[template] ?? '#1e293b';
  const bodyLines = body.replace(/\n/g, '<br>');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <tr><td style="background:${accent};padding:24px 32px">
          <h1 style="margin:0;color:#ffffff;font-size:20px;font-weight:700">Envico CareOS</h1>
          <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:13px">Envico Supported Living Ltd · Hayes, Middlesex</p>
        </td></tr>
        <tr><td style="padding:32px">
          <h2 style="margin:0 0 16px;color:#1e293b;font-size:18px">${subject}</h2>
          <div style="color:#475569;font-size:14px;line-height:1.6">${bodyLines}</div>
          ${data ? `<div style="margin-top:24px;padding:16px;background:#f1f5f9;border-radius:6px;font-size:12px;color:#64748b;font-family:monospace">${JSON.stringify(data, null, 2).replace(/\n/g, '<br>').replace(/ /g, '&nbsp;')}</div>` : ''}
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e2e8f0;background:#f8fafc">
          <p style="margin:0;color:#94a3b8;font-size:12px">This is an automated message from Envico CareOS. Do not reply to this email.<br>Envico Supported Living Ltd · CQC Registered · Hayes UB3</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function sendEmail(params: SendEmailParams): Promise<{ success: boolean; error?: string }> {
  const { to, subject, body, template = 'GENERAL', data } = params;

  if (!resend) {
    console.log(`[emailService] RESEND not configured — would send to ${to}: ${subject}`);
    return { success: true };
  }

  try {
    const html = buildHtml(template, subject, body, data);
    const result = await resend.emails.send({
      from: FROM,
      to,
      subject,
      html,
      text: body,
    });

    if (result.error) {
      console.error('[emailService] Resend error:', result.error);
      return { success: false, error: result.error.message };
    }

    console.log(`[emailService] Sent "${subject}" to ${to}`);
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[emailService] Exception:', msg);
    return { success: false, error: msg };
  }
}
