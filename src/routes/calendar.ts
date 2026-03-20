import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import {
  getAuthUrl,
  getTokensFromCode,
  saveTokens,
  getCalendarEvents,
  getTodayEvents,
  createReminder,
  deleteTokens,
} from '../services/googleCalendarService';

const CreateReminderSchema = z.object({
  summary:      z.string().min(1).max(500),
  description:  z.string().optional(),
  start:        z.string().datetime(),
  end:          z.string().datetime(),
  attendees:    z.array(z.string().email()).optional(),
});

export async function calendarRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/calendar/auth — returns OAuth URL for CEO to connect their Google account
  fastify.get(
    '/api/calendar/auth',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const url = getAuthUrl();
      return reply.code(200).send({ success: true, auth_url: url });
    }
  );

  // GET /api/calendar/callback — Google redirects here after OAuth consent
  fastify.get(
    '/api/calendar/callback',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { code?: string; state?: string; error?: string };

      if (query.error) {
        return reply.code(400).send({ success: false, error: `OAuth error: ${query.error}` });
      }
      if (!query.code) {
        return reply.code(400).send({ success: false, error: 'Missing authorization code' });
      }

      try {
        const tokens = await getTokensFromCode(query.code);

        // state carries user_id if passed during auth URL generation
        // Fallback: save under user_id=1 (CEO/first admin) for single-user OAuth flows
        const userId = query.state ? Number(query.state) : 1;
        await saveTokens(userId, tokens);

        return reply.code(200).send({
          success: true,
          message: 'Google Calendar connected successfully',
          user_id: userId,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        fastify.log.error({ err: msg }, '[calendar] OAuth callback error');
        return reply.code(500).send({ success: false, error: 'Failed to exchange OAuth code', details: msg });
      }
    }
  );

  // GET /api/calendar/today — today's events
  fastify.get(
    '/api/calendar/today',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as FastifyRequest & { user?: { id: number } }).user;
      const userId = user?.id ?? 1;

      try {
        const events = await getTodayEvents(userId);

        const formatted = events.map((e) => ({
          id:          e.id,
          summary:     e.summary,
          description: e.description,
          start:       e.start?.dateTime ?? e.start?.date,
          end:         e.end?.dateTime   ?? e.end?.date,
          location:    e.location,
          attendees:   e.attendees?.map((a) => ({ email: a.email, name: a.displayName })),
          html_link:   e.htmlLink,
          all_day:     !e.start?.dateTime,
        }));

        return reply.code(200).send({
          success: true,
          date:    new Date().toLocaleDateString('en-GB'),
          count:   formatted.length,
          data:    formatted,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not connected')) {
          return reply.code(404).send({ success: false, error: 'Google Calendar not connected. Visit /api/calendar/auth to connect.' });
        }
        return reply.code(500).send({ success: false, error: msg });
      }
    }
  );

  // GET /api/calendar/upcoming — next N days (default 7)
  fastify.get(
    '/api/calendar/upcoming',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user  = (request as FastifyRequest & { user?: { id: number } }).user;
      const userId = user?.id ?? 1;
      const query = request.query as { days?: string };
      const days  = Math.min(30, Math.max(1, Number(query.days ?? 7)));

      try {
        const events = await getCalendarEvents(userId, days);

        const formatted = events.map((e) => ({
          id:          e.id,
          summary:     e.summary,
          description: e.description,
          start:       e.start?.dateTime ?? e.start?.date,
          end:         e.end?.dateTime   ?? e.end?.date,
          location:    e.location,
          attendees:   e.attendees?.map((a) => ({ email: a.email, name: a.displayName })),
          html_link:   e.htmlLink,
          all_day:     !e.start?.dateTime,
        }));

        return reply.code(200).send({
          success: true,
          days,
          count:  formatted.length,
          data:   formatted,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not connected')) {
          return reply.code(404).send({ success: false, error: 'Google Calendar not connected. Visit /api/calendar/auth to connect.' });
        }
        return reply.code(500).send({ success: false, error: msg });
      }
    }
  );

  // POST /api/calendar/reminder — create a calendar event/reminder
  fastify.post(
    '/api/calendar/reminder',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user   = (request as FastifyRequest & { user?: { id: number } }).user;
      const userId = user?.id ?? 1;

      const parsed = CreateReminderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      try {
        const event = await createReminder(userId, parsed.data);
        return reply.code(201).send({
          success: true,
          data: {
            id:        event.id,
            summary:   event.summary,
            start:     event.start?.dateTime,
            end:       event.end?.dateTime,
            html_link: event.htmlLink,
          },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not connected')) {
          return reply.code(404).send({ success: false, error: 'Google Calendar not connected. Visit /api/calendar/auth to connect.' });
        }
        return reply.code(500).send({ success: false, error: msg });
      }
    }
  );

  // DELETE /api/calendar/disconnect — revoke tokens and remove from DB
  fastify.delete(
    '/api/calendar/disconnect',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user   = (request as FastifyRequest & { user?: { id: number } }).user;
      const userId = user?.id ?? 1;

      await deleteTokens(userId);

      return reply.code(200).send({ success: true, message: 'Google Calendar disconnected' });
    }
  );
}
