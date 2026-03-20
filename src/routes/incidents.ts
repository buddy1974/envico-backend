import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateIncidentSchema = z.object({
  type:         z.enum(['ACCIDENT', 'SAFEGUARDING', 'MEDICATION_ERROR', 'BEHAVIOUR', 'OTHER']),
  severity:     z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  description:  z.string().min(1),
  location:     z.string().optional(),
  witnesses:    z.string().optional(),
  reported_by:  z.string().min(1),
  reported_at:  z.string().optional(),
  action_taken: z.string().optional(),
});

const UpdateIncidentSchema = z.object({
  status:       z.enum(['OPEN', 'UNDER_INVESTIGATION', 'CLOSED']).optional(),
  action_taken: z.string().optional(),
});

export async function incidentRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/service-users/:id/incidents
  fastify.get<{ Params: { id: string } }>(
    '/api/service-users/:id/incidents',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const service_user_id = parseInt(request.params.id, 10);
      if (isNaN(service_user_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const incidents = await prisma.incident.findMany({
        where: { service_user_id },
        orderBy: { reported_at: 'desc' },
      });

      return reply.code(200).send({ success: true, incidents });
    }
  );

  // POST /api/service-users/:id/incidents
  fastify.post<{ Params: { id: string } }>(
    '/api/service-users/:id/incidents',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const service_user_id = parseInt(request.params.id, 10);
      if (isNaN(service_user_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = CreateIncidentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const data = parsed.data;
      const incident = await prisma.incident.create({
        data: {
          ...data,
          service_user_id,
          ...(data.reported_at ? { reported_at: new Date(data.reported_at) } : {}),
        },
      });

      return reply.code(201).send({ success: true, incident });
    }
  );

  // PATCH /api/incidents/:id
  fastify.patch<{ Params: { id: string } }>(
    '/api/incidents/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateIncidentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const incident = await prisma.incident.update({
        where: { id },
        data: parsed.data,
      });

      return reply.code(200).send({ success: true, incident });
    }
  );
}
