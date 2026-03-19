import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { registerUser, loginUser } from '../services/authService';

const RegisterSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['ADMIN', 'MANAGER', 'STAFF']),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = RegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const user = await registerUser(
        parsed.data.name,
        parsed.data.email,
        parsed.data.password,
        parsed.data.role
      );
      return reply.code(201).send({ success: true, user });
    } catch (err: any) {
      if (err.code === 'P2002') {
        return reply.code(409).send({ success: false, error: 'Email already registered' });
      }
      throw err;
    }
  });

  fastify.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        success: false,
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const result = await loginUser(parsed.data.email, parsed.data.password);
    if ('error' in result) {
      return reply.code(401).send({ success: false, error: 'Invalid credentials' });
    }

    return reply.code(200).send({ success: true, token: result.token, user: result.user });
  });
}
