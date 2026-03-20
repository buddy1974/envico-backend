import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateCarePlanSchema = z.object({
  title:       z.string().min(1),
  description: z.string().optional(),
  goals:       z.array(z.any()).optional(),
  review_date: z.string().optional(),
  status:      z.enum(['DRAFT', 'ACTIVE', 'UNDER_REVIEW', 'ARCHIVED']).optional(),
  created_by:  z.string().min(1),
  version:     z.number().int().positive().optional(),
});

const UpdateCarePlanSchema = z.object({
  title:       z.string().min(1).optional(),
  description: z.string().optional(),
  goals:       z.array(z.any()).optional(),
  review_date: z.string().optional(),
  status:      z.enum(['DRAFT', 'ACTIVE', 'UNDER_REVIEW', 'ARCHIVED']).optional(),
  version:     z.number().int().positive().optional(),
});

export async function carePlanRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/service-users/:id/care-plans
  fastify.get<{ Params: { id: string } }>(
    '/api/service-users/:id/care-plans',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const service_user_id = parseInt(request.params.id, 10);
      if (isNaN(service_user_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const plans = await prisma.carePlan.findMany({
        where: { service_user_id },
        orderBy: { created_at: 'desc' },
      });

      return reply.code(200).send({ success: true, care_plans: plans });
    }
  );

  // POST /api/service-users/:id/care-plans
  fastify.post<{ Params: { id: string } }>(
    '/api/service-users/:id/care-plans',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const service_user_id = parseInt(request.params.id, 10);
      if (isNaN(service_user_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = CreateCarePlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const data = parsed.data;
      const plan = await prisma.carePlan.create({
        data: {
          ...data,
          service_user_id,
          goals: data.goals ?? [],
          ...(data.review_date ? { review_date: new Date(data.review_date) } : {}),
        },
      });

      return reply.code(201).send({ success: true, care_plan: plan });
    }
  );

  // PATCH /api/care-plans/:id
  fastify.patch<{ Params: { id: string } }>(
    '/api/care-plans/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateCarePlanSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const data = parsed.data;
      const plan = await prisma.carePlan.update({
        where: { id },
        data: {
          ...data,
          ...(data.review_date ? { review_date: new Date(data.review_date) } : {}),
        },
      });

      return reply.code(200).send({ success: true, care_plan: plan });
    }
  );
}
