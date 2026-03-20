import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import { getRecentEmails, sendEmail, draftEmail, searchEmails } from '../lib/gmail';

type AuthUser = { id: number; role: string };

function userId(request: FastifyRequest): number {
  return ((request as FastifyRequest & { user?: AuthUser }).user?.id) ?? 1;
}

const SendSchema = z.object({
  to:      z.string().email(),
  subject: z.string().min(1).max(500),
  body:    z.string().min(1),
});

const DraftSchema = SendSchema;

function handleGoogleError(err: unknown, reply: FastifyReply) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('not connected')) {
    return reply.code(404).send({ success: false, error: 'Gmail not connected. Visit GET /api/calendar/auth to connect Google.' });
  }
  return reply.code(500).send({ success: false, error: msg });
}

export async function gmailRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/gmail/messages — last 20 inbox messages
  fastify.get(
    '/api/gmail/messages',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { limit?: string };
      const limit = Math.min(50, Math.max(1, Number(query.limit ?? 20)));

      try {
        const messages = await getRecentEmails(userId(request), limit);
        return reply.code(200).send({ success: true, count: messages.length, data: messages });
      } catch (err) {
        return handleGoogleError(err, reply);
      }
    }
  );

  // POST /api/gmail/send — send email via CEO's Gmail account
  fastify.post(
    '/api/gmail/send',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SendSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      try {
        const result = await sendEmail(userId(request), parsed.data);
        return reply.code(200).send({ success: true, data: result });
      } catch (err) {
        return handleGoogleError(err, reply);
      }
    }
  );

  // POST /api/gmail/draft — save as Gmail draft
  fastify.post(
    '/api/gmail/draft',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = DraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      try {
        const result = await draftEmail(userId(request), parsed.data);
        return reply.code(201).send({ success: true, data: result });
      } catch (err) {
        return handleGoogleError(err, reply);
      }
    }
  );

  // GET /api/gmail/search?q=... — search Gmail
  fastify.get(
    '/api/gmail/search',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { q?: string; limit?: string };
      if (!query.q) {
        return reply.code(400).send({ success: false, error: 'Query parameter ?q= is required' });
      }

      const limit = Math.min(50, Math.max(1, Number(query.limit ?? 20)));

      try {
        const results = await searchEmails(userId(request), query.q, limit);
        return reply.code(200).send({ success: true, count: results.length, query: query.q, data: results });
      } catch (err) {
        return handleGoogleError(err, reply);
      }
    }
  );
}
