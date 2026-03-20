import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateTrainingSchema = z.object({
  training_name:   z.string().min(1),
  training_type:   z.string().min(1),
  provider:        z.string().optional(),
  completed_date:  z.string().optional(),
  expiry_date:     z.string().optional(),
  certificate_url: z.string().optional(),
  status:          z.enum(['COMPLETED', 'EXPIRED', 'DUE', 'OVERDUE']).optional(),
  notes:           z.string().optional(),
});

const UpdateTrainingSchema = CreateTrainingSchema.partial();

export async function trainingRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/training — global create (staff_id in body)
  fastify.post(
    '/api/training',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const BodySchema = CreateTrainingSchema.extend({
        staff_id: z.number().int().positive(),
      });
      const parsed = BodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { staff_id, completed_date, expiry_date, ...rest } = parsed.data;
      const record = await prisma.trainingRecord.create({
        data: {
          ...rest,
          staff_id,
          ...(completed_date ? { completed_date: new Date(completed_date) } : {}),
          ...(expiry_date ? { expiry_date: new Date(expiry_date) } : {}),
        },
        include: { staff: { select: { id: true, name: true, role: true } } },
      });
      return reply.code(201).send({ success: true, training: record });
    }
  );

  // GET /api/training — all records
  fastify.get(
    '/api/training',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, training_type } = request.query as { status?: string; training_type?: string };
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (training_type) where.training_type = training_type;

      const records = await prisma.trainingRecord.findMany({
        where,
        include: {
          staff: { select: { id: true, name: true, role: true, email: true } },
        },
        orderBy: { created_at: 'desc' },
      });

      return reply.code(200).send({ success: true, training: records });
    }
  );

  // GET /api/staff/:id/training
  fastify.get<{ Params: { id: string } }>(
    '/api/staff/:id/training',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const staff_id = parseInt(request.params.id, 10);
      if (isNaN(staff_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const records = await prisma.trainingRecord.findMany({
        where: { staff_id },
        orderBy: { expiry_date: 'asc' },
      });

      return reply.code(200).send({ success: true, training: records });
    }
  );

  // POST /api/staff/:id/training
  fastify.post<{ Params: { id: string } }>(
    '/api/staff/:id/training',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const staff_id = parseInt(request.params.id, 10);
      if (isNaN(staff_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = CreateTrainingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { completed_date, expiry_date, ...rest } = parsed.data;
      const record = await prisma.trainingRecord.create({
        data: {
          ...rest,
          staff_id,
          ...(completed_date ? { completed_date: new Date(completed_date) } : {}),
          ...(expiry_date ? { expiry_date: new Date(expiry_date) } : {}),
        },
      });

      return reply.code(201).send({ success: true, training: record });
    }
  );

  // PATCH /api/training/:id
  fastify.patch<{ Params: { id: string } }>(
    '/api/training/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateTrainingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { completed_date, expiry_date, ...rest } = parsed.data;
      const record = await prisma.trainingRecord.update({
        where: { id },
        data: {
          ...rest,
          ...(completed_date ? { completed_date: new Date(completed_date) } : {}),
          ...(expiry_date ? { expiry_date: new Date(expiry_date) } : {}),
        },
      });

      return reply.code(200).send({ success: true, training: record });
    }
  );

  // GET /api/training/overdue
  fastify.get(
    '/api/training/overdue',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const records = await prisma.trainingRecord.findMany({
        where: {
          status: { in: ['OVERDUE', 'EXPIRED'] },
        },
        include: {
          staff: { select: { id: true, name: true, role: true, email: true } },
        },
        orderBy: { expiry_date: 'asc' },
      });

      return reply.code(200).send({ success: true, training: records });
    }
  );
}
