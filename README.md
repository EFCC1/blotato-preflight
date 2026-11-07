# Blotato Preflight

Checks a social media post **before** it is sent through [Blotato](https://blotato.com). It then sends the post, follows its status, and explains any failure in plain English with the fix.

Most failed Blotato posts never reach the social platform. They fail because of:

- a bad media link (a Google Drive share link, an expired link, or "403 Forbidden")
- the wrong file format, size or aspect ratio
- a wrong API key

This app catches those problems first.

## What it does

1. You enter a caption and one public image or video link, and tick Instagram, TikTok and/or LinkedIn.
2. **Run Preflight** checks:
   - the link opens
   - it isn't a Google Drive share link
   - it really is an image or video
   - the whole file downloads
   - the format, file size, aspect ratio and caption length suit each platform
   - you have a connected account for each platform
   Every failed check says exactly what is wrong and what to do, with real numbers. For example: "Your image is 3:4 (1200x1600). Instagram accepts 4:5 to 1.91:1 or 9:16. Crop it to 4:5 (1200x1500)."
3. **Post now or schedule.** After preflight passes, choose **Post now** (the default) or **Schedule** (see below).
4. **Send to Blotato** (or **Schedule post**) turns on only when no check has failed. The server enforces this too, not just the button.
5. **Live status** shows Sending, then In progress, then one of these:
   - **Published**, with the post link
   - **Scheduled**, with the date and time in your local time
   - **Failed**, with what it means and how to fix it
   - **Timed out**, after 2 minutes

Platform rules (formats, sizes, ratios, caption limits) live in `platformRules.js`, with the source of each value. Your API key stays on the server: the page never sees it, and the logs show it as `[HIDDEN]`.

## Run it on Windows

You need **Node.js 20.6 or newer** (check with `node --version`). For video checks, you also need **FFmpeg**. Without it, video size checks show "Skipped".

1. Open PowerShell in the project folder.
2. The first time only, install the two packages:
   ```bash
   npm install
   ```
3. The first time only, create your settings file:
   ```bash
   copy .env.example .env
   ```
4. Start the app:
   ```bash
   npm start
   ```
5. Open http://localhost:3000 in your browser. A yellow **MOCK MODE** bar means nothing is really posted.
6. To stop the app, click in PowerShell and press `Ctrl+C`.

If port 3000 is busy, the terminal tells you. Set `PORT=3001` (or any free number) in `.env`, then run `npm start` again.

To run the automated tests, stop the app first, then run:
```bash
npm test
```

## Test each mock scenario

Mock mode uses a fake Blotato built into the app, which answers exactly like the real one.

1. Type a caption.
2. Paste `https://picsum.photos/1080/1350` as the Media URL.
3. Tick all three platforms.
4. Click **Run Preflight**. Send turns on.
5. Pick a **Mock scenario**, then click **Send to Blotato**.
6. To try another scenario, click **Run Preflight** again. Each pass can be used once.

| Scenario | What you should see |
|---|---|
| 1. Success | In progress, then ✓ Published with a fake post link (about 15 seconds) |
| 2. Wrong API key | ✕ Failed at once, with "Copy the key again from Blotato Settings > API". Pick it **before** Run Preflight instead, and the account check fails and Send stays off. |
| 3. Media fetch failed | In progress, then ✕ Failed: use a direct public file link |
| 4. Bad media file | In progress, then ✕ Failed: use a direct public file link |
| 5. Aspect ratio | In progress, then ✕ Failed: resize to a supported ratio |
| 6. Rate limit | ✕ Failed at once: wait one minute and send again |
| 7. Stuck in progress | ✕ Timed out after about 2 minutes, with a link to https://my.blotato.com/failed |
| 8. Only Instagram connected | Pick it **before** Run Preflight: TikTok and LinkedIn fail the account check |

To see preflight block a post, try `https://picsum.photos/1000/1400`, which has the wrong ratio for Instagram.

## Schedule a post

After preflight passes, a **When to post** choice appears above the Send button.

1. Choose **Schedule**. A date and time picker appears, with your time zone name next to it (for example `Africa/Lagos`).
2. Pick a date and time in **your local time**. The app converts it to UTC (world standard time) in ISO 8601 format, for example `2026-11-10T15:30:00Z`, before sending.
3. The button changes to **Schedule post**. It stays locked until the time is in the future. A time in the past shows a clear message instead.
4. Press **Schedule post**. Live status shows a blue **Scheduled** badge with the date and time in your local time.

How it works:

- Blotato gets the time as the top-level `scheduledTime` field next to `post` in `POST /v2/posts`, as Blotato's OpenAPI file and docs show.
- The server checks the time again, and refuses one that is in the past or invalid.
- The preflight pass and, in real mode, the confirmation tick box are still required.

**To try it in mock mode:** pick scenario **1. Success**, choose **Schedule**, pick a time later today, and press **Schedule post**. The fake Blotato answers "scheduled" instead of "published".

## Switch to the real Blotato API

1. Open `.env` in a text editor.
2. Set `BLOTATO_MOCK=false`.
3. After `BLOTATO_API_KEY=`, paste your key from Blotato **Settings > API**. Paste it exactly, including any `=` at the end, with no spaces or quotes.
4. Save, then stop and restart the app (`Ctrl+C`, then `npm start`).

The bar turns red: **REAL MODE**. Before anything is published, a red box names the exact accounts, and Send stays off until you tick it.

The app only uses real mode when `BLOTATO_MOCK` says `false`. Anything else, including a typo, stays in mock mode. Never share `.env`; `.gitignore` keeps it out of git.

## Endpoints

| Method and path | What it does |
|---|---|
| `GET /api/health` | Says the app is running and which mode it is in, and lists the platforms and mock scenarios. |
| `GET /api/accounts` | Lists your connected social accounts (id, platform, username and name only). |
| `POST /api/preflight` | Runs every check on `{ caption, mediaUrl, platforms }`. Returns the results and, if nothing failed, a one-time pass. |
| `POST /api/send` | Uploads the media to Blotato and publishes to each platform. Needs the one-time pass, and in real mode `confirmPublish: true`. Optional `scheduledTime` (ISO 8601, in the future): the post is scheduled instead of published now, and the time is sent to Blotato in UTC. |
| `GET /api/status/:postSubmissionId` | Asks Blotato for a post's status: in-progress, published, scheduled or failed. |

The page only calls these. In mock mode, the fake Blotato also answers at `/mock-blotato/v2/...`, but only the server uses it.

Blotato endpoints used (base `https://backend.blotato.com/v2`, header `blotato-api-key`):

- `GET /users/me/accounts`
- `POST /media`
- `POST /posts`
- `GET /posts/{postSubmissionId}`

## File structure

```
blotato project/
├── server.js            The backend: the five endpoints above, plus safety rules
├── blotatoClient.js     Every call to Blotato (mock or real), with logging and the key hidden
├── mockBlotato.js       The fake Blotato used in mock mode, with the 8 scenarios
├── preflight.js         All the checks run by Run Preflight
├── mediaFetcher.js      Downloads media links safely, blocking private and internal addresses
├── platformRules.js     Formats, sizes, aspect ratios and caption limits, with sources
├── errorExplainer.js    Turns Blotato errors into plain English and a fix
├── config.js            Reads the settings (mode, port)
├── public/
│   ├── index.html       The page
│   ├── app.js           The page's behaviour
│   └── style.css        The page's look
├── test/                Automated tests (npm test) and the helpers they use
├── docs/
│   └── scheduled-task.md  The daily test task's instructions
├── .claude/
│   ├── skills/blotato-error-explainer/SKILL.md  The Claude Code skill for Blotato errors
│   └── launch.json      How Claude Code starts the app for browser checks
├── .mcp.json            The Playwright MCP server Claude Code uses to test in a browser
├── .env                 Your settings and key. Private: never uploaded
├── .env.example         The setting names with no real values. Safe to share
├── .gitignore           Keeps .env, node_modules and logs out of git
├── package.json         Project info, the start and test commands, and the two packages
└── BLOTATO_PREFLIGHT_FINAL_AUDIT.md   The full audit and test report
```

## How I built this with Claude Code

I built this app with [Claude Code](https://claude.com/claude-code), Anthropic's AI coding tool, while learning to code. Three Claude Code features are part of the project.

### The MCP server: Playwright

MCP (Model Context Protocol) is a standard way to give Claude extra tools. [Playwright MCP](https://github.com/microsoft/playwright-mcp) gives Claude a real web browser it can control. It can open the app at http://localhost:3000, type into the form, click **Run Preflight** and **Send to Blotato**, and read what appears on the page.

I use it so Claude checks its work the way a person would, in a real browser, **before** saying a fix works. Automated tests check the backend, but only a browser shows whether the buttons, messages and layout actually work.

It is saved in `.mcp.json`, so anyone who opens this project in Claude Code gets the same tool. It uses Microsoft Edge (`--browser msedge`), which comes with Windows, so no extra browser has to be downloaded. The first time Claude Code starts it, `npx` downloads the `@playwright/mcp` package.

### The skill: blotato-error-explainer

A skill is a set of written instructions Claude follows for one kind of job. `.claude/skills/blotato-error-explainer/SKILL.md` teaches Claude how to answer "why did my Blotato post fail?":

1. Read the exact error message.
2. Match it against this app's `errorExplainer.js`, then Blotato's [error reference](https://help.blotato.com/support/errors).
3. Explain what happened in one plain sentence.
4. Give the exact fix.

It includes three worked examples: a wrong API key, a media fetch "403 Forbidden", and an unsupported aspect ratio. Its answers match the wording the app itself shows.

### The scheduled task: preflight-daily-check

Every day at 9 AM, Claude Code runs `npm test` in this folder. If any test fails, it explains in plain English which test failed, why, and whether it looks like a real bug or an outside cause, such as a test website being down. It only reports; it never changes files. The full instructions are in [docs/scheduled-task.md](docs/scheduled-task.md).

### The top 3 bugs, and how they were caught

1. **SSRF: the app would download private links on my own network.** SSRF (server-side request forgery) means tricking a server into fetching something it shouldn't. Preflight downloaded any link it was given, including `http://localhost`, my router, or cloud "metadata" addresses. FFmpeg even downloaded video links by itself, skipping every check. The security audit found this. Now `mediaFetcher.js` blocks private and internal addresses, checks every redirect, and checks the real address at the moment of connecting. FFmpeg only reads a copy the app has already downloaded safely.
2. **My own safety rule blocked every public website in real mode, and the automated tests caught it.** One rule was meant to block IPv4 addresses written in IPv6 form (like `::ffff:127.0.0.1`). But Node.js's address checker treats every normal IPv4 address the same way, so in real mode every public image link was refused as "private". The mock-mode tests missed it, because they allow local test links. The real-mode tests failed straight away and showed the cause. The fix handles those IPv6-form addresses separately, and a test now checks that public addresses are allowed.
3. **Blotato's two official sources disagree about uploading media.** Blotato's OpenAPI file (the machine-readable API description) says media links "must originate from the blotato domain", so they have to be uploaded to Blotato first. The newer help docs say any public link works and the upload step is optional. Reading both caught this. The app uploads the media to Blotato first (`POST /v2/media`), then publishes with the link Blotato returns, which works under both versions of the rules.
