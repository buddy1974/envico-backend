import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const CreateRotaSchema = z.object({
  week_start:  z.string().datetime(),
  location_id: z.number().int().positive(),
  notes:       z.string().optional(),
  created_by:  z.string().min(1),
});

const CreateShiftSchema = z.object({
  rota_id:    z.number().int().positive(),
  staff_id:   z.number().int().positive(),
  date:       z.string().datetime(),
  shift_type: z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT', 'FULL_DAY', 'ON_CALL']).default('FULL_DAY'),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, 'Format HH:MM'),
  end_time:   z.string().regex(/^\d{2}:\d{2}$/, 'Format HH:MM'),
  break_mins: z.number().int().min(0).default(30),
  notes:      z.string().optional(),
});

const UpdateShiftSchema = z.object({
  shift_type:  z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT', 'FULL_DAY', 'ON_CALL']).optional(),
  start_time:  z.string().regex(/^\d{2}:\d{2}$/).optional(),
  end_time:    z.string().regex(/^\d{2}:\d{2}$/).optional(),
  break_mins:  z.number().int().min(0).optional(),
  status:      z.enum(['SCHEDULED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW']).optional(),
  notes:       z.string().optional(),
});

const ClockInSchema = z.object({
  actual_start: z.string().datetime().optional(),
});

