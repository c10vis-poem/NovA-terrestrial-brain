/**
 * ProjectExtractor — detects project associations from parsed notes.
 *
 * Detection signals (in priority order):
 * 1a. Conventional path: `projects/{name}/` pattern (case-insensitive, any depth)
 * 1b. LLM path analysis: path segments or filename containing "project"
 * 2.  Heading match: case-insensitive comparison against known projects
 * 3.  LLM content matching: focused AI call for remaining associations
 */

import type { ParsedNote } from "../parser.ts";
import type {
  ExtractionContext,
  ExtractionResult,
  Extractor,
} from "./pipeline.ts";

const OPENROUTER_BASE = Deno.env.get("OPENROUTER_BASE") || "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;

// ---------------------------------------------------------------------------
// Signal 1a: Conventional path detection (case-insensitive, any depth)
// ---------------------------------------------------------------------------

/**
 * Extracts the project folder name from a referenceId matching
 * `projects/{name}/...` at any depth, case-insensitive.
 * Returns null if no match or empty name.
 */
export function extractProjectFromConventionalPath(
  referenceId: string | null,
): string | null {
  if (!referenceId) return null;

  // Match "projects/{name}/" at any depth, case-insensitive
  const match = referenceId.match(/(?:^|\/)projects\/([^/]+)\//i);
  if (!match) return null;

  const folderName = match[1].trim();
  return folderName.length > 0 ? folderName : null;
}

// ---------------------------------------------------------------------------
// Signal 1b: LLM-based project name extraction from path
// ---------------------------------------------------------------------------

/**
 * Returns true if any path segment or filename (sans extension) contains
 * the word "project" (case-insensitive).
 */
export function pathContainsProjectKeyword(
  referenceId: string | null,
): boolean {
  if (!referenceId) return false;
  // Remove .md extension from filename before checking
  const pathWithoutExtension = referenceId.replace(/\.md$/i, "");
  const segments = pathWithoutExtension.split("/");
  return segments.some((segment) => /project/i.test(segment));
}

/**
 * Uses LLM to determine if a path containing "project" represents
 * an actual project name, and if so, extracts the clean project name.
 *
 * Returns { isProject: true, projectName: "..." } or { isProject: false }.
 */
export async function extractProjectNameFromPath(
  referenceId: string,
): Promise<{ isProject: boolean; projectName: string | null }> {
  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
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
            content: `You analyze file paths from an Obsidian vault to determine if they reference a specific project.

RULES:
- A path segment or filename like "Rabbit Hutch Project" IS a project named "Rabbit Hutch"
- A path segment like "Project Planning notes" is NOT a project — "Project" is used descriptively
- A filename like "Acme Project.md" IS a project named "Acme"
- A folder like "My Garden Project" IS a project named "My Garden"
- "Project updates" or "Project ideas" are NOT project names — they're generic labels
- Strip the word "Project" from the name when extracting
- If the path has a conventional "projects/{name}/" structure, use that name directly

Return JSON: {"is_project": true/false, "project_name": "name" or null}`,
          },
          {
            role: "user",
            content: `Path: ${referenceId}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(
        `ProjectExtractor LLM path analysis failed: ${response.status} ${errorText}`,
      );
      return { isProject: false, projectName: null };
    }

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);

    if (parsed.is_project && typeof parsed.project_name === "string" && parsed.project_name.trim()) {
      return { isProject: true, projectName: parsed.project_name.trim() };
    }

    return { isProject: false, projectName: null };
  } catch (error) {
    console.error(
      `ProjectExtractor LLM path analysis error: ${(error as Error).message}`,
    );
    return { isProject: false, projectName: null };
  }
}

// ---------------------------------------------------------------------------
// Heading-based detection
// ---------------------------------------------------------------------------

/**
 * Returns project IDs whose name matches any heading (case-insensitive).
 */
function detectProjectsByHeadings(
  note: ParsedNote,
  knownProjects: { id: string; name: string }[],
): string[] {
  if (knownProjects.length === 0 || note.headings.length === 0) return [];

  const matchedIds: string[] = [];

  for (const heading of note.headings) {
    const headingLower = heading.text.toLowerCase().trim();
    for (const project of knownProjects) {
      if (project.name.toLowerCase() === headingLower) {
        matchedIds.push(project.id);
      }
    }
  }

  return matchedIds;
}

// ---------------------------------------------------------------------------
// LLM content matching
// ---------------------------------------------------------------------------

/**
 * Builds a summary of the note for the LLM call: title, heading structure,
 * and first ~200 chars of each section.
 */
function buildNoteSummary(note: ParsedNote): string {
  const parts: string[] = [];

  if (note.title) {
    parts.push(`Title: ${note.title}`);
  }

  if (note.headings.length > 0) {
    parts.push("Sections:");
    const lines = note.content.split("\n");
    for (const heading of note.headings) {
      const sectionLines = lines.slice(
        heading.lineStart - 1,
        heading.lineEnd,
      );
      const sectionText = sectionLines.join("\n").substring(0, 200);
      parts.push(`  ${"#".repeat(heading.level)} ${heading.text}: ${sectionText}`);
    }
  } else {
    // No headings — just use first 400 chars of content
    parts.push(`Content: ${note.content.substring(0, 400)}`);
  }

  return parts.join("\n");
}

/**
 * Uses a focused LLM call to detect project mentions in note content.
 * Returns only IDs that exist in the known projects list.
 */
async function detectProjectsByContent(
  note: ParsedNote,
  knownProjects: { id: string; name: string }[],
): Promise<string[]> {
  if (knownProjects.length === 0) return [];

  const projectList = knownProjects
    .map((project) => `- "${project.name}" (id: ${project.id})`)
    .join("\n");

  const noteSummary = buildNoteSummary(note);

  const validIds = new Set(knownProjects.map((project) => project.id));

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
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
            content: `You identify which projects a note is about. You are given a note summary and a list of known projects. Return ONLY project IDs from the list that the note clearly references or relates to. Do not invent new projects. If no projects match, return an empty array.

Return JSON: {"project_ids": ["uuid1", "uuid2"]}

KNOWN PROJECTS:
${projectList}`,
          },
          {
            role: "user",
            content: noteSummary,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      console.error(
        `ProjectExtractor LLM call failed: ${response.status} ${errorText}`,
      );
      return [];
    }

    const data = await response.json();
    const parsed = JSON.parse(data.choices[0].message.content);

    if (!Array.isArray(parsed.project_ids)) return [];

    // Only accept IDs that exist in the known projects list
    return parsed.project_ids.filter(
      (id: unknown) => typeof id === "string" && validIds.has(id),
    );
  } catch (error) {
    console.error(
      `ProjectExtractor LLM content matching error: ${(error as Error).message}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// ProjectExtractor
// ---------------------------------------------------------------------------

export class ProjectExtractor implements Extractor {
  readonly referenceKey = "projects";

  async extract(
    note: ParsedNote,
    context: ExtractionContext,
  ): Promise<ExtractionResult> {
    const matchedIds: string[] = [];

    // Signal 1a: Conventional path detection (case-insensitive, any depth)
    const folderName = extractProjectFromConventionalPath(note.referenceId);
    let conventionalPathMatched = false;

    if (folderName) {
      conventionalPathMatched = true;
      const projectId = await this.matchOrCreateProject(folderName, context);
      if (projectId) matchedIds.push(projectId);
    }

    // Signal 1b: LLM path analysis (only if Signal 1a didn't match and path contains "project")
    if (!conventionalPathMatched && note.referenceId && pathContainsProjectKeyword(note.referenceId)) {
      const pathResult = await extractProjectNameFromPath(note.referenceId);
      if (pathResult.isProject && pathResult.projectName) {
        const projectId = await this.matchOrCreateProject(pathResult.projectName, context);
        if (projectId) matchedIds.push(projectId);
      }
    }

    // Signal 2: Heading-based detection
    const headingIds = detectProjectsByHeadings(note, context.knownProjects);
    matchedIds.push(...headingIds);

    // Signal 3: LLM content matching (only if there are projects to match against)
    const contentIds = await detectProjectsByContent(
      note,
      context.knownProjects,
    );
    matchedIds.push(...contentIds);

    // Deduplicate
    const uniqueIds = [...new Set(matchedIds)];

    return {
      referenceKey: this.referenceKey,
      ids: uniqueIds,
    };
  }

  /**
   * Matches a project name against known projects (case-insensitive),
   * or auto-creates a new project if not found.
   * Returns the project ID, or null on failure.
   */
  private async matchOrCreateProject(
    projectName: string,
    context: ExtractionContext,
  ): Promise<string | null> {
    const existingProject = context.knownProjects.find(
      (project) => project.name.toLowerCase() === projectName.toLowerCase(),
    );

    if (existingProject) {
      return existingProject.id;
    }

    // Auto-create project
    const { data: newProject, error } = await context.supabase
      .from("projects")
      .insert({ name: projectName })
      .select("id, name")
      .single();

    if (!error && newProject) {
      context.newlyCreatedProjects.push({
        id: newProject.id,
        name: newProject.name,
      });
      context.knownProjects.push({
        id: newProject.id,
        name: newProject.name,
      });
      return newProject.id;
    }

    console.error(
      `ProjectExtractor auto-create failed for "${projectName}": ${error?.message}`,
    );
    return null;
  }
}
