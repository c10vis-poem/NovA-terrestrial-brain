import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";
import { getEmbedding, extractMetadata, freshIngest, getProjectRefs, resolveProjectNames, writeVaultNote } from "../helpers.ts";
import { parseNote } from "../parser.ts";
import { runExtractionPipeline } from "../extractors/pipeline.ts";
import { ProjectExtractor } from "../extractors/project-extractor.ts";
import { TaskExtractor } from "../extractors/task-extractor.ts";
import { PeopleExtractor } from "../extractors/people-extractor.ts";
import { FunctionCallLogger, withMcpLogging } from "../logger.ts";
import { CHAT_MODEL } from "../models.ts";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;
const USEFULNESS_REMINDER_LINES = [
  "⚠️ REQUIRED BEFORE NEXT USER RESPONSE:",
  "1. Call record_useful_thoughts with IDs that contributed (or empty array).",
  "2. Scan these results for contradictions/outdated data — surface to user, do NOT archive silently.",
  "",
  "NEVER skip the record_useful_thoughts step (if no thoughts were found useful, pass in an empty array)! ALWAYS do the record_useful_thoughts step (if no thoughts were found useful, pass in an empty array)!!!",
];

const USEFULNESS_REMINDER_LINES_SOFT = [
  "⚠️ BEFORE NEXT USER RESPONSE:",
  "If any of these thoughts contributed to your response, call record_useful_thoughts with their IDs.",
  "If none contributed (e.g. you were just browsing), call record_useful_thoughts with an empty array to acknowledge the scan.",
  "",
  "Also scan for contradictions/outdated data — surface to user, do NOT archive silently.",
];

function buildUsefulnessReminder(thoughtIds: string[]): string {
  return [
    ...USEFULNESS_REMINDER_LINES,
    `Candidate IDs from this search: ${JSON.stringify(thoughtIds)}`,
  ].join("\n");
}

function buildUsefulnessHeader(thoughtIds: string[]): string {
  return `${buildUsefulnessReminder(thoughtIds)}\n\n--- Results ---\n\n`;
}

function buildUsefulnessReminderSoft(thoughtIds: string[]): string {
  return [
    ...USEFULNESS_REMINDER_LINES_SOFT,
    `Candidate IDs from this list: ${JSON.stringify(thoughtIds)}`,
  ].join("\n");
}

function buildUsefulnessHeaderSoft(thoughtIds: string[]): string {
  return `${buildUsefulnessReminderSoft(thoughtIds)}\n\n--- Results ---\n\n`;
}

