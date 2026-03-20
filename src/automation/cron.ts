import cron from 'node-cron';
import prisma from '../db/prisma';
import { emit } from '../utils/eventBus';

export function startCronJobs(): void {

  // ── Daily 8am: check DBS expiring in next 30 days ─────────────────────────
  cron.schedule('0 8 * * *', async () => {
    console.log('[cron] Checking DBS expiry...');
    try {
      const now = new Date();
      const in30 = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const expiring = await prisma.staffDocument.findMany({
        where: {
          type: 'DBS',
          status: 'VALID',
          expiry_date: { gte: now, lte: in30 },
        },
        include: { staff: { select: { id: true, name: true, email: true } } },
      });

      for (const doc of expiring) {
        const daysRemaining = Math.ceil(
          ((doc.expiry_date?.getTime() ?? 0) - now.getTime()) / (1000 * 60 * 60 * 24)
        );
        emit('DBS_EXPIRING', {
          staff_id: doc.staff.id,
          staff_name: doc.staff.name,
          staff_email: doc.staff.email,
          expiry_date: doc.expiry_date?.toLocaleDateString('en-GB') ?? '',
          days_remaining: daysRemaining,
        });
      }

      console.log(`[cron] DBS check complete — ${expiring.length} expiring`);
    } catch (err) {
      console.error('[cron] DBS check failed:', err);
    }
  });

  // ── Daily 8am: check overdue training ─────────────────────────────────────
  cron.schedule('5 8 * * *', async () => {
    console.log('[cron] Checking overdue training...');
    try {
      const overdue = await prisma.trainingRecord.findMany({
        where: { status: { in: ['OVERDUE', 'EXPIRED'] } },
        include: { staff: { select: { id: true, name: true, email: true } } },
      });

      for (const record of overdue) {
        emit('TRAINING_OVERDUE', {
          staff_id: record.staff.id,
          staff_name: record.staff.name,
          staff_email: record.staff.email,
          training_name: record.training_name,
        });
      }

      console.log(`[cron] Training check complete — ${overdue.length} overdue`);
    } catch (err) {
      console.error('[cron] Training check failed:', err);
    }
  });

  // ── Daily 9am: check invoices overdue ─────────────────────────────────────
  cron.schedule('0 9 * * *', async () => {
    console.log('[cron] Checking overdue invoices...');
    try {
      const now = new Date();
      const overdue = await prisma.invoice.findMany({
        where: {
          status: 'SENT',
          due_date: { lt: now },
        },
      });

      for (const invoice of overdue) {
        await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'OVERDUE' } });

        const webhookUrl = process.env.N8N_INVOICE_WEBHOOK;
        if (webhookUrl) {
          await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoice_id: invoice.id, invoice_number: invoice.invoice_number, amount: invoice.amount_total }),
          }).catch((e) => console.error('[cron] Invoice webhook failed:', e));
        }
      }

      console.log(`[cron] Invoice check complete — ${overdue.length} overdue`);
    } catch (err) {
      console.error('[cron] Invoice check failed:', err);
    }
  });

  // ── Monday 9am: weekly summary ─────────────────────────────────────────────
  cron.schedule('0 9 * * 1', async () => {
    console.log('[cron] Sending weekly summary...');
    try {
      const webhookUrl = process.env.N8N_CQC_WEBHOOK;
      if (webhookUrl) {
        const [openTasks, criticalTasks, openIncidents, actionRequired] = await Promise.all([
          prisma.task.count({ where: { status: { not: 'DONE' } } }),
          prisma.task.count({ where: { priority: 'CRITICAL', status: { not: 'DONE' } } }),
          prisma.incident.count({ where: { status: 'OPEN' } }),
          prisma.complianceCheck.count({ where: { status: 'ACTION_REQUIRED' } }),
        ]);

        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            trigger: 'WEEKLY_SUMMARY',
            data: { openTasks, criticalTasks, openIncidents, actionRequired },
            timestamp: new Date().toISOString(),
          }),
        }).catch((e) => console.error('[cron] Weekly webhook failed:', e));
      }

      console.log('[cron] Weekly summary complete');
    } catch (err) {
      console.error('[cron] Weekly summary failed:', err);
    }
  });

  console.log('[cron] All cron jobs scheduled');
}
