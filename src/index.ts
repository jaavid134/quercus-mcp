import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { canvasDownload, canvasGet, canvasGetOne } from "./canvas.js";

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

// --- read_file --------------------------------------------------------------
// get_file_download_url only returns a link, and that link needs the Quercus token,
// so the model cannot open it. read_file downloads the file here and returns what
// is inside it: PDF text page by page, text-like files as text, images as images.

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 40_000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "rst", "tex", "bib", "csv", "tsv", "json", "xml", "yaml", "yml", "toml", "ini", "log",
  "html", "htm", "css", "js", "mjs", "ts", "py", "ipynb", "r", "m", "java", "c", "h", "cpp", "hpp", "cc", "cs",
  "sql", "sh", "v", "sv", "vhd", "sp", "cir", "asm", "s", "mod", "dat", "lp",
]);
const TEXT_MIME_TYPES = new Set([
  "application/json", "application/xml", "application/javascript", "application/x-ipynb+json",
  "application/x-sh", "application/x-python", "application/sql", "application/x-tex",
]);
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Turns "3", "1-10", "5-" or "2,4,8-12" into sorted page numbers within 1..total. No spec means every page. */
function parsePages(spec: string | undefined, total: number): number[] {
  if (!spec || !spec.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^\s*(\d+)?\s*(-)?\s*(\d+)?\s*$/.exec(part);
    if (!m || (!m[1] && !m[3])) {
      throw new Error(`could not read page range "${part.trim()}". Use forms like "3", "1-10", "5-" or "2,4,8-12".`);
    }
    const start = m[1] ? Number(m[1]) : 1;
    const end = m[2] ? (m[3] ? Number(m[3]) : total) : start;
    for (let p = Math.max(1, start); p <= Math.min(end, total); p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** [1,2,3,7,9,10] -> "1-3, 7, 9-10" */
function describePages(pages: number[]): string {
  const ranges: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i];
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) i++;
    ranges.push(start === pages[i] ? `${start}` : `${start}-${pages[i]}`);
  }
  return ranges.join(", ");
}

