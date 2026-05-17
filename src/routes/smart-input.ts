import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';
import { authenticate } from '../middleware/authMiddleware';

function getClaude() { return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }); }

// ─── Section field schemas ────────────────────────────────────────────────────

const SECTION_SCHEMAS: Record<string, { fields: string[]; description: string }> = {
  incident: {
    description: 'Incident report for a care setting',
    fields: ['type', 'severity', 'service_user_name', 'description', 'reported_by', 'location', 'immediate_action_taken', 'witnesses'],
  },
  'care-plan': {
    description: 'Care plan for a service user',
    fields: ['title', 'service_user_name', 'goals', 'support_needs', 'review_date', 'key_worker', 'notes'],
  },
  medication: {
    description: 'Medication record or administration note',
    fields: ['medication_name', 'dosage', 'frequency', 'route', 'prescribed_by', 'start_date', 'reason', 'observations', 'side_effects_noted'],
  },
  compliance: {
    description: 'CQC / regulatory compliance observation or action',
    fields: ['area', 'regulation_reference', 'finding', 'risk_level', 'action_required', 'responsible_person', 'due_date', 'evidence'],
  },
  referral: {
    description: 'New referral for supported living or care services',
    fields: ['service_user_name', 'date_of_birth', 'referral_source', 'referrer_name', 'support_needs', 'urgency_level', 'medical_notes', 'risk_flags'],
  },
  'service-user': {
    description: 'Service user progress note or update',
    fields: ['service_user_name', 'activity_type', 'observation', 'mood', 'physical_wellbeing', 'social_interaction', 'action_needed', 'follow_up_date'],
  },
  finance: {
    description: 'Finance note, invoice or funding update',
    fields: ['reference', 'amount', 'funder', 'service_user_name', 'description', 'due_date', 'status', 'action_required'],
  },
  staff: {
    description: 'Staff note, HR observation or supervision record',
    fields: ['staff_name', 'event_type', 'date', 'summary', 'outcome', 'action_required', 'follow_up_date'],
  },
  'ceo-command': {
    description: 'CEO natural language command or strategic note',
    fields: ['intent', 'urgency', 'subject', 'key_points', 'action_items', 'people_involved', 'deadline'],
  },
  'family-message': {
    description: 'Message from a family member to the care team about their loved one',
    fields: ['subject', 'message', 'urgency', 'preferred_callback', 'specific_concerns'],
  },
};

// ─── Validation schemas ───────────────────────────────────────────────────────

const ProcessSchema = z.object({
  rawText: z.string().min(1).max(5000),
  section: z.string().min(1),
  context: z.string().optional(), // extra context e.g. service user name already known
});

const TranscribeSchema = z.object({
  transcript: z.string().min(1).max(5000),
  section: z.string().min(1),
});

// ─── AI processor ────────────────────────────────────────────────────────────

