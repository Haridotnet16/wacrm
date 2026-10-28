// ============================================================
// GET /api/v1/broadcasts/{id}/recipients — list a broadcast's recipients
// (scope: broadcasts:read or broadcasts:send).
//
// Returns recipient-level statuses (pending, sent, delivered, read,
// replied, failed) along with contact info (phone, name) and Meta's
// whatsapp_message_id.
//
// Keyset-paginated via `(created_at, id)` descending.
// Account-scoped: a foreign or non-existent broadcast id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';

export const VALID_RECIPIENT_STATUSES = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
] as const;

export type ValidRecipientStatus = (typeof VALID_RECIPIENT_STATUSES)[number];

export interface SerializedBroadcastRecipient {
  id: string;
  broadcast_id: string;
  contact_id: string | null;
  phone: string | null;
  name: string | null;
  status: string;
  whatsapp_message_id: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  error_message: string | null;
  created_at: string;
}

/**
 * Serialize a database row into the public API recipient format.
 * Extracts minimal contact fields (phone, name) while avoiding
 * leaking sensitive contact details (email, company, notes).
 */
export function serializeBroadcastRecipient(
  row: Record<string, unknown>
): SerializedBroadcastRecipient {
  const contact = (
    Array.isArray(row.contact) ? row.contact[0] : row.contact
  ) as { id?: string; phone?: string; name?: string } | null;

  return {
    id: String(row.id),
    broadcast_id: String(row.broadcast_id),
    contact_id: (row.contact_id as string | null) ?? null,
    phone: contact?.phone ?? null,
    name: contact?.name ?? null,
    status: String(row.status),
    whatsapp_message_id: (row.whatsapp_message_id as string | null) ?? null,
    sent_at: (row.sent_at as string | null) ?? null,
    delivered_at: (row.delivered_at as string | null) ?? null,
    read_at: (row.read_at as string | null) ?? null,
    replied_at: (row.replied_at as string | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
    created_at: String(row.created_at),
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, [
      'broadcasts:read',
      'broadcasts:send',
    ]);
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    const url = new URL(request.url);
    const rawStatus = url.searchParams.get('status');
    if (
      rawStatus &&
      !VALID_RECIPIENT_STATUSES.includes(rawStatus as ValidRecipientStatus)
    ) {
      return fail(
        'bad_request',
        `Invalid status filter. Allowed values: ${VALID_RECIPIENT_STATUSES.join(', ')}`,
        400
      );
    }

    // 1. Account ownership check: verify the broadcast exists and belongs to this account.
    const { data: broadcast, error: bcError } = await ctx.supabase
      .from('broadcasts')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (bcError) {
      console.error(
        '[api/v1/broadcasts/recipients] broadcast check error:',
        bcError
      );
      return fail('internal', 'Failed to read broadcast', 500);
    }
    if (!broadcast) return fail('not_found', 'Broadcast not found', 404);

    // 2. Query recipient rows with associated contact details.
    let query = ctx.supabase
      .from('broadcast_recipients')
      .select(`
        id,
        broadcast_id,
        contact_id,
        status,
        whatsapp_message_id,
        sent_at,
        delivered_at,
        read_at,
        replied_at,
        error_message,
        created_at,
        contact:contacts(id, phone, name)
      `)
      .eq('broadcast_id', id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (rawStatus) {
      query = query.eq('status', rawStatus);
    }

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/broadcasts/recipients] list error:', error);
      return fail('internal', 'Failed to list broadcast recipients', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );

    return okList(
      items.map((r) =>
        serializeBroadcastRecipient(r as Record<string, unknown>)
      ),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
