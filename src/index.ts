import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { strFromU8, unzipSync } from "fflate";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

// --- read_file / download_file ----------------------------------------------
// get_file_download_url only returns a link, and that link needs the Quercus token,
// so the model cannot open it. read_file downloads the file here and returns what
// is inside it: PDF text page by page, PowerPoint text slide by slide, Word text,
// text-like files as text, images as images. download_file is the fallback for
// anything read_file cannot open or cannot show: it saves the file to this computer.

const MB = 1024 * 1024;
const MAX_READ_BYTES = 50 * MB;
const MAX_SAVE_BYTES = 250 * MB;
const MAX_IMAGE_BYTES = 4 * MB;
const MAX_ZIP_ENTRY_BYTES = 30 * MB;
const MAX_ZIP_TOTAL_BYTES = 150 * MB;
const DEFAULT_MAX_CHARS = 40_000;

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}
const DOWNLOAD_DIR = path.resolve(expandHome(process.env.QUERCUS_DOWNLOAD_DIR?.trim() || "~/quercus-downloads"));

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
const PPTX_EXTENSIONS = new Set(["pptx", "pptm", "ppsx", "ppsm", "potx"]);
const DOCX_EXTENSIONS = new Set(["docx", "docm", "dotx"]);
const OLD_OFFICE_EXTENSIONS = new Set(["ppt", "pps", "doc", "dot"]);

const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(name);
  return match ? match[1].toLowerCase() : "";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Finds a file's metadata, through its course first when the course is known. */
