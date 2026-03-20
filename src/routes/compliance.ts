import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateComplianceSchema = z.object({
  check_type:        z.enum(['SAFEGUARDING', 'MEDICATION', 'STAFFING', 'DOCUMENTATION', 'TRAINING']),
  title:             z.string().min(1),
  description:       z.string().optional(),
  due_date:          z.string(),
  assigned_to:       z.string().min(1),
  service_user_id:   z.number().int().positive().optional(),
});

const UpdateComplianceSchema = z.object({
  status:             z.enum(['COMPLIANT', 'NON_COMPLIANT', 'ACTION_REQUIRED', 'UNDER_REVIEW']).optional(),
  completed_date:     z.string().optional(),
  conducted_by:       z.string().optional(),
  findings:           z.string().optional(),
  actions_required:   z.string().optional(),
  actions_completed:  z.boolean().optional(),
});

export async function complianceRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/compliance
  fastify.get(
    '/api/compliance',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, check_type } = request.query as { status?: string; check_type?: string };
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (check_type) where.check_type = check_type;

      const checks = await prisma.complianceCheck.findMany({
        where,
        include: {
          service_user: { select: { id: true, first_name: true, last_name: true } },
        },
        orderBy: { due_date: 'asc' },
      });

      return reply.code(200).send({ success: true, checks });
    }
  );

  // POST /api/compliance
  fastify.post(
    '/api/compliance',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateComplianceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { due_date, ...rest } = parsed.data;
      const check = await prisma.complianceCheck.create({
        data: { ...rest, due_date: new Date(due_date) },
      });

      return reply.code(201).send({ success: true, check });
    }
  );

  // PATCH /api/compliance/:id
  fastify.patch<{ Params: { id: string } }>(
    '/api/compliance/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateComplianceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { completed_date, ...rest } = parsed.data;
      const check = await prisma.complianceCheck.update({
        where: { id },
        data: {
          ...rest,
          ...(completed_date ? { completed_date: new Date(completed_date) } : {}),
        },
      });

      return reply.code(200).send({ success: true, check });
    }
  );

  // GET /api/compliance/due — due in next 7 days
  fastify.get(
    '/api/compliance/due',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now = new Date();
      const in7 = new Date();
      in7.setDate(in7.getDate() + 7);

      const checks = await prisma.complianceCheck.findMany({
        where: {
          due_date: { gte: now, lte: in7 },
          status: { in: ['UNDER_REVIEW', 'ACTION_REQUIRED'] },
        },
        include: {
          service_user: { select: { id: true, first_name: true, last_name: true } },
        },
        orderBy: { due_date: 'asc' },
      });

      return reply.code(200).send({ success: true, checks });
    }
  );
}
