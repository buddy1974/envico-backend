import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/authMiddleware';

interface Appointment {
  id:      number;
  name:    string;
  email:   string;
  phone:   string;
  purpose: string;
  date:    string;
  time:    string;
  status:  'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';
  created_at: string;
}

const store: Appointment[] = [];
let nextId = 1;

const CreateSchema = z.object({
  name:    z.string().min(1).max(200),
  email:   z.string().email(),
  phone:   z.string().min(1).max(30),
  purpose: z.string().min(1).max(500),
  date:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD'),
  time:    z.string().regex(/^\d{2}:\d{2}$/, 'Format HH:MM'),
  status:  z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'COMPLETED']).default('PENDING'),
});

export async function appointmentRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/appointments — create appointment
  fastify.post(
    '/api/appointments',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const appointment: Appointment = {
        id:         nextId++,
        ...parsed.data,
        created_at: new Date().toISOString(),
      };

      store.push(appointment);

      return reply.code(201).send({ success: true, data: appointment });
    },
  );

  // GET /api/appointments — list all appointments
  fastify.get(
    '/api/appointments',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as {
        status?: string;
        date?:   string;
      };

      let results = [...store];
      if (query.status) results = results.filter((a) => a.status === query.status.toUpperCase());
      if (query.date)   results = results.filter((a) => a.date === query.date);

      return reply.code(200).send({
        success: true,
        data:    results,
        total:   results.length,
      });
    },
  );
}
