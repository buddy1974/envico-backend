import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Schemas ─────────────────────────────────────────────────────────────────

const ClassifyEmailSchema = z.object({
  from_email: z.string().email(),
  from_name:  z.string().optional(),
  subject:    z.string().min(1).max(500),
  body:       z.string().min(1).max(20000),
  source:     z.string().default('MANUAL'),
});

const HandleSchema = z.object({
  handled_by: z.string().min(1),
  notes:      z.string().optional(),
});

const ComposeSchema = z.object({
  to:           z.string().email(),
  subject_hint: z.string().min(1).max(300),
  context:      z.string().min(1).max(2000),
  tone:         z.enum(['professional', 'friendly', 'formal', 'urgent']).default('professional'),
});

// ─── AI classification prompt ─────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You are an AI email classifier for Envico Supported Living Ltd, a CQC-registered supported living provider in Hayes, Middlesex.

Classify the incoming email and return ONLY valid JSON with this exact structure:
{
  "category": string,     // One of: REFERRAL, COMPLAINT, SAFEGUARDING, COMPLIANCE, INVOICE, HR, GENERAL_ENQUIRY, FAMILY_CONTACT, SUPPLIER, STAFF_ISSUE, CQC, LOCAL_AUTHORITY, NHS, INTERNAL
  "priority": string,     // One of: urgent, high, normal, low
  "department": string,   // One of: CARE, FINANCE, HR, COMPLIANCE, MANAGEMENT, ADMIN
  "summary": string,      // 1-2 sentence plain English summary of the email
  "suggested_reply": string  // A professional suggested reply draft (3-6 sentences)
}

Priority rules:
- urgent: safeguarding concerns, CQC inspector contact, complaints about harm, medical emergencies
- high: new referrals, complaints, compliance deadlines, invoice disputes, local authority contact
- normal: general enquiries, family contact, supplier comms, routine HR
- low: newsletters, marketing, non-urgent admin

Always respond with valid JSON only. No markdown, no explanations.`;

async function classifyEmail(subject: string, body: string, fromEmail: string, fromName?: string) {
  const prompt = `From: ${fromName ?? fromEmail} <${fromEmail}>
Subject: ${subject}

${body}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: CLASSIFY_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';

  try {
    return JSON.parse(text) as {
      category: string;
      priority: string;
      department: string;
      summary: string;
      suggested_reply: string;
    };
  } catch {
    return {
      category: 'GENERAL_ENQUIRY',
      priority: 'normal',
      department: 'ADMIN',
      summary: 'Unable to classify — review manually.',
      suggested_reply: 'Thank you for your email. A member of our team will be in touch shortly.',
    };
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function emailRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/email/classify — receive + classify email, save to DB
  fastify.post(
    '/api/email/classify',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ClassifyEmailSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { from_email, from_name, subject, body, source } = parsed.data;

      const classification = await classifyEmail(subject, body, from_email, from_name);

      const log = await prisma.emailLog.create({
        data: {
          from_email,
          from_name,
          subject,
          body,
          source,
          category:   classification.category,
          priority:   classification.priority,
          department: classification.department,
          summary:    classification.summary,
          ai_reply:   classification.suggested_reply,
        },
      });

      return reply.code(201).send({
        success: true,
        data: log,
        classification,
      });
    }
  );

  // GET /api/email — list emails with filters
  fastify.get(
    '/api/email',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        priority?:   string;
        handled?:    string;
        category?:   string;
        department?: string;
        search?:     string;
        page?:       string;
        limit?:      string;
      };

      const page  = Math.max(1, Number(query.page  ?? 1));
      const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
      const skip  = (page - 1) * limit;

      const where: Record<string, unknown> = {};
      if (query.priority)   where.priority   = query.priority;
      if (query.category)   where.category   = query.category;
      if (query.department) where.department = query.department;
      if (query.handled !== undefined) where.handled = query.handled === 'true';
      if (query.search) {
        where.OR = [
          { subject:    { contains: query.search, mode: 'insensitive' } },
          { from_email: { contains: query.search, mode: 'insensitive' } },
          { from_name:  { contains: query.search, mode: 'insensitive' } },
          { summary:    { contains: query.search, mode: 'insensitive' } },
        ];
      }

      const [emails, total] = await Promise.all([
        prisma.emailLog.findMany({
          where,
          orderBy: [
            // urgent first, then newest
            { priority: 'asc' },
            { created_at: 'desc' },
          ],
          skip,
          take: limit,
        }),
        prisma.emailLog.count({ where }),
      ]);

      // Summary counts for dashboard tabs
      const [urgentCount, highCount, unhandledCount] = await Promise.all([
        prisma.emailLog.count({ where: { priority: 'urgent', handled: false } }),
        prisma.emailLog.count({ where: { priority: 'high',   handled: false } }),
        prisma.emailLog.count({ where: { handled: false } }),
      ]);

      return reply.code(200).send({
        success: true,
        data: emails,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        summary: { urgent: urgentCount, high: highCount, unhandled: unhandledCount },
      });
    }
  );

  // GET /api/email/:id — single email
  fastify.get(
    '/api/email/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const email = await prisma.emailLog.findUnique({ where: { id: Number(id) } });
      if (!email) return reply.code(404).send({ success: false, error: 'Email not found' });

      return reply.code(200).send({ success: true, data: email });
    }
  );

  // PATCH /api/email/:id/handle — mark as handled
  fastify.patch(
    '/api/email/:id/handle',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = HandleSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const email = await prisma.emailLog.findUnique({ where: { id: Number(id) } });
      if (!email) return reply.code(404).send({ success: false, error: 'Email not found' });

      const updated = await prisma.emailLog.update({
        where: { id: Number(id) },
        data: {
          handled:    true,
          handled_by: parsed.data.handled_by,
          handled_at: new Date(),
        },
      });

      return reply.code(200).send({ success: true, data: updated });
    }
  );

  // PATCH /api/email/:id/route — route to department
  fastify.patch(
    '/api/email/:id/route',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { routed_to?: string; department?: string };

      const email = await prisma.emailLog.findUnique({ where: { id: Number(id) } });
      if (!email) return reply.code(404).send({ success: false, error: 'Email not found' });

      const updated = await prisma.emailLog.update({
        where: { id: Number(id) },
        data: {
          ...(body.routed_to  && { routed_to:  body.routed_to }),
          ...(body.department && { department: body.department }),
        },
      });

      return reply.code(200).send({ success: true, data: updated });
    }
  );

  // POST /api/email/compose — AI drafts a full email
  fastify.post(
    '/api/email/compose',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ComposeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { to, subject_hint, context, tone } = parsed.data;

      const systemPrompt = `You are an AI email writer for Envico Supported Living Ltd.
Write professional emails on behalf of the care management team.
Return ONLY valid JSON with this structure:
{
  "subject": string,
  "body": string,
  "suggested_send_time": string
}
Tone: ${tone}. Keep emails concise, clear, and person-centred where applicable.`;

      const userPrompt = `Write an email to: ${to}
Subject hint: ${subject_hint}
Context: ${context}`;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '{}';

      let draft: { subject: string; body: string; suggested_send_time: string };
      try {
        draft = JSON.parse(text);
      } catch {
        draft = {
          subject:              subject_hint,
          body:                 text,
          suggested_send_time:  'As soon as possible',
        };
      }

      return reply.code(200).send({ success: true, to, draft });
    }
  );
}
