import { SupabaseClient } from "@supabase/supabase-js";

const OPENROUTER_BASE = Deno.env.get("OPENROUTER_BASE") || "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;

// ---------------------------------------------------------------------------
// Backwards-compatible references reader
// ---------------------------------------------------------------------------

/**
 * Reads project references from thought metadata, supporting both
 * the old `{ project_id: "uuid" }` and new `{ projects: ["uuid"] }` formats.
 */
export function getProjectRefs(metadata: Record<string, unknown>): string[] {
  const refs = metadata?.references as Record<string, unknown> | undefined;
  if (!refs) return [];
  if (Array.isArray(refs.projects)) return refs.projects as string[];
  if (typeof refs.project_id === "string") return [refs.project_id];
  return [];
};

/**
 * Resolves project UUIDs to human-readable project names via a single batch query.
 * Falls back to the raw UUID for any project not found in the database.
 */
export async function resolveProjectNames(
  supabase: SupabaseClient,
  projectUuids: string[],
): Promise<Map<string, string>> {
  const nameMap = new Map<string, string>();
  if (projectUuids.length === 0) return nameMap;

  const uniqueUuids = [...new Set(projectUuids)];
  const { data, error } = await supabase
    .from("projects")
    .select("id, name")
    .in("id", uniqueUuids);

  if (error) {
    console.error(`Project name resolution failed: ${error.message}`);
    for (const uuid of uniqueUuids) nameMap.set(uuid, uuid);
    return nameMap;
  }

  for (const project of data || []) {
    nameMap.set(project.id, project.name);
  }
  for (const uuid of uniqueUuids) {
    if (!nameMap.has(uuid)) nameMap.set(uuid, uuid);
  }
  return nameMap;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const r = await fetch(`${OPENROUTER_BASE}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`OpenRouter embeddings failed: ${r.status} ${msg}`);
  }
  const d = await r.json();
  return d.data[0].embedding;
}

export async function extractMetadata(text: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract metadata from the user's captured thought. Return JSON with:
- "people": array of people mentioned (empty if none)
- "action_items": array of implied to-dos (empty if none)
- "dates_mentioned": array of dates YYYY-MM-DD (empty if none)
- "topics": array of 1-3 short topic tags (always at least one)
- "type": one of "observation", "task", "idea", "reference", "person_note"
Only extract what's explicitly there.`,
        },
        { role: "user", content: text },
      ],
    }),
  });
  const d = await r.json();
  try {
    return JSON.parse(d.choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

export async function freshIngest(
  supabase: SupabaseClient,
  content: string,
  title: string | undefined,
  note_id: string | undefined,
  noteSnapshotId?: string | null,
  references?: Record<string, string[]>,
  provenance?: { reliability: string; author: string },
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const splitResponse = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You split notes into discrete, standalone thoughts for a personal knowledge base.

RULES:
- Each thought must be fully self-contained — readable without any other context
- Preserve specificity: names, dates, project names, tool names, decisions, dollar amounts
- Each thought is 1–3 sentences. No walls of text.
- Prefix decisions with "Decision:", tasks with "TODO:"
- Preserve magical working / ritual / synchronicity framing naturally
- Split on topic boundaries — Java features and a magick working are two separate thoughts
- Skip: bare headings, lone tags, empty sections
- If the entire note is already a single coherent thought, return it as a single-item array

Return ONLY valid JSON: {"thoughts": ["thought 1", "thought 2", ...]}`,
        },
        {
          role: "user",
          content: title ? `Note title: ${title}\n\n${content}` : content,
        },
      ],
    }),
  });

  if (!splitResponse.ok) {
    const msg = await splitResponse.text().catch(() => "");
    throw new Error(`OpenRouter split failed: ${splitResponse.status} ${msg}`);
  }

  const splitData = await splitResponse.json();
  const thoughts: string[] = [];

  try {
    const parsed = JSON.parse(splitData.choices[0].message.content);
    if (Array.isArray(parsed.thoughts)) {
      for (const item of parsed.thoughts) {
        if (typeof item === "string" && item.trim().length > 0) {
          thoughts.push(item);
        } else if (typeof item === "object" && item.thought && typeof item.thought === "string" && item.thought.trim().length > 0) {
          thoughts.push(item.thought);
        }
      }
    }
  } catch {
    thoughts.push(content.trim());
  }

  if (thoughts.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No thoughts extracted — note may be empty." }],
    };
  }

  const pipelineRefs = references || {};

  const results = await Promise.allSettled(
    thoughts.map(async (thoughtContent) => {
      const [embedding, metadata] = await Promise.all([
        getEmbedding(thoughtContent),
        extractMetadata(thoughtContent),
      ]);
      const { error } = await supabase.from("thoughts").insert({
        content: thoughtContent,
        embedding,
        reference_id: note_id || null,
        note_snapshot_id: noteSnapshotId || null,
        metadata: {
          ...metadata,
          source: "obsidian",
          note_title: title || null,
          references: pipelineRefs,
        },
        ...(provenance ? { reliability: provenance.reliability, author: provenance.author } : {}),
      });
      if (error) throw new Error(error.message);
    })
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;

  const taskCount = pipelineRefs.tasks?.length || 0;
  const projectCount = pipelineRefs.projects?.length || 0;
  const extractionParts: string[] = [];
  if (taskCount > 0) extractionParts.push(`${taskCount} task${taskCount !== 1 ? "s" : ""} detected`);
  if (projectCount > 0) extractionParts.push(`${projectCount} project${projectCount !== 1 ? "s" : ""} linked`);
  const extractionSuffix = extractionParts.length > 0 ? ` — ${extractionParts.join(", ")}` : "";

  return {
    content: [{
      type: "text" as const,
      text: `Captured ${succeeded} thought${succeeded !== 1 ? "s" : ""} from "${title || "note"}"${failed > 0 ? ` — ${failed} failed` : ""}${extractionSuffix}`,
    }],
    isError: failed === thoughts.length,
  };
}
