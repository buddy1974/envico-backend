import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import { sendEmail } from '../services/emailService';
import { notify } from '../services/notificationService';
import { askAssistant } from '../ai/assistantService';
import { logActivity } from '../services/activityService';
import prisma from '../db/prisma';

const DraftEmailSchema = z.object({
  purpose:  z.string().min(1),   // e.g. "chase invoice INV-2026-0042"
  to_name:  z.string().optional(),
  context:  z.string().optional(),
});

const SendReportSchema = z.object({
  recipient_email: z.string().email(),
});

export async function automationRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/automation/draft-email — AI drafts email, returns draft
  fastify.post(
    '/api/automation/draft-email',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = DraftEmailSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { purpose, to_name, context } = parsed.data;
      const prompt = `Draft a professional email for the following purpose: ${purpose}${to_name ? `. The recipient is ${to_name}` : ''}${context ? `. Additional context: ${context}` : ''}. Write only the email body (no subject line). Be professional, concise, and appropriate for a UK care organisation.`;

      const result = await askAssistant(prompt, 'GENERAL');

      return reply.code(200).send({
        success: true,
        draft: result.answer,
        model: result.model,
      });
    }
  );

  // POST /api/automation/send-report — generates and emails weekly summary
  fastify.post(
    '/api/automation/send-report',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SendReportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const [
        totalUsers, activeUsers, openIncidents, openTasks, criticalTasks,
        activeCompliance, nonCompliant, totalInvoices, overdueInvoices,
      ] = await Promise.all([
        prisma.serviceUser.count(),
        prisma.serviceUser.count({ where: { status: 'ACTIVE' } }),
        prisma.incident.count({ where: { status: 'OPEN' } }),
        prisma.task.count({ where: { status: { not: 'DONE' } } }),
        prisma.task.count({ where: { priority: 'CRITICAL', status: { not: 'DONE' } } }),
        prisma.complianceCheck.count({ where: { status: { not: 'COMPLIANT' } } }),
        prisma.complianceCheck.count({ where: { status: 'NON_COMPLIANT' } }),
        prisma.invoice.count(),
        prisma.invoice.count({ where: { status: 'OVERDUE' } }),
      ]);

      const summaryData = {
        service_users: { total: totalUsers, active: activeUsers },
        tasks: { open: openTasks, critical: criticalTasks },
        incidents: { open: openIncidents },
        compliance: { pending: activeCompliance, non_compliant: nonCompliant },
        invoices: { total: totalInvoices, overdue: overdueInvoices },
      };

      const aiSummary = await askAssistant(
        `Generate a concise weekly summary report for the CEO based on this data: ${JSON.stringify(summaryData)}. Highlight any urgent items, risks, and positive indicators. Keep it to 3-4 paragraphs.`,
        'GENERAL'
      );

      const reportBody = `Weekly Envico CareOS Summary\n\n${aiSummary.answer}\n\n---\nRaw Data:\n${JSON.stringify(summaryData, null, 2)}`;

      await sendEmail({
        to: parsed.data.recipient_email,
        subject: `Envico Weekly Summary — ${new Date().toLocaleDateString('en-GB')}`,
        body: reportBody,
        template: 'GENERAL',
      });

      await logActivity('SYSTEM', 0, 'WEEKLY_REPORT_SENT', JSON.stringify({ recipient: parsed.data.recipient_email }));

      return reply.code(200).send({ success: true, summary: summaryData, ai_narrative: aiSummary.answer });
    }
  );

  // POST /api/automation/chase-invoice/:id
  fastify.post<{ Params: { id: string } }>(
    '/api/automation/chase-invoice/:id',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: {
          service_user: { select: { first_name: true, last_name: true } },
          funding_source: { select: { funder_name: true } },
        },
      });

      if (!invoice) return reply.code(404).send({ success: false, error: 'Invoice not found' });

      const funderName = invoice.funding_source?.funder_name ?? 'Funder';
      const serviceUserName = `${invoice.service_user.first_name} ${invoice.service_user.last_name}`;

      const chaseBody = `Dear ${funderName},\n\nI am writing regarding invoice ${invoice.invoice_number} for care services provided to ${serviceUserName} for the period ${invoice.period_start.toLocaleDateString('en-GB')} to ${invoice.period_end.toLocaleDateString('en-GB')}.\n\nThe total amount due is £${invoice.amount_total} and this invoice is currently outstanding.\n\nPlease arrange payment at your earliest convenience. If you have any queries, please do not hesitate to contact us.\n\nKind regards,\nEnvico Finance Team`;

      // In production: send to funder. Currently logs the chase.
      await logActivity('INVOICE', id, 'CHASE_SENT', JSON.stringify({ invoice_number: invoice.invoice_number, funder: funderName }));

      await prisma.invoice.update({ where: { id }, data: { status: 'OVERDUE' } });

      return reply.code(200).send({ success: true, invoice_number: invoice.invoice_number, chase_body: chaseBody });
    }
  );

  // POST /api/automation/rota-reminder — sends rota reminder to all staff
  fastify.post(
    '/api/automation/rota-reminder',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const webhookUrl = process.env.N8N_ROTA_WEBHOOK;
      if (webhookUrl) {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trigger: 'MANUAL_ROTA_REMINDER', timestamp: new Date().toISOString() }),
        });
      }

      await logActivity('SYSTEM', 0, 'ROTA_REMINDER_TRIGGERED', JSON.stringify({ webhook: !!webhookUrl }));

      return reply.code(200).send({ success: true, message: 'Rota reminder triggered' });
    }
  );

  // GET /api/automation/dashboard
  fastify.get(
    '/api/automation/dashboard',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [
        emailsSent, emailsFailed, chasesSent, reportsSent,
        pendingInvoices, overdueCompliance, expiringDbs,
      ] = await Promise.all([
        prisma.activityLog.count({ where: { action: 'NOTIFICATION_SENT' } }),
        prisma.activityLog.count({ where: { action: 'NOTIFICATION_FAILED' } }),
        prisma.activityLog.count({ where: { action: 'CHASE_SENT' } }),
        prisma.activityLog.count({ where: { action: 'WEEKLY_REPORT_SENT' } }),
        prisma.invoice.count({ where: { status: { in: ['SENT', 'OVERDUE'] } } }),
        prisma.complianceCheck.count({ where: { status: 'ACTION_REQUIRED' } }),
        prisma.staffDocument.count({
          where: {
            type: 'DBS',
            status: 'VALID',
            expiry_date: { lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
          },
        }),
      ]);

      return reply.code(200).send({
        success: true,
        dashboard: {
          notifications: { sent: emailsSent, failed: emailsFailed },
          automation: { invoice_chases: chasesSent, reports_sent: reportsSent },
          alerts: {
            pending_invoices: pendingInvoices,
            overdue_compliance: overdueCompliance,
            expiring_dbs: expiringDbs,
          },
        },
      });
    }
  );
}
