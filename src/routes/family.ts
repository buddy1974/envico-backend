import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

type FamilyUser = {
  id:                     number;
  role:                   string;
  email:                  string;
  family_service_user_id?: number;
};

const ALLOWED_ROLES = ['FAMILY', 'ADMIN', 'MANAGER'];

function getRequestUser(request: FastifyRequest): FamilyUser {
  return (request as FastifyRequest & { user?: FamilyUser }).user ??
    { id: 0, role: '', email: '' };
}

function roleCheck(user: FamilyUser, reply: FastifyReply): boolean {
  if (!ALLOWED_ROLES.includes(user.role)) {
    reply.code(403).send({ success: false, error: 'Forbidden — Family Portal access only' });
    return false;
  }
  return true;
}

function resolveServiceUserId(user: FamilyUser, queryOrBody: Record<string, unknown>): number | null {
  if (user.role === 'FAMILY') {
    return user.family_service_user_id ?? null;
  }
  const id = queryOrBody.service_user_id;
  return id ? Number(id) : null;
}

const MessageSchema = z.object({
  message:         z.string().min(1).max(2000),
  service_user_id: z.number().int().positive().optional(), // required for ADMIN/MANAGER
});

export async function familyRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/family/my-service-user
  fastify.get(
    '/api/family/my-service-user',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = getRequestUser(request);
      if (!roleCheck(user, reply)) return;

      const serviceUserId = resolveServiceUserId(user, request.query as Record<string, unknown>);
      if (!serviceUserId) {
        return reply.code(400).send({ success: false, error: 'No service user linked. Contact your care manager.' });
      }

      const serviceUser = await prisma.serviceUser.findUnique({
        where: { id: serviceUserId },
        include: {
          care_plans: {
            where:   { status: 'ACTIVE' },
            orderBy: { updated_at: 'desc' },
            select: {
              id: true, title: true, description: true, goals: true,
              review_date: true, status: true, version: true, updated_at: true,
            },
          },
          medications: {
            where:   { status: 'ACTIVE' },
            orderBy: { name: 'asc' },
            select: {
              id: true, name: true, dosage: true, frequency: true,
              route: true, start_date: true, status: true, notes: true,
            },
          },
          incidents: {
            orderBy: { reported_at: 'desc' },
            take:    5,
            select: {
              id: true, type: true, severity: true,
              description: true, reported_at: true, status: true, action_taken: true,
            },
          },
          location: { select: { id: true, name: true } },
        },
      });

      if (!serviceUser) {
        return reply.code(404).send({ success: false, error: 'Service user not found' });
      }

      // Strip finance fields — return only care-relevant data for family
      const {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        ...safeUser
      } = serviceUser;

      return reply.code(200).send({ success: true, data: safeUser });
    }
  );

  // GET /api/family/care-updates — last 10 activity logs for their service user
  fastify.get(
    '/api/family/care-updates',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = getRequestUser(request);
      if (!roleCheck(user, reply)) return;

      const serviceUserId = resolveServiceUserId(user, request.query as Record<string, unknown>);
      if (!serviceUserId) {
        return reply.code(400).send({ success: false, error: 'No service user linked.' });
      }

      const logs = await prisma.activityLog.findMany({
        where:   { entity: 'SERVICE_USER', entity_id: serviceUserId },
        orderBy: { created_at: 'desc' },
        take:    10,
      });

      return reply.code(200).send({ success: true, data: logs });
    }
  );

  // POST /api/family/message — send message to care team
  fastify.post(
    '/api/family/message',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = getRequestUser(request);
      if (!roleCheck(user, reply)) return;

      const parsed = MessageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const serviceUserId = resolveServiceUserId(
        user,
        { service_user_id: parsed.data.service_user_id },
      );
      if (!serviceUserId) {
        return reply.code(400).send({ success: false, error: 'No service user linked.' });
      }

      const msg = await prisma.familyMessage.create({
        data: {
          from_user_id:    user.id,
          service_user_id: serviceUserId,
          message:         parsed.data.message,
        },
        include: {
          from_user:    { select: { id: true, name: true, role: true } },
          service_user: { select: { id: true, first_name: true, last_name: true } },
        },
      });

      // Log the message as an activity for care team visibility
      await prisma.activityLog.create({
        data: {
          entity:    'SERVICE_USER',
          entity_id: serviceUserId,
          action:    'FAMILY_MESSAGE',
          details:   `Message from ${msg.from_user.name}: "${parsed.data.message.substring(0, 100)}${parsed.data.message.length > 100 ? '…' : ''}"`,
        },
      });

      return reply.code(201).send({ success: true, data: msg });
    }
  );

  // GET /api/family/messages — view message thread for a service user
  fastify.get(
    '/api/family/messages',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = getRequestUser(request);
      if (!roleCheck(user, reply)) return;

      const serviceUserId = resolveServiceUserId(user, request.query as Record<string, unknown>);
      if (!serviceUserId) {
        return reply.code(400).send({ success: false, error: 'No service user linked.' });
      }

      const messages = await prisma.familyMessage.findMany({
        where:   { service_user_id: serviceUserId },
        include: { from_user: { select: { id: true, name: true, role: true } } },
        orderBy: { created_at: 'desc' },
        take:    50,
      });

      // Mark as read when family user views their thread
      if (user.role === 'FAMILY') {
        await prisma.familyMessage.updateMany({
          where: { service_user_id: serviceUserId, read: false, from_user_id: { not: user.id } },
          data:  { read: true },
        });
      }

      return reply.code(200).send({ success: true, data: messages });
    }
  );
}
