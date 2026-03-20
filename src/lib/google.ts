import { google } from 'googleapis';
import prisma from '../db/prisma';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
];

export function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

export function getAuthUrl(userId?: number): string {
  const auth = createOAuth2Client();
  return auth.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       SCOPES,
    state:       userId ? String(userId) : undefined,
  });
}

export async function exchangeCode(code: string) {
  const auth = createOAuth2Client();
  const { tokens } = await auth.getToken(code);
  return tokens;
}

export async function saveTokens(
  userId: number,
  tokens: {
    access_token?:  string | null;
    refresh_token?: string | null;
    expiry_date?:   number | null;
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
      access_token: tokens.access_token ?? '',
      // Only overwrite refresh_token when Google sends a new one (first auth / re-consent)
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      expiry_date: tokens.expiry_date != null ? BigInt(tokens.expiry_date) : null,
    },
  });
}

export async function refreshAccessToken(userId: number) {
  const stored = await prisma.googleToken.findUnique({ where: { user_id: userId } });
  if (!stored?.refresh_token) throw new Error('No refresh token — user must re-authorise');

  const auth = createOAuth2Client();
  auth.setCredentials({ refresh_token: stored.refresh_token });

  const { credentials } = await auth.refreshAccessToken();
  await saveTokens(userId, {
    access_token:  credentials.access_token,
    refresh_token: credentials.refresh_token ?? stored.refresh_token,
    expiry_date:   credentials.expiry_date,
  });

  return credentials;
}

export async function getValidToken(userId: number) {
  const stored = await prisma.googleToken.findUnique({ where: { user_id: userId } });
  if (!stored) throw new Error('Google not connected for this user');

  const auth = createOAuth2Client();
  auth.setCredentials({
    access_token:  stored.access_token,
    refresh_token: stored.refresh_token ?? undefined,
    expiry_date:   stored.expiry_date != null ? Number(stored.expiry_date) : undefined,
  });

  // Auto-refresh if within 60s of expiry
  const isExpired =
    stored.expiry_date != null && Date.now() > Number(stored.expiry_date) - 60_000;

  if (isExpired && stored.refresh_token) {
    const { credentials } = await auth.refreshAccessToken();
    await saveTokens(userId, {
      access_token:  credentials.access_token,
      refresh_token: credentials.refresh_token ?? stored.refresh_token,
      expiry_date:   credentials.expiry_date,
    });
    auth.setCredentials(credentials);
  }

  // Persist any background token refreshes
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

export async function revokeTokens(userId: number) {
  const stored = await prisma.googleToken.findUnique({ where: { user_id: userId } });
  if (!stored) return;

  try {
    const auth = createOAuth2Client();
    auth.setCredentials({ access_token: stored.access_token });
    await auth.revokeCredentials();
  } catch {
    // best-effort — still delete locally
  }

  await prisma.googleToken.delete({ where: { user_id: userId } });
}
