import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyEnv from '@fastify/env';

import { healthRoutes } from './routes/health';
import { referralRoutes } from './routes/referrals';
import { taskRoutes } from './routes/tasks';
import { activityRoutes } from './routes/activity';
import { staffRoutes } from './routes/staff';
import { authRoutes } from './routes/auth';
import { escalationRoutes } from './routes/escalations';

import { registerHandlers } from './automation/handlers';
import { ensureCriticalTestTask } from './scripts/ensureCriticalTestTask';

const envSchema = {
  type: 'object',
  required: ['DATABASE_URL', 'JWT_SECRET'],
  properties: {
    DATABASE_URL: { type: 'string' },
    PORT: { type: 'string', default: '3000' },
    HOST: { type: 'string', default: '0.0.0.0' },
    JWT_SECRET: { type: 'string' },
  },
};

declare module 'fastify' {
  interface FastifyInstance {
    config: {
      DATABASE_URL: string;
      PORT: string;
      HOST: string;
      JWT_SECRET: string;
    };
  }
}

registerHandlers();

export async function buildServer() {
  const fastify = Fastify({
    logger: {
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss Z',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  fastify.register(fastifyEnv, {
    schema: envSchema,
    dotenv: true,
  });

  fastify.register(cors, {
    origin: ['http://localhost:5173', 'https://envico-dashboard.vercel.app', 'https://envico.maxpromo.digital'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  fastify.register(healthRoutes);
  fastify.register(referralRoutes);
  fastify.register(authRoutes);
  fastify.register(taskRoutes);
  fastify.register(activityRoutes);
  fastify.register(staffRoutes);
  fastify.register(escalationRoutes, { prefix: '/api' });

  fastify.setErrorHandler((error, _request, reply) => {
    fastify.log.error(error);
    reply.status(500).send({ error: 'Internal Server Error' });
  });

  return fastify;
}

async function start() {
  const fastify = await buildServer();
  const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

  if (process.env.NODE_ENV !== 'production') {
    console.log('DEV MODE — ensuring clean start');
  }

  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log('SERVER RUNNING ON:', PORT);
    console.log(fastify.printRoutes());

    if (process.env.NODE_ENV !== 'production') {
      await ensureCriticalTestTask();
    }
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      console.error(`PORT ${PORT} already in use — kill the existing process and retry`);
      process.exit(1);
    }
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
