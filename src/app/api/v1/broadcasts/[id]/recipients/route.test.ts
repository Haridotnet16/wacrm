import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GET,
  serializeBroadcastRecipient,
} from './route';
import { ApiError } from '@/lib/api/v1/respond';

const mocks = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  supabase: {
    from: vi.fn(),
  },
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));

describe('serializeBroadcastRecipient', () => {
  it('correctly maps recipient and contact fields', () => {
    const rawRow = {
      id: 'rec-1',
      broadcast_id: 'bc-1',
      contact_id: 'cnt-1',
      status: 'delivered',
      whatsapp_message_id: 'wamid.123',
      sent_at: '2026-10-20T10:00:00Z',
      delivered_at: '2026-10-20T10:00:05Z',
      read_at: '2026-10-20T10:01:00Z',
      replied_at: null,
      error_message: null,
      created_at: '2026-10-20T09:59:00Z',
      contact: {
        id: 'cnt-1',
        phone: '+919345018227',
        name: 'John Doe',
        email: 'secret@example.com',
        notes: 'Sensitive notes',
      },
    };

    const serialized = serializeBroadcastRecipient(rawRow);
    expect(serialized).toEqual({
      id: 'rec-1',
      broadcast_id: 'bc-1',
      contact_id: 'cnt-1',
      phone: '+919345018227',
      name: 'John Doe',
      status: 'delivered',
      whatsapp_message_id: 'wamid.123',
      sent_at: '2026-10-20T10:00:00Z',
      delivered_at: '2026-10-20T10:00:05Z',
      read_at: '2026-10-20T10:01:00Z',
      replied_at: null,
      error_message: null,
      created_at: '2026-10-20T09:59:00Z',
    });

    // Sensitive contact information must NOT be present on the recipient object.
    expect(
      (serialized as unknown as Record<string, unknown>).email
    ).toBeUndefined();
    expect(
      (serialized as unknown as Record<string, unknown>).notes
    ).toBeUndefined();
  });

  it('handles null contact gracefully (e.g. deleted contact)', () => {
    const rawRow = {
      id: 'rec-2',
      broadcast_id: 'bc-1',
      contact_id: null,
      status: 'failed',
      whatsapp_message_id: null,
      sent_at: null,
      delivered_at: null,
      read_at: null,
      replied_at: null,
      error_message: 'Recipient phone invalid',
      created_at: '2026-10-20T09:59:00Z',
      contact: null,
    };

    const serialized = serializeBroadcastRecipient(rawRow);
    expect(serialized.phone).toBeNull();
    expect(serialized.name).toBeNull();
    expect(serialized.status).toBe('failed');
    expect(serialized.error_message).toBe('Recipient phone invalid');
  });
});

describe('GET /api/v1/broadcasts/[id]/recipients', () => {
  beforeEach(() => {
    mocks.requireApiKey.mockReset();
    mocks.supabase.from.mockReset();
  });

  const validCtx = {
    authType: 'api_key',
    accountId: 'acct-1',
    keyId: 'key-1',
    scopes: ['broadcasts:read'],
    supabase: mocks.supabase,
  };

  it('401s when requireApiKey throws unauthorized', async () => {
    mocks.requireApiKey.mockRejectedValue(
      new ApiError('unauthorized', 'Missing or invalid API key', 401)
    );

    const req = new Request('http://localhost/api/v1/broadcasts/bc-1/recipients');
    const res = await GET(req, { params: Promise.resolve({ id: 'bc-1' }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
  });

  it('403s when requireApiKey throws forbidden (missing scope)', async () => {
    mocks.requireApiKey.mockRejectedValue(
      new ApiError('forbidden', "This API key requires one of the following scopes: 'broadcasts:read', 'broadcasts:send'", 403)
    );

    const req = new Request('http://localhost/api/v1/broadcasts/bc-1/recipients');
    const res = await GET(req, { params: Promise.resolve({ id: 'bc-1' }) });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
  });

  it('400s on invalid status filter parameter', async () => {
    mocks.requireApiKey.mockResolvedValue(validCtx);

    const req = new Request('http://localhost/api/v1/broadcasts/bc-1/recipients?status=unknown_status');
    const res = await GET(req, { params: Promise.resolve({ id: 'bc-1' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.message).toContain('Invalid status filter');
  });

  it('404s when the broadcast does not exist or belongs to another account', async () => {
    mocks.requireApiKey.mockResolvedValue(validCtx);

    const selectMock = vi.fn().mockReturnThis();
    const eqMock = vi.fn().mockReturnThis();
    const maybeSingleMock = vi.fn().mockResolvedValue({ data: null, error: null });

    mocks.supabase.from.mockReturnValue({
      select: selectMock,
      eq: eqMock,
      maybeSingle: maybeSingleMock,
    });

    const req = new Request('http://localhost/api/v1/broadcasts/bc-foreign/recipients');
    const res = await GET(req, { params: Promise.resolve({ id: 'bc-foreign' }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Broadcast not found');
  });

  it('returns 200 with paginated recipients on success', async () => {
    mocks.requireApiKey.mockResolvedValue(validCtx);

    // 1st query: check broadcast ownership
    const bcQueryBuilder = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'bc-1' }, error: null }),
    };

    // 2nd query: query broadcast_recipients
    const recsQueryBuilder: Record<string, unknown> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      then: (resolve: (val: unknown) => unknown) =>
        resolve({
          data: [
            {
              id: 'rec-1',
              broadcast_id: 'bc-1',
              contact_id: 'cnt-1',
              status: 'delivered',
              whatsapp_message_id: 'wamid.123',
              sent_at: '2026-10-20T10:00:00Z',
              delivered_at: '2026-10-20T10:00:05Z',
              read_at: null,
              replied_at: null,
              error_message: null,
              created_at: '2026-10-20T09:59:00Z',
              contact: {
                id: 'cnt-1',
                phone: '+919345018227',
                name: 'Alice',
              },
            },
          ],
          error: null,
        }),
    };

    mocks.supabase.from.mockImplementation((table: string) => {
      if (table === 'broadcasts') return bcQueryBuilder;
      if (table === 'broadcast_recipients') return recsQueryBuilder;
      throw new Error(`Unexpected table: ${table}`);
    });

    const req = new Request('http://localhost/api/v1/broadcasts/bc-1/recipients?limit=10');
    const res = await GET(req, { params: Promise.resolve({ id: 'bc-1' }) });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toEqual({
      id: 'rec-1',
      broadcast_id: 'bc-1',
      contact_id: 'cnt-1',
      phone: '+919345018227',
      name: 'Alice',
      status: 'delivered',
      whatsapp_message_id: 'wamid.123',
      sent_at: '2026-10-20T10:00:00Z',
      delivered_at: '2026-10-20T10:00:05Z',
      read_at: null,
      replied_at: null,
      error_message: null,
      created_at: '2026-10-20T09:59:00Z',
    });
    expect(json.meta).toEqual({
      next_cursor: null,
    });
  });
});
