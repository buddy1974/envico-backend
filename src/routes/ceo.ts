import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';
import { getTodayEvents } from '../lib/calendar';
import { draftEmail } from '../lib/gmail';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

type AuthUser = { id: number; role: string; email: string };

function getUser(request: FastifyRequest): AuthUser {
  return (request as FastifyRequest & { user?: AuthUser }).user ?? { id: 1, role: 'ADMIN', email: '' };
}

const CommandSchema = z.object({
  command: z.string().min(1).max(2000),
});

// ─── Action executors ─────────────────────────────────────────────────────────

async function execSystemStats() {
  const [openTasks, criticalTasks, openIncidents, complianceActions, overdueInvoices, activeServiceUsers, urgentEmails] =
    await Promise.all([
      prisma.task.count({ where: { status: { not: 'DONE' } } }),
      prisma.task.count({ where: { priority: 'CRITICAL', status: { not: 'DONE' } } }),
      prisma.incident.count({ where: { status: 'OPEN' } }),
      prisma.complianceCheck.count({ where: { status: { in: ['ACTION_REQUIRED', 'NON_COMPLIANT'] } } }),
      prisma.invoice.count({ where: { status: 'OVERDUE' } }),
      prisma.serviceUser.count({ where: { status: 'ACTIVE' } }),
      prisma.emailLog.count({ where: { priority: { in: ['urgent', 'high'] }, handled: false } }),
    ]);

  return { openTasks, criticalTasks, openIncidents, complianceActions, overdueInvoices, activeServiceUsers, urgentEmails };
}

async function execHrSummary() {
  const [staffCount, overdueTraining, expiringDbs, openApplications, complianceActions] = await Promise.all([
    prisma.staff.count(),
    prisma.trainingRecord.count({ where: { status: { in: ['OVERDUE', 'EXPIRED'] } } }),
    prisma.staffDocument.count({
      where: {
        type:        'DBS',
        status:      'VALID',
        expiry_date: { lte: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
      },
    }),
    prisma.recruitmentApplication.count({ where: { status: { in: ['NEW', 'SHORTLISTED', 'INTERVIEW'] } } }),
    prisma.complianceCheck.count({ where: { status: { in: ['ACTION_REQUIRED', 'NON_COMPLIANT'] } } }),
  ]);

  return { staffCount, overdueTraining, expiringDbs, openApplications, complianceActions };
}

async function execChaseInvoice(invoiceId?: number | null) {
  const where = invoiceId
    ? { id: invoiceId }
    : { status: 'OVERDUE' as const };

  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      service_user:   { select: { first_name: true, last_name: true } },
      funding_source: { select: { funder_name: true } },
    },
    orderBy: { due_date: 'asc' },
    take:    invoiceId ? 1 : 10,
  });

  // Generate chase text for each
  const chased = await Promise.all(
    invoices.map(async (inv) => {
      const funder = inv.funding_source?.funder_name ?? 'the funding authority';
      const user   = `${inv.service_user.first_name} ${inv.service_user.last_name}`;
      const amount = `£${Number(inv.amount_total).toFixed(2)}`;

      const res = await claude.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 400,
        system:     'You are writing on behalf of Envico Supported Living Ltd. Draft a professional, firm but polite invoice chase email.',
        messages:   [{
          role:    'user',
          content: `Write a 3-sentence invoice chase email to ${funder} for invoice ${inv.invoice_number}, amount ${amount}, for care provided to ${user}. The invoice is overdue.`,
        }],
      });

      return {
        invoice_number: inv.invoice_number,
        amount:         amount,
        service_user:   user,
        funder:         funder,
        due_date:       inv.due_date?.toLocaleDateString('en-GB'),
        chase_draft:    res.content[0].type === 'text' ? res.content[0].text : '',
      };
    }),
  );

  return chased;
}

