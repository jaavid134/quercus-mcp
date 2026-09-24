# quercus-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude read your University of Toronto **Quercus** courses: assignments, due dates, grades, announcements, files, and modules.

Quercus runs on Canvas LMS, so it also works with **any school that uses Canvas**.

Ask Claude things like:

- "What's due this week across all my courses?"
- "Summarize the latest announcements in MAT188."
- "What's my current grade in CIV100?"
- "Find the lecture slides for week 3 in my calculus course."

## How it works

The server runs locally on your computer and talks to the Canvas REST API with a personal access token that you create. Your token stays on your machine. It is only ever sent to your school's Canvas server, never anywhere else.

Every tool is **read-only**. The server can't submit work, post, or change anything in your account.

## Setup

**Requirements:** Node.js 18 or newer, and Claude Code or Claude Desktop.

### 1. Get a Quercus access token

1. Sign in to [Quercus](https://q.utoronto.ca).
2. Go to **Account → Settings → Approved Integrations**.
3. Click **+ New Access Token**, give it a name like "Claude", and copy the token.

Treat this token like a password. Anyone who has it can read your Quercus account.

### 2. Install and build

```bash
git clone https://github.com/lance-lii/quercus-mcp.git
cd quercus-mcp
npm install
npm run build
```

### 3. Connect it to Claude

**Claude Code:**

```bash
claude mcp add quercus -s user \
  -e QUERCUS_API_TOKEN=<your token> \
  -e QUERCUS_BASE_URL=https://q.utoronto.ca/api/v1 \
  -- node /absolute/path/to/quercus-mcp/dist/index.js
```

Start a new Claude Code session afterwards so it picks up the new tools. Check the connection with `claude mcp get quercus`.

**Claude Desktop:** add this to your `claude_desktop_config.json` and restart the app:

```json
{
  "mcpServers": {
    "quercus": {
      "command": "node",
      "args": ["/absolute/path/to/quercus-mcp/dist/index.js"],
      "env": {
        "QUERCUS_API_TOKEN": "<your token>",
        "QUERCUS_BASE_URL": "https://q.utoronto.ca/api/v1"
      }
    }
  }
}
```

### Using a different Canvas school

Set `QUERCUS_BASE_URL` to your school's Canvas API, for example `https://yourschool.instructure.com/api/v1`, and create the token from that school's Canvas settings page.

## Tools

| Tool | What it does |
|---|---|
| `list_courses` | Your active, completed, or all enrolled courses |
| `list_assignments` | Assignments for a course, optionally filtered (upcoming, overdue, ungraded, and more) |
| `get_course_grades` | Your grade and enrollment info for one course |
| `list_all_grades` | Your grades across all courses |
| `list_announcements` | Announcements for one or more courses |
| `list_todo` | Your Quercus to-do list |
| `list_upcoming_events` | Upcoming events and due dates |
| `list_calendar_events` | Calendar events or assignments in a date range |
| `list_files` | Files in a course |
| `get_file_download_url` | Metadata and an authenticated download link for a file |
| `get_course_modules` | A course's modules and their items |

## Security notes

- Keep your token out of git. `.env` is already in `.gitignore`. Copy `.env.example` to `.env` if you'd rather keep your token in a file.
- If a token leaks, delete it under **Approved Integrations** in Quercus and create a new one.
- Check your school's policies on third-party tools before using this.

## Development

```bash
npm run build   # compile TypeScript to dist/
npm start       # run the server over stdio
```

Source is in `src/`: `canvas.ts` handles the API client and pagination, and `index.ts` defines the tools.

## Disclaimer

This is an independent student project. It isn't affiliated with or endorsed by the University of Toronto or Instructure.

## License

[MIT](LICENSE) © 2026 Lance Li
