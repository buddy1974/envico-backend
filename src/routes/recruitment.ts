import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateApplicationSchema = z.object({
  first_name:      z.string().min(1),
  last_name:       z.string().min(1),
  email:           z.string().email(),
  phone:           z.string().optional(),
  role_applied:    z.string().min(1),
  cv_url:          z.string().optional(),
  interview_date:  z.string().optional(),
  notes:           z.string().optional(),
});

const UpdateApplicationSchema = z.object({
  status:          z.enum(['NEW', 'SHORTLISTED', 'INTERVIEW', 'OFFERED', 'HIRED', 'REJECTED']).optional(),
  interview_date:  z.string().optional(),
  interview_notes: z.string().optional(),
  outcome_notes:   z.string().optional(),
  reviewed_by:     z.string().optional(),
});

const HireSchema = z.object({
  role:  z.string().min(1),
  phone: z.string().min(1),
});

export async function recruitmentRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/recruitment
  fastify.get(
    '/api/recruitment',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status } = request.query as { status?: string };
      const where: Record<string, unknown> = {};
      if (status) where.status = status;

      const applications = await prisma.recruitmentApplication.findMany({
        where,
        include: {
          staff: { select: { id: true, name: true, email: true } },
        },
        orderBy: { applied_at: 'desc' },
      });

      return reply.code(200).send({ success: true, applications });
    }
  );

  // POST /api/recruitment
  fastify.post(
    '/api/recruitment',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateApplicationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { interview_date, notes: outcome_notes, ...rest } = parsed.data;
      const application = await prisma.recruitmentApplication.create({
        data: {
          ...rest,
          ...(interview_date ? { interview_date: new Date(interview_date) } : {}),
          ...(outcome_notes ? { outcome_notes } : {}),
        },
      });

      return reply.code(201).send({ success: true, application });
    }
  );

  // PATCH /api/recruitment/:id
  fastify.patch<{ Params: { id: string } }>(
    '/api/recruitment/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateApplicationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { interview_date, ...rest } = parsed.data;
      const application = await prisma.recruitmentApplication.update({
        where: { id },
        data: {
          ...rest,
          ...(interview_date ? { interview_date: new Date(interview_date) } : {}),
        },
      });

      return reply.code(200).send({ success: true, application });
    }
  );

  // POST /api/recruitment/:id/hire — convert to Staff record
  fastify.post<{ Params: { id: string } }>(
    '/api/recruitment/:id/hire',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = HireSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const app = await prisma.recruitmentApplication.findUnique({ where: { id } });
      if (!app) return reply.code(404).send({ success: false, error: 'Application not found' });
      if (app.staff_id) return reply.code(409).send({ success: false, error: 'Already hired' });

      const staff = await prisma.staff.create({
        data: {
          name:  `${app.first_name} ${app.last_name}`,
          email: app.email,
          phone: parsed.data.phone,
          role:  parsed.data.role,
        },
      });

      const application = await prisma.recruitmentApplication.update({
        where: { id },
        data: { status: 'HIRED', staff_id: staff.id },
      });

      return reply.code(201).send({ success: true, staff, application });
    }
  );
}
