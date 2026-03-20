import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const CreatePayrollSchema = z.object({
  staff_id:       z.number().int().positive(),
  period_start:   z.string(),
  period_end:     z.string(),
  hours_worked:   z.number().positive(),
  hourly_rate:    z.number().positive(),
  overtime_hours: z.number().min(0).optional(),
  overtime_rate:  z.number().min(0).optional(),
  deductions:     z.number().min(0).optional(),
  notes:          z.string().optional(),
});

const UpdatePayrollSchema = z.object({
  hours_worked:   z.number().positive().optional(),
  hourly_rate:    z.number().positive().optional(),
  overtime_hours: z.number().min(0).optional(),
  overtime_rate:  z.number().min(0).optional(),
  deductions:     z.number().min(0).optional(),
  notes:          z.string().optional(),
  status:         z.enum(['DRAFT', 'APPROVED', 'PAID']).optional(),
});

export async function payrollRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/payroll
  fastify.get(
    '/api/payroll',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { status, staff_id } = request.query as { status?: string; staff_id?: string };
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (staff_id) where.staff_id = parseInt(staff_id, 10);

      const records = await prisma.payrollRecord.findMany({
        where,
        include: { staff: { select: { id: true, name: true, role: true, email: true } } },
        orderBy: { period_start: 'desc' },
      });
      return reply.code(200).send({ success: true, payroll: records });
    }
  );

  // POST /api/payroll
  fastify.post(
    '/api/payroll',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreatePayrollSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { period_start, period_end, hours_worked, hourly_rate, overtime_hours = 0, overtime_rate = 0, deductions = 0, ...rest } = parsed.data;
      const gross_pay = (hours_worked * hourly_rate) + (overtime_hours * overtime_rate);
      const net_pay = gross_pay - deductions;

      const record = await prisma.payrollRecord.create({
        data: {
          ...rest,
          period_start: new Date(period_start),
          period_end: new Date(period_end),
          hours_worked,
          hourly_rate,
          overtime_hours,
          overtime_rate,
          gross_pay,
          deductions,
          net_pay,
        },
      });

      return reply.code(201).send({ success: true, payroll: record });
    }
  );

  // PATCH /api/payroll/:id
  fastify.patch<{ Params: { id: string } }>(
    '/api/payroll/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const parsed = UpdatePayrollSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const data = parsed.data;
      // Recalculate pay if hours/rate changed
      const updateData: Record<string, unknown> = { ...data };
      if (data.hours_worked !== undefined || data.hourly_rate !== undefined || data.overtime_hours !== undefined || data.overtime_rate !== undefined || data.deductions !== undefined) {
        const existing = await prisma.payrollRecord.findUnique({ where: { id } });
        if (!existing) return reply.code(404).send({ success: false, error: 'Payroll record not found' });
        const h = Number(data.hours_worked ?? existing.hours_worked);
        const r = Number(data.hourly_rate ?? existing.hourly_rate);
        const oh = Number(data.overtime_hours ?? existing.overtime_hours);
        const or_ = Number(data.overtime_rate ?? existing.overtime_rate);
        const ded = Number(data.deductions ?? existing.deductions);
        updateData.gross_pay = (h * r) + (oh * or_);
        updateData.net_pay = Number(updateData.gross_pay) - ded;
      }

      const record = await prisma.payrollRecord.update({ where: { id }, data: updateData });
      return reply.code(200).send({ success: true, payroll: record });
    }
  );

  // POST /api/payroll/:id/approve
  fastify.post<{ Params: { id: string } }>(
    '/api/payroll/:id/approve',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid id' });

      const { approved_by } = request.body as { approved_by?: string };

      const record = await prisma.payrollRecord.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approved_by: approved_by ?? 'system',
          approved_at: new Date(),
        },
      });

      return reply.code(200).send({ success: true, payroll: record });
    }
  );
}
