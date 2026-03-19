import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createReferral } from '../services/referralService';

const CreateReferralSchema = z.object({
  service_user_name: z.string().min(1, 'service_user_name is required'),
  dob: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: 'dob must be a valid ISO date string',
  }),
  referral_source: z.string().min(1, 'referral_source is required'),
  referrer_name: z.string().min(1, 'referrer_name is required'),
  referrer_contact: z.string().min(1, 'referrer_contact is required'),
  support_needs: z.string().min(1, 'support_needs is required'),
  urgency_level: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT'], {
    errorMap: () => ({ message: 'urgency_level must be LOW, MEDIUM, HIGH, or URGENT' }),
  }),
});

type CreateReferralBody = z.infer<typeof CreateReferralSchema>;

export async function referralRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/referrals',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = CreateReferralSchema.safeParse(request.body);

      if (!parseResult.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: parseResult.error.flatten().fieldErrors,
        });
      }

      const body: CreateReferralBody = parseResult.data;

      try {
        const referral = await createReferral({
          service_user_name: body.service_user_name,
          dob: new Date(body.dob),
          referral_source: body.referral_source,
          referrer_name: body.referrer_name,
          referrer_contact: body.referrer_contact,
          support_needs: body.support_needs,
          urgency_level: body.urgency_level,
        });

        return reply.code(201).send({
          success: true,
          referral_id: referral.referral_id,
        });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({
          success: false,
          error: 'Internal server error',
        });
      }
    }
  );
}
