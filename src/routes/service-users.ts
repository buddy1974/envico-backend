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

  // GET /api/service-users — list all with pagination
  fastify.get(
    '/api/service-users',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { page, limit, status, care_type } = request.query as {
        page?: string;
        limit?: string;
        status?: string;
        care_type?: string;
      };

      const take = Math.min(parseInt(limit ?? '20', 10), 100);
      const skip = (parseInt(page ?? '1', 10) - 1) * take;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (care_type) where.care_type = care_type;

      const [total, service_users] = await Promise.all([
        prisma.serviceUser.count({ where }),
        prisma.serviceUser.findMany({
          where,
          orderBy: { created_at: 'desc' },
          skip,
          take,
        }),
      ]);

      return reply.code(200).send({
        success: true,
        service_users,
        pagination: { total, page: parseInt(page ?? '1', 10), limit: take },
      });
    }
  );

  // GET /api/service-users/:id — get one with care plans, incidents, medications
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

  // POST /api/service-users — create new service user
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

  // PATCH /api/service-users/:id — update service user
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

  // POST /api/service-users/from-referral/:referral_id — convert referral to service user
  fastify.post<{ Params: { referral_id: string } }>(
    '/api/service-users/from-referral/:referral_id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { referral_id: string } }>, reply: FastifyReply) => {
      const { referral_id } = request.params;

      const referral = await prisma.referral.findUnique({ where: { referral_id } });
      if (!referral) return reply.code(404).send({ success: false, error: 'Referral not found' });

      const existing = await prisma.serviceUser.findUnique({ where: { referral_id } });
      if (existing) return reply.code(409).send({ success: false, error: 'Service user already created from this referral' });

      // Split service_user_name into first/last
      const nameParts = referral.service_user_name.trim().split(' ');
      const first_name = nameParts[0] ?? referral.service_user_name;
      const last_name = nameParts.slice(1).join(' ') || 'Unknown';

      const user = await prisma.serviceUser.create({
        data: {
          first_name,
          last_name,
          dob: referral.dob,
          referral_id: referral.referral_id,
        },
      });

      // Mark referral as converted
      await prisma.referral.update({
        where: { referral_id },
        data: { status: 'CONVERTED' },
      });

      return reply.code(201).send({ success: true, service_user: user });
    }
  );
}