async function readPdf(bytes: Uint8Array, pagesSpec: string | undefined, maxChars: number) {
  let unpdf: typeof import("unpdf");
  try {
    unpdf = await import("unpdf");
  } catch (err) {
    throw new Error(
      "PDF reading needs the 'unpdf' package and Node.js 22 or newer. Run `npm install` in the quercus-mcp folder. " +
        `(${(err as Error).message})`
    );
  }

  const pdf = await unpdf.getDocumentProxy(bytes);
  try {
    const total = pdf.numPages;
    const wanted = parsePages(pagesSpec, total);
    const returned: number[] = [];
    const parts: string[] = [];
    const notes: string[] = [];
    let used = 0;
    let empty = 0;

    for (const n of wanted) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let text = content.items
        .map((item: any) => (typeof item.str === "string" ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (returned.length > 0 && used + text.length > maxChars) {
        notes.push(
          `Stopped before page ${n} to keep the reply a manageable size. ` +
            `Call read_file again with pages "${n}-" to continue.`
        );
        break;
      }
      if (text.length > maxChars) {
        text = text.slice(0, maxChars) + "\n[page cut off at the max_chars limit]";
      }
      if (!text) empty++;
      parts.push(`--- Page ${n} ---\n${text || "(no extractable text on this page)"}`);
      used += text.length;
      returned.push(n);
    }

    if (wanted.length === 0) {
      notes.push(`No pages matched "${pagesSpec}"; this PDF has ${total} page(s).`);
    } else if (empty === returned.length) {
      notes.push(
        "No text could be extracted. These pages are probably scans, handwriting or pictures, " +
          "which this tool cannot read as text."
      );
    } else if (empty > 0) {
      notes.push(`${empty} of the returned pages had no extractable text (likely scans, handwriting or pictures).`);
    }

    return { total, returned, notes, text: parts.join("\n\n") };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Keeps a notebook's cell sources and text outputs, dropping embedded images and metadata. */
function notebookToText(raw: string): string | null {
  try {
    const nb = JSON.parse(raw);
    if (!Array.isArray(nb?.cells)) return null;
    const join = (v: unknown) => (Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "");
    const out: string[] = [];
    nb.cells.forEach((cell: any, i: number) => {
      out.push(`--- Cell ${i + 1} [${cell.cell_type}] ---\n${join(cell.source)}`);
      for (const o of cell.outputs ?? []) {
        const text = join(o.text) || join(o.data?.["text/plain"]) || (o.ename ? `${o.ename}: ${o.evalue}` : "");
        if (text) out.push(`[output]\n${text.trimEnd()}`);
      }
    });
    return out.join("\n\n");
  } catch {
    return null;
  }
}

server.registerTool(
  "read_file",
  {
    title: "Read a file's contents",
    description:
      "Download a Quercus file and return what is inside it, so lecture slides, labs and handouts can be read directly. " +
      "PDFs come back as text, page by page (use `pages`, e.g. \"1-10\", for long decks). Text, code, CSV, HTML and " +
      "Jupyter notebooks come back as text. PNG, JPEG, GIF and WebP images come back as images. " +
      "Get file IDs from list_files. Scanned or handwritten PDFs have no text to extract, and the result says so.",
    inputSchema: {
      file_id: z.string(),
      course_id: z
        .string()
        .optional()
        .describe("Course the file belongs to. Helps when a file can only be looked up through its course."),
      pages: z
        .string()
        .optional()
        .describe('PDF pages to return: "3", "1-10", "5-" or "2,4,8-12". Default: from page 1, as many as fit.'),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .max(200_000)
        .optional()
        .describe(`Upper limit on returned text. Default ${DEFAULT_MAX_CHARS}.`),
    },
  },
  async ({ file_id, course_id, pages, max_chars }) => {
    const maxChars = max_chars ?? DEFAULT_MAX_CHARS;
    const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

    const file =
      (course_id ? await tryGet(() => canvasGetOne<any>(`/courses/${course_id}/files/${file_id}`)) : null) ??
      (await tryGet(() => canvasGetOne<any>(`/files/${file_id}`)));
    if (!file) {
      return fail(
        `File ${file_id} was not found or is not available to you.` +
          (course_id ? "" : " If you know which course it belongs to, pass course_id as well.")
      );
    }

    const name: string = file.display_name ?? file.filename ?? `file ${file_id}`;
    if (!file.url) {
      return fail(`"${name}" is locked${file.lock_explanation ? `: ${file.lock_explanation}` : " and cannot be downloaded right now."}`);
    }
    if (typeof file.size === "number" && file.size > MAX_DOWNLOAD_BYTES) {
      return fail(`"${name}" is ${formatSize(file.size)}, over the ${formatSize(MAX_DOWNLOAD_BYTES)} limit for read_file.`);
    }

    let bytes: Uint8Array;
    let servedType: string | null;
    try {
      ({ bytes, contentType: servedType } = await canvasDownload(file.url, MAX_DOWNLOAD_BYTES));
    } catch (err) {
      return fail(`Could not download "${name}": ${(err as Error).message}`);
    }

    const ext = extensionOf(name);
    const mime = String(file["content-type"] ?? servedType ?? "").split(";")[0].trim().toLowerCase();
    const heading = `File: ${name} (${mime || ext || "unknown type"}, ${formatSize(bytes.byteLength)})`;
    const looksLikePdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;

    // PDF
    if (mime === "application/pdf" || ext === "pdf" || looksLikePdf) {
      let pdf;
      try {
        pdf = await readPdf(bytes, pages, maxChars);
      } catch (err) {
        return fail(`Could not read "${name}" as a PDF: ${(err as Error).message}`);
      }
      const lines = [
        heading,
        `Pages: ${pdf.total} total; returned ${pdf.returned.length ? describePages(pdf.returned) : "none"}`,
        ...pdf.notes.map((n) => `Note: ${n}`),
      ];
      return { content: [{ type: "text", text: `${lines.join("\n")}\n\n${pdf.text}`.trimEnd() }] };
    }

    // Images
    const imageMime = mime.startsWith("image/") ? mime : IMAGE_MIME_BY_EXTENSION[ext];
    if (imageMime && Object.values(IMAGE_MIME_BY_EXTENSION).includes(imageMime)) {
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return fail(`"${name}" is a ${formatSize(bytes.byteLength)} image, over the ${formatSize(MAX_IMAGE_BYTES)} limit for read_file.`);
      }
      return {
        content: [
          { type: "text", text: heading },
          { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: imageMime },
        ],
      };
    }

    // Text-like files
    if (mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime) || TEXT_EXTENSIONS.has(ext)) {
      let text = new TextDecoder("utf-8").decode(bytes);
      if (ext === "ipynb" || mime === "application/x-ipynb+json") text = notebookToText(text) ?? text;
      const lines = [heading];
      if (text.length > maxChars) {
        lines.push(
          `Note: showing the first ${maxChars} of ${text.length} characters. Pass a larger max_chars (up to 200000) for more.`
        );
        text = text.slice(0, maxChars);
      }
      return { content: [{ type: "text", text: `${lines.join("\n")}\n\n${text}` }] };
    }

    return fail(
      `${heading}\nread_file cannot open this type yet. It reads PDFs, text-like files (code, CSV, HTML, notebooks) and images.`
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