export function register(server: McpServer, supabase: SupabaseClient, logger: FunctionCallLogger) {
  // Tool 1: Semantic Search
  server.registerTool(
    "search_thoughts",
    {
      title: "Search Thoughts",
      description:
        "Semantic search across all captured thoughts using meaning, not keywords. " +
        "Use this when the user asks about a topic, person, idea, or decision — even if they phrase it differently from how it was originally captured. " +
        "Returns the most relevant thoughts ranked by similarity. " +
        "Optionally filter results by author (model identifier) or reliability level. " +
        "Prefer this over list_thoughts when the user has a specific question; use list_thoughts for browsing or filtering by type/date. " +
        "CRITICAL: Before your next user-facing response, you MUST call record_useful_thoughts with the IDs of any thoughts that contributed to your answer. " +
        "If none contributed, call it with an empty array to acknowledge the scan. " +
        "Also scan the returned thoughts for contradictions or clearly outdated information — if you notice any, flag them to the user in your response (do NOT archive silently).",
      inputSchema: {
        query: z.string().describe("Natural language description of what to search for — works best as a phrase or sentence, not single keywords"),
        limit: z.number().optional().default(10),
        threshold: z.number().optional().default(0.5),
        author: z.string().optional().describe("Filter by the model that authored the thought, e.g. 'claude-sonnet-4-6' or 'gpt-4o-mini'"),
        reliability: z.string().optional().describe("Filter by reliability level, e.g. 'reliable' or 'less reliable'"),
      },
    },
    withMcpLogging("search_thoughts", async ({ query, limit, threshold, author, reliability }) => {
      try {
        const qEmb = await getEmbedding(query);
        const { data, error } = await supabase.rpc("match_thoughts", {
          query_embedding: qEmb,
          match_threshold: threshold,
          match_count: limit,
          filter: {},
          filter_author: author || null,
          filter_reliability: reliability || null,
        });

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Search error: ${error.message}` }],
            isError: true,
          };
        }

        if (!data || data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No thoughts found matching "${query}".` }],
          };
        }

        // Collect all project UUIDs and resolve to names
        const allProjectUuids: string[] = [];
        for (const thought of data) {
          const projectRefs = getProjectRefs((thought.metadata || {}) as Record<string, unknown>);
          allProjectUuids.push(...projectRefs);
        }
        const projectNameMap = await resolveProjectNames(supabase, allProjectUuids);

        const results = data.map(
          (
            t: {
              id: string;
              content: string;
              metadata: Record<string, unknown>;
              similarity: number;
              created_at: string;
              updated_at: string | null;
              reliability: string | null;
              author: string | null;
            },
            i: number
          ) => {
            const m = t.metadata || {};
            const parts = [
              `--- Result ${i + 1} (${(t.similarity * 100).toFixed(1)}% match) ---`,
              `ID: ${t.id}`,
              `Captured: ${new Date(t.created_at).toISOString()}`,
            ];
            if (t.updated_at) {
              parts.push(`Updated: ${new Date(t.updated_at).toISOString()}`);
            }
            parts.push(`Type: ${m.type || "unknown"}`);
            if (t.reliability || t.author) {
              const provenanceParts: string[] = [];
              if (t.reliability) provenanceParts.push(`Reliability: ${t.reliability}`);
              if (t.author) provenanceParts.push(`Author: ${t.author}`);
              parts.push(provenanceParts.join(" | "));
            }
            if (Array.isArray(m.topics) && m.topics.length)
              parts.push(`Topics: ${(m.topics as string[]).join(", ")}`);
            if (Array.isArray(m.people) && m.people.length)
              parts.push(`People: ${(m.people as string[]).join(", ")}`);
            const projectRefs = getProjectRefs(m as Record<string, unknown>);
            if (projectRefs.length > 0) {
              const projectNames = projectRefs.map((uuid) => projectNameMap.get(uuid) || uuid);
              parts.push(`Projects: ${projectNames.join(", ")}`);
            }
            if (Array.isArray(m.action_items) && m.action_items.length)
              parts.push(`Actions: ${(m.action_items as string[]).join("; ")}`);
            parts.push(`\n${t.content}`);
            return parts.join("\n");
          }
        );

        const thoughtIds = data.map((t: { id: string }) => t.id);
        const header = buildUsefulnessHeader(thoughtIds);
        const footer = buildUsefulnessReminder(thoughtIds);

        return {
          content: [{
            type: "text" as const,
            text: `${header}Found ${data.length} thought(s):\n\n${results.join("\n\n")}\n\n${footer}`,
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

  // Tool 2: List Recent
  server.registerTool(
    "list_thoughts",
    {
      title: "List Recent Thoughts",
      description:
        "Browse recent thoughts chronologically with optional filters. " +
        "Use this when the user wants to see what's been captured lately, review thoughts by category, or check activity for a time period. " +
        "Supports filtering by type, topic, person, time window, project, author (model identifier), or reliability level. " +
        "Prefer search_thoughts when the user has a specific question; use this for open-ended browsing like 'what did I capture this week?' or 'show me all person_notes'. " +
        "CRITICAL: Before your next user-facing response, you MUST call record_useful_thoughts with the IDs of any thoughts that contributed to your answer. " +
        "If none contributed (common when browsing), call it with an empty array to acknowledge the scan. " +
        "Also scan the returned thoughts for contradictions or clearly outdated information — if you notice any, flag them to the user in your response (do NOT archive silently).",
      inputSchema: {
        limit: z.number().optional().default(10),
        type: z.string().optional().describe("Filter by type: observation, task, idea, reference, person_note"),
        topic: z.string().optional().describe("Filter by topic tag"),
        person: z.string().optional().describe("Filter by person mentioned"),
        days: z.number().optional().describe("Only thoughts from the last N days"),
        project_id: z.string().optional().describe("Filter by project UUID — matches thoughts whose metadata.references.projects array contains this UUID"),
        author: z.string().optional().describe("Filter by the model that authored the thought, e.g. 'claude-sonnet-4-6' or 'gpt-4o-mini'"),
        reliability: z.string().optional().describe("Filter by reliability level, e.g. 'reliable' or 'less reliable'"),
        include_archived: z.boolean().optional().default(false).describe("Include archived thoughts in results (default: false)"),
      },
    },
    withMcpLogging("list_thoughts", async ({ limit, type, topic, person, days, project_id, author, reliability, include_archived }) => {
      try {
        let q = supabase
          .from("thoughts")
          .select("id, content, metadata, created_at, updated_at, reliability, author")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (!include_archived) q = q.is("archived_at", null);

        if (type) q = q.contains("metadata", { type });
        if (topic) q = q.contains("metadata", { topics: [topic] });
        if (person) q = q.contains("metadata", { people: [person] });
        if (project_id) q = q.contains("metadata", { references: { projects: [project_id] } });
        if (author) q = q.eq("author", author);
        if (reliability) q = q.eq("reliability", reliability);
        if (days) {
          const since = new Date();
          since.setDate(since.getDate() - days);
          q = q.gte("created_at", since.toISOString());
        }

        const { data, error } = await q;

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }

        if (!data || !data.length) {
          return { content: [{ type: "text" as const, text: "No thoughts found." }] };
        }

        // Collect all project UUIDs and resolve to names
        const allProjectUuids: string[] = [];
        for (const thought of data) {
          const projectRefs = getProjectRefs((thought.metadata || {}) as Record<string, unknown>);
          allProjectUuids.push(...projectRefs);
        }
        const projectNameMap = await resolveProjectNames(supabase, allProjectUuids);

        const results = data.map(
          (
            t: { id: string; content: string; metadata: Record<string, unknown>; created_at: string; updated_at: string | null; reliability: string | null; author: string | null },
            i: number
          ) => {
            const m = t.metadata || {};
            const tags = Array.isArray(m.topics) ? (m.topics as string[]).join(", ") : "";
            const parts = [`${i + 1}. [${new Date(t.created_at).toISOString()}] (${m.type || "??"}${tags ? " - " + tags : ""})`, `   ID: ${t.id}`];
            if (t.updated_at) {
              parts.push(`   Updated: ${new Date(t.updated_at).toISOString()}`);
            }
            if (t.reliability || t.author) {
              const provenanceParts: string[] = [];
              if (t.reliability) provenanceParts.push(`Reliability: ${t.reliability}`);
              if (t.author) provenanceParts.push(`Author: ${t.author}`);
              parts.push(`   ${provenanceParts.join(" | ")}`);
            }
            const projectRefs = getProjectRefs(m as Record<string, unknown>);
            if (projectRefs.length > 0) {
              const projectNames = projectRefs.map((uuid) => projectNameMap.get(uuid) || uuid);
              parts.push(`   Projects: ${projectNames.join(", ")}`);
            }
            parts.push(`   ${t.content}`);
            return parts.join("\n");
          }
        );

        const thoughtIds = data.map((t: { id: string }) => t.id);
        const header = buildUsefulnessHeaderSoft(thoughtIds);
        const footer = buildUsefulnessReminderSoft(thoughtIds);

        return {
          content: [{
            type: "text" as const,
            text: `${header}${data.length} recent thought(s):\n\n${results.join("\n\n")}\n\n${footer}`,
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

  // Tool 3: Stats
  server.registerTool(
    "thought_stats",
    {
      title: "Thought Statistics",
      description:
        "Get high-level statistics about the knowledge base: total thought count, breakdown by type, most frequent topics, and people mentioned. " +
        "Optionally filter by project_id to see stats for a specific project. " +
        "Use this to orient yourself when starting a conversation, to answer 'how much is in my brain?', or to discover which topics and people appear most often.",
      inputSchema: {
        project_id: z.string().optional().describe("Filter statistics to a specific project UUID — only counts thoughts linked to this project"),
      },
    },
    withMcpLogging("thought_stats", async ({ project_id }) => {
      try {
        let countQuery = supabase
          .from("thoughts")
          .select("*", { count: "exact", head: true })
          .is("archived_at", null);
        if (project_id) countQuery = countQuery.contains("metadata", { references: { projects: [project_id] } });
        const { count } = await countQuery;

        let dataQuery = supabase
          .from("thoughts")
          .select("metadata, created_at")
          .is("archived_at", null)
          .order("created_at", { ascending: false });
        if (project_id) dataQuery = dataQuery.contains("metadata", { references: { projects: [project_id] } });
        const { data } = await dataQuery;

        const types: Record<string, number> = {};
        const topics: Record<string, number> = {};
        const people: Record<string, number> = {};

        for (const r of data || []) {
          const m = (r.metadata || {}) as Record<string, unknown>;
          if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
          if (Array.isArray(m.topics))
            for (const t of m.topics) topics[t as string] = (topics[t as string] || 0) + 1;
          if (Array.isArray(m.people))
            for (const p of m.people) people[p as string] = (people[p as string] || 0) + 1;
        }

        const sort = (o: Record<string, number>): [string, number][] =>
          Object.entries(o)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        const lines: string[] = [
          `Total thoughts: ${count}`,
          `Date range: ${
            data?.length
              ? new Date(data[data.length - 1].created_at).toLocaleDateString() +
                " → " +
                new Date(data[0].created_at).toLocaleDateString()
              : "N/A"
          }`,
          "",
          "Types:",
          ...sort(types).map(([k, v]) => `  ${k}: ${v}`),
        ];

        if (Object.keys(topics).length) {
          lines.push("", "Top topics:");
          for (const [k, v] of sort(topics)) lines.push(`  ${k}: ${v}`);
        }

        if (Object.keys(people).length) {
          lines.push("", "People mentioned:");
          for (const [k, v] of sort(people)) lines.push(`  ${k}: ${v}`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

  // Tool 4: Get Thought by ID
  server.registerTool(
    "get_thought_by_id",
    {
      title: "Get Thought by ID",
      description:
        "Retrieve a single thought by its UUID. " +
        "Use this when you have a specific thought ID (e.g. from search results, task references, or a previous conversation) and need its full content and metadata.",
      inputSchema: {
        id: z.string().uuid().describe("The UUID of the thought to retrieve"),
      },
    },
    withMcpLogging("get_thought_by_id", async ({ id }) => {
      try {
        const { data, error } = await supabase
          .from("thoughts")
          .select("id, content, metadata, reference_id, created_at, updated_at")
          .eq("id", id)
          .single();

        if (error) {
          const message = error.code === "PGRST116"
            ? `No thought found with ID "${id}".`
            : `Error: ${error.message}`;
          return {
            content: [{ type: "text" as const, text: message }],
            isError: error.code !== "PGRST116",
          };
        }

        // A fetch by ID implies the caller found the thought useful — auto-record
        // so the model doesn't need to make a separate record_useful_thoughts call.
        // Failures here must not break the fetch itself.
        const { error: usefulnessError } = await supabase.rpc("increment_usefulness", {
          thought_ids: [data.id],
        });
        if (usefulnessError) {
          console.error(`get_thought_by_id auto-record error: ${usefulnessError.message}`);
        }

        const metadata = (data.metadata || {}) as Record<string, unknown>;
        const lines: string[] = [
          `ID: ${data.id}`,
          `Captured: ${new Date(data.created_at).toISOString()}`,
        ];
        if (data.updated_at) {
          lines.push(`Updated: ${new Date(data.updated_at).toISOString()}`);
        }
        lines.push(`Type: ${metadata.type || "unknown"}`);
        if (data.reference_id) lines.push(`Source: ${data.reference_id}`);
        if (Array.isArray(metadata.topics) && metadata.topics.length) {
          lines.push(`Topics: ${(metadata.topics as string[]).join(", ")}`);
        }
        if (Array.isArray(metadata.people) && metadata.people.length) {
          lines.push(`People: ${(metadata.people as string[]).join(", ")}`);
        }
        if (Array.isArray(metadata.action_items) && metadata.action_items.length) {
          lines.push(`Actions: ${(metadata.action_items as string[]).join("; ")}`);
        }
        const references = metadata.references as Record<string, string[]> | undefined;
        if (references) {
          if (references.projects?.length) lines.push(`Projects: ${references.projects.join(", ")}`);
          if (references.tasks?.length) lines.push(`Tasks: ${references.tasks.join(", ")}`);
          if (references.people?.length) lines.push(`People refs: ${references.people.join(", ")}`);
        }
        lines.push(`\n${data.content}`);

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

  // Tool 5: Capture Thought
  server.registerTool(
    "capture_thought",
    {
      title: "Capture Thought",
      description:
        "Save a single thought directly to the knowledge base, stored verbatim. If you are an AI, use this function — do NOT use ingest_note, which paraphrases and is for the Obsidian plugin only. " +
        "Generates an embedding and extracts metadata (type, topics, people, action items) automatically for consistency. " +
        "Each thought should be a clear, self-contained statement. " +
        "Pass your model name as author (e.g. 'claude-sonnet-4-6') and any known project_ids to link projects explicitly. " +
        "If this thought was derived from a document stored via write_document, pass the document UUID as document_ids to create a bidirectional link. " +
        "If this thought was synthesized from prior thoughts you retrieved via search_thoughts, pass their UUIDs as builds_on — each listed thought's usefulness score is incremented as a side effect, which closes the feedback loop inside this call. " +
        "builds_on is additive to record_useful_thoughts, not a replacement: a thought that both answered the user's question AND became a source for this new thought is genuinely worth crediting twice. " +
        "Reliability is hardcoded to 'reliable' for all calls to this function.",
      inputSchema: {
        content: z.string().describe("The thought to capture — a clear, standalone statement that will make sense when retrieved later by any AI"),
        author: z.string().optional().describe("Model identifier of the AI writing this thought, e.g. 'claude-sonnet-4-6'. Stored for provenance — informational only."),
        project_ids: z.string().array().optional().describe("UUIDs of projects to explicitly associate with this thought, merged with any projects the extractor finds."),
        document_ids: z.string().array().optional().describe("UUIDs of source documents this thought was derived from (e.g. from write_document). Stored in metadata.references.documents for traceability."),
        builds_on: z
          .string()
          .uuid()
          .array()
          .optional()
          .describe(
            "UUIDs of prior thoughts this new thought was synthesized from. Each listed thought's usefulness_score is incremented by 1 as a side effect after the insert succeeds. Additive to record_useful_thoughts.",
          ),
      },
    },
    withMcpLogging("capture_thought", async ({ content, author, project_ids, document_ids, builds_on }) => {
      try {
        // Run structural parser + extractor pipeline
        let references: Record<string, string[]> = {};
        try {
          const parsedNote = parseNote(content, null, null, "mcp");
          references = await runExtractionPipeline(
            parsedNote,
            [new ProjectExtractor(), new PeopleExtractor(), new TaskExtractor()],
            supabase,
          );
        } catch (pipelineError) {
          console.error(`capture_thought pipeline error: ${(pipelineError as Error).message}`);
        }

        // Merge explicit project_ids with pipeline-detected projects (union, deduplicated)
        if (project_ids && project_ids.length > 0) {
          const pipelineProjects: string[] = references.projects || [];
          const merged = [...new Set([...pipelineProjects, ...project_ids])];
          references = { ...references, projects: merged };
        }

        // Merge explicit document_ids into references (same union pattern)
        if (document_ids && document_ids.length > 0) {
          const existing: string[] = references.documents || [];
          const merged = [...new Set([...existing, ...document_ids])];
          references = { ...references, documents: merged };
        }

        const [embedding, metadata] = await Promise.all([
          getEmbedding(content),
          extractMetadata(content),
        ]);

        const { error } = await supabase.from("thoughts").insert({
          content,
          embedding,
          reliability: "reliable",
          author: author || null,
          metadata: { ...metadata, source: "mcp", references },
        });

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Failed to capture: ${error.message}` }],
            isError: true,
          };
        }

        await writeVaultNote("thought", content, metadata as Record<string, unknown>);

        let buildsOnNote = "";
        if (builds_on && builds_on.length > 0) {
          const { data: creditedCount, error: buildsOnError } = await supabase.rpc(
            "increment_usefulness",
            { thought_ids: builds_on },
          );
          if (buildsOnError) {
            console.error(`capture_thought builds_on error: ${buildsOnError.message}`);
            buildsOnNote = ` — failed to credit sources: ${buildsOnError.message}`;
          } else {
            buildsOnNote = ` — credited ${creditedCount} prior thought(s) as sources.`;
          }
        }

        const meta = metadata as Record<string, unknown>;
        let confirmation = `Captured as ${meta.type || "thought"}`;
        if (Array.isArray(meta.topics) && meta.topics.length)
          confirmation += ` — ${(meta.topics as string[]).join(", ")}`;
        if (Array.isArray(meta.people) && meta.people.length)
          confirmation += ` | People: ${(meta.people as string[]).join(", ")}`;
        if (Array.isArray(meta.action_items) && meta.action_items.length)
          confirmation += ` | Actions: ${(meta.action_items as string[]).join("; ")}`;
        confirmation += buildsOnNote;

        return {
          content: [{ type: "text" as const, text: confirmation }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

  // Tool 6: Update Thought
  server.registerTool(
    "update_thought",
    {
      title: "Update Thought",
      description:
        "Update an existing thought's content, reliability, author, or project/document associations. " +
        "At least one optional field must be provided. " +
        "When content is updated, the embedding and metadata (type, topics, people, action_items, dates_mentioned) are regenerated automatically. " +
        "When only non-content fields are updated, no AI processing occurs — changes are applied directly. " +
        "project_ids and document_ids use REPLACE semantics: the provided array becomes the new value (not merged with existing). " +
        "Pass project_ids: [] to clear all project links. " +
        "Original created_at, reference_id, note_snapshot_id, and metadata.source are always preserved.",
      inputSchema: {
        id: z.string().describe("UUID of the thought to update"),
        content: z.string().optional().describe("New thought content — triggers embedding regeneration and metadata re-extraction"),
        reliability: z.string().optional().describe("New reliability level: 'reliable' or 'less reliable'"),
        author: z.string().optional().describe("New author attribution, e.g. 'claude-sonnet-4-6'"),
        project_ids: z.string().array().optional().describe("Replace project associations — these UUIDs become the new metadata.references.projects array"),
        document_ids: z.string().array().optional().describe("Replace document associations — these UUIDs become the new metadata.references.documents array"),
      },
    },
    withMcpLogging("update_thought", async ({ id, content, reliability, author, project_ids, document_ids }) => {
      try {
        // Validate at least one optional field is provided
        if (
          content === undefined &&
          reliability === undefined &&
          author === undefined &&
          project_ids === undefined &&
          document_ids === undefined
        ) {
          return {
            content: [{ type: "text" as const, text: "At least one of content, reliability, author, project_ids, or document_ids must be provided." }],
            isError: true,
          };
        }

        // Fetch existing thought
        const { data: existing, error: fetchError } = await supabase
          .from("thoughts")
          .select("id, content, reliability, author, metadata")
          .eq("id", id)
          .single();

        if (fetchError || !existing) {
          return {
            content: [{ type: "text" as const, text: "Thought not found." }],
            isError: true,
          };
        }

        const existingMetadata = (existing.metadata || {}) as Record<string, unknown>;
        const existingReferences = (existingMetadata.references || {}) as Record<string, string[]>;
        const updatedFields: string[] = [];

        if (content !== undefined) {
          // Content update path: regenerate embedding + metadata
          const [embedding, newMetadata] = await Promise.all([
            getEmbedding(content),
            extractMetadata(content),
          ]);

          // Build updated references: preserve existing, apply explicit overrides
          const updatedReferences = { ...existingReferences };
          if (project_ids !== undefined) {
            updatedReferences.projects = project_ids;
            updatedFields.push("project_ids");
          }
          if (document_ids !== undefined) {
            updatedReferences.documents = document_ids;
            updatedFields.push("document_ids");
          }

          // Merge: re-extracted metadata overwrites content-dependent fields,
          // preserve source and apply updated references
          const mergedMetadata = {
            ...existingMetadata,
            ...(newMetadata as Record<string, unknown>),
            source: existingMetadata.source,
            references: updatedReferences,
          };

          const updatePayload: Record<string, unknown> = {
            content,
            embedding,
            metadata: mergedMetadata,
          };

          // Apply top-level field updates alongside content
          if (reliability !== undefined) {
            updatePayload.reliability = reliability;
            updatedFields.push("reliability");
          }
          if (author !== undefined) {
            updatePayload.author = author;
            updatedFields.push("author");
          }

          const { error: updateError } = await supabase
            .from("thoughts")
            .update(updatePayload)
            .eq("id", id);

          if (updateError) {
            return {
              content: [{ type: "text" as const, text: `Update failed: ${updateError.message}` }],
              isError: true,
            };
          }

          updatedFields.unshift("content (embedding + metadata regenerated)");
          return {
            content: [{ type: "text" as const, text: `Thought updated: ${updatedFields.join(", ")}` }],
          };
        } else {
          // Non-content update path: direct DB update, no AI calls
          const updatePayload: Record<string, unknown> = {};
          let metadataChanged = false;
          const updatedReferences = { ...existingReferences };

          if (reliability !== undefined) {
            updatePayload.reliability = reliability;
            updatedFields.push("reliability");
          }
          if (author !== undefined) {
            updatePayload.author = author;
            updatedFields.push("author");
          }
          if (project_ids !== undefined) {
            updatedReferences.projects = project_ids;
            metadataChanged = true;
            updatedFields.push("project_ids");
          }
          if (document_ids !== undefined) {
            updatedReferences.documents = document_ids;
            metadataChanged = true;
            updatedFields.push("document_ids");
          }

          if (metadataChanged) {
            updatePayload.metadata = {
              ...existingMetadata,
              references: updatedReferences,
            };
          }

          const { error: updateError } = await supabase
            .from("thoughts")
            .update(updatePayload)
            .eq("id", id);

          if (updateError) {
            return {
              content: [{ type: "text" as const, text: `Update failed: ${updateError.message}` }],
              isError: true,
            };
          }

          return {
            content: [{ type: "text" as const, text: `Thought updated: ${updatedFields.join(", ")}` }],
          };
        }
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

  // Tool 7: Record Useful Thoughts
  server.registerTool(
    "record_useful_thoughts",
    {
      title: "Record Useful Thoughts",
      description:
        "Record which thoughts were useful during this interaction by incrementing their usefulness score. " +
        "Call this after every search_thoughts call — it is required, not optional. " +
        "Pass the IDs of thoughts that contributed to your answer. " +
        "If none of the returned thoughts contributed, pass an empty array to acknowledge the scan — an empty array is the correct input in that case, not a reason to skip the call. " +
        "This feedback loop helps surface the most valuable thoughts in future queries. " +
        "Each call increments the score by 1 for every thought ID provided.",
      inputSchema: {
        thought_ids: z
          .string()
          .uuid()
          .array()
          .describe(
            "Array of thought UUIDs that were useful in this interaction. Pass [] if no returned thought contributed — that is the correct value, not a reason to skip the call.",
          ),
      },
    },
    withMcpLogging("record_useful_thoughts", async ({ thought_ids }) => {
      try {
        const { data: affectedCount, error } = await supabase.rpc("increment_usefulness", {
          thought_ids,
        });

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Failed to record usefulness: ${error.message}` }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `Recorded usefulness for ${affectedCount} thought(s) out of ${thought_ids.length} provided.`,
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

  // Tool 8: Archive Thought
  server.registerTool(
    "archive_thought",
    {
      title: "Archive Thought",
      description:
        "Archive a thought by setting its archived_at timestamp. " +
        "Archived thoughts are hidden from search, listing, and stats by default — they are not deleted and can still be retrieved with include_archived. " +
        "Use this when a thought is outdated, incorrect, or no longer relevant. Confirm with the user before archiving.",
      inputSchema: {
        id: z.string().uuid().describe("UUID of the thought to archive"),
      },
    },
    withMcpLogging("archive_thought", async ({ id }) => {
      try {
        const { data: thought, error: fetchError } = await supabase
          .from("thoughts")
          .select("id, content")
          .eq("id", id)
          .is("archived_at", null)
          .single();

        if (fetchError || !thought) {
          return {
            content: [{ type: "text" as const, text: `Thought not found or already archived: ${fetchError?.message || "unknown"}` }],
            isError: true,
          };
        }

        const { error: archiveError } = await supabase
          .from("thoughts")
          .update({ archived_at: new Date().toISOString() })
          .eq("id", id);

        if (archiveError) {
          return {
            content: [{ type: "text" as const, text: `Archive failed: ${archiveError.message}` }],
            isError: true,
          };
        }

        const preview = thought.content.length > 80 ? thought.content.slice(0, 80) + "…" : thought.content;
        return {
          content: [{ type: "text" as const, text: `Archived thought: "${preview}"` }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

}

// ─── Standalone ingest_note handler (called via direct HTTP route, not MCP) ──

const INGEST_PROVENANCE = { reliability: "less reliable", author: "gpt-4o-mini" };

export async function handleIngestNote(
  supabase: SupabaseClient,
  { content, title, note_id }: { content: string; title?: string; note_id?: string },
): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    // Step 0: Skip if content is unchanged (prevents duplicate ingestion from Obsidian Sync)
    if (note_id) {
      const { data: existing } = await supabase
        .from("note_snapshots")
        .select("content")
        .eq("reference_id", note_id)
        .single();

      if (existing && existing.content === content) {
        return { success: true, message: "Note unchanged — skipped." };
      }
    }

    // Step 1: Upsert note snapshot
    let noteSnapshotId: string | null = null;
    if (note_id) {
      const { data: snapshot, error: snapshotError } = await supabase
        .from("note_snapshots")
        .upsert(
          { reference_id: note_id, title: title || null, content, source: "obsidian" },
          { onConflict: "reference_id" },
        )
        .select("id")
        .single();

      if (snapshotError) {
        console.error(`Note snapshot upsert failed: ${snapshotError.message}`);
      } else {
        noteSnapshotId = snapshot.id;
      }
    }

    // Step 2: Structural parse
    const parsedNote = parseNote(content, title || null, note_id || null, "obsidian");

    // Step 3: Run extractor pipeline
    let references: Record<string, string[]> = {};
    try {
      references = await runExtractionPipeline(
        parsedNote,
        [new ProjectExtractor(), new PeopleExtractor(), new TaskExtractor()],
        supabase,
      );
    } catch (pipelineError) {
      console.error(`Extractor pipeline error: ${(pipelineError as Error).message}`);
    }

    // Step 4: Fetch existing thoughts for this note
    type ExistingThought = { id: string; content: string; created_at: string };
    let existingThoughts: ExistingThought[] = [];

    if (note_id) {
      const { data, error } = await supabase
        .from("thoughts")
        .select("id, content, created_at")
        .eq("reference_id", note_id)
        .is("archived_at", null)
        .order("created_at", { ascending: true });

      if (error) throw new Error(`Failed to fetch existing thoughts: ${error.message}`);
      existingThoughts = data || [];
    }

    // Step 5: No existing thoughts → fresh split and insert
    if (existingThoughts.length === 0) {
      const result = await freshIngest(supabase, content, title, note_id, noteSnapshotId, references, INGEST_PROVENANCE);
      return {
        success: !result.isError,
        message: result.content[0].text,
        ...(result.isError ? { error: result.content[0].text } : {}),
      };
    }

    // Step 6: Existing thoughts found → reconcile with updated note
    const existingForPrompt = existingThoughts
      .map((t) => `[ID:${t.id}] (captured ${new Date(t.created_at).toLocaleDateString()})\n${t.content}`)
      .join("\n\n");

    const reconcileResponse = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You reconcile an updated note with its previously captured thoughts in a personal knowledge base.

You will receive:
- EXISTING THOUGHTS: previously captured thoughts, each tagged with [ID:uuid]
- NEW NOTE CONTENT: the current version of the note

Produce a reconciliation plan:
- "keep": IDs of thoughts that are still accurate and essentially unchanged
- "update": thoughts whose core idea is the same but details changed — provide revised content (1-3 sentences, self-contained)
- "add": genuinely new topics or ideas not represented in any existing thought
- "delete": IDs of thoughts whose topic no longer appears in the note

Rules:
- Do NOT duplicate. Same idea expressed differently = keep the existing one.
- Do NOT add a thought for something you are already updating.
- Every thought must be fully self-contained — readable without context.
- Preserve specificity: names, dates, project names, decisions, dollar amounts.
- Prefix decisions with "Decision:", tasks with "TODO:", preserve magical working framing naturally.

Return ONLY valid JSON in this exact structure:
{
  "keep": ["id1", "id2"],
  "update": [{"id": "id3", "content": "revised text"}],
  "add": ["new thought 1", "new thought 2"],
  "delete": ["id4"]
}`,
          },
          {
            role: "user",
            content: `EXISTING THOUGHTS:\n${existingForPrompt}\n\n---\n\nNEW NOTE CONTENT (title: ${title || "untitled"}):\n${content}`,
          },
        ],
      }),
    });

    if (!reconcileResponse.ok) {
      const msg = await reconcileResponse.text().catch(() => "");
      throw new Error(`OpenRouter reconcile failed: ${reconcileResponse.status} ${msg}`);
    }

    const reconcileData = await reconcileResponse.json();
    let plan: {
      keep: string[];
      update: { id: string; content: string }[];
      add: string[];
      delete: string[];
    } = { keep: [], update: [], add: [], delete: [] };

    try {
      plan = JSON.parse(reconcileData.choices[0].message.content);
    } catch {
      console.warn("Reconciliation parse failed, falling back to fresh ingest");
      const result = await freshIngest(supabase, content, title, note_id, noteSnapshotId, references, INGEST_PROVENANCE);
      return {
        success: !result.isError,
        message: result.content[0].text,
        ...(result.isError ? { error: result.content[0].text } : {}),
      };
    }

    // Step 7: Execute reconciliation plan
    const ops: Promise<void>[] = [];
    let updated = 0, added = 0, deleted = 0;

    for (const updateItem of (plan.update || [])) {
      ops.push((async () => {
        const [embedding, metadata] = await Promise.all([
          getEmbedding(updateItem.content),
          extractMetadata(updateItem.content),
        ]);
        const { error } = await supabase
          .from("thoughts")
          .update({
            content: updateItem.content,
            embedding,
            note_snapshot_id: noteSnapshotId,
            reliability: INGEST_PROVENANCE.reliability,
            author: INGEST_PROVENANCE.author,
            metadata: {
              ...metadata,
              source: "obsidian",
              note_title: title || null,
              updated_at: new Date().toISOString(),
              references,
            },
          })
          .eq("id", updateItem.id);
        if (error) throw new Error(`Update failed for ${updateItem.id}: ${error.message}`);
        updated++;
      })());
    }

    for (const addItem of (plan.add || [])) {
      const thoughtContent = typeof addItem === "string" ? addItem : (addItem as unknown as { thought: string }).thought || addItem;
      ops.push((async () => {
        const [embedding, metadata] = await Promise.all([
          getEmbedding(thoughtContent as string),
          extractMetadata(thoughtContent as string),
        ]);
        const { error } = await supabase.from("thoughts").insert({
          content: thoughtContent,
          embedding,
          reference_id: note_id || null,
          note_snapshot_id: noteSnapshotId,
          reliability: INGEST_PROVENANCE.reliability,
          author: INGEST_PROVENANCE.author,
          metadata: {
            ...metadata,
            source: "obsidian",
            note_title: title || null,
            references,
          },
        });
        if (error) throw new Error(`Insert failed: ${error.message}`);
        added++;
      })());
    }

    for (const id of (plan.delete || [])) {
      ops.push((async () => {
        // Soft-archive, never hard-delete: an LLM-produced (and possibly
        // hallucinated) ID must never permanently destroy captured knowledge.
        // Archived thoughts stay retrievable and are excluded from the next
        // reconciliation fetch (which filters archived_at IS NULL).
        const { error } = await supabase
          .from("thoughts")
          .update({ archived_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw new Error(`Archive failed for ${id}: ${error.message}`);
        deleted++;
      })());
    }

    const results = await Promise.allSettled(ops);
    const failures = results.filter((r) => r.status === "rejected").length;

    const kept = (plan.keep || []).length;
    const parts: string[] = [];
    if (kept > 0) parts.push(`${kept} unchanged`);
    if (updated > 0) parts.push(`${updated} updated`);
    if (added > 0) parts.push(`${added} added`);
    if (deleted > 0) parts.push(`${deleted} removed`);
    if (failures > 0) parts.push(`${failures} failed`);

    const taskCount = references.tasks?.length || 0;
    const projectCount = references.projects?.length || 0;
    const peopleCount = references.people?.length || 0;
    const extractionParts: string[] = [];
    if (taskCount > 0) extractionParts.push(`${taskCount} task${taskCount !== 1 ? "s" : ""} detected`);
    if (projectCount > 0) extractionParts.push(`${projectCount} project${projectCount !== 1 ? "s" : ""} linked`);
    if (peopleCount > 0) extractionParts.push(`${peopleCount} ${peopleCount !== 1 ? "people" : "person"} referenced`);
    const extractionSuffix = extractionParts.length > 0 ? ` | ${extractionParts.join(", ")}` : "";

    const message = `Synced "${title || note_id || "note"}": ${parts.join(", ") || "no changes"}${extractionSuffix}`;
    const isError = failures > 0 && failures === ops.length;

    return {
      success: !isError,
      message,
      ...(isError ? { error: message } : {}),
    };

  } catch (err: unknown) {
    return {
      success: false,
      error: (err as Error).message,
    };
  }
}
