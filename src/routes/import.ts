import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import {
  parseFile,
  analyseWithAI,
  importRows,
  generatePreview,
  getTemplateCsv,
  buildSheetCsvUrl,
  ImportResult,
} from '../services/importService';
import prisma from '../db/prisma';

const ALLOWED_MODULES = ['service_users', 'staff', 'medications', 'incidents', 'training'] as const;
type ImportModule = typeof ALLOWED_MODULES[number];

const AnalyseSchema = z.object({
  module: z.enum(ALLOWED_MODULES),
});

const ExecuteSchema = z.object({
  module:  z.enum(ALLOWED_MODULES),
  mapping: z.record(z.string()),
  rows:    z.array(z.record(z.unknown())),
});

const GoogleSheetSchema = z.object({
  sheet_url: z.string().url(),
  module:    z.enum(ALLOWED_MODULES),
});

async function logImport(
  module: string,
  source: string,
  result: ImportResult,
  importedBy: number,
): Promise<void> {
  await prisma.importLog.create({
    data: {
      module,
      source,
      total:       result.total,
      imported:    result.imported,
      skipped:     result.skipped,
      errors:      result.errors as unknown as object[],
      imported_by: String(importedBy),
    },
  });
}

export async function importRoutes(fastify: FastifyInstance): Promise<void> {

  // POST /api/import/analyse — upload file, get AI column mapping
  fastify.post(
    '/api/import/analyse',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const data = await (request as any).file();
      if (!data) {
        return reply.code(400).send({ success: false, error: 'No file uploaded' });
      }

      const moduleHeader = (request.headers['x-import-module'] as string) ?? '';
      const parsedModule = AnalyseSchema.safeParse({ module: moduleHeader });
      if (!parsedModule.success) {
        return reply.code(400).send({
          success: false,
          error:   'Missing or invalid x-import-module header',
          allowed: ALLOWED_MODULES,
        });
      }

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      let parsed: { headers: string[]; rows: Record<string, unknown>[] };
      try {
        parsed = parseFile(buffer);
      } catch (err: any) {
        return reply.code(400).send({ success: false, error: `File parse error: ${err.message}` });
      }

      if (parsed.rows.length === 0) {
        return reply.code(400).send({ success: false, error: 'File is empty or has no data rows' });
      }

      const sampleRows = parsed.rows.slice(0, 5);
      const analysis   = await analyseWithAI(parsed.headers, sampleRows, parsedModule.data.module);
      const preview    = generatePreview(parsed.rows, analysis.mapping, parsedModule.data.module);

      return reply.code(200).send({
        success: true,
        data: {
          headers:   parsed.headers,
          row_count: parsed.rows.length,
          analysis,
          preview,               // 5 mapped rows with per-row issue flags
          all_rows:  parsed.rows, // full raw data for confirmed execute
        },
      });
    }
  );

  // POST /api/import/execute — run import with confirmed mapping
  fastify.post(
    '/api/import/execute',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ExecuteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error:   'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { module, mapping, rows } = parsed.data;
      const userId = (request as any).user?.id ?? 0;

      let result: ImportResult;
      try {
        result = await importRows(rows, module, mapping);
      } catch (err: any) {
        return reply.code(500).send({ success: false, error: `Import failed: ${err.message}` });
      }

      await logImport(module, 'FILE', result, userId);

      return reply.code(200).send({ success: true, data: result });
    }
  );

  // POST /api/import/google-sheet — import from Google Sheets URL
  fastify.post(
    '/api/import/google-sheet',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = GoogleSheetSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          success: false,
          error:   'Validation failed',
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { sheet_url, module } = parsed.data;
      const userId = (request as any).user?.id ?? 0;

      let csvUrl: string;
      try {
        csvUrl = buildSheetCsvUrl(sheet_url);
      } catch (err: any) {
        return reply.code(400).send({ success: false, error: `Invalid Google Sheets URL: ${err.message}` });
      }

      let buffer: Buffer;
      try {
        const response = await fetch(csvUrl);
        if (!response.ok) {
          return reply.code(400).send({ success: false, error: 'Could not fetch Google Sheet. Ensure it is publicly accessible.' });
        }
        buffer = Buffer.from(await response.arrayBuffer());
      } catch (err: any) {
        return reply.code(400).send({ success: false, error: `Failed to fetch sheet: ${err.message}` });
      }

      let fileData: { headers: string[]; rows: Record<string, unknown>[] };
      try {
        fileData = parseFile(buffer);
      } catch (err: any) {
        return reply.code(400).send({ success: false, error: `Sheet parse error: ${err.message}` });
      }

      if (fileData.rows.length === 0) {
        return reply.code(400).send({ success: false, error: 'Sheet is empty or has no data rows' });
      }

      const sampleRows = fileData.rows.slice(0, 5);
      const analysis   = await analyseWithAI(fileData.headers, sampleRows, module);
      const preview    = generatePreview(fileData.rows, analysis.mapping, module);

      // Auto-execute if AI estimates >= 85% success
      if (analysis.success_estimate >= 85) {
        const result = await importRows(fileData.rows, module, analysis.mapping);
        await logImport(module, 'GOOGLE_SHEET', result, userId);

        return reply.code(200).send({
          success: true,
          data:    { auto_imported: true, analysis, preview, result },
        });
      }

      // Low confidence — return analysis + preview for manual review
      return reply.code(200).send({
        success: true,
        data: {
          auto_imported: false,
          reason:        'Confidence below 85% — manual mapping required',
          headers:       fileData.headers,
          row_count:     fileData.rows.length,
          analysis,
          preview,
          all_rows:      fileData.rows,
        },
      });
    }
  );

  // GET /api/import/template/:module — download CSV template
  fastify.get<{ Params: { module: string } }>(
    '/api/import/template/:module',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: { module: string } }>, reply: FastifyReply) => {
      const { module } = request.params;

      if (!ALLOWED_MODULES.includes(module as ImportModule)) {
        return reply.code(400).send({
          success: false,
          error:   `Unknown module. Allowed: ${ALLOWED_MODULES.join(', ')}`,
        });
      }

      const csv = getTemplateCsv(module);
      if (!csv) {
        return reply.code(404).send({ success: false, error: 'Template not available for this module' });
      }

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="envico_${module}_template.csv"`);
      return reply.code(200).send(csv);
    }
  );

  // GET /api/import/history — past import logs
  fastify.get(
    '/api/import/history',
    { preHandler: [authenticate, requireRole(['ADMIN', 'MANAGER'])] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { module?: string; limit?: string };
      const take  = Math.min(parseInt(query.limit ?? '20', 10), 100);

      const logs = await prisma.importLog.findMany({
        where:   query.module ? { module: query.module } : undefined,
        orderBy: { created_at: 'desc' },
        take,
      });

      return reply.code(200).send({ success: true, data: logs });
    }
  );
}
