import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreateInvoiceSchema = z.object({
  service_user_id:   z.number().int().positive(),
  funding_source_id: z.number().int().positive().optional(),
  period_start:      z.string(),
  period_end:        z.string(),
  weeks:             z.number().positive(),
  weekly_rate:       z.number().positive(),
  notes:             z.string().optional(),
  created_by:        z.string().min(1),
});

const UpdateInvoiceSchema = z.object({
  status:    z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']).optional(),
  due_date:  z.string().optional(),
  issued_at: z.string().optional(),
  notes:     z.string().optional(),
});

function generateInvoiceNumber(): string {
  const year = new Date().getFullYear();
  const rand = Math.floor(Math.random() * 9000) + 1000;
  return `INV-${year}-${rand}`;
}

export async function invoiceRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/invoices
  fastify.get(
    '/api/invoices',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, service_user_id } = request.query as { status?: string; service_user_id?: string };
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (service_user_id) where.service_user_id = parseInt(service_user_id, 10);

      const invoices = await prisma.invoice.findMany({
        where,
        include: {
          service_user: { select: { id: true, first_name: true, last_name: true } },
          funding_source: { select: { id: true, funder_name: true, funding_type: true } },
        },
        orderBy: { created_at: 'desc' },
      });
      return reply.code(200).send({ success: true, invoices });
    }
  );

  // GET /api/invoices/:id
  fastify.get<{ Params: { id: string } }>(
    '/api/invoices/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: {
          service_user: { select: { id: true, first_name: true, last_name: true } },
          funding_source: true,
          transactions: true,
        },
      });

      if (!invoice) return reply.code(404).send({ success: false, error: 'Invoice not found' });
      return reply.code(200).send({ success: true, invoice });
    }
  );

  // POST /api/invoices
  fastify.post(
    '/api/invoices',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateInvoiceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { period_start, period_end, weeks, weekly_rate, ...rest } = parsed.data;
      const amount_net = weeks * weekly_rate;

      const invoice = await prisma.invoice.create({
        data: {
          ...rest,
          invoice_number: generateInvoiceNumber(),
          period_start: new Date(period_start),
          period_end: new Date(period_end),
          weeks,
          weekly_rate,
          amount_net,
          vat_amount: 0,
          amount_total: amount_net,
        },
      });

      return reply.code(201).send({ success: true, invoice });
    }
  );

  // PATCH /api/invoices/:id
  fastify.patch<{ Params: { id: string } }>(
    '/api/invoices/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdateInvoiceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const data = parsed.data;
      const invoice = await prisma.invoice.update({
        where: { id },
        data: {
          ...data,
          ...(data.due_date ? { due_date: new Date(data.due_date) } : {}),
          ...(data.issued_at ? { issued_at: new Date(data.issued_at) } : {}),
        },
      });

      return reply.code(200).send({ success: true, invoice });
    }
  );

  // POST /api/invoices/:id/mark-paid
  fastify.post<{ Params: { id: string } }>(
    '/api/invoices/:id/mark-paid',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const invoice = await prisma.invoice.update({
        where: { id },
        data: { status: 'PAID', paid_at: new Date() },
      });

      return reply.code(200).send({ success: true, invoice });
    }
  );
}