async function execGenerateReport(type: string) {
  const stats = await execSystemStats();
  const hr    = await execHrSummary();

  const overdueInvoices = await prisma.invoice.findMany({
    where: { status: 'OVERDUE' },
    select: { invoice_number: true, amount_total: true, due_date: true },
    take: 5,
  });

  const recentIncidents = await prisma.incident.findMany({
    where:   { status: 'OPEN' },
    orderBy: { reported_at: 'desc' },
    take:    5,
    include: { service_user: { select: { first_name: true, last_name: true } } },
  });

  const prompt = `Generate a ${type} report for Envico Supported Living Ltd as at ${new Date().toLocaleDateString('en-GB')}.

System Data:
- Active service users: ${stats.activeServiceUsers}
- Open tasks: ${stats.openTasks} (${stats.criticalTasks} critical)
- Open incidents: ${stats.openIncidents}
- Compliance actions required: ${stats.complianceActions}
- Overdue invoices: ${stats.overdueInvoices}
- Urgent unhandled emails: ${stats.urgentEmails}

HR:
- Staff: ${hr.staffCount}
- Overdue training: ${hr.overdueTraining}
- DBS expiring (30 days): ${hr.expiringDbs}
- Open recruitment: ${hr.openApplications}

Recent open incidents: ${recentIncidents.map((i) => `${i.service_user.first_name} ${i.service_user.last_name} - ${i.type}`).join(', ') || 'None'}
Overdue invoices: ${overdueInvoices.map((i) => `${i.invoice_number} £${Number(i.amount_total).toFixed(2)}`).join(', ') || 'None'}

Write a professional report with sections: Executive Summary, Care Operations, Finance, HR & Compliance, Actions Required.`;

  const res = await claude.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    system:     'You are a report writer for the CEO of Envico Supported Living Ltd, a CQC-registered care provider.',
    messages:   [{ role: 'user', content: prompt }],
  });

  return res.content[0].type === 'text' ? res.content[0].text : '';
}

// ─── Command classifier ───────────────────────────────────────────────────────

const COMMAND_SYSTEM = `You are the AI command interpreter for Envico CareOS CEO Digital Office.

Interpret the natural language command and return ONLY valid JSON:
{
  "action": "draft_email" | "check_calendar" | "system_stats" | "chase_invoice" | "generate_report" | "hr_summary",
  "reasoning": "one sentence explaining what you understood",
  "params": {
    // draft_email: { "to": string, "subject": string, "context": string, "tone": "professional|formal|urgent|friendly" }
    // check_calendar: { "days": number }
    // system_stats: {}
    // chase_invoice: { "invoice_id": number | null }
    // generate_report: { "type": "weekly|monthly|incident|compliance|finance" }
    // hr_summary: {}
  }
}

Respond with valid JSON only. No markdown fences.`;

type CommandResult = {
  action:    string;
  reasoning: string;
  params:    Record<string, unknown>;
};

