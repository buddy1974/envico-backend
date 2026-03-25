import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { authenticate } from '../middleware/authMiddleware';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Route 1: POST /ocr ────────────────────────────────────────────────────

type OcrContext = 'referral' | 'incident' | 'care_note' | 'document';

interface OcrBody {
  imageBase64: string;
  mediaType: string;
  context: OcrContext;
}

const OCR_SYSTEM_PROMPT =
  'You are a document reader for Envico Supported Living, a CQC-registered care provider in Hayes, Middlesex. ' +
  'Extract all relevant information from this image. The image may be a handwritten referral note, an NHS referral form, ' +
  'an incident report, a care note, a DBS certificate, or a training certificate. ' +
  'Return ONLY valid JSON. No markdown. No explanation.';

const OCR_USER_PROMPTS: Record<OcrContext, string> = {
  referral:
    'Extract and return JSON with these fields: full_name, date_of_birth (YYYY-MM-DD), phone, email, address, ' +
    'support_needs, urgency ("Routine"|"Urgent"|"Emergency"|null), referring_professional, referring_organisation, ' +
    'nhs_number, gp_name, funding_source, notes, confidence ("high"|"medium"|"low")',

  incident:
    'Extract and return JSON with these fields: incident_date (YYYY-MM-DD), incident_time (HH:MM), location, ' +
    'description, severity ("LOW"|"MEDIUM"|"HIGH"|"CRITICAL"|null), persons_involved, immediate_action_taken, ' +
    'witnesses, injuries_reported (boolean), police_notified (boolean), family_notified (boolean), confidence ("high"|"medium"|"low")',

  care_note:
    'Extract and return JSON with these fields: service_user_name, date, shift ("morning"|"afternoon"|"night"|null), ' +
    'mood, activities, personal_care, nutrition, medication_given (boolean), concerns, handover_notes, confidence ("high"|"medium"|"low")',

  document:
    'Extract and return JSON with these fields: document_type, person_name, issue_date (YYYY-MM-DD), ' +
    'expiry_date (YYYY-MM-DD), reference_number, issuing_body, status, confidence ("high"|"medium"|"low")',
};

async function ocrHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as OcrBody;

  if (!body?.imageBase64 || !body?.mediaType || !body?.context) {
    return reply.code(400).send({ success: false, error: 'imageBase64, mediaType, and context are required' });
  }

  const validContexts: OcrContext[] = ['referral', 'incident', 'care_note', 'document'];
  if (!validContexts.includes(body.context)) {
    return reply.code(400).send({ success: false, error: `context must be one of: ${validContexts.join(', ')}` });
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: OCR_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: body.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: body.imageBase64,
            },
          },
          { type: 'text', text: OCR_USER_PROMPTS[body.context] },
        ],
      },
    ],
  });

  const raw = response.content.find((b) => b.type === 'text')?.text ?? '';

  try {
    const parsed = JSON.parse(raw);
    return reply.send({ success: true, data: parsed });
  } catch {
    return reply.send({ success: false, error: 'Failed to parse JSON from Claude', raw });
  }
}

// ─── Route 2: GET /address ─────────────────────────────────────────────────

interface AddressQuery {
  q?: string;
}

async function addressHandler(request: FastifyRequest, reply: FastifyReply) {
  const { q } = request.query as AddressQuery;

  if (!q || q.length < 3) {
    return reply.send([]);
  }

  const url =
    `https://nominatim.openstreetmap.org/search` +
    `?q=${encodeURIComponent(q + ', United Kingdom')}` +
    `&format=json&addressdetails=1&limit=5&countrycodes=gb`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'EnvicoCareOS/1.0 (ops@envicosl.co.uk)' },
  });

  if (!res.ok) {
    return reply.code(502).send({ success: false, error: 'Address lookup failed' });
  }

  const results = (await res.json()) as Array<{
    display_name: string;
    address: {
      road?: string;
      house_number?: string;
      city?: string;
      town?: string;
      village?: string;
      postcode?: string;
    };
    lat: string;
    lon: string;
  }>;

  const mapped = results.map((r) => {
    const street = [r.address.road, r.address.house_number].filter(Boolean).join(' ');
    const city = r.address.city ?? r.address.town ?? r.address.village ?? '';
    return {
      display: r.display_name,
      street,
      city,
      postcode: r.address.postcode ?? '',
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
    };
  });

  return reply.send(mapped);
}

// ─── Route 3: POST /care-writer ────────────────────────────────────────────

type CareWriterField =
  | 'incident_description'
  | 'care_plan_goal'
  | 'handover_note'
  | 'support_needs'
  | 'risk_assessment'
  | 'activity_note'
  | 'medication_note';

interface CareWriterBody {
  input: string;
  field: CareWriterField;
}

const CARE_WRITER_SYSTEM_PROMPT =
  'You are a professional care documentation assistant for Envico Supported Living, a CQC-registered supported living provider. ' +
  'You help support workers and managers write clear, professional, person-centred care documentation. ' +
  'Your language must be: compassionate, professional, CQC-compliant, use person-first language (e.g. "the individual" not "the client"). ' +
  'Respond ONLY with the expanded text. No explanation. No quotes.';

const CARE_WRITER_INSTRUCTIONS: Record<CareWriterField, string> = {
  incident_description:
    'Expand into a formal CQC-compliant incident description. Include factual language, avoid blame, state what was observed.',
  care_plan_goal:
    'Expand into a SMART care plan goal using person-centred language. Focus on what the individual wants to achieve.',
  handover_note:
    'Expand into a clear shift handover note covering: mood, activities, concerns, medications, and what the next shift needs to know.',
  support_needs:
    'Expand into a clear description of support needs suitable for a referral form or care plan.',
  risk_assessment:
    'Expand into a professional risk assessment note including: identified risk, likelihood, impact, and mitigating actions.',
  activity_note:
    'Expand into a warm, positive daily activity note for the care record.',
  medication_note:
    'Expand into a formal medication administration note. Be precise about timing, dosage, and any observations.',
};

const VALID_FIELDS: CareWriterField[] = [
  'incident_description',
  'care_plan_goal',
  'handover_note',
  'support_needs',
  'risk_assessment',
  'activity_note',
  'medication_note',
];

async function careWriterHandler(request: FastifyRequest, reply: FastifyReply) {
  const body = request.body as CareWriterBody;

  if (!body?.input || !body?.field) {
    return reply.code(400).send({ success: false, error: 'input and field are required' });
  }

  if (!VALID_FIELDS.includes(body.field)) {
    return reply.code(400).send({ success: false, error: `field must be one of: ${VALID_FIELDS.join(', ')}` });
  }

  const instruction = CARE_WRITER_INSTRUCTIONS[body.field];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: CARE_WRITER_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `${instruction}\n\nInput: ${body.input}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === 'text')?.text ?? '';
  return reply.send({ text });
}

// ─── Route registration ────────────────────────────────────────────────────

export async function aiRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/ocr', { preHandler: authenticate }, ocrHandler);
  fastify.get('/address', addressHandler);
  fastify.post('/care-writer', { preHandler: authenticate }, careWriterHandler);
}
