import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import webpush from 'web-push';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

// ─── VAPID setup ──────────────────────────────────────────────────────────────
// Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Render environment.
// Init is guarded so missing keys do not crash the server at startup.
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY ?? null;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(
      'mailto:info@envicosl.co.uk',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY,
    );
  } catch (err) {
    console.warn('[notifications] VAPID init failed — push notifications disabled:', err);
  }
} else {
  console.warn('[notifications] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not set — push notifications disabled');
}

// ─── Types ────────────────────────────────────────────────────────────────────
const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth:   z.string().min(1),
  }),
});

const SendSchema = z.object({
  title:  z.string().min(1).max(100),
  body:   z.string().min(1).max(500),
  url:    z.string().optional(),
  icon:   z.string().optional(),
});

// ─── Helper: send to all subscriptions, remove dead ones ─────────────────────
export async function sendPushToAll(payload: { title: string; body: string; url?: string }): Promise<void> {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  const subs = await prisma.pushSubscription.findMany();
  if (!subs.length) return;

  const deadIds: number[] = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: payload.title, body: payload.body, url: payload.url ?? '/' }),
        );
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404 / 410 = subscription expired or unregistered
        if (status === 404 || status === 410) deadIds.push(sub.id);
      }
    })
  );

  if (deadIds.length) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: deadIds } } });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
export async function notificationRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/notifications/vapid-public — client needs this to subscribe
  fastify.get(
    '/api/notifications/vapid-public',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(200).send({ success: true, publicKey: VAPID_PUBLIC });
    }
  );

  // POST /api/notifications/subscribe — save browser push subscription
  fastify.post(
    '/api/notifications/subscribe',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SubscribeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error:   'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const userId = (request as any).user?.id ?? 0;
      const { endpoint, keys } = parsed.data;

      await prisma.pushSubscription.upsert({
        where:  { endpoint },
        update: { p256dh: keys.p256dh, auth: keys.auth, user_id: userId },
        create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, user_id: userId },
      });

      return reply.code(200).send({ success: true, message: 'Subscribed to push notifications' });
    }
  );

  // DELETE /api/notifications/subscribe — unsubscribe
  fastify.delete(
    '/api/notifications/subscribe',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { endpoint } = (request.body ?? {}) as { endpoint?: string };
      if (!endpoint) return reply.code(400).send({ success: false, error: 'endpoint required' });

      await prisma.pushSubscription.deleteMany({ where: { endpoint } }).catch(() => null);
      return reply.code(200).send({ success: true });
    }
  );

  // POST /api/notifications/send — manual push (ADMIN only)
  fastify.post(
    '/api/notifications/send',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SendSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error:   'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      await sendPushToAll(parsed.data);
      return reply.code(200).send({ success: true, message: 'Notification sent' });
    }
  );
}
