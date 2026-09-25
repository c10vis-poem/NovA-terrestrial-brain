/**
 * PeopleExtractor — detects person mentions in note content.
 *
 * Uses an LLM call to detect ALL person names mentioned in the note.
 * Matches detected names against known people, and auto-creates new
 * people records for previously unseen names.
 */

import type { ParsedNote } from "../parser.ts";
import type {
  ExtractionContext,
  ExtractionResult,
  Extractor,
} from "./pipeline.ts";
import { findPersonByName } from "./name-matching.ts";
import { CHAT_MODEL } from "../models.ts";

const OPENROUTER_BASE = Deno.env.get("OPENROUTER_BASE") || "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;

// ---------------------------------------------------------------------------
// LLM-based person detection
// ---------------------------------------------------------------------------

interface DetectedPerson {
  name: string;
  knownId: string | null;
}

/**
 * Batch LLM call to detect all person names in the note. Returns both
 * matched known people (with their IDs) and new names to auto-create.
 */
async function detectAllPeople(
  noteContent: string,
  knownPeople: { id: string; name: string }[],
): Promise<DetectedPerson[]> {
  if (!noteContent.trim()) return [];

  const peopleList = knownPeople.length > 0
    ? knownPeople.map((person) => `- "${person.name}" (id: ${person.id})`).join("\n")
    : "(none)";

  const validIds = new Set(knownPeople.map((person) => person.id));

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
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
            content: `You identify people mentioned in a note. Given note content and a list of known people, return ALL person names detected.

For each person found:
- If they match a known person, return their ID
- If the note uses only a first name or last name, match it to a known person when there is exactly one clear match (e.g., "Bub" matches "Bub Goodwin" if no other known person has the first name "Bub")
- If they are a NEW person not in the known list, return their name with id: null

Only detect real human names — not product names, company names, or fictional characters.
Skip generic references like "the user", "someone", "they".

Return JSON: {"people": [{"name": "Alice", "id": "uuid-if-known-or-null"}, ...]}

KNOWN PEOPLE:
${peopleList}`,
          },
          {
            role: "user",
            content: noteContent,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(
        `PeopleExtractor LLM call failed: ${response.status} ${errorText}`,
      );
      return [];
    }

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);

    if (!Array.isArray(parsed.people)) return [];

    return parsed.people
      .filter(
        (entry: { name?: unknown; id?: unknown }) =>
          typeof entry.name === "string" && entry.name.trim().length > 0,
      )
      .map((entry: { name: string; id?: string | null }) => ({
        name: entry.name.trim(),
        knownId:
          typeof entry.id === "string" && validIds.has(entry.id)
            ? entry.id
            : null,
      }));
  } catch (error) {
    console.error(
      `PeopleExtractor LLM detection error: ${(error as Error).message}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// PeopleExtractor
// ---------------------------------------------------------------------------

export class PeopleExtractor implements Extractor {
  readonly referenceKey = "people";

  async extract(
    note: ParsedNote,
    context: ExtractionContext,
  ): Promise<ExtractionResult> {
    // Build note content for LLM
    const contentParts: string[] = [];
    if (note.title) contentParts.push(`Title: ${note.title}`);
    contentParts.push(note.content);
    const noteContent = contentParts.join("\n").trim();

    if (!noteContent) {
      return { referenceKey: this.referenceKey, ids: [] };
    }

    const allPeople = [
      ...context.knownPeople,
      ...context.newlyCreatedPeople,
    ];
    const uniquePeople = Array.from(
      new Map(allPeople.map((person) => [person.id, person])).values(),
    );

    const detectedPeople = await detectAllPeople(noteContent, uniquePeople);
    const resultIds: string[] = [];

    for (const detected of detectedPeople) {
      if (detected.knownId) {
        // Known person — just include their ID
        if (!resultIds.includes(detected.knownId)) {
          resultIds.push(detected.knownId);
        }
      } else {
        // New person — check if already known by case-insensitive name match
        const existingMatch = this.findByName(detected.name, uniquePeople);
        if (existingMatch) {
          if (!resultIds.includes(existingMatch)) {
            resultIds.push(existingMatch);
          }
        } else {
          // Auto-create
          const newId = await this.createPerson(detected.name, context);
          if (newId && !resultIds.includes(newId)) {
            resultIds.push(newId);
          }
        }
      }
    }

    return {
      referenceKey: this.referenceKey,
      ids: resultIds,
    };
  }

  /**
   * Two-tier name lookup: exact case-insensitive match, then partial
   * name-part match (unambiguous only). Delegates to shared utility.
   */
  private findByName(
    name: string,
    knownPeople: { id: string; name: string }[],
  ): string | null {
    return findPersonByName(name, knownPeople);
  }

  /**
   * Inserts a new person record and adds it to the context so downstream
   * extractors (TaskExtractor) can use it immediately.
   */
  private async createPerson(
    name: string,
    context: ExtractionContext,
  ): Promise<string | null> {
    const { data: newPerson, error } = await context.supabase
      .from("people")
      .insert({ name })
      .select("id, name")
      .single();

    if (!error && newPerson) {
      context.newlyCreatedPeople.push({
        id: newPerson.id,
        name: newPerson.name,
      });
      context.knownPeople.push({
        id: newPerson.id,
        name: newPerson.name,
      });
      return newPerson.id;
    }

    console.error(
      `PeopleExtractor auto-create failed for "${name}": ${error?.message}`,
    );
    return null;
  }
}
