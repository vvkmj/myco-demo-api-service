// Supabase Edge Function (Deno runtime). Deploy target for this file:
// `supabase/functions/ingest-metrics/index.ts` in the project, or paste
// directly into the Supabase dashboard's Edge Functions editor.
//
// This is a deliberately thin wrapper around handler.ts — every decision
// (auth check, payload validation, row shaping) lives there and is unit
// tested with plain Node/ts-node (see test-ingestMetricsHandler.ts in the
// Myco-backend repo). This file only does Deno-specific plumbing: reading the
// request, calling the DB, shaping the HTTP response.
//
// Why an edge function instead of pointing METRICS_ENDPOINT straight at
// Supabase's auto-generated REST API: PostgREST requires an `apikey` header
// (not just `Authorization: Bearer`), which would leak Supabase-specific
// request shape into every client's CI config, and would require handing
// every client's CI a Supabase key. This function instead accepts a single
// generic bearer token (METRICS_INGEST_KEY, unrelated to any Supabase key)
// and uses the service-role key — injected automatically into every edge
// function's environment by Supabase, never exposed to callers — to do the
// actual insert.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { validateAuth, validatePayload, toRow } from "./handler.ts";

const METRICS_INGEST_KEY = Deno.env.get("METRICS_INGEST_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed — use POST." }, 405);
  }

  if (!validateAuth(req.headers.get("Authorization"), METRICS_INGEST_KEY)) {
    return json({ error: "Unauthorized." }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }

  const result = validatePayload(body);
  if (!result.valid) {
    return json({ error: result.error }, 400);
  }

  const row = toRow(result.payload);
  const { error } = await supabase.from("pr_review_metrics").insert(row);

  if (error) {
    console.error("Insert failed:", error);
    return json({ error: "Failed to store metrics." }, 500);
  }

  return json({ ok: true }, 200);
});
