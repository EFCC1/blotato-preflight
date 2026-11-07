# Scheduled task: preflight-daily-check

A Claude Code scheduled task that runs every day at 9 AM on my computer. It runs the automated tests and, if any fail, explains in plain English which one failed and why.

- **Schedule:** every day at 9:00 AM local time (cron `0 9 * * *`). Claude Code adds a small delay of a few minutes to spread the load, so it actually starts around 9:08.
- **Where it runs:** only while the Claude desktop app is open. If the app is closed at 9 AM, the task runs the next time the app opens.
- **What it can change:** nothing. It only runs the tests and reports back.

## The task's prompt

```text
Daily health check for the Blotato Preflight project.

Project folder: C:\Users\User\blotato project

1. Make sure nothing is already using port 3000 that belongs to this app. The tests use their own ports (3101 to 3121), so the app itself does not need to be stopped. Only stop something if a test fails because a port is busy.
2. In the project folder, run: npm test
   It takes about 2 minutes. It needs Node.js 20.6 or newer and FFmpeg. It uses some public test links (picsum.photos, w3schools.com, drive.google.com), so a few tests need an internet connection.
3. If every test passes, reply with one line: "All N tests passed" (with the real number) and the date.
4. If any test fails, reply in plain English for a beginner:
   - Which test failed: its exact name, and which file it is in (test/....test.js).
   - Why it failed: read the assertion message and the code it tests, then explain the cause in one or two simple sentences. Explain any technical word you use.
   - Whether it looks like a real bug in the app, or an outside cause, such as no internet, a public test website being down or changed, or a busy port.
   - The fix you recommend. Do not change any files and do not commit anything. Only report.
5. Never print or ask for the API key. Do not open or change the .env file.

Keep the whole reply short.
```
