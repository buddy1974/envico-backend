import XLSX from 'xlsx';
import Anthropic from '@anthropic-ai/sdk';
import prisma from '../db/prisma';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Module field definitions ─────────────────────────────────────────────────
// All module keys use underscores to match route params

const MODULE_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  service_users: {
    required: ['first_name', 'last_name', 'dob'],
    optional: ['full_name', 'gender', 'ethnicity', 'nhs_number', 'phone', 'address_line1', 'address_line2', 'city', 'postcode', 'care_type', 'gp_name', 'gp_phone', 'nok_name', 'nok_phone', 'nok_relationship'],
  },
  staff: {
    required: ['name', 'email', 'phone', 'role'],
    optional: ['first_name', 'last_name'],
  },
  medications: {
    required: ['service_user_name', 'name', 'dosage', 'frequency', 'route', 'prescribed_by', 'start_date'],
    optional: ['end_date', 'notes'],
  },
  incidents: {
    required: ['service_user_name', 'type', 'severity', 'description', 'reported_by'],
    optional: ['reported_at', 'location', 'witnesses', 'action_taken'],
  },
  training: {
    required: ['staff_name', 'training_name', 'training_type'],
    optional: ['provider', 'completed_date', 'expiry_date', 'notes'],
  },
};

const CSV_TEMPLATES: Record<string, string> = {
  service_users: 'first_name,last_name,dob,gender,nhs_number,phone,address_line1,postcode,care_type,gp_name,gp_phone,nok_name,nok_phone,nok_relationship\nJohn,Smith,1985-04-12,Male,123 456 7890,07700900000,12 High St,UB3 2TE,SUPPORTED_LIVING,Dr Jones,01234 567890,Jane Smith,07700900001,Mother',
  staff:         'name,email,phone,role\nSarah Jones,sarah@example.com,07700900002,STAFF',
  medications:   'service_user_name,name,dosage,frequency,route,prescribed_by,start_date,end_date,notes\nJohn Smith,Metformin 500mg,500mg,Twice daily,Oral,Dr Jones,2024-01-01,,With food',
  incidents:     'service_user_name,type,severity,description,reported_by,reported_at,location,action_taken\nJohn Smith,ACCIDENT,LOW,Tripped in corridor,Sarah Jones,2024-01-15,Living room,First aid applied',
  training:      'staff_name,training_name,training_type,provider,completed_date,expiry_date,notes\nSarah Jones,Oliver McGowan,MANDATORY,NHS England,2024-01-10,2025-01-10,Online module',
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AIAnalysisResult {
  mapping:          Record<string, string | null>;
  missing_required: string[];
  issues:           { field: string; issue: string; suggestion: string }[];
  success_estimate: number;
  summary:          string;
}

export interface ImportResult {
  total:    number;
  imported: number;
  skipped:  number;
  errors:   { row: number; field: string; error: string }[];
}

export interface PreviewRow {
  row_number: number;
  mapped:     Record<string, unknown>;
  issues:     string[];
  will_import: boolean;
}

// ─── File parsing ─────────────────────────────────────────────────────────────

export function parseFile(buffer: Buffer): { headers: string[]; rows: Record<string, unknown>[] } {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const sheet    = workbook.Sheets[workbook.SheetNames[0]];
  const raw      = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null }) as unknown[][];

  if (!raw.length) return { headers: [], rows: [] };

  const headers = (raw[0] as unknown[]).map((h) => (h != null ? String(h).trim() : '')).filter(Boolean);

  const rows = raw
    .slice(1)
    .filter((row) => (row as unknown[]).some((cell) => cell != null && cell !== ''))
    .map((row) => {
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => { obj[h] = (row as unknown[])[i] ?? null; });
      return obj;
    });

  return { headers, rows };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  const str = String(value).trim();
  if (!str) return null;

  // ISO date or datetime
  const iso = new Date(str);
  if (!isNaN(iso.getTime())) return iso;

  // UK format DD/MM/YYYY
  const ukMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ukMatch) {
    return new Date(`${ukMatch[3]}-${ukMatch[2].padStart(2, '0')}-${ukMatch[1].padStart(2, '0')}`);
  }

  // UK with dashes DD-MM-YYYY
  const ukDash = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ukDash) {
    return new Date(`${ukDash[3]}-${ukDash[2].padStart(2, '0')}-${ukDash[1].padStart(2, '0')}`);
  }

  return null;
}

