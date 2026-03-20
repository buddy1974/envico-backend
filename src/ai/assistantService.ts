import Anthropic from '@anthropic-ai/sdk';
import prisma from '../db/prisma';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an AI assistant for Envico CareOS 2026, an enterprise care management system for Envico Supported Living LTD, a CQC-registered supported living provider in the UK based in Hayes, Middlesex.

You support adults with learning disabilities, autism, ADHD, acquired brain injuries, and mental health conditions.

You help care staff and managers by:
- Answering questions about service users, tasks, incidents, medications
- Suggesting care plan goals based on service user profiles
- Analysing incidents and recommending actions
- Flagging compliance risks and CQC requirements
- Drafting care notes, reports, and correspondence
- Identifying patterns in care data

Key regulations you follow:
- CQC Fundamental Standards (Health and Social Care Act 2008)
- Oliver McGowan Mandatory Training (legal from Q2 2026)
- Mental Capacity Act 2005
- Care Act 2014
- Right Support Right Care Right Culture framework

Always be professional, compassionate, and person-centred in your responses.
Always flag urgent safeguarding concerns immediately.
Never share personal data unnecessarily.
Respond in clear, plain English suitable for care staff.`;

export async function askAssistant(question: string, contextType: string, contextData?: unknown) {
  let contextMessage = '';

  if (contextType === 'TASK') {
    const tasks = await prisma.task.findMany({
      where: { status: { not: 'DONE' } },
      orderBy: { created_at: 'desc' },
      take: 20,
    });
    contextMessage = `Current open tasks: ${JSON.stringify(tasks)}`;
  }

  if (contextType === 'SERVICE_USER') {
    const users = await prisma.serviceUser.findMany({
      include: { incidents: { take: 5 }, medications: true, care_plans: true },
      take: 10,
    });
    contextMessage = `Service users data: ${JSON.stringify(users)}`;
  }

  if (contextType === 'COMPLIANCE') {
    const checks = await prisma.complianceCheck.findMany({
      where: { status: { not: 'COMPLIANT' } },
      orderBy: { due_date: 'asc' },
      take: 10,
    });
    contextMessage = `Non-compliant checks: ${JSON.stringify(checks)}`;
  }

  if (contextType === 'MEDICATION') {
    const meds = await prisma.medication.findMany({
      where: { status: 'ACTIVE' },
      include: { service_user: true },
    });
    contextMessage = `Active medications: ${JSON.stringify(meds)}`;
  }

  if (contextType === 'GENERAL') {
    const [taskCount, criticalCount, openIncidents, overdueCompliance] = await Promise.all([
      prisma.task.count({ where: { status: { not: 'DONE' } } }),
      prisma.task.count({ where: { priority: 'CRITICAL', status: { not: 'DONE' } } }),
      prisma.incident.count({ where: { status: 'OPEN' } }),
      prisma.complianceCheck.count({ where: { status: 'ACTION_REQUIRED' } }),
    ]);
    contextMessage = `System summary: ${taskCount} open tasks, ${criticalCount} critical, ${openIncidents} open incidents, ${overdueCompliance} compliance actions required.`;
  }

  if (contextData) {
    contextMessage += `\nAdditional context: ${JSON.stringify(contextData)}`;
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: contextMessage
          ? `Context:\n${contextMessage}\n\nQuestion: ${question}`
          : question,
      },
    ],
  });

  const answer = response.content[0].type === 'text' ? response.content[0].text : '';

  return {
    answer,
    model: response.model,
    context_type: contextType,
  };
}
