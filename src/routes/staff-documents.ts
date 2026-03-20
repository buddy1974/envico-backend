import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateDocumentSchema = z.object({
  type:         z.enum(['DBS', 'CONTRACT', 'RIGHT_TO_WORK', 'TRAINING_CERT', 'ID', 'OTHER']),
  title:        z.string().min(1),
  reference_no: z.string().optional(),
  file_url:     z.string().optional(),
  issued_date:  z.string().optional(),
  expiry_date:  z.string().optional(),
  status:       z.enum(['VALID', 'EXPIRED', 'PENDING', 'REJECTED']).optional(),
  notes:        z.string().optional(),
});

const UpdateDocumentSchema = z.object({
  status:       z.enum(['VALID', 'EXPIRED', 'PENDING', 'REJECTED']).optional(),
  verified_by:  z.string().optional(),
  expiry_date:  z.string().optional(),
  file_url:     z.string().optional(),
  notes:        z.string().optional(),
});

export async function staffDocumentRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/staff-documents — global list with staff joined
  fastify.get(
    '/api/staff-documents',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, type } = request.query as { status?: string; type?: string };
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (type) where.type = type;

      const documents = await prisma.staffDocument.findMany({
        where,
        include: { staff: { select: { id: true, name: true, role: true, email: true } } },
        orderBy: { expiry_date: 'asc' },
      });
      return reply.code(200).send({ success: true, documents });
    }
  );

  // POST /api/staff-documents — global create (staff_id in body)
  fastify.post(
    '/api/staff-documents',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const BodySchema = CreateDocumentSchema.extend({
        staff_id: z.number().int().positive(),
      });
      const parsed = BodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const { staff_id, issued_date, expiry_date, ...rest } = parsed.data;
      const doc = await prisma.staffDocument.create({
        data: {
          ...rest,
          staff_id,
          ...(issued_date ? { issued_date: new Date(issued_date) } : {}),
          ...(expiry_date ? { expiry_date: new Date(expiry_date) } : {}),
        },
        include: { staff: { select: { id: true, name: true, role: true } } },
      });
      return reply.code(201).send({ success: true, document: doc });
    }
  );

  // GET /api/staff/:id/documents
  fastify.get<{ Params: { id: string } }>(
    '/api/staff/:id/documents',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const staff_id = parseInt(request.params.id, 10);
      if (isNaN(staff_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const documents = await prisma.staffDocument.findMany({
        where: { staff_id },
        orderBy: { created_at: 'desc' },
      });

      return reply.code(200).send({ success: true, documents });
    }
  );

  // POST /api/staff/:id/documents
  fastify.post<{ Params: { id: string } }>(
    '/api/staff/:id/documents',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const staff_id = parseInt(request.params.id, 10);
      if (isNaN(staff_id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = CreateDocumentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { issued_date, expiry_date, ...rest } = parsed.data;
      const doc = await prisma.staffDocument.create({
        data: {
          ...rest,
          staff_id,
          ...(issued_date ? { issued_date: new Date(issued_date) } : {}),
          ...(expiry_date ? { expiry_date: new Date(expiry_date) } : {}),
        },
      });

      return reply.code(201).send({ success: true, document: doc });
    }
  );

  // PATCH /api/staff-documents/:id
  fastify.patch<{ Params: { id: string } }>(
    '/api/staff-documents/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateDocumentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { expiry_date, ...rest } = parsed.data;
      const doc = await prisma.staffDocument.update({
        where: { id },
        data: {
          ...rest,
          ...(expiry_date ? { expiry_date: new Date(expiry_date) } : {}),
          ...(rest.verified_by ? { verified_at: new Date() } : {}),
        },
      });

      return reply.code(200).send({ success: true, document: doc });
    }
  );

  // GET /api/staff-documents/expiring — expiring in next 30 days
  fastify.get(
    '/api/staff-documents/expiring',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const now = new Date();
      const in30 = new Date();
      in30.setDate(in30.getDate() + 30);

      const documents = await prisma.staffDocument.findMany({
        where: {
          expiry_date: { gte: now, lte: in30 },
          status: 'VALID',
        },
        include: {
          staff: { select: { id: true, name: true, role: true, email: true } },
        },
        orderBy: { expiry_date: 'asc' },
      });

      return reply.code(200).send({ success: true, documents });
    }
  );
}