function normalizeCareType(value: unknown): 'SUPPORTED_LIVING' | 'DOMICILIARY' | 'RESIDENTIAL' {
  const s = String(value ?? '').toUpperCase();
  if (s.includes('DOM')) return 'DOMICILIARY';
  if (s.includes('RES')) return 'RESIDENTIAL';
  return 'SUPPORTED_LIVING';
}

function normalizeIncidentType(value: unknown): string {
  const s = String(value ?? '').toUpperCase().replace(/[\s_-]/g, '');
  if (s.includes('SAFEGUARD'))                          return 'SAFEGUARDING';
  if (s.includes('MEDICATION'))                         return 'MEDICATION_ERROR';
  if (s.includes('BEHAVIOUR') || s.includes('BEHAVIOR')) return 'BEHAVIOUR';
  if (s.includes('ACCIDENT'))                           return 'ACCIDENT';
  return 'OTHER';
}

function normalizeSeverity(value: unknown): string {
  const s = String(value ?? '').toUpperCase();
  if (s.includes('CRITICAL'))                     return 'CRITICAL';
  if (s.includes('HIGH'))                         return 'HIGH';
  if (s.includes('MED') || s.includes('MOD'))     return 'MEDIUM';
  return 'LOW';
}

/**
 * Split a "full_name" value ("John Smith") into first_name / last_name.
 * Returns both parts and the original full_name key removed.
 */
function splitFullName(row: Record<string, unknown>): Record<string, unknown> {
  if (!row.full_name) return row;
  const out = { ...row };
  const parts = String(out.full_name).trim().split(/\s+/);
  if (!out.first_name) out.first_name = parts[0] ?? '';
  if (!out.last_name)  out.last_name  = parts.slice(1).join(' ') || '';
  delete out.full_name;
  return out;
}

/**
 * Apply the AI mapping: transform uploaded column names → CareOS field names.
 * Only mapped fields are kept; unmapped columns are dropped.
 * After mapping, split full_name → first_name + last_name if present.
 */
function applyMapping(
  rows:    Record<string, unknown>[],
  mapping: Record<string, string | null>,
): Record<string, unknown>[] {
  return rows.map((row) => {
    const mapped: Record<string, unknown> = {};

    for (const [uploadedKey, careosField] of Object.entries(mapping)) {
      if (!careosField) continue;
      if (row[uploadedKey] !== undefined && row[uploadedKey] !== null && row[uploadedKey] !== '') {
        // Handle composite mapping: "full_name" will be split later
        mapped[careosField] = row[uploadedKey];
      }
    }

    return splitFullName(mapped);
  });
}

async function findServiceUserByName(name: string): Promise<number | null> {
  const parts     = name.trim().split(/\s+/);
  const firstName = parts[0] ?? '';
  const lastName  = parts.slice(1).join(' ');

  const user = await prisma.serviceUser.findFirst({
    where: {
      first_name: { equals: firstName, mode: 'insensitive' },
      ...(lastName ? { last_name: { contains: lastName, mode: 'insensitive' } } : {}),
    },
    select: { id: true },
  });
  return user?.id ?? null;
}

async function findStaffByName(name: string): Promise<number | null> {
  const staff = await prisma.staff.findFirst({
    where:  { name: { contains: name.trim(), mode: 'insensitive' } },
    select: { id: true },
  });
  return staff?.id ?? null;
}

// ─── AI Analysis ──────────────────────────────────────────────────────────────

