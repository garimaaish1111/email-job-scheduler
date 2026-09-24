import { Client } from "@elastic/elasticsearch";
import type { EmailStatus } from "@prisma/client";
import { env } from "../config/env";

export const EMAIL_INDEX = "emails";

export const esClient = new Client({
  node: env.ELASTICSEARCH_NODE,
  requestTimeout: 5000,
  maxRetries: 2,
});

let indexReady = false;

export interface EmailDocument {
  emailId: string;
  campaignId: string;
  userId: string;
  recipientEmail: string;
  senderEmail: string;
  subject: string;
  body: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
}

export async function ensureIndex(): Promise<boolean> {
  try {
    const exists = await esClient.indices.exists({ index: EMAIL_INDEX });
    if (!exists) {
      // keyword is stored whole and is right for exact matching and filters.
      // text runs through an analyser that lowercases and tokenises, which is what
      // makes partial matching work. Getting these the wrong way round gives a
      // search that silently returns nothing.
      await esClient.indices.create({
        index: EMAIL_INDEX,
        mappings: {
          properties: {
            emailId: { type: "keyword" },
            campaignId: { type: "keyword" },
            userId: { type: "keyword" },
            recipientEmail: { type: "keyword" },
            senderEmail: { type: "keyword" },
            subject: { type: "text", analyzer: "standard" },
            body: { type: "text", analyzer: "standard" },
            status: { type: "keyword" },
            scheduledAt: { type: "date" },
            sentAt: { type: "date" },
          },
        },
      });
      console.log(`[search] created index ${EMAIL_INDEX}`);
    }
    indexReady = true;
    return true;
  } catch (err) {
    console.error("[search] index setup failed, search disabled:", (err as Error).message);
    indexReady = false;
    return false;
  }
}

// Best effort on purpose. Search being unavailable must never stop an email from
// going out, so failures are logged and swallowed. The document id is the email
// row id, so the write on send overwrites the one from scheduling.
export async function indexEmail(doc: EmailDocument): Promise<void> {
  if (!indexReady) return;
  try {
    await esClient.index({
      index: EMAIL_INDEX,
      id: doc.emailId,
      document: doc,
      refresh: false,
    });
  } catch (err) {
    console.error(`[search] index failed for ${doc.emailId}:`, (err as Error).message);
  }
}

export async function indexEmailsBulk(docs: EmailDocument[]): Promise<void> {
  if (!indexReady || docs.length === 0) return;
  try {
    const operations = docs.flatMap((doc) => [
      { index: { _index: EMAIL_INDEX, _id: doc.emailId } },
      doc,
    ]);
    const res = await esClient.bulk({ operations, refresh: false });
    if (res.errors) {
      const firstError = res.items.find((i) => i.index?.error);
      console.error("[search] bulk had errors:", firstError?.index?.error?.reason);
    }
  } catch (err) {
    console.error("[search] bulk index failed:", (err as Error).message);
  }
}

export interface SearchParams {
  userId: string;
  q?: string;
  status?: EmailStatus;
  from?: number;
  size?: number;
}

export interface SearchHit {
  emailId: string;
  recipientEmail: string;
  senderEmail: string;
  subject: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt: string | null;
  score: number | null;
}

export async function searchEmails(
  params: SearchParams
): Promise<{ available: boolean; total: number; hits: SearchHit[] }> {
  if (!indexReady) return { available: false, total: 0, hits: [] };

  const filter: Record<string, unknown>[] = [{ term: { userId: params.userId } }];
  if (params.status) filter.push({ term: { status: params.status } });

  const must = params.q
    ? [
        {
          multi_match: {
            query: params.q,
            fields: ["subject^3", "body", "recipientEmail^2", "senderEmail"],
            fuzziness: "AUTO",
          },
        },
      ]
    : [{ match_all: {} }];

  try {
    const res = await esClient.search<EmailDocument>({
      index: EMAIL_INDEX,
      from: params.from ?? 0,
      size: params.size ?? 25,
      query: { bool: { must, filter } },
      sort: params.q ? undefined : [{ scheduledAt: { order: "desc" } }],
    });

    return {
      available: true,
      total:
        typeof res.hits.total === "number"
          ? res.hits.total
          : (res.hits.total?.value ?? 0),
      hits: res.hits.hits.map((h) => ({
        emailId: h._source!.emailId,
        recipientEmail: h._source!.recipientEmail,
        senderEmail: h._source!.senderEmail,
        subject: h._source!.subject,
        status: h._source!.status,
        scheduledAt: h._source!.scheduledAt,
        sentAt: h._source!.sentAt,
        score: h._score ?? null,
      })),
    };
  } catch (err) {
    console.error("[search] query failed:", (err as Error).message);
    return { available: false, total: 0, hits: [] };
  }
}
