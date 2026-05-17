import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/authMiddleware';
import { company } from '../config/company';

export async function configRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/config — public system config (no secrets)
  fastify.get(
    '/api/config',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(200).send({
        success: true,
        company,
      });
    },
  );

  // GET /api/config/full — extended config (authenticated)
  fastify.get(
    '/api/config/full',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(200).send({
        success: true,
        company,
        system: {
          version:     '2.0.0',
          environment: process.env.NODE_ENV ?? 'development',
          phase:       'Phase 1 — Foundation',
          modules:     ['rota', 'referrals', 'training', 'staff', 'service-users', 'incidents', 'medications', 'care-plans', 'compliance'],
        },
      });
    },
  );
}
