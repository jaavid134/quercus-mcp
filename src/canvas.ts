const BASE_URL = (process.env.QUERCUS_BASE_URL ?? "https://q.utoronto.ca/api/v1").replace(/\/+$/, "");
const BASE_ORIGIN = new URL(BASE_URL).origin;
const TOKEN = process.env.QUERCUS_API_TOKEN;

if (!TOKEN) {
  throw new Error(
    "QUERCUS_API_TOKEN is not set. Generate a token at https://q.utoronto.ca/profile/settings " +
      "(Approved Integrations > New Access Token) and set it in your environment."
  );
}

export interface CanvasRequestOptions {
  params?: Record<string, string | number | string[] | undefined>;
  maxPages?: number;
}

function buildQuery(params: CanvasRequestOptions["params"]): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) search.append(`${key}[]`, v);
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/** Returns the rel="next" URL, but only if it points at the same Canvas host, so the token is never sent elsewhere. */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) {
      try {
        return new URL(match[1]).origin === BASE_ORIGIN ? match[1] : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Calls the Canvas/Quercus REST API, following pagination up to maxPages (default 3). */
export async function canvasGet<T = unknown>(path: string, options: CanvasRequestOptions = {}): Promise<T[]> {
  const maxPages = options.maxPages ?? 3;
  let url = `${BASE_URL}${path}${buildQuery(options.params)}`;
  const results: T[] = [];
  let page = 0;

  while (url && page < maxPages) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Quercus API error ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as T | T[];
    if (Array.isArray(data)) results.push(...data);
    else results.push(data);

    url = parseNextLink(res.headers.get("Link")) ?? "";
    page++;
  }

  return results;
}

export async function canvasGetOne<T = unknown>(path: string, options: CanvasRequestOptions = {}): Promise<T> {
  const url = `${BASE_URL}${path}${buildQuery(options.params)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Quercus API error ${res.status} ${res.statusText} for ${url}: ${body.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export interface DownloadedFile {
  bytes: Uint8Array;
  contentType: string | null;
}

/**
 * Downloads a file's bytes from the `url` Canvas reports for it. Canvas answers with a redirect to its
 * file-storage host, so redirects are followed by hand: the token is only ever sent to the Quercus host.
 */
export async function canvasDownload(fileUrl: string, maxBytes: number): Promise<DownloadedFile> {
  let url = new URL(fileUrl);

  for (let hop = 0; hop < 6; hop++) {
    const sameHost = url.origin === BASE_ORIGIN;
    if (url.protocol !== "https:" && !sameHost) {
      throw new Error(`refusing to download over ${url.protocol}//`);
    }

    const res = await fetch(url, {
      headers: sameHost ? { Authorization: `Bearer ${TOKEN}` } : {},
      redirect: "manual",
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("Location");
      await res.body?.cancel();
      if (!location) throw new Error(`redirect (${res.status}) without a Location header`);
      url = new URL(location, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`${res.status} ${res.statusText}`);
    }

    const tooLarge = () => new Error(`file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
    if (Number(res.headers.get("Content-Length") ?? 0) > maxBytes) {
      await res.body?.cancel();
      throw tooLarge();
    }
    if (!res.body) throw new Error("empty response");

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, contentType: res.headers.get("Content-Type") };
  }

  throw new Error("too many redirects");
}
