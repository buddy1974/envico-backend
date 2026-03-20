import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { getValidToken } from './google';

function gmailClient(auth: OAuth2Client) {
  return google.gmail({ version: 'v1', auth });
}

function encodeRFC2822(options: { to: string; subject: string; body: string }) {
  const lines = [
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    options.body,
  ].join('\r\n');

  return Buffer.from(lines)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function getHeader(headers: { name?: string | null; value?: string | null }[], name: string) {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

export async function getRecentEmails(userId: number, maxResults = 20) {
  const auth  = await getValidToken(userId);
  const gmail = gmailClient(auth);

  const list = await gmail.users.messages.list({
    userId:     'me',
    q:          'in:inbox',
    maxResults,
  });

  const messages = list.data.messages ?? [];

  const details = await Promise.all(
    messages.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId:  'me',
        id:      msg.id!,
        format:  'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const hdrs = detail.data.payload?.headers ?? [];

      return {
        id:        msg.id,
        thread_id: msg.threadId,
        from:      getHeader(hdrs, 'From'),
        subject:   getHeader(hdrs, 'Subject'),
        date:      getHeader(hdrs, 'Date'),
        snippet:   detail.data.snippet ?? '',
        unread:    detail.data.labelIds?.includes('UNREAD') ?? false,
      };
    }),
  );

  return details;
}

export async function sendEmail(
  userId: number,
  options: { to: string; subject: string; body: string },
) {
  const auth  = await getValidToken(userId);
  const gmail = gmailClient(auth);

  const raw = encodeRFC2822(options);
  const res = await gmail.users.messages.send({
    userId:      'me',
    requestBody: { raw },
  });

  return { id: res.data.id, thread_id: res.data.threadId };
}

export async function draftEmail(
  userId: number,
  options: { to: string; subject: string; body: string },
) {
  const auth  = await getValidToken(userId);
  const gmail = gmailClient(auth);

  const raw = encodeRFC2822(options);
  const res = await gmail.users.drafts.create({
    userId:      'me',
    requestBody: { message: { raw } },
  });

  return { draft_id: res.data.id, message_id: res.data.message?.id };
}

export async function searchEmails(userId: number, query: string, maxResults = 20) {
  const auth  = await getValidToken(userId);
  const gmail = gmailClient(auth);

  const list = await gmail.users.messages.list({
    userId:     'me',
    q:          query,
    maxResults,
  });

  const messages = list.data.messages ?? [];

  const details = await Promise.all(
    messages.map(async (msg) => {
      const detail = await gmail.users.messages.get({
        userId:  'me',
        id:      msg.id!,
        format:  'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const hdrs = detail.data.payload?.headers ?? [];

      return {
        id:        msg.id,
        thread_id: msg.threadId,
        from:      getHeader(hdrs, 'From'),
        subject:   getHeader(hdrs, 'Subject'),
        date:      getHeader(hdrs, 'Date'),
        snippet:   detail.data.snippet ?? '',
        unread:    detail.data.labelIds?.includes('UNREAD') ?? false,
      };
    }),
  );

  return details;
}
