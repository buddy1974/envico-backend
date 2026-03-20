import { google, calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import Anthropic from '@anthropic-ai/sdk';
import { getValidToken } from './google';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function calClient(auth: OAuth2Client) {
  return google.calendar({ version: 'v3', auth });
}

function fmt(e: calendar_v3.Schema$Event) {
  return {
    id:          e.id,
    summary:     e.summary ?? '(No title)',
    description: e.description ?? null,
    start:       e.start?.dateTime ?? e.start?.date ?? null,
    end:         e.end?.dateTime   ?? e.end?.date   ?? null,
    location:    e.location ?? null,
    attendees:   e.attendees?.map((a) => ({
      email:  a.email,
      name:   a.displayName,
      status: a.responseStatus,
    })) ?? [],
    html_link:  e.htmlLink ?? null,
    all_day:    !e.start?.dateTime,
    conference: e.conferenceData?.entryPoints?.[0]?.uri ?? null,
  };
}

export async function getTodayEvents(userId: number) {
  const auth = await getValidToken(userId);
  const cal  = calClient(auth);

  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);

  const res = await cal.events.list({
    calendarId:   'primary',
    timeMin:      start.toISOString(),
    timeMax:      end.toISOString(),
    singleEvents: true,
    orderBy:      'startTime',
    maxResults:   20,
  });

  return (res.data.items ?? []).map(fmt);
}

export async function getWeekEvents(userId: number) {
  const auth = await getValidToken(userId);
  const cal  = calClient(auth);

  const now    = new Date();
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const res = await cal.events.list({
    calendarId:   'primary',
    timeMin:      now.toISOString(),
    timeMax:      future.toISOString(),
    singleEvents: true,
    orderBy:      'startTime',
    maxResults:   50,
  });

  return (res.data.items ?? []).map(fmt);
}

export async function createEvent(
  userId: number,
  event: {
    title:        string;
    start:        string;
    end:          string;
    description?: string;
    attendees?:   string[];
  },
) {
  const auth = await getValidToken(userId);
  const cal  = calClient(auth);

  const res = await cal.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary:     event.title,
      description: event.description,
      start: { dateTime: event.start, timeZone: 'Europe/London' },
      end:   { dateTime: event.end,   timeZone: 'Europe/London' },
      attendees: event.attendees?.map((email) => ({ email })),
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 15 },
        ],
      },
    },
  });

  return fmt(res.data);
}

export async function getMeetingPrepNotes(event: {
  summary?:     string | null;
  description?: string | null;
  start?:       string | null;
  attendees?:   { email?: string | null; name?: string | null }[];
}): Promise<string> {
  const attendeeList =
    event.attendees?.map((a) => a.name ?? a.email ?? 'Unknown').join(', ') ||
    'None listed';

  const prompt = `Generate concise meeting preparation notes for:
Title: ${event.summary ?? 'Untitled'}
Start: ${event.start ?? 'Unknown'}
Attendees: ${attendeeList}
Description: ${event.description ?? 'None provided'}

Provide:
1. Key objectives to achieve in this meeting
2. Questions to ask / points to raise
3. Relevant context for a care home CEO
4. Suggested follow-up actions

Be brief and actionable — bullet points preferred.`;

  const res = await claude.messages.create({
    model:     'claude-sonnet-4-6',
    max_tokens: 512,
    system:    'You are a personal assistant for the CEO of Envico Supported Living Ltd. Generate practical, concise meeting prep notes.',
    messages:  [{ role: 'user', content: prompt }],
  });

  return res.content[0].type === 'text' ? res.content[0].text : '';
}
