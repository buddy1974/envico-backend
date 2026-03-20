import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyEnv from '@fastify/env';
import rateLimit from '@fastify/rate-limit';

import { healthRoutes } from './routes/health';
import { referralRoutes } from './routes/referrals';
import { taskRoutes } from './routes/tasks';
import { activityRoutes } from './routes/activity';
import { staffRoutes } from './routes/staff';
import { authRoutes } from './routes/auth';
import { escalationRoutes } from './routes/escalations';
import { serviceUserRoutes } from './routes/service-users';
import { carePlanRoutes } from './routes/care-plans';
import { incidentRoutes } from './routes/incidents';
import { medicationRoutes } from './routes/medications';
import { invoiceRoutes } from './routes/invoices';
import { payrollRoutes } from './routes/payroll';
import { financeRoutes } from './routes/finance';
import { fundingRoutes } from './routes/funding';
import { staffDocumentRoutes } from './routes/staff-documents';
import { trainingRoutes } from './routes/training';
import { recruitmentRoutes } from './routes/recruitment';
import { complianceRoutes } from './routes/compliance';
import { assistantRoutes } from './routes/assistant';
import { userRoutes } from './routes/users';
import { locationRoutes } from './routes/locations';
import { automationRoutes } from './routes/automation';
import { rotaRoutes } from './routes/rota';
import { emailRoutes } from './routes/email';
import { calendarRoutes } from './routes/calendar';

import { registerHandlers } from './automation/handlers';
import { startCronJobs } from './automation/cron';
import { ensureCriticalTestTask } from './scripts/ensureCriticalTestTask';
import { seedLocations } from './scripts/seedLocations';

import { FastifyRequest } from 'fastify';

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
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Global rate limit — 100 req/min per IP
  await fastify.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request: FastifyRequest, context: { after: string }) => ({
      success: false,
      error: `Rate limit exceeded. Try again in ${context.after}`,
    }),
  });

  fastify.register(healthRoutes);
  fastify.register(referralRoutes);
  fastify.register(authRoutes);
  fastify.register(taskRoutes);
  fastify.register(activityRoutes);
  fastify.register(staffRoutes);
  fastify.register(escalationRoutes, { prefix: '/api' });
  fastify.register(serviceUserRoutes);
  fastify.register(carePlanRoutes);
  fastify.register(incidentRoutes);
  fastify.register(medicationRoutes);
  fastify.register(invoiceRoutes);
  fastify.register(payrollRoutes);
  fastify.register(financeRoutes);
  fastify.register(fundingRoutes);
  fastify.register(staffDocumentRoutes);
  fastify.register(trainingRoutes);
  fastify.register(recruitmentRoutes);
  fastify.register(complianceRoutes);
  fastify.register(assistantRoutes);
  fastify.register(userRoutes);
  fastify.register(locationRoutes);
  fastify.register(automationRoutes);
  fastify.register(rotaRoutes);
  fastify.register(emailRoutes);
  fastify.register(calendarRoutes);

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

    await seedLocations();
    startCronJobs();
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
