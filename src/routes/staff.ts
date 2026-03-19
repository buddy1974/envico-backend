import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createStaff, listStaff } from '../services/staffService';
import { authenticate } from '../middleware/authMiddleware';

const CreateStaffSchema = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
});

export async function staffRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/staff', { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = CreateStaffSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const staff = await createStaff(parsed.data);
      return reply.code(201).send({ success: true, staff });
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.code(409).send({ success: false, error: 'Email already registered' });
      }
      throw err;
    }
  });

  fastify.get('/api/staff', { preHandler: [authenticate] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const staff = await listStaff();
    return reply.code(200).send({ success: true, staff });
  });
}