export async function analyseWithAI(
  headers:      string[],
  sampleRows:   Record<string, unknown>[],
  targetModule: string,
): Promise<AIAnalysisResult> {
  const fields = MODULE_FIELDS[targetModule];
  if (!fields) throw new Error(`Unknown module: ${targetModule}`);

  const allFields = [...fields.required, ...fields.optional];

  const prompt = `You are a data import assistant for Envico CareOS, a UK supported-living care management system.

The manager is importing data into the "${targetModule}" module.

CareOS expected fields:
- REQUIRED: ${fields.required.join(', ')}
- OPTIONAL: ${fields.optional.join(', ')}

Special mapping rules:
- If the file has a single "full name" / "client name" / "service user name" column, map it to "full_name" — the system will automatically split it into first_name + last_name.
- "Date of Birth", "DOB", "D.O.B", "Birth Date" → dob
- "NHS No", "NHS Number", "NHS Num" → nhs_number
- "Address", "Address Line 1", "Street" → address_line1
- "Postcode", "Post Code", "ZIP" → postcode
- "Next of Kin", "NOK Name", "Emergency Contact" → nok_name
- "NOK Phone", "Emergency Phone", "Emergency Tel" → nok_phone
- "Relationship", "NOK Relationship" → nok_relationship
- "GP", "Doctor", "GP Name" → gp_name
- "GP Phone", "GP Tel", "Doctor Phone" → gp_phone

Uploaded file headers: ${JSON.stringify(headers)}

Sample data rows (up to 3):
${JSON.stringify(sampleRows.slice(0, 3), null, 2)}

Instructions:
1. Map EVERY uploaded header to the best matching CareOS field. Use null only if truly no match exists.
2. List any REQUIRED fields that will be missing after mapping.
3. Flag data quality issues visible in the sample (wrong date formats, invalid values, etc.).
4. Estimate what % of rows will successfully import (0–100).
5. Write a one-line summary for the manager.

Respond with VALID JSON ONLY — no markdown, no code fences:
{
  "mapping": { "Uploaded Header": "careos_field_or_null" },
  "missing_required": ["field_name"],
  "issues": [{ "field": "...", "issue": "...", "suggestion": "..." }],
  "success_estimate": 85,
  "summary": "47 service users ready to import. DOB column needs UK date format fix."
}`;

  const response = await claude.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1500,
    system:     'You are a data migration expert for UK care management systems. Always respond with valid JSON only. No prose, no markdown.',
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '{}';

  // Strip accidental markdown fences if present
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    const parsed = JSON.parse(clean) as AIAnalysisResult;
    // Guarantee all required keys exist
    return {
      mapping:          parsed.mapping          ?? Object.fromEntries(headers.map((h) => [h, null])),
      missing_required: parsed.missing_required ?? fields.required,
      issues:           parsed.issues           ?? [],
      success_estimate: parsed.success_estimate ?? 0,
      summary:          parsed.summary          ?? 'Manual review required',
    };
  } catch {
    return {
      mapping:          Object.fromEntries(headers.map((h) => [h, null])),
      missing_required: fields.required,
      issues:           [{ field: 'general', issue: 'AI could not auto-map columns', suggestion: 'Map columns manually before importing' }],
      success_estimate: 0,
      summary:          'Manual column mapping required',
    };
  }
}

// ─── Preview (mapped rows with per-row issue flags) ───────────────────────────

export function generatePreview(
  rows:         Record<string, unknown>[],
  mapping:      Record<string, string | null>,
  targetModule: string,
): PreviewRow[] {
  const fields   = MODULE_FIELDS[targetModule];
  const required = fields?.required ?? [];
  const mapped   = applyMapping(rows, mapping);

  return mapped.slice(0, 5).map((row, i) => {
    const issues: string[] = [];

    for (const field of required) {
      // full_name can satisfy first_name + last_name requirement
      if (field === 'first_name' && (row.first_name || row.full_name)) continue;
      if (field === 'last_name'  && (row.last_name  || row.full_name)) continue;
      if (!row[field]) issues.push(`Missing required field: ${field}`);
    }

    // Date format checks
    for (const dateField of ['dob', 'start_date', 'end_date', 'completed_date', 'expiry_date', 'reported_at']) {
      if (row[dateField] && !parseDate(row[dateField])) {
        issues.push(`Invalid date format in ${dateField}: "${row[dateField]}"`);
      }
    }

    return {
      row_number:  i + 2, // 1-indexed, row 1 is headers
      mapped:      row,
      issues,
      will_import: issues.length === 0,
    };
  });
}

// ─── Module importers ─────────────────────────────────────────────────────────

