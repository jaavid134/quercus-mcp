import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { canvasGet, canvasGetOne } from "./canvas.js";

const server = new McpServer({
  name: "quercus",
  version: "1.0.0",
});

server.registerTool(
  "list_courses",
  {
    title: "List courses",
    description: "List the user's Quercus courses.",
    inputSchema: {
      enrollment_state: z.enum(["active", "completed", "invited_or_pending", "all"]).optional(),
    },
  },
  async ({ enrollment_state }) => {
    const courses = await canvasGet("/courses", {
      params: { enrollment_state: enrollment_state ?? "active", per_page: 100 },
    });
    return { content: [{ type: "text", text: JSON.stringify(courses, null, 2) }] };
  }
);

server.registerTool(
  "list_assignments",
  {
    title: "List assignments for a course",
    description: "List assignments for a given Quercus course, optionally filtered by bucket.",
    inputSchema: {
      course_id: z.string(),
      bucket: z.enum(["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"]).optional(),
    },
  },
  async ({ course_id, bucket }) => {
    const assignments = await canvasGet(`/courses/${course_id}/assignments`, {
      params: { bucket, per_page: 100 },
    });
    return { content: [{ type: "text", text: JSON.stringify(assignments, null, 2) }] };
  }
);

server.registerTool(
  "get_course_grades",
  {
    title: "Get grades for a course",
    description: "Get the current user's grades/enrollment info for a specific course.",
    inputSchema: {
      course_id: z.string(),
    },
  },
  async ({ course_id }) => {
    const enrollments = await canvasGet(`/courses/${course_id}/enrollments`, {
      params: { "user_id": "self" },
    });
    return { content: [{ type: "text", text: JSON.stringify(enrollments, null, 2) }] };
  }
);

server.registerTool(
  "list_all_grades",
  {
    title: "List grades across all courses",
    description: "List the current user's enrollments and grades across all active courses.",
    inputSchema: {},
  },
  async () => {
    const enrollments = await canvasGet("/users/self/enrollments", {
      params: { per_page: 100 },
    });
    return { content: [{ type: "text", text: JSON.stringify(enrollments, null, 2) }] };
  }
);

server.registerTool(
  "list_announcements",
  {
    title: "List announcements",
    description: "List announcements for one or more courses (context_codes like 'course_12345').",
    inputSchema: {
      course_ids: z.array(z.string()).min(1),
    },
  },
  async ({ course_ids }) => {
    const context_codes = course_ids.map((id) => `course_${id}`);
    const announcements = await canvasGet("/announcements", {
      params: { context_codes, per_page: 50 },
    });
    return { content: [{ type: "text", text: JSON.stringify(announcements, null, 2) }] };
  }
);

server.registerTool(
  "list_todo",
  {
    title: "List to-do items",
    description: "List the current user's Quercus to-do items (ungraded submissions, upcoming quizzes, etc.).",
    inputSchema: {},
  },
  async () => {
    const todo = await canvasGet("/users/self/todo", { params: { per_page: 100 } });
    return { content: [{ type: "text", text: JSON.stringify(todo, null, 2) }] };
  }
);

server.registerTool(
  "list_upcoming_events",
  {
    title: "List upcoming events",
    description: "List the current user's upcoming Quercus events and assignment due dates.",
    inputSchema: {},
  },
  async () => {
    const events = await canvasGet("/users/self/upcoming_events");
    return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
  }
);

server.registerTool(
  "list_calendar_events",
  {
    title: "List calendar events",
    description: "List calendar events/assignments in a date range across given course context codes.",
    inputSchema: {
      course_ids: z.array(z.string()).min(1),
      start_date: z.string().describe("ISO date, e.g. 2026-09-01"),
      end_date: z.string().describe("ISO date, e.g. 2026-09-30"),
      type: z.enum(["event", "assignment"]).optional(),
    },
  },
  async ({ course_ids, start_date, end_date, type }) => {
    const context_codes = course_ids.map((id) => `course_${id}`);
    const events = await canvasGet("/calendar_events", {
      params: { context_codes, start_date, end_date, type: type ?? "assignment", per_page: 100 },
    });
    return { content: [{ type: "text", text: JSON.stringify(events, null, 2) }] };
  }
);

server.registerTool(
  "list_files",
  {
    title: "List course files",
    description: "List files available in a Quercus course.",
    inputSchema: {
      course_id: z.string(),
    },
  },
  async ({ course_id }) => {
    const files = await canvasGet(`/courses/${course_id}/files`, { params: { per_page: 100 } });
    return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
  }
);

server.registerTool(
  "get_file_download_url",
  {
    title: "Get a file's download URL",
    description: "Resolve a Quercus file ID to its metadata and authenticated download URL.",
    inputSchema: {
      file_id: z.string(),
    },
  },
  async ({ file_id }) => {
    const file = await canvasGetOne(`/files/${file_id}`);
    return { content: [{ type: "text", text: JSON.stringify(file, null, 2) }] };
  }
);

server.registerTool(
  "get_course_modules",
  {
    title: "List course modules",
    description: "List the modules (and items) for a Quercus course.",
    inputSchema: {
      course_id: z.string(),
    },
  },
  async ({ course_id }) => {
    const modules = await canvasGet(`/courses/${course_id}/modules`, {
      params: { include: ["items"], per_page: 100 },
    });
    return { content: [{ type: "text", text: JSON.stringify(modules, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
