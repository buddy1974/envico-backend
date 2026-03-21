import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import { registerUser } from '../services/authService';
import { sendEmail } from '../services/emailService';
import prisma from '../db/prisma';

const CreateUserSchema = z.object({
  name:                   z.string().min(1),
  email:                  z.string().email(),
  password:               z.string().min(8),
  role:                   z.enum(['ADMIN', 'MANAGER', 'STAFF', 'FAMILY']),
  location_id:            z.number().int().positive().optional(),
  family_service_user_id: z.number().int().positive().optional(),
}).refine(
  (data) => data.role !== 'FAMILY' || data.family_service_user_id != null,
  { message: 'family_service_user_id is required when role is FAMILY', path: ['family_service_user_id'] }
);

const UpdateUserSchema = z.object({
  name:                   z.string().min(1).optional(),
  role:                   z.enum(['ADMIN', 'MANAGER', 'STAFF', 'FAMILY']).optional(),
  is_active:              z.boolean().optional(),
  location_id:            z.number().int().positive().nullable().optional(),
  family_service_user_id: z.number().int().positive().nullable().optional(),
});

export async function userRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/users — ADMIN only
  fastify.get(
    '/api/users',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const users = await prisma.user.findMany({
        select: {
          id: true, name: true, email: true, role: true,
          is_active: true, last_login: true, location_id: true, created_at: true,
          family_service_user_id: true,
          family_service_user: {
            select: { id: true, first_name: true, last_name: true },
          },
        },
        orderBy: { created_at: 'desc' },
      });
      return reply.code(200).send({ success: true, users });
    }
  );

  // POST /api/users — ADMIN only
  fastify.post(
    '/api/users',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { name, email, password, role, location_id, family_service_user_id } = parsed.data;

      try {
        const user = await registerUser(name, email, password, role, location_id, family_service_user_id);

        // Send welcome email for FAMILY accounts
        if (role === 'FAMILY') {
          await sendEmail({
            to:       email,
            subject:  'Your Envico Family Portal Access',
            template: 'GENERAL',
            body: `Dear ${name},\n\nYour family portal account has been created.\n\nLogin at: https://envico.maxpromo.digital/portal/family\nEmail: ${email}\n\nPlease use the password set by your care manager to login.\n\nIf you have any questions, please contact us at ops@envicosl.co.uk.\n\nWarm regards,\nEnvico Supported Living Ltd`,
          });
        }

        return reply.code(201).send({ success: true, user });
      } catch (err: any) {
        if (err.code === 'P2002') {
          return reply.code(409).send({ success: false, error: 'Email already registered' });
        }
        throw err;
      }
    }
  );

  // PATCH /api/users/:id — ADMIN only
  fastify.patch<{ Params: { id: string } }>(
    '/api/users/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const user = await prisma.user.update({
        where: { id },
        data:  parsed.data,
        select: { id: true, name: true, email: true, role: true, is_active: true, location_id: true, family_service_user_id: true },
      });

      return reply.code(200).send({ success: true, user });
    }
  );

  // POST /api/users/:id/deactivate — ADMIN only
  fastify.post<{ Params: { id: string } }>(
    '/api/users/:id/deactivate',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      if (request.user?.id === id) {
        return reply.code(400).send({ success: false, error: 'Cannot deactivate your own account' });
      }

      const user = await prisma.user.update({
        where: { id },
        data:  { is_active: false, refresh_token: null },
        select: { id: true, name: true, email: true, is_active: true },
      });

      return reply.code(200).send({ success: true, user });
    }
  );
}
