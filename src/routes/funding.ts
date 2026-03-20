import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateFundingSchema = z.object({
  funder_name:      z.string().min(1),
  funding_type:     z.enum(['LOCAL_AUTHORITY', 'NHS', 'PRIVATE', 'DIRECT_PAYMENT', 'MIXED']),
  weekly_rate:      z.number().positive(),
  contribution_pct: z.number().int().min(0).max(100).optional(),
  reference_no:     z.string().optional(),
  start_date:       z.string(),
  end_date:         z.string().optional(),
  notes:            z.string().optional(),
});

const UpdateFundingSchema = CreateFundingSchema.partial().extend({
  is_active: z.boolean().optional(),
});

export async function fundingRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/service-users/:id/funding
  fastify.get<{ Params: { id: string } }>(
    '/api/service-users/:id/funding',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const service_user_id = parseInt(request.params.id, 10);
      if (isNaN(service_user_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const sources = await prisma.fundingSource.findMany({
        where: { service_user_id },
        orderBy: { start_date: 'desc' },
      });

      return reply.code(200).send({ success: true, funding_sources: sources });
    }
  );

  // POST /api/service-users/:id/funding
  fastify.post<{ Params: { id: string } }>(
    '/api/service-users/:id/funding',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const service_user_id = parseInt(request.params.id, 10);
      if (isNaN(service_user_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = CreateFundingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { start_date, end_date, ...rest } = parsed.data;
      const source = await prisma.fundingSource.create({
        data: {
          ...rest,
          service_user_id,
          start_date: new Date(start_date),
          ...(end_date ? { end_date: new Date(end_date) } : {}),
        },
      });

      return reply.code(201).send({ success: true, funding_source: source });
    }
  );

  // PATCH /api/funding/:id
  fastify.patch<{ Params: { id: string } }>(
    '/api/funding/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateFundingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { start_date, end_date, ...rest } = parsed.data;
      const source = await prisma.fundingSource.update({
        where: { id },
        data: {
          ...rest,
          ...(start_date ? { start_date: new Date(start_date) } : {}),
          ...(end_date ? { end_date: new Date(end_date) } : {}),
        },
      });

      return reply.code(200).send({ success: true, funding_source: source });
    }
  );
}