async function lookUpFile(file_id: string, course_id?: string): Promise<{ file: any; name: string } | { error: string }> {
  const file =
    (course_id ? await tryGet(() => canvasGetOne<any>(`/courses/${course_id}/files/${file_id}`)) : null) ??
    (await tryGet(() => canvasGetOne<any>(`/files/${file_id}`)));
  if (!file) {
    return {
      error:
        `File ${file_id} was not found or is not available to you.` +
        (course_id ? "" : " If you know which course it belongs to, pass course_id as well."),
    };
  }
  const name: string = file.display_name ?? file.filename ?? `file ${file_id}`;
  if (!file.url) {
    return {
      error: `"${name}" is locked${file.lock_explanation ? `: ${file.lock_explanation}` : " and cannot be downloaded right now."}`,
    };
  }
  return { file, name };
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

interface PagedResult {
  unit: "Pages" | "Slides";
  total: number;
  returned: number[];
  notes: string[];
  text: string;
}

/** Collects numbered units (PDF pages, slides) in order until the character budget is used up. */
async function collectUnits(
  label: "Page" | "Slide",
  wanted: number[],
  maxChars: number,
  getText: (n: number) => Promise<string> | string
) {
  const returned: number[] = [];
  const parts: string[] = [];
  const notes: string[] = [];
  let used = 0;
  let empty = 0;

  for (const n of wanted) {
    let text = await getText(n);
    if (returned.length > 0 && used + text.length > maxChars) {
      notes.push(
        `Stopped before ${label.toLowerCase()} ${n} to keep the reply a manageable size. ` +
          `Call read_file again with pages "${n}-" to continue.`
      );
      break;
    }
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n[${label.toLowerCase()} cut off at the max_chars limit]`;
    }
    if (!text) empty++;
    parts.push(`--- ${label} ${n} ---\n${text || `(no extractable text on this ${label.toLowerCase()})`}`);
    used += text.length;
    returned.push(n);
  }
  return { returned, notes, empty, text: parts.join("\n\n") };
}

async function readPdf(bytes: Uint8Array, pagesSpec: string | undefined, maxChars: number): Promise<PagedResult> {
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
    const { returned, notes, empty, text } = await collectUnits("Page", wanted, maxChars, async (n) => {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      return content.items
        .map((item: any) => (typeof item.str === "string" ? item.str + (item.hasEOL ? "\n" : "") : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    });

    if (wanted.length === 0) {
      notes.push(`No pages matched "${pagesSpec}"; this PDF has ${plural(total, "page")}.`);
    } else if (empty === returned.length) {
      notes.push(
        "No text could be extracted. These pages are probably scans, handwriting or pictures, which this tool " +
          "cannot read as text. Use download_file to save the PDF to this computer and open it from there."
      );
    } else if (empty > 0) {
      notes.push(`${empty} of the returned pages had no extractable text (likely scans, handwriting or pictures).`);
    }
    return { unit: "Pages", total, returned, notes, text };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

// PowerPoint (.pptx) and Word (.docx) files are zip archives of XML. The text is pulled straight out of
// that XML. Pictures, charts and diagrams are not text, so they are counted and reported instead.

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    if (entity[0] !== "#") return XML_ENTITIES[entity];
    const code = /^#[xX]/.test(entity) ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

/** Office stores a newer and an older version of some content side by side; keep only the newer one. */
function stripFallbacks(xml: string): string {
  return xml.replace(/<mc:Fallback(?:\s[^>]*)?>[\s\S]*?<\/mc:Fallback>/g, "");
}

function tidyLines(lines: string[]): string {
  return lines
    .map((line) => line.replace(/[ \t]+$/gm, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unzipEntries(bytes: Uint8Array, wanted: RegExp): Record<string, Uint8Array> {
  let total = 0;
  return unzipSync(bytes, {
    filter: (entry) => {
      if (!wanted.test(entry.name) || entry.originalSize > MAX_ZIP_ENTRY_BYTES) return false;
      total += entry.originalSize;
      return total <= MAX_ZIP_TOTAL_BYTES;
    },
  });
}

function parseRels(xml: string | undefined, baseDir: string): { id: string; type: string; target: string }[] {
  const rels: { id: string; type: string; target: string }[] = [];
  for (const m of (xml ?? "").matchAll(/<Relationship\b([^>]*)>/g)) {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1])?.[1] ?? "";
    if (attr("TargetMode") === "External") continue;
    const target = decodeXml(attr("Target"));
    rels.push({
      id: attr("Id"),
      type: attr("Type"),
      target: target.startsWith("/") ? target.slice(1) : path.posix.normalize(path.posix.join(baseDir, target)),
    });
  }
  return rels;
}

/** Text of a DrawingML fragment (a slide shape or table): one line per paragraph, table rows as "a | b". */
function drawingText(xml: string): string {
  const lines: string[] = [];
  let para = "";
  let indent = 0;
  let math: string | null = null;
  let row: string[] | null = null;
  let cell: string[] | null = null;

  const endParagraph = () => {
    const text = para.trim() ? "  ".repeat(indent) + para.trim() : "";
    if (cell) {
      if (text) cell.push(text.trim());
    } else {
      lines.push(text);
    }
    para = "";
    indent = 0;
  };

  const TOKEN =
    /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<m:t(?:\s[^>]*)?>([^<]*)<\/m:t>|<(\/?)(a:pPr|a:p|a:br|a:tr|a:tc|m:oMath)(?=[\s>\/])([^>]*?)(\/?)>/g;
  for (const m of xml.matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      para += decodeXml(m[1]);
      continue;
    }
    if (m[2] !== undefined) {
      if (math !== null) math += decodeXml(m[2]);
      else para += decodeXml(m[2]);
      continue;
    }
    const closing = m[3] === "/";
    const selfClosing = m[6] === "/";
    switch (m[4]) {
      case "a:p":
        if (closing || selfClosing) endParagraph();
        break;
      case "a:pPr":
        if (!closing) indent = Math.min(Number(/\blvl="(\d+)"/.exec(m[5])?.[1] ?? 0), 8);
        break;
      case "a:br":
        if (!closing) para += "\n";
        break;
      case "m:oMath":
        if (closing && math !== null) {
          para += `[equation: ${math.trim()}]`;
          math = null;
        } else if (!closing && !selfClosing) {
          math = "";
        }
        break;
      case "a:tc":
        if (closing) {
          row?.push((cell ?? []).join(" / "));
          cell = null;
        } else if (!selfClosing) {
          cell = [];
        }
        break;
      case "a:tr":
        if (closing) {
          if (row) lines.push(row.join(" | "));
          row = null;
        } else if (!selfClosing) {
          row = [];
        }
        break;
    }
  }
  return tidyLines(lines);
}

const SKIPPED_PLACEHOLDERS = /<p:ph\b[^>]*\btype="(?:sldNum|ftr|dt|hdr|sldImg)"/;

/** Text of every shape and table on a slide or notes page, leaving out slide numbers, dates and footers. */
function shapesText(source: string): string {
  const xml = stripFallbacks(source);
  const blocks =
    xml.match(/<p:sp(?=[\s>])[\s\S]*?<\/p:sp>|<p:graphicFrame(?=[\s>])[\s\S]*?<\/p:graphicFrame>/g) ?? [];
  return blocks
    .filter((block) => !SKIPPED_PLACEHOLDERS.test(block))
    .map(drawingText)
    .filter(Boolean)
    .join("\n");
}

async function readPptx(bytes: Uint8Array, pagesSpec: string | undefined, maxChars: number): Promise<PagedResult> {
  const entries = unzipEntries(
    bytes,
    /^ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/[^/]+\.xml|slides\/_rels\/[^/]+\.rels|notesSlides\/[^/]+\.xml)$/
  );
  const xmlOf = (name: string) => (entries[name] ? strFromU8(entries[name]) : undefined);

  // Slide order comes from the presentation part; file names alone are not reliable.
  let order: string[] = [];
  const presentation = xmlOf("ppt/presentation.xml");
  if (presentation) {
    const rels = parseRels(xmlOf("ppt/_rels/presentation.xml.rels"), "ppt");
    for (const m of presentation.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
      const rel = rels.find((r) => r.id === m[1]);
      if (rel && entries[rel.target]) order.push(rel.target);
    }
  }
  if (order.length === 0) {
    const number = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
    order = Object.keys(entries)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => number(a) - number(b));
  }
  if (order.length === 0) throw new Error("no slides were found in it");

  const total = order.length;
  const wanted = parsePages(pagesSpec, total);
  let pictures = 0;
  let textless = 0;

  const { returned, notes, text } = await collectUnits("Slide", wanted, maxChars, (n) => {
    const slidePath = order[n - 1];
    const xml = xmlOf(slidePath) ?? "";
    const dir = path.posix.dirname(slidePath);
    const body = shapesText(xml);
    const notesRel = parseRels(xmlOf(`${dir}/_rels/${path.posix.basename(slidePath)}.rels`), dir).find((r) =>
      r.type.endsWith("/notesSlide")
    );
    const speakerNotes = notesRel ? shapesText(xmlOf(notesRel.target) ?? "") : "";
    const pics = (xml.match(/<p:pic(?=[\s>])/g) ?? []).length;

    if (!body && !speakerNotes) textless++;
    const lines: string[] = [];
    if (/<p:sld\b[^>]*\bshow="0"/.test(xml)) lines.push("(hidden slide)");
    lines.push(body || "(no text on this slide)");
    if (speakerNotes) lines.push(`\n[Speaker notes]\n${speakerNotes}`);
    if (pics) {
      pictures += pics;
      lines.push(`[${plural(pics, "picture")} not shown]`);
    }
    return lines.join("\n");
  });

  if (wanted.length === 0) {
    notes.push(`No slides matched "${pagesSpec}"; this file has ${plural(total, "slide")}.`);
  } else if (textless === returned.length) {
    notes.push(
      "None of the returned slides have any text; they are probably pictures or scans. " +
        "Use download_file to save the file to this computer and open it from there."
    );
  } else if (textless > 0) {
    notes.push(`${textless} of the returned slides have no text (pictures only).`);
  }
  if (pictures > 0) {
    notes.push(
      `${plural(pictures, "picture")} on these slides ${pictures === 1 ? "is" : "are"} not shown, and text inside ` +
        `pictures, charts and diagrams is not included. Use download_file if you need to see ${pictures === 1 ? "it" : "them"}.`
    );
  }
  return { unit: "Slides", total, returned, notes, text };
}

/** Text of a Word document body: headings as "#", list items as "-", table rows as "a | b". */
function wordText(source: string): { text: string; pictures: number } {
  const xml = stripFallbacks(source);
  const lines: string[] = [];
  let para = "";
  let inPara = false;
  let heading = 0;
  let list = false;
  let level = 0;
  let math: string | null = null;
  let pictures = 0;
  let tableDepth = 0;
  let row: string[] | null = null;
  let cell: string[] | null = null;

  const endParagraph = () => {
    if (!inPara) return;
    const body = para.trim();
    const prefix = heading ? "#".repeat(heading) + " " : list ? "  ".repeat(level) + "- " : "";
    const text = body ? prefix + body : "";
    if (cell) {
      if (text) cell.push(text);
    } else {
      lines.push(text);
    }
    para = "";
    inPara = false;
    heading = 0;
    list = false;
    level = 0;
  };

  const TOKEN =
    /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<m:t(?:\s[^>]*)?>([^<]*)<\/m:t>|<(\/?)(w:pStyle|w:p|w:br|w:cr|w:tab|w:tbl|w:tr|w:tc|w:numPr|w:ilvl|w:drawing|m:oMath)(?=[\s>\/])([^>]*?)(\/?)>/g;
  for (const m of xml.matchAll(TOKEN)) {
    if (m[1] !== undefined) {
      para += decodeXml(m[1]);
      continue;
    }
    if (m[2] !== undefined) {
      if (math !== null) math += decodeXml(m[2]);
      else para += decodeXml(m[2]);
      continue;
    }
    const closing = m[3] === "/";
    const attrs = m[5];
    const selfClosing = m[6] === "/";
    switch (m[4]) {
      case "w:p":
        endParagraph(); // also closes an outer paragraph when a text box starts a nested one
        if (!closing) {
          inPara = true;
          if (selfClosing) endParagraph();
        }
        break;
      case "w:pStyle": {
        const style = /w:val="([^"]*)"/.exec(attrs)?.[1] ?? "";
        const h = /^heading\s?([1-9])$/i.exec(style);
        if (h) heading = Number(h[1]);
        else if (/^title$/i.test(style)) heading = 1;
        else if (/^list\s?(bullet|number)/i.test(style)) list = true;
        break;
      }
      case "w:numPr":
        if (!closing) list = true;
        break;
      case "w:ilvl":
        level = Math.min(Number(/w:val="(\d+)"/.exec(attrs)?.[1] ?? 0), 8);
        break;
      case "w:br":
      case "w:cr":
        if (!closing) para += "\n";
        break;
      case "w:tab":
        // <w:tab/> inside a run is a tab character; with attributes it is a tab-stop definition.
        if (!closing && !attrs.trim()) para += "\t";
        break;
      case "w:drawing":
        if (!closing) pictures++;
        break;
      case "m:oMath":
        if (closing && math !== null) {
          para += `[equation: ${math.trim()}]`;
          math = null;
        } else if (!closing && !selfClosing) {
          math = "";
        }
        break;
      case "w:tbl":
        if (closing) {
          tableDepth = Math.max(0, tableDepth - 1);
        } else if (!selfClosing) {
          endParagraph();
          tableDepth++;
        }
        break;
      case "w:tr":
        if (tableDepth !== 1) break; // a nested table's text stays inside its outer cell
        if (closing) {
          if (row) lines.push(row.join(" | "));
          row = null;
        } else if (!selfClosing) {
          row = [];
        }
        break;
      case "w:tc":
        if (tableDepth !== 1) break;
        if (closing) {
          endParagraph();
          row?.push((cell ?? []).join(" / "));
          cell = null;
        } else if (!selfClosing) {
          cell = [];
        }
        break;
    }
  }
  endParagraph();
  return { text: tidyLines(lines), pictures };
}

function readDocx(bytes: Uint8Array): { text: string; pictures: number } {
  const entries = unzipEntries(bytes, /^word\/document\.xml$/);
  const body = entries["word/document.xml"];
  if (!body) throw new Error("no document text was found in it");
  return wordText(strFromU8(body));
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
      "PDFs come back as text page by page, and PowerPoint (.pptx) files as text slide by slide with speaker notes " +
      "(use `pages`, e.g. \"1-10\", for long decks). Word (.docx) files, text, code, CSV, HTML and Jupyter notebooks " +
      "come back as text. PNG, JPEG, GIF and WebP images come back as images. Get file IDs from list_files. " +
      "Pictures, charts and scanned or handwritten pages have no text to extract, and the result says so; " +
      "for those and for any other file type, use download_file instead.",
    inputSchema: {
      file_id: z.string(),
      course_id: z
        .string()
        .optional()
        .describe("Course the file belongs to. Helps when a file can only be looked up through its course."),
      pages: z
        .string()
        .optional()
        .describe(
          'PDF pages or PowerPoint slides to return: "3", "1-10", "5-" or "2,4,8-12". Default: from the start, as many as fit.'
        ),
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

    const found = await lookUpFile(file_id, course_id);
    if ("error" in found) return fail(found.error);
    const { file, name } = found;
    if (typeof file.size === "number" && file.size > MAX_READ_BYTES) {
      return fail(
        `"${name}" is ${formatSize(file.size)}, over the ${formatSize(MAX_READ_BYTES)} limit for read_file. ` +
          "Use download_file to save it to this computer instead."
      );
    }

    let bytes: Uint8Array;
    let servedType: string | null;
    try {
      ({ bytes, contentType: servedType } = await canvasDownload(file.url, MAX_READ_BYTES));
    } catch (err) {
      return fail(`Could not download "${name}": ${(err as Error).message}`);
    }

    const ext = extensionOf(name);
    const mime = String(file["content-type"] ?? servedType ?? "").split(";")[0].trim().toLowerCase();
    const heading = `File: ${name} (${mime || ext || "unknown type"}, ${formatSize(bytes.byteLength)})`;
    const looksLikePdf = bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
    const useDownload = "Use download_file to save it to this computer and open it from there.";

    const paged = (result: PagedResult) => {
      const lines = [
        heading,
        `${result.unit}: ${result.total} total; returned ${result.returned.length ? describePages(result.returned) : "none"}`,
        ...result.notes.map((n) => `Note: ${n}`),
      ];
      return { content: [{ type: "text" as const, text: `${lines.join("\n")}\n\n${result.text}`.trimEnd() }] };
    };
    const plain = (text: string, notes: string[]) => {
      if (text.length > maxChars) {
        notes.push(
          `showing the first ${maxChars} of ${text.length} characters. Pass a larger max_chars (up to 200000) for more.`
        );
        text = text.slice(0, maxChars);
      }
      const lines = [heading, ...notes.map((n) => `Note: ${n}`)];
      return { content: [{ type: "text" as const, text: `${lines.join("\n")}\n\n${text}`.trimEnd() }] };
    };

    // PDF
    if (mime === "application/pdf" || ext === "pdf" || looksLikePdf) {
      try {
        return paged(await readPdf(bytes, pages, maxChars));
      } catch (err) {
        return fail(`Could not read "${name}" as a PDF: ${(err as Error).message}`);
      }
    }

    // PowerPoint
    if (PPTX_EXTENSIONS.has(ext) || mime.includes("presentationml")) {
      try {
        return paged(await readPptx(bytes, pages, maxChars));
      } catch (err) {
        return fail(`Could not read "${name}" as a PowerPoint file: ${(err as Error).message}. ${useDownload}`);
      }
    }

    // Word
    if (DOCX_EXTENSIONS.has(ext) || mime.includes("wordprocessingml")) {
      try {
        const doc = readDocx(bytes);
        const notes: string[] = [];
        if (pages) notes.push("Word files have no fixed pages, so `pages` was ignored.");
        if (doc.pictures > 0) {
          notes.push(
            `${plural(doc.pictures, "picture")} in this document ${doc.pictures === 1 ? "is" : "are"} not shown. ` +
              `Use download_file if you need to see ${doc.pictures === 1 ? "it" : "them"}.`
          );
        }
        if (!doc.text) notes.push(`No text was found in this document. ${useDownload}`);
        return plain(doc.text, notes);
      } catch (err) {
        return fail(`Could not read "${name}" as a Word file: ${(err as Error).message}. ${useDownload}`);
      }
    }

    // Images
    const imageMime = mime.startsWith("image/") ? mime : IMAGE_MIME_BY_EXTENSION[ext];
    if (imageMime && Object.values(IMAGE_MIME_BY_EXTENSION).includes(imageMime)) {
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        return fail(
          `"${name}" is a ${formatSize(bytes.byteLength)} image, over the ${formatSize(MAX_IMAGE_BYTES)} limit for read_file. ${useDownload}`
        );
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
      return plain(text, []);
    }

    if (OLD_OFFICE_EXTENSIONS.has(ext)) {
      return fail(`${heading}\nThis is the older .${ext} format, which read_file cannot open. ${useDownload}`);
    }
    return fail(
      `${heading}\nread_file cannot open this type. It reads PDFs, PowerPoint and Word files, text-like files ` +
        `(code, CSV, HTML, notebooks) and images. ${useDownload}`
    );
  }
);

function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\/\\:<>"|?*\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  if (!cleaned) return "file";
  if (cleaned.length <= 150) return cleaned;
  const ext = extensionOf(cleaned);
  return ext ? `${cleaned.slice(0, 149 - ext.length)}.${ext}` : cleaned.slice(0, 150);
}

server.registerTool(
  "download_file",
  {
    title: "Save a file to this computer",
    description:
      `Save a Quercus file into the downloads folder on this computer (${DOWNLOAD_DIR}) and return where it was saved. ` +
      "Use this when read_file cannot open a file or cannot show what matters in it: scanned or handwritten PDFs, " +
      "slides that are mostly pictures, spreadsheets, archives, older .ppt/.doc files. " +
      "This writes a file to the user's disk and replaces an earlier download of the same file.",
    inputSchema: {
      file_id: z.string().regex(/^\d+$/, "file_id must be a number"),
      course_id: z
        .string()
        .optional()
        .describe("Course the file belongs to. Helps when a file can only be looked up through its course."),
    },
  },
  async ({ file_id, course_id }) => {
    const found = await lookUpFile(file_id, course_id);
    if ("error" in found) return fail(found.error);
    const { file, name } = found;
    if (typeof file.size === "number" && file.size > MAX_SAVE_BYTES) {
      return fail(`"${name}" is ${formatSize(file.size)}, over the ${formatSize(MAX_SAVE_BYTES)} limit for download_file.`);
    }

    let bytes: Uint8Array;
    try {
      ({ bytes } = await canvasDownload(file.url, MAX_SAVE_BYTES));
    } catch (err) {
      return fail(`Could not download "${name}": ${(err as Error).message}`);
    }

    const savedTo = path.join(DOWNLOAD_DIR, `${file_id}-${safeFileName(name)}`);
    if (path.dirname(savedTo) !== DOWNLOAD_DIR) return fail(`Refusing to save "${name}" outside ${DOWNLOAD_DIR}.`);
    try {
      await mkdir(DOWNLOAD_DIR, { recursive: true });
      await writeFile(savedTo, bytes);
    } catch (err) {
      return fail(`Could not save "${name}" to ${DOWNLOAD_DIR}: ${(err as Error).message}`);
    }

    const result = {
      saved_to: savedTo,
      folder: DOWNLOAD_DIR,
      display_name: name,
      "content-type": file["content-type"],
      size: bytes.byteLength,
    };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
