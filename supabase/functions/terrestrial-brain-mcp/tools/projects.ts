import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";
import { FunctionCallLogger, withMcpLogging } from "../logger.ts";
import { writeVaultNote } from "../helpers.ts";

export function register(server: McpServer, supabase: SupabaseClient, logger: FunctionCallLogger) {
  server.registerTool(
    "create_project",
    {
      title: "Create Project",
      description:
        "Create a new project. Projects group related thoughts and tasks, and store context about the work " +
        "(client name, purpose, location, key contacts) in the description and type fields. " +
        "When creating a project, populate the description with any known context — this helps other AIs understand the project without searching through thoughts. " +
        "Use type to categorize: 'client' for client work, 'personal' for personal projects, 'research' for research/learning, 'internal' for internal tooling.",
      inputSchema: {
        name: z.string().describe("Project name"),
        type: z.string().optional().describe("Project type: client, personal, research, internal"),
        parent_id: z.string().optional().describe("UUID of parent project for nesting"),
        description: z.string().optional().describe("Project description — include client name, purpose, location, key contacts, or any context that helps understand this project at a glance"),
      },
    },
    withMcpLogging("create_project", async ({ name, type, parent_id, description }) => {
      try {
        const { data, error } = await supabase
          .from("projects")
          .insert({
            name,
            type: type || null,
            parent_id: parent_id || null,
            description: description || null,
          })
          .select("id, name")
          .single();

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Failed to create project: ${error.message}` }],
            isError: true,
          };
        }

        await writeVaultNote("project", `Project: ${data.name}${description ? ` — ${description}` : ""}`, { type: type || "project" });

        return {
          content: [{ type: "text" as const, text: `Created project "${data.name}" (id: ${data.id})` }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Projects",
      description:
        "List all projects with optional filters by type, parent, or archive status. " +
        "Use this to find a project by name before creating tasks or updating project details. " +
        "Also useful for answering 'what projects are active?' or 'what client projects do I have?'",
      inputSchema: {
        include_archived: z.boolean().optional().default(false).describe("Include archived projects"),
        parent_id: z.string().optional().describe("List only children of this project"),
        type: z.string().optional().describe("Filter by project type"),
      },
    },
    withMcpLogging("list_projects", async ({ include_archived, parent_id, type }) => {
      try {
        let q = supabase
          .from("projects")
          .select("id, name, type, parent_id, archived_at, created_at")
          .order("created_at", { ascending: false });

        if (!include_archived) q = q.is("archived_at", null);
        if (parent_id) q = q.eq("parent_id", parent_id);
        if (type) q = q.eq("type", type);

        const { data, error } = await q;

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }

        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No projects found." }] };
        }

        // Get parent names for display
        const parentIds = [...new Set(data.filter(p => p.parent_id).map(p => p.parent_id))];
        let parentMap: Record<string, string> = {};
        if (parentIds.length > 0) {
          const { data: parents } = await supabase
            .from("projects")
            .select("id, name")
            .in("id", parentIds);
          parentMap = Object.fromEntries((parents || []).map(p => [p.id, p.name]));
        }

        // Get child counts
        const projectIds = data.map(p => p.id);
        const { data: children } = await supabase
          .from("projects")
          .select("parent_id")
          .in("parent_id", projectIds)
          .is("archived_at", null);
        const childCounts: Record<string, number> = {};
        for (const c of children || []) {
          childCounts[c.parent_id] = (childCounts[c.parent_id] || 0) + 1;
        }

        const lines = data.map((p, i) => {
          const parts = [
            `${i + 1}. ${p.name}`,
            `   ID: ${p.id}`,
            `   Type: ${p.type || "—"}`,
          ];
          if (p.parent_id && parentMap[p.parent_id])
            parts.push(`   Parent: ${parentMap[p.parent_id]}`);
          if (childCounts[p.id])
            parts.push(`   Children: ${childCounts[p.id]}`);
          parts.push(`   Created: ${new Date(p.created_at).toLocaleDateString()}`);
          if (p.archived_at)
            parts.push(`   Archived: ${new Date(p.archived_at).toLocaleDateString()}`);
          return parts.join("\n");
        });

        return {
          content: [{ type: "text" as const, text: `${data.length} project(s):\n\n${lines.join("\n\n")}` }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

  server.registerTool(
    "get_project",
    {
      title: "Get Project",
      description:
        "Get a project's details: name, type, description, parent, children, and open task count. " +
        "Use this for quick lookups when you need project metadata. " +
        "For a richer view that also includes recent thoughts and source notes, use get_project_summary instead.",
      inputSchema: {
        id: z.string().describe("Project UUID"),
      },
    },
    withMcpLogging("get_project", async ({ id }) => {
      try {
        const { data: project, error } = await supabase
          .from("projects")
          .select("*")
          .eq("id", id)
          .single();

        if (error || !project) {
          return {
            content: [{ type: "text" as const, text: `Project not found: ${error?.message || "unknown"}` }],
            isError: true,
          };
        }

        // Get parent name
        let parentName = null;
        if (project.parent_id) {
          const { data: parent } = await supabase
            .from("projects")
            .select("name")
            .eq("id", project.parent_id)
            .single();
          parentName = parent?.name;
        }

        // Get children
        const { data: children } = await supabase
          .from("projects")
          .select("id, name, type")
          .eq("parent_id", id)
          .is("archived_at", null);

        // Get open task count
        const { count: taskCount } = await supabase
          .from("tasks")
          .select("*", { count: "exact", head: true })
          .eq("project_id", id)
          .in("status", ["open", "in_progress"]);

        const lines = [
          `Name: ${project.name}`,
          `ID: ${project.id}`,
          `Type: ${project.type || "—"}`,
          `Description: ${project.description || "—"}`,
        ];
        if (parentName) lines.push(`Parent: ${parentName} (${project.parent_id})`);
        if (children && children.length > 0) {
          lines.push(`Children: ${children.map(c => `${c.name} (${c.type || "—"})`).join(", ")}`);
        }
        lines.push(`Open tasks: ${taskCount || 0}`);
        lines.push(`Created: ${new Date(project.created_at).toLocaleDateString()}`);
        lines.push(`Updated: ${new Date(project.updated_at).toLocaleDateString()}`);
        if (project.archived_at)
          lines.push(`Archived: ${new Date(project.archived_at).toLocaleDateString()}`);

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

  server.registerTool(
    "update_project",
    {
      title: "Update Project",
      description:
        "Update a project's name, type, parent, or description. " +
        "IMPORTANT: When the user mentions facts about a project — client name, location, purpose, key people, deadlines, or any contextual detail — " +
        "proactively call this tool to store that information in the project's description. " +
        "This makes the project self-documenting so that any AI querying it later has the full picture without needing to search through individual thoughts. " +
        "Append to the existing description rather than replacing it, unless the user is correcting outdated information.",
      inputSchema: {
        id: z.string().describe("Project UUID"),
        name: z.string().optional().describe("New name"),
        type: z.string().optional().describe("New type"),
        parent_id: z.string().nullable().optional().describe("New parent UUID, or null to remove parent"),
        description: z.string().optional().describe("New or updated description — include client name, purpose, location, key contacts, or any context. Append to existing description unless correcting outdated info"),
      },
    },
    withMcpLogging("update_project", async ({ id, name, type, parent_id, description }) => {
      try {
        const updates: Record<string, unknown> = {};
        if (name !== undefined) updates.name = name;
        if (type !== undefined) updates.type = type;
        if (parent_id !== undefined) updates.parent_id = parent_id;
        if (description !== undefined) updates.description = description;

        if (Object.keys(updates).length === 0) {
          return { content: [{ type: "text" as const, text: "No fields to update." }] };
        }

        const { error } = await supabase
          .from("projects")
          .update(updates)
          .eq("id", id);

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Update failed: ${error.message}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Project ${id} updated: ${Object.keys(updates).join(", ")}` }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    }, logger)
  );

  server.registerTool(
    "archive_project",
    {
      title: "Archive Project",
      description:
        "Archive a project, recursively archiving all child projects and their open tasks. " +
        "Archived projects are hidden from default list_projects results but not deleted — they can still be queried with include_archived. " +
        "Use this when a project is complete, cancelled, or no longer relevant. This is a significant action — confirm with the user before archiving.",
      inputSchema: {
        id: z.string().describe("Project UUID to archive"),
      },
    },
    withMcpLogging("archive_project", async ({ id }) => {
      try {
        // Get the project name
        const { data: project, error: fetchErr } = await supabase
          .from("projects")
          .select("name")
          .eq("id", id)
          .single();

        if (fetchErr || !project) {
          return {
            content: [{ type: "text" as const, text: `Project not found: ${fetchErr?.message || "unknown"}` }],
            isError: true,
          };
        }

        // Recursively collect all descendant project IDs
        const allProjectIds: string[] = [id];
        let frontier = [id];
        while (frontier.length > 0) {
          const { data: kids } = await supabase
            .from("projects")
            .select("id")
            .in("parent_id", frontier)
            .is("archived_at", null);

          frontier = (kids || []).map(k => k.id);
          allProjectIds.push(...frontier);
        }

        const childCount = allProjectIds.length - 1;

        // Archive all projects
        const { error: archiveErr } = await supabase
          .from("projects")
          .update({ archived_at: new Date().toISOString() })
          .in("id", allProjectIds)
          .is("archived_at", null);

        if (archiveErr) throw new Error(`Archive projects failed: ${archiveErr.message}`);

        // Archive open tasks for all these projects
        const { data: tasks } = await supabase
          .from("tasks")
          .select("id")
          .in("project_id", allProjectIds)
          .is("archived_at", null)
          .in("status", ["open", "in_progress"]);

        let taskCount = 0;
        if (tasks && tasks.length > 0) {
          const taskIds = tasks.map(t => t.id);
          const { error: taskErr } = await supabase
            .from("tasks")
            .update({ archived_at: new Date().toISOString() })
            .in("id", taskIds);

          if (taskErr) throw new Error(`Archive tasks failed: ${taskErr.message}`);
          taskCount = tasks.length;
        }

        const parts = [`Archived project "${project.name}"`];
        if (childCount > 0) parts.push(`${childCount} child project${childCount > 1 ? "s" : ""}`);
        if (taskCount > 0) parts.push(`${taskCount} task${taskCount > 1 ? "s" : ""}`);

        return {
          content: [{ type: "text" as const, text: parts.join(" and ") }],
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
