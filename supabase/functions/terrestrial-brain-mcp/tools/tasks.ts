import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";
import { FunctionCallLogger, withMcpLogging } from "../logger.ts";
import { writeVaultNote } from "../helpers.ts";

export function register(server: McpServer, supabase: SupabaseClient, logger: FunctionCallLogger) {
  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description:
        "Create a single task, optionally linked to a project and/or assigned to a person. " +
        "Use this for ad-hoc tasks the user mentions in conversation. " +
        "Use assigned_to with a person UUID to assign the task (use list_people to find person IDs). " +
        "For creating multiple related tasks at once (e.g. a sprint plan or checklist), prefer create_tasks_with_output — " +
        "it creates structured task rows AND delivers a markdown checklist to the user's Obsidian vault in one call.",
      inputSchema: {
        content: z.string().describe("Task description"),
        project_id: z.string().optional().describe("UUID of the project this task belongs to"),
        parent_id: z.string().optional().describe("UUID of parent task for sub-tasks"),
        due_by: z.string().optional().describe("Due date as ISO 8601 string"),
        status: z.string().optional().default("open").describe("Status: open, in_progress, done, deferred"),
        assigned_to: z.string().optional().describe("UUID of the person this task is assigned to"),
      },
    },
    withMcpLogging("create_task", async ({ content, project_id, parent_id, due_by, status, assigned_to }) => {
      try {
        const { data, error } = await supabase
          .from("tasks")
          .insert({
            content,
            status: status || "open",
            project_id: project_id || null,
            parent_id: parent_id || null,
            due_by: due_by || null,
            assigned_to: assigned_to || null,
          })
          .select("id")
          .single();

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Failed to create task: ${error.message}` }],
            isError: true,
          };
        }

        await writeVaultNote("task", content, { type: "task" });

        return {
          content: [{ type: "text" as const, text: `Created task (id: ${data.id}): "${content}"` }],
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
    "list_tasks",
    {
      title: "List Tasks",
      description:
        "List tasks with optional filters. Common uses: " +
        "filter by project_id to see a project's task list, " +
        "filter by status='open' to see what needs doing, " +
        "set overdue_only=true to find tasks past their due date. " +
        "Results include project names and assigned person names for context.",
      inputSchema: {
        project_id: z.string().optional().describe("Filter by project UUID"),
        status: z.string().optional().describe("Filter by status: open, in_progress, done, deferred"),
        overdue_only: z.boolean().optional().default(false).describe("Only show overdue tasks"),
        include_archived: z.boolean().optional().default(false).describe("Include archived tasks"),
        limit: z.number().optional().default(20).describe("Max results"),
      },
    },
    withMcpLogging("list_tasks", async ({ project_id, status, overdue_only, include_archived, limit }) => {
      try {
        let q = supabase
          .from("tasks")
          .select("id, content, status, due_by, project_id, assigned_to, archived_at, created_at")
          .order("created_at", { ascending: false })
          .limit(limit);

        if (!include_archived) q = q.is("archived_at", null);
        if (project_id) q = q.eq("project_id", project_id);
        if (status) q = q.eq("status", status);
        if (overdue_only) {
          q = q.lt("due_by", new Date().toISOString()).neq("status", "done");
        }

        const { data, error } = await q;

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }

        if (!data || data.length === 0) {
          return { content: [{ type: "text" as const, text: "No tasks found." }] };
        }

        // Get project names
        const projectIds = [...new Set(data.filter(t => t.project_id).map(t => t.project_id))];
        let projectMap: Record<string, string> = {};
        if (projectIds.length > 0) {
          const { data: projects } = await supabase
            .from("projects")
            .select("id, name")
            .in("id", projectIds);
          projectMap = Object.fromEntries((projects || []).map(p => [p.id, p.name]));
        }

        // Get assigned person names
        const personIds = [...new Set(data.filter(t => t.assigned_to).map(t => t.assigned_to))];
        let personMap: Record<string, string> = {};
        if (personIds.length > 0) {
          const { data: people } = await supabase
            .from("people")
            .select("id, name")
            .in("id", personIds);
          personMap = Object.fromEntries((people || []).map(p => [p.id, p.name]));
        }

        const lines = data.map((t, i) => {
          const statusIcon = t.status === "done" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
          const parts = [`${i + 1}. ${statusIcon} ${t.content}`];
          parts.push(`   ID: ${t.id} | Status: ${t.status}`);
          if (t.project_id && projectMap[t.project_id])
            parts.push(`   Project: ${projectMap[t.project_id]}`);
          if (t.assigned_to && personMap[t.assigned_to])
            parts.push(`   Assigned to: ${personMap[t.assigned_to]}`);
          if (t.due_by) {
            const due = new Date(t.due_by);
            const overdue = due < new Date() && t.status !== "done";
            parts.push(`   Due: ${due.toLocaleDateString()}${overdue ? " (OVERDUE)" : ""}`);
          }
          return parts.join("\n");
        });

        return {
          content: [{ type: "text" as const, text: `${data.length} task(s):\n\n${lines.join("\n\n")}` }],
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
    "update_task",
    {
      title: "Update Task",
      description:
        "Update a task's content, status, due date, project assignment, or person assignment. " +
        "Setting status to 'done' automatically archives the task. " +
        "When the user says they finished something, started working on something, or wants to defer a task, use this to update the status accordingly. " +
        "Valid statuses: 'open' (not started), 'in_progress' (actively working), 'done' (completed, auto-archives), 'deferred' (postponed).",
      inputSchema: {
        id: z.string().describe("Task UUID"),
        content: z.string().optional().describe("New task description"),
        status: z.string().optional().describe("New status: open, in_progress, done, deferred"),
        due_by: z.string().nullable().optional().describe("New due date (ISO 8601), or null to clear"),
        project_id: z.string().nullable().optional().describe("New project UUID, or null to unlink"),
        assigned_to: z.string().nullable().optional().describe("Person UUID to assign, or null to unassign"),
      },
    },
    withMcpLogging("update_task", async ({ id, content, status, due_by, project_id, assigned_to }) => {
      try {
        const updates: Record<string, unknown> = {};
        if (content !== undefined) updates.content = content;
        if (status !== undefined) updates.status = status;
        if (due_by !== undefined) updates.due_by = due_by;
        if (project_id !== undefined) updates.project_id = project_id;
        if (assigned_to !== undefined) updates.assigned_to = assigned_to;

        // Auto-archive when marked done
        if (status === "done") {
          updates.archived_at = new Date().toISOString();
        }

        if (Object.keys(updates).length === 0) {
          return { content: [{ type: "text" as const, text: "No fields to update." }] };
        }

        const { error } = await supabase
          .from("tasks")
          .update(updates)
          .eq("id", id);

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Update failed: ${error.message}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Task ${id} updated: ${Object.keys(updates).join(", ")}` }],
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
    "archive_task",
    {
      title: "Archive Task",
      description:
        "Archive a task without changing its status. " +
        "Use this to hide tasks that are no longer relevant but weren't completed (e.g. cancelled or superseded). " +
        "For tasks the user actually finished, prefer update_task with status='done' — that both marks completion and archives in one step.",
      inputSchema: {
        id: z.string().describe("Task UUID to archive"),
      },
    },
    withMcpLogging("archive_task", async ({ id }) => {
      try {
        const { error } = await supabase
          .from("tasks")
          .update({ archived_at: new Date().toISOString() })
          .eq("id", id);

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Archive failed: ${error.message}` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text" as const, text: `Task ${id} archived.` }],
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
    "get_tasks",
    {
      title: "Get Tasks by ID",
      description:
        "Retrieve one or more tasks by their UUIDs. Returns full task details including " +
        "resolved project name, assigned person name, parent task content, and overdue detection. " +
        "Use this when you already have task IDs (e.g. from create_task, get_project_summary, or prior conversation) " +
        "and need to check their current state. Archived tasks are included — if you ask for an ID, you get it.",
      inputSchema: {
        ids: z.array(z.string()).describe("Array of task UUIDs to retrieve (max 50)"),
      },
    },
    withMcpLogging("get_tasks", async ({ ids }) => {
      try {
        if (ids.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Error: At least one task ID is required." }],
            isError: true,
          };
        }

        if (ids.length > 50) {
          return {
            content: [{ type: "text" as const, text: "Error: Maximum 50 task IDs per request." }],
            isError: true,
          };
        }

        const { data, error } = await supabase
          .from("tasks")
          .select("id, content, status, due_by, project_id, parent_id, assigned_to, archived_at, created_at")
          .in("id", ids);

        if (error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }

        const foundIds = new Set((data || []).map((task: { id: string }) => task.id));
        const missingIds = ids.filter((requestedId: string) => !foundIds.has(requestedId));

        if (!data || data.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No tasks found. Missing IDs: ${missingIds.join(", ")}` }],
          };
        }

        // Batch-resolve project names
        const projectIds = [...new Set(data.filter(task => task.project_id).map(task => task.project_id))];
        let projectMap: Record<string, string> = {};
        if (projectIds.length > 0) {
          const { data: projects } = await supabase
            .from("projects")
            .select("id, name")
            .in("id", projectIds);
          projectMap = Object.fromEntries((projects || []).map(project => [project.id, project.name]));
        }

        // Batch-resolve assigned person names
        const personIds = [...new Set(data.filter(task => task.assigned_to).map(task => task.assigned_to))];
        let personMap: Record<string, string> = {};
        if (personIds.length > 0) {
          const { data: people } = await supabase
            .from("people")
            .select("id, name")
            .in("id", personIds);
          personMap = Object.fromEntries((people || []).map(person => [person.id, person.name]));
        }

        // Batch-resolve parent task content
        const parentIds = [...new Set(data.filter(task => task.parent_id).map(task => task.parent_id))];
        let parentMap: Record<string, string> = {};
        if (parentIds.length > 0) {
          const { data: parents } = await supabase
            .from("tasks")
            .select("id, content")
            .in("id", parentIds);
          parentMap = Object.fromEntries((parents || []).map(parent => [parent.id, parent.content]));
        }

        const lines = data.map((task, index) => {
          const statusIcon = task.status === "done" ? "[x]" : task.status === "in_progress" ? "[~]" : "[ ]";
          const parts = [`${index + 1}. ${statusIcon} ${task.content}`];
          parts.push(`   ID: ${task.id} | Status: ${task.status}`);
          if (task.project_id && projectMap[task.project_id])
            parts.push(`   Project: ${projectMap[task.project_id]}`);
          if (task.assigned_to && personMap[task.assigned_to])
            parts.push(`   Assigned to: ${personMap[task.assigned_to]}`);
          if (task.parent_id && parentMap[task.parent_id])
            parts.push(`   Parent task: ${parentMap[task.parent_id]}`);
          if (task.due_by) {
            const due = new Date(task.due_by);
            const overdue = due < new Date() && task.status !== "done";
            parts.push(`   Due: ${due.toLocaleDateString()}${overdue ? " (OVERDUE)" : ""}`);
          }
          if (task.archived_at)
            parts.push(`   Archived: ${new Date(task.archived_at).toLocaleDateString()}`);
          return parts.join("\n");
        });

        let result = `${data.length} task(s):\n\n${lines.join("\n\n")}`;
        if (missingIds.length > 0) {
          result += `\n\nNot found (${missingIds.length}): ${missingIds.join(", ")}`;
        }

        return {
          content: [{ type: "text" as const, text: result }],
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