async function importServiceUsers(rows: Record<string, unknown>[]): Promise<ImportResult> {
  let imported = 0;
  const errors: ImportResult['errors'] = [];

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rowNum = i + 2;

    // Accept either split or full_name
    const firstName = row.first_name ? String(row.first_name) : null;
    const lastName  = row.last_name  ? String(row.last_name)  : null;

    if (!firstName || !lastName || !row.dob) {
      errors.push({ row: rowNum, field: 'required', error: `Missing: ${!firstName ? 'first_name ' : ''}${!lastName ? 'last_name ' : ''}${!row.dob ? 'dob' : ''}`.trim() });
      continue;
    }

    const dob = parseDate(row.dob);
    if (!dob) {
      errors.push({ row: rowNum, field: 'dob', error: `Invalid date format: "${row.dob}" — use YYYY-MM-DD or DD/MM/YYYY` });
      continue;
    }

    try {
      await prisma.serviceUser.create({
        data: {
          first_name:       firstName,
          last_name:        lastName,
          dob,
          gender:           row.gender           ? String(row.gender)           : null,
          ethnicity:        row.ethnicity         ? String(row.ethnicity)        : null,
          nhs_number:       row.nhs_number        ? String(row.nhs_number)       : null,
          phone:            row.phone             ? String(row.phone)            : null,
          address_line1:    row.address_line1     ? String(row.address_line1)    : null,
          address_line2:    row.address_line2     ? String(row.address_line2)    : null,
          city:             row.city              ? String(row.city)             : null,
          postcode:         row.postcode          ? String(row.postcode)         : null,
          care_type:        normalizeCareType(row.care_type),
          gp_name:          row.gp_name           ? String(row.gp_name)          : null,
          gp_phone:         row.gp_phone          ? String(row.gp_phone)         : null,
          nok_name:         row.nok_name          ? String(row.nok_name)         : null,
          nok_phone:        row.nok_phone         ? String(row.nok_phone)        : null,
          nok_relationship: row.nok_relationship  ? String(row.nok_relationship) : null,
        },
      });
      imported++;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        errors.push({ row: rowNum, field: 'nhs_number', error: `Duplicate NHS number — service user already exists` });
      } else {
        errors.push({ row: rowNum, field: 'database', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { total: rows.length, imported, skipped: rows.length - imported, errors };
}

async function importStaff(rows: Record<string, unknown>[]): Promise<ImportResult> {
  let imported = 0;
  const errors: ImportResult['errors'] = [];

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rowNum = i + 2;

    // Accept full name or first+last
    const name = row.name
      ?? (row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : null);

    if (!name || !row.email || !row.phone || !row.role) {
      errors.push({ row: rowNum, field: 'required', error: `Missing: ${!name ? 'name ' : ''}${!row.email ? 'email ' : ''}${!row.phone ? 'phone ' : ''}${!row.role ? 'role' : ''}`.trim() });
      continue;
    }

    try {
      await prisma.staff.create({
        data: {
          name:  String(name).trim(),
          email: String(row.email).toLowerCase().trim(),
          phone: String(row.phone),
          role:  String(row.role),
        },
      });
      imported++;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        errors.push({ row: rowNum, field: 'email', error: `Duplicate email — staff member already exists: ${row.email}` });
      } else {
        errors.push({ row: rowNum, field: 'database', error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { total: rows.length, imported, skipped: rows.length - imported, errors };
}

async function importMedications(rows: Record<string, unknown>[]): Promise<ImportResult> {
  let imported = 0;
  const errors: ImportResult['errors'] = [];

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rowNum = i + 2;

    const serviceUserName = String(row.service_user_name ?? '').trim();
    const medName         = row.name ?? row.medication_name;

    if (!serviceUserName || !medName || !row.dosage || !row.frequency || !row.route || !row.prescribed_by || !row.start_date) {
      errors.push({ row: rowNum, field: 'required', error: 'Missing required medication fields' });
      continue;
    }

    const serviceUserId = await findServiceUserByName(serviceUserName);
    if (!serviceUserId) {
      errors.push({ row: rowNum, field: 'service_user_name', error: `Service user not found: "${serviceUserName}" — import service users first` });
      continue;
    }

    const startDate = parseDate(row.start_date);
    if (!startDate) {
      errors.push({ row: rowNum, field: 'start_date', error: `Invalid date format: "${row.start_date}"` });
      continue;
    }

    try {
      await prisma.medication.create({
        data: {
          service_user_id: serviceUserId,
          name:            String(medName),
          dosage:          String(row.dosage),
          frequency:       String(row.frequency),
          route:           String(row.route),
          prescribed_by:   String(row.prescribed_by),
          start_date:      startDate,
          end_date:        parseDate(row.end_date) ?? undefined,
          notes:           row.notes ? String(row.notes) : null,
        },
      });
      imported++;
    } catch (err: unknown) {
      errors.push({ row: rowNum, field: 'database', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { total: rows.length, imported, skipped: rows.length - imported, errors };
}

async function importIncidents(rows: Record<string, unknown>[]): Promise<ImportResult> {
  let imported = 0;
  const errors: ImportResult['errors'] = [];

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rowNum = i + 2;

    const serviceUserName = String(row.service_user_name ?? '').trim();
    if (!serviceUserName || !row.type || !row.severity || !row.description || !row.reported_by) {
      errors.push({ row: rowNum, field: 'required', error: 'Missing required incident fields' });
      continue;
    }

    const serviceUserId = await findServiceUserByName(serviceUserName);
    if (!serviceUserId) {
      errors.push({ row: rowNum, field: 'service_user_name', error: `Service user not found: "${serviceUserName}"` });
      continue;
    }

    try {
      await prisma.incident.create({
        data: {
          service_user_id: serviceUserId,
          type:            normalizeIncidentType(row.type) as 'ACCIDENT' | 'SAFEGUARDING' | 'MEDICATION_ERROR' | 'BEHAVIOUR' | 'OTHER',
          severity:        normalizeSeverity(row.severity) as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
          description:     String(row.description),
          reported_by:     String(row.reported_by),
          reported_at:     parseDate(row.reported_at) ?? new Date(),
          location:        row.location     ? String(row.location)     : null,
          witnesses:       row.witnesses    ? String(row.witnesses)    : null,
          action_taken:    row.action_taken ? String(row.action_taken) : null,
        },
      });
      imported++;
    } catch (err: unknown) {
      errors.push({ row: rowNum, field: 'database', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { total: rows.length, imported, skipped: rows.length - imported, errors };
}

async function importTraining(rows: Record<string, unknown>[]): Promise<ImportResult> {
  let imported = 0;
  const errors: ImportResult['errors'] = [];

  for (let i = 0; i < rows.length; i++) {
    const row    = rows[i];
    const rowNum = i + 2;

    const staffName = String(row.staff_name ?? '').trim();
    if (!staffName || !row.training_name || !row.training_type) {
      errors.push({ row: rowNum, field: 'required', error: 'Missing staff_name, training_name, or training_type' });
      continue;
    }

    const staffId = await findStaffByName(staffName);
    if (!staffId) {
      errors.push({ row: rowNum, field: 'staff_name', error: `Staff member not found: "${staffName}" — import staff first` });
      continue;
    }

    const completedDate = parseDate(row.completed_date);
    const expiryDate    = parseDate(row.expiry_date);

    let status: 'COMPLETED' | 'EXPIRED' | 'DUE' | 'OVERDUE' = 'DUE';
    if (completedDate) {
      status = expiryDate && expiryDate < new Date() ? 'EXPIRED' : 'COMPLETED';
    }

    try {
      await prisma.trainingRecord.create({
        data: {
          staff_id:       staffId,
          training_name:  String(row.training_name),
          training_type:  String(row.training_type),
          provider:       row.provider ? String(row.provider) : null,
          completed_date: completedDate ?? undefined,
          expiry_date:    expiryDate    ?? undefined,
          notes:          row.notes     ? String(row.notes)   : null,
          status,
        },
      });
      imported++;
    } catch (err: unknown) {
      errors.push({ row: rowNum, field: 'database', error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { total: rows.length, imported, skipped: rows.length - imported, errors };
}

// ─── Public: importRows dispatcher ───────────────────────────────────────────

export async function importRows(
  rows:    Record<string, unknown>[],
  module:  string,
  mapping: Record<string, string | null>,
): Promise<ImportResult> {
  const mappedRows = applyMapping(rows, mapping);

  switch (module) {
    case 'service_users': return importServiceUsers(mappedRows);
    case 'staff':         return importStaff(mappedRows);
    case 'medications':   return importMedications(mappedRows);
    case 'incidents':     return importIncidents(mappedRows);
    case 'training':      return importTraining(mappedRows);
    default:
      return { total: rows.length, imported: 0, skipped: rows.length, errors: [{ row: 0, field: 'module', error: `Unknown module: ${module}` }] };
  }
}

// ─── Template CSV ─────────────────────────────────────────────────────────────

export function getTemplateCsv(module: string): string | null {
  return CSV_TEMPLATES[module] ?? null;
}

// ─── Google Sheets URL converter ──────────────────────────────────────────────

export function buildSheetCsvUrl(sheetUrl: string): string {
  const match = sheetUrl.match(/\/spreadsheets\/d\/([^/]+)/);
  if (!match) throw new Error('Invalid Google Sheets URL — could not extract spreadsheet ID');

  const sheetId  = match[1];
  const gidMatch = sheetUrl.match(/[#&]gid=(\d+)/);
  const gid      = gidMatch ? gidMatch[1] : '0';

  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
}