const ClockOutSchema = z.object({
  actual_end: z.string().datetime().optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcHours(start: Date, end: Date, breakMins: number): number {
  const diffMs = end.getTime() - start.getTime();
  const diffMins = diffMs / 60000;
  return Math.max(0, (diffMins - breakMins) / 60);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function rotaRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/rotas — list rotas (filter by location_id, week_start)
  fastify.get(
    '/api/rotas',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        location_id?: string;
        week_start?: string;
        published?: string;
        page?: string;
        limit?: string;
      };

      const page  = Math.max(1, Number(query.page  ?? 1));
      const limit = Math.min(50, Math.max(1, Number(query.limit ?? 10)));
      const skip  = (page - 1) * limit;

      const where: Record<string, unknown> = {};
      if (query.location_id) where.location_id = Number(query.location_id);
      if (query.week_start)  where.week_start  = new Date(query.week_start);
      if (query.published !== undefined) where.published = query.published === 'true';

      const [rotas, total] = await Promise.all([
        prisma.rota.findMany({
          where,
          include: {
            location: { select: { id: true, name: true } },
            shifts: {
              include: { staff: { select: { id: true, name: true, role: true } } },
              orderBy: { date: 'asc' },
            },
          },
          orderBy: { week_start: 'desc' },
          skip,
          take: limit,
        }),
        prisma.rota.count({ where }),
      ]);

      return reply.code(200).send({
        success: true,
        data: rotas,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    }
  );

  // GET /api/rotas/current — rota for the current week (all locations or one)
  fastify.get(
    '/api/rotas/current',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { location_id?: string };

      // Monday of the current week (UTC)
      const now  = new Date();
      const day  = now.getUTCDay(); // 0=Sun
      const diff = day === 0 ? -6 : 1 - day;
      const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));

      const where: Record<string, unknown> = { week_start: monday };
      if (query.location_id) where.location_id = Number(query.location_id);

      const rotas = await prisma.rota.findMany({
        where,
        include: {
          location: { select: { id: true, name: true } },
          shifts: {
            include: { staff: { select: { id: true, name: true, role: true, email: true } } },
            orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
          },
        },
      });

      return reply.code(200).send({ success: true, data: rotas, week_start: monday });
    }
  );

  // GET /api/rotas/:id — single rota with full shifts
  fastify.get(
    '/api/rotas/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const rota = await prisma.rota.findUnique({
        where: { id: Number(id) },
        include: {
          location: true,
          shifts: {
            include: { staff: { select: { id: true, name: true, role: true, email: true, phone: true } } },
            orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
          },
        },
      });

      if (!rota) return reply.code(404).send({ success: false, error: 'Rota not found' });

      return reply.code(200).send({ success: true, data: rota });
    }
  );

  // POST /api/rotas — create rota
  fastify.post(
    '/api/rotas',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateRotaSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { week_start, location_id, notes, created_by } = parsed.data;

      // Normalise to midnight Monday
      const weekDate = new Date(week_start);
      const day = weekDate.getUTCDay();
      const diff = day === 0 ? -6 : 1 - day;
      weekDate.setUTCDate(weekDate.getUTCDate() + diff);
      weekDate.setUTCHours(0, 0, 0, 0);

      const existing = await prisma.rota.findUnique({
        where: { week_start_location_id: { week_start: weekDate, location_id } },
      });
      if (existing) {
        return reply.code(409).send({ success: false, error: 'Rota already exists for this week and location' });
      }

      const rota = await prisma.rota.create({
        data: { week_start: weekDate, location_id, notes, created_by },
        include: { location: { select: { id: true, name: true } } },
      });

      return reply.code(201).send({ success: true, data: rota });
    }
  );

  // POST /api/rotas/:id/publish — publish rota (notifies staff)
  fastify.post(
    '/api/rotas/:id/publish',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const rota = await prisma.rota.findUnique({
        where: { id: Number(id) },
        include: { shifts: { include: { staff: true } } },
      });
      if (!rota) return reply.code(404).send({ success: false, error: 'Rota not found' });
      if (rota.published) return reply.code(409).send({ success: false, error: 'Rota already published' });

      const updated = await prisma.rota.update({
        where: { id: Number(id) },
        data: { published: true, published_at: new Date() },
      });

      return reply.code(200).send({ success: true, data: updated, shifts_notified: rota.shifts.length });
    }
  );

  // ─── Shift routes ──────────────────────────────────────────────────────────

  // GET /api/shifts — list shifts (filter by staff_id, date range, status)
  fastify.get(
    '/api/shifts',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        staff_id?: string;
        rota_id?: string;
        date_from?: string;
        date_to?: string;
        status?: string;
        page?: string;
        limit?: string;
      };

      const page  = Math.max(1, Number(query.page  ?? 1));
      const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
      const skip  = (page - 1) * limit;

      const where: Record<string, unknown> = {};
      if (query.staff_id) where.staff_id = Number(query.staff_id);
      if (query.rota_id)  where.rota_id  = Number(query.rota_id);
      if (query.status)   where.status   = query.status;
      if (query.date_from || query.date_to) {
        const dateFilter: Record<string, Date> = {};
        if (query.date_from) dateFilter.gte = new Date(query.date_from);
        if (query.date_to)   dateFilter.lte = new Date(query.date_to);
        where.date = dateFilter;
      }

      const [shifts, total] = await Promise.all([
        prisma.shift.findMany({
          where,
          include: {
            staff: { select: { id: true, name: true, role: true } },
            rota: { include: { location: { select: { id: true, name: true } } } },
          },
          orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
          skip,
          take: limit,
        }),
        prisma.shift.count({ where }),
      ]);

      return reply.code(200).send({
        success: true,
        data: shifts,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      });
    }
  );

  // POST /api/shifts — create shift
  fastify.post(
    '/api/shifts',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateShiftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const { rota_id, staff_id, date, shift_type, start_time, end_time, break_mins, notes } = parsed.data;

      const rota = await prisma.rota.findUnique({ where: { id: rota_id } });
      if (!rota) return reply.code(404).send({ success: false, error: 'Rota not found' });

      const shift = await prisma.shift.create({
        data: {
          rota_id,
          staff_id,
          date: new Date(date),
          shift_type,
          start_time,
          end_time,
          break_mins,
          notes,
        },
        include: {
          staff: { select: { id: true, name: true, role: true } },
          rota: { include: { location: { select: { id: true, name: true } } } },
        },
      });

      return reply.code(201).send({ success: true, data: shift });
    }
  );

  // PATCH /api/shifts/:id — update shift
  fastify.patch(
    '/api/shifts/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = UpdateShiftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const shift = await prisma.shift.findUnique({ where: { id: Number(id) } });
      if (!shift) return reply.code(404).send({ success: false, error: 'Shift not found' });

      const updated = await prisma.shift.update({
        where: { id: Number(id) },
        data: parsed.data,
        include: {
          staff: { select: { id: true, name: true, role: true } },
        },
      });

      return reply.code(200).send({ success: true, data: updated });
    }
  );

  // POST /api/shifts/:id/clock-in
  fastify.post(
    '/api/shifts/:id/clock-in',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = ClockInSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const shift = await prisma.shift.findUnique({ where: { id: Number(id) } });
      if (!shift) return reply.code(404).send({ success: false, error: 'Shift not found' });
      if (shift.actual_start) return reply.code(409).send({ success: false, error: 'Already clocked in' });

      const updated = await prisma.shift.update({
        where: { id: Number(id) },
        data: {
          actual_start: parsed.data.actual_start ? new Date(parsed.data.actual_start) : new Date(),
          status: 'IN_PROGRESS',
        },
      });

      return reply.code(200).send({ success: true, data: updated });
    }
  );

  // POST /api/shifts/:id/clock-out
  fastify.post(
    '/api/shifts/:id/clock-out',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const parsed = ClockOutSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const shift = await prisma.shift.findUnique({ where: { id: Number(id) } });
      if (!shift) return reply.code(404).send({ success: false, error: 'Shift not found' });
      if (!shift.actual_start) return reply.code(400).send({ success: false, error: 'Not clocked in yet' });
      if (shift.actual_end)    return reply.code(409).send({ success: false, error: 'Already clocked out' });

      const endTime = parsed.data.actual_end ? new Date(parsed.data.actual_end) : new Date();
      const hoursWorked = calcHours(shift.actual_start, endTime, shift.break_mins);

      const updated = await prisma.shift.update({
        where: { id: Number(id) },
        data: {
          actual_end:   endTime,
          hours_worked: hoursWorked,
          status:       'COMPLETED',
        },
        include: {
          staff: { select: { id: true, name: true } },
        },
      });

      return reply.code(200).send({ success: true, data: updated, hours_worked: hoursWorked });
    }
  );

  // DELETE /api/shifts/:id — remove shift (only if SCHEDULED)
  fastify.delete(
    '/api/shifts/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      const shift = await prisma.shift.findUnique({ where: { id: Number(id) } });
      if (!shift) return reply.code(404).send({ success: false, error: 'Shift not found' });
      if (!['SCHEDULED', 'CONFIRMED'].includes(shift.status)) {
        return reply.code(400).send({ success: false, error: 'Cannot delete a shift that is in progress, completed, or no-show' });
      }

      await prisma.shift.delete({ where: { id: Number(id) } });

      return reply.code(200).send({ success: true, message: 'Shift deleted' });
    }
  );

  // GET /api/staff/:id/shifts — shifts for a staff member
  fastify.get(
    '/api/staff/:id/shifts',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const query = request.query as { date_from?: string; date_to?: string; status?: string };

      const where: Record<string, unknown> = { staff_id: Number(id) };
      if (query.status) where.status = query.status;
      if (query.date_from || query.date_to) {
        const dateFilter: Record<string, Date> = {};
        if (query.date_from) dateFilter.gte = new Date(query.date_from);
        if (query.date_to)   dateFilter.lte = new Date(query.date_to);
        where.date = dateFilter;
      }

      const shifts = await prisma.shift.findMany({
        where,
        include: {
          rota: { include: { location: { select: { id: true, name: true } } } },
        },
        orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
      });

      const totalHours = shifts.reduce((sum, s) => sum + (Number(s.hours_worked) || 0), 0);

      return reply.code(200).send({ success: true, data: shifts, total_hours: totalHours });
    }
  );
}
