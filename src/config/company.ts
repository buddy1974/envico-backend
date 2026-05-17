// ─── Company / System Configuration ─────────────────────────────────────────
// All values read from environment variables with sensible defaults.
// Set these in your Render dashboard (or .env for local dev).

export const company = {
  name:    process.env.COMPANY_NAME    ?? 'Envico Supported Living Ltd',
  ceo:     process.env.COMPANY_CEO     ?? 'Engelbert Maxplan',
  phone:   process.env.COMPANY_PHONE   ?? '020 8797 9974',
  email:   process.env.COMPANY_EMAIL   ?? 'info@envicosl.co.uk',
  address: process.env.COMPANY_ADDRESS ?? 'Hayes, Middlesex, UB3',
  website: process.env.COMPANY_WEBSITE ?? 'https://envicosl.co.uk',
  cqc_id:  process.env.COMPANY_CQC_ID  ?? '1-12345678',
  region:  'England',
  regulator: 'Care Quality Commission (CQC)',
} as const;

export type Company = typeof company;
