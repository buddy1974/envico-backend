import { google, calendar_v3 } from 'googleapis';
import prisma from '../db/prisma';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export function getAuthUrl(): string {
  const auth = createOAuth2Client();
  return auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  });
}

export async function getTokensFromCode(code: string) {
  const auth = createOAuth2Client();
  const { tokens } = await auth.getToken(code);
  return tokens;
}

export async function saveTokens(
  userId: number,
  tokens: {
    access_token?: string | null;
    refresh_token?: string | null;
    expiry_date?: number | null;
  },
) {
  await prisma.googleToken.upsert({
    where: { user_id: userId },
    create: {
      user_id:       userId,
      access_token:  tokens.access_token  ?? '',
      refresh_token: tokens.refresh_token ?? null,
      expiry_date:   tokens.expiry_date   != null ? BigInt(tokens.expiry_date) : null,
    },
    update: {
      access_token:  tokens.access_token  ?? '',
      refresh_token: tokens.refresh_token ?? undefined,
      expiry_date:   tokens.expiry_date   != null ? BigInt(tokens.expiry_date) : null,
    },
  });
}

async function getAuthedClient(userId: number) {
  const stored = await prisma.googleToken.findUnique({ where: { user_id: userId } });
  if (!stored) throw new Error('Google Calendar not connected for this user');

  const auth = createOAuth2Client();
  auth.setCredentials({
    access_token:  stored.access_token,
    refresh_token: stored.refresh_token ?? undefined,
    expiry_date:   stored.expiry_date != null ? Number(stored.expiry_date) : undefined,
  });

  // Auto-refresh and persist new token if needed
  auth.on('tokens', async (tokens) => {
    if (tokens.access_token) {
      await saveTokens(userId, {
        access_token:  tokens.access_token,
        refresh_token: tokens.refresh_token ?? stored.refresh_token,
        expiry_date:   tokens.expiry_date,
      });
    }
  });

  return auth;
}

// ─── Calendar operations ──────────────────────────────────────────────────────

export async function getCalendarEvents(userId: number, days = 7): Promise<calendar_v3.Schema$Event[]> {
  const auth = await getAuthedClient(userId);
  const cal  = google.calendar({ version: 'v3', auth });

  const now    = new Date();
  const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin:    now.toISOString(),
    timeMax:    future.toISOString(),
    singleEvents: true,
    orderBy:    'startTime',
    maxResults: 50,
  });

  return res.data.items ?? [];
}

export async function getTodayEvents(userId: number): Promise<calendar_v3.Schema$Event[]> {
  const auth = await getAuthedClient(userId);
  const cal  = google.calendar({ version: 'v3', auth });

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const res = await cal.events.list({
    calendarId:   'primary',
    timeMin:      startOfDay.toISOString(),
    timeMax:      endOfDay.toISOString(),
    singleEvents: true,
    orderBy:      'startTime',
    maxResults:   20,
  });

  return res.data.items ?? [];
}

export async function createReminder(
  userId: number,
  event: {
    summary:     string;
    description?: string;
    start:        string; // ISO datetime
    end:          string; // ISO datetime
    attendees?:   string[]; // email addresses
  },
): Promise<calendar_v3.Schema$Event> {
  const auth = await getAuthedClient(userId);
  const cal  = google.calendar({ version: 'v3', auth });

  const res = await cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary:     event.summary,
      description: event.description,
      start: { dateTime: event.start, timeZone: 'Europe/London' },
      end:   { dateTime: event.end,   timeZone: 'Europe/London' },
      attendees: event.attendees?.map((email) => ({ email })),
      reminders: {
        useDefault: false,
        overrides:  [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 15 },
        ],
      },
    },
  });

  return res.data;
}

export async function deleteTokens(userId: number): Promise<void> {
  const stored = await prisma.googleToken.findUnique({ where: { user_id: userId } });
  if (!stored) return;

  // Revoke with Google
  try {
    const auth = createOAuth2Client();
    auth.setCredentials({ access_token: stored.access_token });
    await auth.revokeCredentials();
  } catch {
    // Best-effort revoke — still delete locally
  }

  await prisma.googleToken.delete({ where: { user_id: userId } });
}
