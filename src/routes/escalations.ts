import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateEscalationSchema = z.object({
  task_id: z.number().int().positive(),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
});

export async function escalationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/escalations',
    { preHandler: process.env.NODE_ENV === 'production' ? [authenticate] : [] },
    async (request, reply) => {
      console.log('ESCALATION ROUTE HIT', request.body);
      const parsed = CreateEscalationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const escalation = await prisma.escalation.create({
        data: { task_id: parsed.data.task_id, priority: parsed.data.priority },
      });

      console.log('ESCALATION STORED', escalation);

      const webhookUrl = process.env.N8N_WEBHOOK_URL;
      if (webhookUrl) {
        try {
          console.log('SENDING TO N8N', escalation);
          const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(escalation),
          });
          console.log('N8N RESPONSE STATUS', res.status);
        } catch (err) {
          console.error('N8N ERROR', err);
        }
      }

      return reply.code(201).send({ success: true, escalation });
    }
  );
}
