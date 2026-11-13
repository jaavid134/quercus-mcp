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

// --- list_files -------------------------------------------------------------
// Most Quercus courses hide the Files tab, so /courses/:id/files returns 403.
// The material is still reachable three ways, and this tool reads all of them:
//   1. the Files index (when the instructor leaves it open)
//   2. File items inside Modules
//   3. file links written into page bodies and the syllabus
// Per-file lookups stay authorised even when the index is not.

const FILE_LINK = /\/(?:courses\/(\d+)\/)?files\/(\d+)/g;

async function tryGet<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function slimFile(f: any, found_via: string, module?: string) {
  return {
    id: f.id,
    display_name: f.display_name ?? f.filename,
    size: f.size,
    "content-type": f["content-type"],
    mime_class: f.mime_class,
    updated_at: f.updated_at,
    locked_for_user: f.locked_for_user,
    url: f.url,
    found_via,
    ...(module ? { module } : {}),
  };
}

server.registerTool(
  "list_files",
  {
    title: "List course files",
    description:
      "List files available in a Quercus course. Works even when the course's Files tab is hidden: " +
      "also collects files published through Modules and files linked from pages and the syllabus. " +
      "Each file's `found_via` says where it came from (files_index, module, page_link, syllabus_link).",
    inputSchema: {
      course_id: z.string(),
    },
  },
  async ({ course_id }) => {
    const found = new Map<string, ReturnType<typeof slimFile>>();
    const notes: string[] = [];

    // 1. Files index
    const index = await tryGet(() =>
      canvasGet<any>(`/courses/${course_id}/files`, { params: { per_page: 100 }, maxPages: 20 })
    );
    if (index) {
      for (const f of index) found.set(String(f.id), slimFile(f, "files_index"));
    } else {
      notes.push("Files tab is hidden for this course; used modules and page links instead.");
    }

    // 2. Modules
    const modules =
      (await tryGet(() =>
        canvasGet<any>(`/courses/${course_id}/modules`, {
          params: { include: ["items"], per_page: 100 },
          maxPages: 20,
        })
      )) ?? [];

    const fileItems: { id: string; module: string }[] = [];
    const pageSlugs = new Set<string>();
    for (const mod of modules) {
      // Canvas leaves `items` out when a module has too many; fetch them directly.
      let items: any[] | null = mod.items ?? null;
      if (!items) {
        items = await tryGet(() =>
          canvasGet<any>(`/courses/${course_id}/modules/${mod.id}/items`, {
            params: { per_page: 100 },
            maxPages: 20,
          })
        );
      }
      for (const item of items ?? []) {
        if (item.type === "File" && item.content_id != null) {
          fileItems.push({ id: String(item.content_id), module: mod.name });
        } else if (item.type === "Page" && item.page_url) {
          pageSlugs.add(item.page_url);
        }
      }
    }

    // 3. Page bodies and the syllabus
    const linked: { id: string; owner: string; via: string }[] = [];
    const scan = (html: string | null | undefined, via: string) => {
      for (const m of (html ?? "").matchAll(FILE_LINK)) {
        linked.push({ id: m[2], owner: m[1] ?? course_id, via });
      }
    };

    const pageIndex = await tryGet(() =>
      canvasGet<any>(`/courses/${course_id}/pages`, { params: { per_page: 100 }, maxPages: 20 })
    );
    for (const p of pageIndex ?? []) if (p.url) pageSlugs.add(p.url);
    const front = await tryGet(() => canvasGetOne<any>(`/courses/${course_id}/front_page`));
    if (front) scan(front.body, "page_link");

    const pages = await mapLimit([...pageSlugs], 6, (slug) =>
      tryGet(() => canvasGetOne<any>(`/courses/${course_id}/pages/${encodeURIComponent(slug)}`))
    );
    for (const p of pages) if (p) scan(p.body, "page_link");

    const course = await tryGet(() =>
      canvasGetOne<any>(`/courses/${course_id}`, { params: { include: ["syllabus_body"] } })
    );
    if (course) scan(course.syllabus_body, "syllabus_link");

    // Resolve everything not already known from the index.
    const pending = new Map<string, { owner: string; via: string; module?: string }>();
    for (const it of fileItems) {
      if (!found.has(it.id) && !pending.has(it.id)) {
        pending.set(it.id, { owner: course_id, via: "module", module: it.module });
      }
    }
    for (const l of linked) {
      if (!found.has(l.id) && !pending.has(l.id)) pending.set(l.id, { owner: l.owner, via: l.via });
    }

    let unavailable = 0;
    await mapLimit([...pending.entries()], 6, async ([fid, info]) => {
      const obj =
        (await tryGet(() => canvasGetOne<any>(`/courses/${info.owner}/files/${fid}`))) ??
        (await tryGet(() => canvasGetOne<any>(`/files/${fid}`)));
      if (obj) found.set(fid, slimFile(obj, info.via, info.module));
      else unavailable++;
    });
    if (unavailable) notes.push(`${unavailable} linked file(s) were locked or unavailable and were skipped.`);

    const files = [...found.values()];
    const result = { course_id, count: files.length, notes, files };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
