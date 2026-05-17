import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { registerUser, loginUser, refreshAccessToken, logoutUser } from '../services/authService';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import prisma from '../db/prisma';

const RegisterSchema = z.object({
  name:        z.string().min(1),
  email:       z.string().email(),
  password:    z.string().min(8),
  role:        z.enum(['ADMIN', 'MANAGER', 'STAFF']),
  location_id: z.number().int().positive().optional(),
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const RefreshSchema = z.object({
  refresh_token: z.string().min(1),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {

  // Register — ADMIN only
  fastify.post(
    '/api/auth/register',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RegisterSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      try {
        const user = await registerUser(parsed.data.name, parsed.data.email, parsed.data.password, parsed.data.role, parsed.data.location_id);
        return reply.code(201).send({ success: true, user });
      } catch (err: any) {
        if (err.code === 'P2002') {
          return reply.code(409).send({ success: false, error: 'Email already registered' });
        }
        throw err;
      }
    }
  );

  // Login — 5 attempts per minute per IP
  fastify.post(
    '/api/auth/login',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          errorResponseBuilder: () => ({
            success: false,
            error: 'Too many login attempts. Please wait 1 minute before trying again.',
          }),
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = LoginSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }
      const result = await loginUser(parsed.data.email, parsed.data.password);
      if ('error' in result) {
        if (result.error === 'ACCOUNT_DISABLED') {
          return reply.code(403).send({ success: false, error: 'Account is disabled' });
        }
        return reply.code(401).send({ success: false, error: 'Invalid credentials' });
      }
      return reply.code(200).send({ success: true, token: result.token, refresh_token: result.refresh_token, user: result.user });
    }
  );

  // Refresh token — 10 per minute per IP
  fastify.post(
    '/api/auth/refresh',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RefreshSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'refresh_token is required' });
      }
      const result = await refreshAccessToken(parsed.data.refresh_token);
      if ('error' in result) {
        return reply.code(401).send({ success: false, error: 'Invalid or expired refresh token' });
      }
      return reply.code(200).send({ success: true, token: result.token, user: result.user });
    }
  );

  // Logout
  fastify.post(
    '/api/auth/logout',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = RefreshSchema.safeParse(request.body);
      if (parsed.success) {
        await logoutUser(parsed.data.refresh_token);
      }
      return reply.code(200).send({ success: true, message: 'Logged out' });
    }
  );

  // POST /api/auth/change-password — authenticated user changes their own password
  fastify.post(
    '/api/auth/change-password',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const Schema = z.object({
        current_password: z.string().min(1),
        new_password:     z.string().min(8, 'New password must be at least 8 characters'),
      });
      const parsed = Schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      }

      const userId = request.user!.id;
      const user   = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return reply.code(404).send({ success: false, error: 'User not found' });

      const match = await bcrypt.compare(parsed.data.current_password, user.password);
      if (!match) return reply.code(401).send({ success: false, error: 'Current password is incorrect' });

      const hashed = await bcrypt.hash(parsed.data.new_password, 10);
      await prisma.user.update({ where: { id: userId }, data: { password: hashed, refresh_token: null } });

      return reply.code(200).send({ success: true, message: 'Password changed successfully. Please log in again.' });
    }
  );

  // POST /api/auth/reset-user-password — ADMIN force-resets any user password by id
  fastify.post<{ Params: { id: string } }>(
    '/api/auth/reset-user-password/:id',
    { preHandler: [authenticate, requireRole(['ADMIN'])] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const Schema = z.object({ new_password: z.string().min(8) });
      const parsed = Schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'new_password must be at least 8 characters' });
      }

      const id = parseInt(request.params.id, 10);
      if (isNaN(id)) return reply.code(400).send({ success: false, error: 'Invalid user id' });

      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) return reply.code(404).send({ success: false, error: 'User not found' });

      const hashed = await bcrypt.hash(parsed.data.new_password, 10);
      await prisma.user.update({ where: { id }, data: { password: hashed, refresh_token: null } });

      return reply.code(200).send({ success: true, message: `Password reset for ${user.email}` });
    }
  );
}