async function classifyCommand(command: string): Promise<CommandResult> {
  const res = await claude.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 512,
    system:     COMMAND_SYSTEM,
    messages:   [{ role: 'user', content: command }],
  });

  const text = res.content[0].type === 'text' ? res.content[0].text : '{}';
  try {
    return JSON.parse(text) as CommandResult;
  } catch {
    return { action: 'system_stats', reasoning: 'Could not parse command — showing system stats', params: {} };
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function ceoRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/ceo/briefing — full AI daily briefing
  fastify.post(
    '/api/ceo/briefing',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = getUser(request);

      // Gather all data in parallel (Google calendar is optional)
      const [stats, hr] = await Promise.all([execSystemStats(), execHrSummary()]);

      let calendarToday: Awaited<ReturnType<typeof getTodayEvents>> = [];
      let calendarConnected = true;
      try {
        calendarToday = await getTodayEvents(user.id);
      } catch {
        calendarConnected = false;
      }

      const urgentEmails = await prisma.emailLog.findMany({
        where:   { priority: { in: ['urgent', 'high'] }, handled: false },
        orderBy: { created_at: 'desc' },
        take:    5,
        select:  { id: true, from_email: true, subject: true, priority: true, summary: true },
      });

      const overdueInvoices = await prisma.invoice.findMany({
        where: { status: 'OVERDUE' },
        include: { service_user: { select: { first_name: true, last_name: true } } },
        take:  5,
      });

      const briefingPrompt = `Generate a concise morning briefing for the CEO of Envico Supported Living Ltd for ${new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}.

System:
- Active service users: ${stats.activeServiceUsers}
- Open tasks: ${stats.openTasks} (${stats.criticalTasks} CRITICAL)
- Open incidents: ${stats.openIncidents}
- Compliance actions: ${stats.complianceActions}

Finance:
- Overdue invoices: ${stats.overdueInvoices} totalling £${overdueInvoices.reduce((s, i) => s + Number(i.amount_total), 0).toFixed(2)}

HR:
- Staff: ${hr.staffCount} | Overdue training: ${hr.overdueTraining} | DBS expiring: ${hr.expiringDbs} | Open recruitment: ${hr.openApplications}

Urgent emails needing attention: ${urgentEmails.length}
${urgentEmails.map((e) => `- [${e.priority.toUpperCase()}] ${e.subject} from ${e.from_email}`).join('\n')}

Today's calendar: ${calendarConnected ? calendarToday.map((e) => `${e.start} - ${e.summary}`).join(', ') || 'No events' : 'Calendar not connected'}

Write a professional briefing with: Good morning greeting, Today's priorities, Items needing immediate action, Key metrics snapshot. Keep it to 3-4 paragraphs.`;

      const res = await claude.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     'You are the personal AI assistant for the CEO of Envico Supported Living Ltd.',
        messages:   [{ role: 'user', content: briefingPrompt }],
      });

      const briefing = res.content[0].type === 'text' ? res.content[0].text : '';

      return reply.code(200).send({
        success:           true,
        date:              new Date().toLocaleDateString('en-GB'),
        briefing,
        stats,
        hr,
        calendar_today:    calendarToday,
        calendar_connected: calendarConnected,
        urgent_emails:     urgentEmails,
        overdue_invoices:  overdueInvoices.length,
      });
    }
  );

  // POST /api/ceo/command — natural language command handler
  fastify.post(
    '/api/ceo/command',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CommandSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const user = getUser(request);
      const { command } = parsed.data;

      // Step 1: classify
      const classified = await classifyCommand(command);
      const { action, reasoning, params } = classified;

      // Step 2: execute
      let result: unknown;
      let draft: unknown = null;

      try {
        switch (action) {
          case 'system_stats':
            result = await execSystemStats();
            break;

          case 'hr_summary':
            result = await execHrSummary();
            break;

          case 'chase_invoice': {
            const invoiceId = typeof params.invoice_id === 'number' ? params.invoice_id : null;
            result = await execChaseInvoice(invoiceId);
            break;
          }

          case 'generate_report': {
            const type = (params.type as string) || 'weekly';
            result = await execGenerateReport(type);
            break;
          }

          case 'check_calendar': {
            const days = Math.min(30, Number(params.days ?? 7));
            try {
              const { getWeekEvents } = await import('../lib/calendar');
              result = await getWeekEvents(user.id);
            } catch {
              result = { error: 'Calendar not connected', hint: 'Visit GET /api/calendar/auth' };
            }
            break;
          }

          case 'draft_email': {
            const to      = (params.to      as string) || '';
            const subject = (params.subject as string) || 'Message from Envico';
            const context = (params.context as string) || command;
            const tone    = (params.tone    as string) || 'professional';

            const emailRes = await claude.messages.create({
              model:      'claude-sonnet-4-6',
              max_tokens: 600,
              system:     `You are an email writer for Envico Supported Living Ltd. Write a ${tone} email.`,
              messages:   [{ role: 'user', content: `Write email to: ${to}\nSubject hint: ${subject}\nContext: ${context}` }],
            });

            const body = emailRes.content[0].type === 'text' ? emailRes.content[0].text : '';
            const emailDraft: Record<string, string | null> = { to, subject, body, gmail_draft_id: null };

            // Optionally save as Gmail draft if connected
            try {
              const savedDraft = await draftEmail(user.id, { to, subject, body });
              emailDraft.gmail_draft_id = savedDraft.draft_id ?? null;
            } catch {
              // Gmail not connected — return draft text only
            }

            draft  = emailDraft;
            result = 'Email draft created';
            break;
          }

          default:
            result = await execSystemStats();
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg, action, reasoning });
      }

      return reply.code(200).send({
        success: true,
        command,
        action,
        reasoning,
        result,
        draft,
      });
    }
  );
}