async function processRawInput(
  rawText: string,
  section: string,
  context?: string,
): Promise<{ fields: Record<string, string>; summary: string; confidence: string; missing: string[] }> {
  const schema = SECTION_SCHEMAS[section] ?? {
    description: 'General care system entry',
    fields: ['title', 'description', 'date', 'action_required'],
  };

  const systemPrompt = `You are the AI data processor for Envico CareOS, a UK care management system.

Your job: extract structured data from raw dictated or typed notes.
Section: ${section} — ${schema.description}
Fields to extract: ${schema.fields.join(', ')}
${context ? `Additional context: ${context}` : ''}

Rules:
- Extract ONLY what is clearly present in the text
- Use null for fields not mentioned
- For severity/urgency: LOW | MEDIUM | HIGH | CRITICAL
- For dates: use DD/MM/YYYY format when extracting, or describe relative dates (e.g. "next Tuesday")
- For UK care: incident types are ACCIDENT | SAFEGUARDING | MEDICATION_ERROR | BEHAVIOUR | OTHER
- Keep descriptions factual and professional
- Do NOT invent or hallucinate information

Return ONLY valid JSON in this exact format:
{
  "fields": {
    ${schema.fields.map((f) => `"${f}": "extracted value or null"`).join(',\n    ')}
  },
  "summary": "One sentence summary of what was captured",
  "confidence": "HIGH | MEDIUM | LOW — how complete the extraction was",
  "missing": ["list", "of", "fields", "that", "were", "not", "found", "but", "are", "important"]
}`;

  const res = await getClaude().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Extract structured data from this input:\n\n${rawText}` }],
  });

  const text = res.content[0].type === 'text' ? res.content[0].text : '{}';

  try {
    // Strip markdown fences if present
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);
    return {
      fields: parsed.fields ?? {},
      summary: parsed.summary ?? 'Data extracted from raw input',
      confidence: parsed.confidence ?? 'MEDIUM',
      missing: parsed.missing ?? [],
    };
  } catch {
    return {
      fields: { description: rawText },
      summary: 'Raw text captured — manual review required',
      confidence: 'LOW',
      missing: schema.fields,
    };
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function smartInputRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/smart-input/sections — return available sections and their fields
  fastify.get(
    '/api/smart-input/sections',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(200).send({
        success: true,
        sections: Object.entries(SECTION_SCHEMAS).map(([key, val]) => ({
          key,
          description: val.description,
          fields: val.fields,
        })),
      });
    },
  );

  // POST /api/smart-input/process — AI processes raw text → structured fields
  fastify.post(
    '/api/smart-input/process',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ProcessSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error: 'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { rawText, section, context } = parsed.data;

      try {
        const result = await processRawInput(rawText, section, context);
        return reply.code(200).send({
          success: true,
          section,
          rawText,
          ...result,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  // POST /api/smart-input/refine — CEO sends a preview + correction note → AI refines
  fastify.post(
    '/api/smart-input/refine',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const RefinedSchema = z.object({
        currentFields: z.record(z.string()),
        correction: z.string().min(1).max(1000),
        section: z.string().min(1),
      });

      const parsed = RefinedSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed' });
      }

      const { currentFields, correction, section } = parsed.data;

      const schema = SECTION_SCHEMAS[section] ?? { description: 'General entry', fields: [] };

      try {
        const res = await getClaude().messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          system: `You are the AI data processor for Envico CareOS. Refine the structured fields based on the correction provided. Return only valid JSON with the updated fields object.`,
          messages: [{
            role: 'user',
            content: `Current fields:\n${JSON.stringify(currentFields, null, 2)}\n\nSection: ${section} — ${schema.description}\n\nCorrection/addition from user: ${correction}\n\nReturn updated JSON: { "fields": { ... }, "summary": "..." }`,
          }],
        });

        const text = res.content[0].type === 'text' ? res.content[0].text : '{}';
        const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const refined = JSON.parse(clean);

        return reply.code(200).send({
          success: true,
          fields: refined.fields ?? currentFields,
          summary: refined.summary ?? 'Fields updated',
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );

  // POST /api/smart-input/generate-report — from raw notes, generate a full formatted report
  fastify.post(
    '/api/smart-input/generate-report',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const ReportSchema = z.object({
        rawText: z.string().min(1).max(5000),
        reportType: z.enum(['incident', 'care-review', 'supervision', 'compliance', 'handover', 'custom']),
        serviceUserName: z.string().optional(),
        staffName: z.string().optional(),
      });

      const parsed = ReportSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Validation failed' });
      }

      const { rawText, reportType, serviceUserName, staffName } = parsed.data;

      const reportPrompts: Record<string, string> = {
        'incident': 'Write a formal CQC-compliant incident report',
        'care-review': 'Write a structured care review summary',
        'supervision': 'Write a professional supervision record',
        'compliance': 'Write a compliance audit finding report',
        'handover': 'Write a clear shift handover note',
        'custom': 'Write a professional care management report',
      };

      try {
        const res = await getClaude().messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1500,
          system: `You are a professional report writer for Envico Supported Living Ltd, a UK CQC-registered care provider. Write formal, accurate, professional reports suitable for regulatory inspection. Use UK English. Date format: DD/MM/YYYY.`,
          messages: [{
            role: 'user',
            content: `${reportPrompts[reportType]} based on these raw notes:

${rawText}

${serviceUserName ? `Service User: ${serviceUserName}` : ''}
${staffName ? `Staff: ${staffName}` : ''}
Date: ${new Date().toLocaleDateString('en-GB')}

Write a complete, professional report with clear sections. Include all information from the notes. Flag any missing information with [REQUIRED: ...]`,
          }],
        });

        const report = res.content[0].type === 'text' ? res.content[0].text : '';

        return reply.code(200).send({
          success: true,
          reportType,
          report,
          generatedAt: new Date().toISOString(),
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({ success: false, error: msg });
      }
    },
  );
}
