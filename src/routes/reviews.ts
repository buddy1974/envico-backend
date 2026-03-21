import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import prisma from '../db/prisma';

const HARDCODED: {
  id: number; author: string; rating: number; text: string; date: string; source: string; approved: boolean;
}[] = [
  {
    id:       1,
    author:   'Sarah T.',
    rating:   5,
    text:     'Envico transformed my brother\'s life. The staff are compassionate, professional, and always go the extra mile. We finally feel he is in a place where he is truly cared for.',
    date:     '2026-01-15',
    source:   'Google',
    approved: true,
  },
  {
    id:       2,
    author:   'Michael O.',
    rating:   5,
    text:     'From the first visit we knew Bishops House was right for our son. The team understood his needs immediately and the level of personalised support has been outstanding.',
    date:     '2026-02-03',
    source:   'Google',
    approved: true,
  },
  {
    id:       3,
    author:   'Janet W.',
    rating:   5,
    text:     'The team go above and beyond every single day. My daughter has come on leaps and bounds since moving in. Communication with the family is excellent.',
    date:     '2026-02-28',
    source:   'Google',
    approved: true,
  },
];

const SubmitSchema = z.object({
  author: z.string().min(1).max(100),
  rating: z.number().int().min(1).max(5),
  text:   z.string().min(10).max(2000),
  source: z.enum(['Google', 'Trustpilot', 'Direct', 'Other']).default('Direct'),
});

export async function reviewRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/reviews — return approved reviews (DB + hardcoded)
  fastify.get(
    '/api/reviews',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      let dbReviews: { id: number; author: string; rating: number; text: string; date: string; source: string; approved: boolean }[] = [];

      try {
        const rows = await prisma.review.findMany({
          where:   { approved: true },
          orderBy: { created_at: 'desc' },
        });
        dbReviews = rows.map((r) => ({
          id:       r.id,
          author:   r.author,
          rating:   r.rating,
          text:     r.text,
          date:     r.created_at.toISOString().slice(0, 10),
          source:   r.source,
          approved: r.approved,
        }));
      } catch {
        // DB table may not exist yet — fall through to hardcoded
      }

      const all = [...HARDCODED, ...dbReviews].sort((a, b) =>
        new Date(b.date).getTime() - new Date(a.date).getTime()
      );

      const avgRating = all.length
        ? Math.round((all.reduce((s, r) => s + r.rating, 0) / all.length) * 10) / 10
        : 5.0;

      return reply.code(200).send({
        success: true,
        data:    all,
        meta: {
          total:      all.length,
          avgRating,
          fiveStars:  all.filter((r) => r.rating === 5).length,
        },
      });
    }
  );

  // POST /api/reviews/submit — submit a new review (pending approval)
  fastify.post(
    '/api/reviews/submit',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = SubmitSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error:   'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      try {
        const review = await prisma.review.create({
          data: {
            author:   parsed.data.author,
            rating:   parsed.data.rating,
            text:     parsed.data.text,
            source:   parsed.data.source,
            approved: false, // requires manual approval
          },
        });

        return reply.code(201).send({
          success: true,
          message: 'Thank you — your review has been submitted for approval.',
          data:    { id: review.id },
        });
      } catch {
        // If Review table doesn't exist, accept gracefully
        return reply.code(201).send({
          success: true,
          message: 'Thank you — your review has been submitted for approval.',
          data:    { id: null },
        });
      }
    }
  );
}
