import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import { getAuthUrl, exchangeCode, saveTokens, revokeTokens } from '../lib/google';
import { getTodayEvents, getWeekEvents, createEvent, getMeetingPrepNotes } from '../lib/calendar';

type AuthUser = { id: number; role: string; email: string };

function userId(request: FastifyRequest): number {
  return ((request as FastifyRequest & { user?: AuthUser }).user?.id) ?? 1;
}

const CreateEventSchema = z.object({
  title:        z.string().min(1).max(500),
  start:        z.string().datetime(),
  end:          z.string().datetime(),
  description:  z.string().optional(),
  attendees:    z.array(z.string().email()).optional(),
});

const PrepSchema = z.object({
  summary:     z.string().optional(),
  description: z.string().optional(),
  start:       z.string().optional(),
  attendees:   z.array(z.object({
    email: z.string().email().optional(),
    name:  z.string().optional(),
  })).optional(),
});

export async function calendarRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/calendar/auth — returns Google OAuth consent URL (includes user_id as state)
  fastify.get(
    '/api/calendar/auth',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const uid = userId(request);
      return reply.code(200).send({ success: true, auth_url: getAuthUrl(uid) });
    }
  );

  // GET /api/calendar/callback — OAuth callback from Google
  fastify.get(
    '/api/calendar/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { code?: string; state?: string; error?: string };

      if (query.error) {
        return reply.code(400).send({ success: false, error: `OAuth denied: ${query.error}` });
      }
      if (!query.code) {
        return reply.code(400).send({ success: false, error: 'Missing authorization code' });
      }

      try {
        const tokens  = await exchangeCode(query.code);
        const uid     = query.state ? Number(query.state) : 1;
        await saveTokens(uid, tokens);

        return reply.code(200).send({
          success: true,
          message: 'Google Calendar & Gmail connected',
          user_id: uid,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err: msg }, '[calendar] OAuth callback failed');
        return reply.code(500).send({ success: false, error: 'Failed to exchange code', details: msg });
      }
    }
  );

  // GET /api/calendar/today
  fastify.get(
    '/api/calendar/today',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const events = await getTodayEvents(userId(request));
        return reply.code(200).send({
          success: true,
          date:  new Date().toLocaleDateString('en-GB'),
          count: events.length,
          data:  events,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not connected')) {
          return reply.code(404).send({ success: false, error: 'Google Calendar not connected. Call GET /api/calendar/auth first.' });
        }
        return reply.code(500).send({ success: false, error: msg });
      }
    }
  );

  // GET /api/calendar/upcoming?days=7
  fastify.get(
    '/api/calendar/upcoming',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const events = await getWeekEvents(userId(request));
        return reply.code(200).send({ success: true, count: events.length, data: events });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not connected')) {
          return reply.code(404).send({ success: false, error: 'Google Calendar not connected.' });
        }
        return reply.code(500).send({ success: false, error: msg });
      }
    }
  );

  // POST /api/calendar/event — create event
  fastify.post(
    '/api/calendar/event',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateEventSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      try {
        const event = await createEvent(userId(request), parsed.data);
        return reply.code(201).send({ success: true, data: event });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not connected')) {
          return reply.code(404).send({ success: false, error: 'Google Calendar not connected.' });
        }
        return reply.code(500).send({ success: false, error: msg });
      }
    }
  );

  // POST /api/calendar/prep — AI meeting prep notes
  fastify.post(
    '/api/calendar/prep',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = PrepSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const notes = await getMeetingPrepNotes(parsed.data);
      return reply.code(200).send({ success: true, notes });
    }
  );

  // DELETE /api/calendar/disconnect
  fastify.delete(
    '/api/calendar/disconnect',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await revokeTokens(userId(request));
      return reply.code(200).send({ success: true, message: 'Google disconnected' });
    }
  );
}
