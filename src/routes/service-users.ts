import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateServiceUserSchema = z.object({
  first_name:       z.string().min(1),
  last_name:        z.string().min(1),
  dob:              z.string(),
  gender:           z.string().optional(),
  ethnicity:        z.string().optional(),
  primary_language: z.string().optional(),
  nhs_number:       z.string().optional(),
  address_line1:    z.string().optional(),
  address_line2:    z.string().optional(),
  city:             z.string().optional(),
  postcode:         z.string().optional(),
  phone:            z.string().optional(),
  gp_name:          z.string().optional(),
  gp_practice:      z.string().optional(),
  gp_phone:         z.string().optional(),
  nok_name:         z.string().optional(),
  nok_relationship: z.string().optional(),
  nok_phone:        z.string().optional(),
  care_type:        z.enum(['SUPPORTED_LIVING', 'DOMICILIARY', 'RESIDENTIAL']).optional(),
  status:           z.enum(['ACTIVE', 'INACTIVE', 'DISCHARGED']).optional(),
  referral_id:      z.string().optional(),
});

const UpdateServiceUserSchema = CreateServiceUserSchema.partial();

export async function serviceUserRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/service-users
  fastify.get(
    '/api/service-users',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const users = await prisma.serviceUser.findMany({
        orderBy: { created_at: 'desc' },
      });
      return reply.code(200).send({ success: true, service_users: users });
    }
  );

  // GET /api/service-users/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/service-users/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const user = await prisma.serviceUser.findUnique({
        where: { id },
        include: { care_plans: true, incidents: true, medications: true },
      });

      if (!user) return reply.code(404).send({ success: false, error: 'Service user not found' });
      return reply.code(200).send({ success: true, service_user: user });
    }
  );

  // POST /api/service-users
  fastify.post(
    '/api/service-users',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateServiceUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const data = parsed.data;
      const user = await prisma.serviceUser.create({
        data: {
          ...data,
          dob: new Date(data.dob),
        },
      });

      return reply.code(201).send({ success: true, service_user: user });
    }
  );

  // PATCH /api/service-users/:id
  fastify.patch<{ Params: { id: string } }>(
    '/api/service-users/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateServiceUserSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const data = parsed.data;
      const user = await prisma.serviceUser.update({
        where: { id },
        data: {
          ...data,
          ...(data.dob ? { dob: new Date(data.dob) } : {}),
        },
      });

      return reply.code(200).send({ success: true, service_user: user });
    }
  );
}
