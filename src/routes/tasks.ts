import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { updateTaskStatus, createTaskFromWebhook } from '../services/taskService';
import { assignTask } from '../services/taskAssignmentService';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const UpdateStatusSchema = z.object({
  status: z.enum(['PENDING', 'IN_PROGRESS', 'DONE']),
});

const AssignTaskSchema = z.object({
  staff_id: z.number().int().positive(),
});

// Task 3 — POST /api/tasks (called by n8n HTTP Request node)
const CreateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(['CRITICAL', 'HIGH', 'NORMAL']).default('NORMAL'),
  referral_id: z.string().optional(),
  escalation_id: z.number().optional(),
});

export async function taskRoutes(fastify: FastifyInstance): Promise<void> {

  // ─── GET /api/tasks — Task 11 (task list) ──────────────────────────────────
  fastify.get(
    '/api/tasks',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { priority, status } = request.query as { priority?: string; status?: string };

      const where: any = {};
      if (priority) where.priority = priority;    // Task 14 — filter by priority
      if (status) where.status = status;

      const tasks = await prisma.task.findMany({
        where,
        orderBy: [{ priority: 'asc' }, { created_at: 'desc' }],
      });

      return reply.code(200).send({ success: true, tasks });
    }
  );

  // ─── GET /api/tasks/summary — Task 15 (dashboard summary) ──────────────────
  fastify.get(
    '/api/tasks/summary',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const [total, critical, pending, inProgress] = await Promise.all([
        prisma.task.count(),
        prisma.task.count({ where: { priority: 'CRITICAL' } }),
        prisma.task.count({ where: { status: 'PENDING' } }),
        prisma.task.count({ where: { status: 'IN_PROGRESS' } }),
      ]);

      return reply.code(200).send({ success: true, summary: { total, critical, pending, inProgress } });
    }
  );

  // ─── GET /api/tasks/:id — Task 12 (task detail) ────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/api/tasks/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const taskId = parseInt(request.params.id, 10);
      if (isNaN(taskId)) return reply.code(400).send({ success: false, error: 'Invalid task id' });

      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: { assignments: { include: { staff: true } } },
      });

      if (!task) return reply.code(404).send({ success: false, error: 'Task not found' });

      return reply.code(200).send({ success: true, task });
    }
  );

  // ─── POST /api/tasks — Task 3 (n8n creates tasks here) ─────────────────────
  fastify.post(
    '/api/tasks',
    { preHandler: [] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const task = await createTaskFromWebhook(parsed.data);

      console.log(`[ENVICO] Task created from n8n — id:${task.id} priority:${task.priority} assignedTo:${task.assignedTo}`);

      return reply.code(201).send({ success: true, task });
    }
  );

  // ─── PATCH /api/tasks/:id/status — Task 13 (Start / Complete buttons) ──────
  fastify.patch<{ Params: { id: string } }>(
    '/api/tasks/:id/status',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const taskId = parseInt(request.params.id, 10);
      if (isNaN(taskId)) return reply.code(400).send({ success: false, error: 'Invalid task id' });

      const parsed = UpdateStatusSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const result = await updateTaskStatus(taskId, parsed.data.status);

      if (result.error === 'NOT_FOUND') return reply.code(404).send({ success: false, error: 'Task not found' });
      if (result.error === 'INVALID_TRANSITION') {
        return reply.code(400).send({
          success: false,
          error: `Invalid transition: ${result.current} → ${result.requested}`,
        });
      }

      return reply.code(200).send({ success: true, task: result.task });
    }
  );

  // ─── POST /api/tasks/:id/assign ─────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/api/tasks/:id/assign',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const taskId = parseInt(request.params.id, 10);
      if (isNaN(taskId)) return reply.code(400).send({ success: false, error: 'Invalid task id' });

      const parsed = AssignTaskSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const result = await assignTask(taskId, parsed.data.staff_id);

      if (result.error === 'TASK_NOT_FOUND') return reply.code(404).send({ success: false, error: 'Task not found' });
      if (result.error === 'STAFF_NOT_FOUND') return reply.code(404).send({ success: false, error: 'Staff not found' });

      return reply.code(200).send({ success: true, assignment: result.assignment });
    }
  );
}
