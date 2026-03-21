import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

const PROVIDER_ID = '1-101648327';
const BASE        = 'https://api.cqc.org.uk/public/v1';

// ─── In-memory cache (24 h) ───────────────────────────────────────────────────
interface CacheEntry<T> { data: T; ts: number }
const cache: Record<string, CacheEntry<unknown>> = {};
const TTL = 24 * 60 * 60 * 1000;

function fromCache<T>(key: string): T | null {
  const entry = cache[key];
  if (entry && Date.now() - entry.ts < TTL) return entry.data as T;
  return null;
}
function toCache<T>(key: string, data: T): void {
  cache[key] = { data, ts: Date.now() };
}

// ─── CQC fetch helper ─────────────────────────────────────────────────────────
async function cqcFetch<T>(url: string, cacheKey: string, fallback: T): Promise<T> {
  const cached = fromCache<T>(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Envico-CareOS/1.0' },
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`CQC API ${res.status}`);
    const data = await res.json() as T;
    toCache(cacheKey, data);
    return data;
  } catch {
    const stale = cache[cacheKey];
    return stale ? (stale.data as T) : fallback;
  }
}

// ─── Default fallback data ────────────────────────────────────────────────────
const DEFAULT_RATING = {
  rating:         'Good',
  reportDate:     null,
  inspectionDate: null,
  locationName:   'Envico Supported Living Ltd',
  locationId:     null,
};

const DEFAULT_PROVIDER = {
  name:              'Envico Supported Living Ltd',
  providerId:        PROVIDER_ID,
  registrationStatus:'Registered',
  type:              'Social Care Org',
  address:           'Hayes, Middlesex',
  website:           'https://envicosl.co.uk',
};

// ─── Routes ───────────────────────────────────────────────────────────────────
export async function cqcRoutes(fastify: FastifyInstance): Promise<void> {

  // GET /api/cqc/rating — overall CQC rating for the provider's primary location
  fastify.get(
    '/api/cqc/rating',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      type LocationsResp = {
        locations?: Array<{
          locationId?: string;
          locationName?: string;
          currentRatings?: { overall?: { rating?: string; reportDate?: string } };
          lastInspection?: { date?: string };
        }>;
      };

      const data = await cqcFetch<LocationsResp>(
        `${BASE}/locations?providerId=${PROVIDER_ID}&perPage=1`,
        'locations',
        { locations: [] },
      );

      const loc     = data.locations?.[0];
      const overall = loc?.currentRatings?.overall;

      return reply.code(200).send({
        success: true,
        data: {
          rating:         overall?.rating         ?? DEFAULT_RATING.rating,
          reportDate:     overall?.reportDate      ?? DEFAULT_RATING.reportDate,
          inspectionDate: loc?.lastInspection?.date ?? DEFAULT_RATING.inspectionDate,
          locationName:   loc?.locationName         ?? DEFAULT_RATING.locationName,
          locationId:     loc?.locationId           ?? DEFAULT_RATING.locationId,
        },
      });
    }
  );

  // GET /api/cqc/provider — full provider registration details
  fastify.get(
    '/api/cqc/provider',
    async (_request: FastifyRequest, reply: FastifyReply) => {
      type ProviderResp = {
        name?:               string;
        providerId?:         string;
        registrationStatus?: string;
        type?:               string;
        postalAddressLine1?: string;
        postalAddressTownCity?: string;
        postalCode?:         string;
        website?:            string;
        contacts?:           unknown[];
        registrationDate?:   string;
        numberOfLocations?:  number;
      };

      const data = await cqcFetch<ProviderResp>(
        `${BASE}/providers/${PROVIDER_ID}`,
        'provider',
        {} as ProviderResp,
      );

      return reply.code(200).send({
        success: true,
        data: {
          name:               data.name               ?? DEFAULT_PROVIDER.name,
          providerId:         data.providerId          ?? PROVIDER_ID,
          registrationStatus: data.registrationStatus  ?? DEFAULT_PROVIDER.registrationStatus,
          type:               data.type                ?? DEFAULT_PROVIDER.type,
          address:            [data.postalAddressLine1, data.postalAddressTownCity, data.postalCode].filter(Boolean).join(', ') || DEFAULT_PROVIDER.address,
          website:            data.website             ?? DEFAULT_PROVIDER.website,
          registrationDate:   data.registrationDate    ?? null,
          numberOfLocations:  data.numberOfLocations   ?? null,
        },
      });
    }
  );
}
