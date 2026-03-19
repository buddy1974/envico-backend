import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import prisma from '../db/prisma';
import { authenticate } from '../middleware/authMiddleware';

export async function activityRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/activity', { preHandler: [authenticate] }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const logs = await prisma.activityLog.findMany({
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    return reply.code(200).send({ success: true, logs });
  });
}
