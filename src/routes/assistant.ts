import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import { askAssistant } from '../ai/assistantService';

const AskSchema = z.object({
  question:     z.string().min(1).max(1000),
  context_type: z.enum(['GENERAL', 'TASK', 'SERVICE_USER', 'COMPLIANCE', 'MEDICATION']).default('GENERAL'),
  context_data: z.unknown().optional(),
});

export async function assistantRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/assistant/ask',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = AskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { question, context_type, context_data } = parsed.data;

      const result = await askAssistant(question, context_type, context_data);

      return reply.code(200).send({ success: true, ...result });
    }
  );
}
