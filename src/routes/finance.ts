import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateTransactionSchema = z.object({
  type:             z.enum(['INCOME', 'EXPENSE']),
  category:         z.enum(['CARE_FEES', 'STAFF_WAGES', 'UTILITIES', 'SUPPLIES', 'TRANSPORT', 'TRAINING', 'OTHER']),
  amount:           z.number().positive(),
  description:      z.string().min(1),
  reference:        z.string().optional(),
  transaction_date: z.string(),
  service_user_id:  z.number().int().positive().optional(),
  invoice_id:       z.number().int().positive().optional(),
  payroll_id:       z.number().int().positive().optional(),
  recorded_by:      z.string().min(1),
  notes:            z.string().optional(),
});

export async function financeRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/finance/transactions
  fastify.get(
    '/api/finance/transactions',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { type, category } = request.query as { type?: string; category?: string };
      const where: Record<string, unknown> = {};
      if (type) where.type = type;
      if (category) where.category = category;

      const transactions = await prisma.financeTransaction.findMany({
        where,
        include: {
          service_user: { select: { id: true, first_name: true, last_name: true } },
          invoice: { select: { id: true, invoice_number: true } },
          payroll: { select: { id: true, period_start: true, period_end: true } },
        },
        orderBy: { transaction_date: 'desc' },
      });
      return reply.code(200).send({ success: true, transactions });
    }
  );

  // POST /api/finance/transactions
  fastify.post(
    '/api/finance/transactions',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateTransactionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { transaction_date, ...rest } = parsed.data;
      const transaction = await prisma.financeTransaction.create({
        data: { ...rest, transaction_date: new Date(transaction_date) },
      });

      return reply.code(201).send({ success: true, transaction });
    }
  );

  // GET /api/finance/summary
  fastify.get(
    '/api/finance/summary',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [incomeResult, expenseResult, invoiceCounts] = await Promise.all([
        prisma.financeTransaction.aggregate({
          where: { type: 'INCOME' },
          _sum: { amount: true },
        }),
        prisma.financeTransaction.aggregate({
          where: { type: 'EXPENSE' },
          _sum: { amount: true },
        }),
        prisma.invoice.groupBy({
          by: ['status'],
          _count: { id: true },
          _sum: { amount_total: true },
        }),
      ]);

      const total_income = Number(incomeResult._sum.amount ?? 0);
      const total_expenses = Number(expenseResult._sum.amount ?? 0);

      return reply.code(200).send({
        success: true,
        summary: {
          total_income,
          total_expenses,
          net: total_income - total_expenses,
          invoices: invoiceCounts,
        },
      });
    }
  );
}
