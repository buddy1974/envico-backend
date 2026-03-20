import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateMedicationSchema = z.object({
  service_user_id: z.number().int().positive(),
  name:            z.string().min(1),
  dosage:          z.string().min(1),
  frequency:       z.string().min(1),
  route:           z.string().min(1),
  prescribed_by:   z.string().min(1),
  start_date:      z.string(),
  end_date:        z.string().optional(),
  status:          z.enum(['ACTIVE', 'SUSPENDED', 'DISCONTINUED']).optional(),
  notes:           z.string().optional(),
});

const UpdateMedicationStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'DISCONTINUED']),
  notes:  z.string().optional(),
});

export async function medicationRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/service-users/:id/medications
  fastify.get<{ Params: { id: string } }>(
    '/api/service-users/:id/medications',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const service_user_id = parseInt(request.params.id, 10);
      if (isNaN(service_user_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const medications = await prisma.medication.findMany({
        where: { service_user_id },
        orderBy: { start_date: 'desc' },
      });

      return reply.code(200).send({ success: true, medications });
    }
  );

  // POST /api/medications
  fastify.post(
    '/api/medications',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateMedicationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const data = parsed.data;
      const medication = await prisma.medication.create({
        data: {
          ...data,
          start_date: new Date(data.start_date),
          ...(data.end_date ? { end_date: new Date(data.end_date) } : {}),
        },
      });

      return reply.code(201).send({ success: true, medication });
    }
  );

  // PATCH /api/medications/:id/status
  fastify.patch<{ Params: { id: string } }>(
    '/api/medications/:id/status',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateMedicationStatusSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const medication = await prisma.medication.update({
        where: { id },
        data: parsed.data,
      });

      return reply.code(200).send({ success: true, medication });
    }
  );
}
