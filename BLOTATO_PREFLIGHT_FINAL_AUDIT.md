# Blotato Preflight: Final Audit

Date: 2026-11-07. Nothing was published during this audit. No real Blotato API key was used.

**Bottom line:** the app is ready for you to add your own Blotato key, but real publishing has **not** been proven yet, because no real key was available. Every part of the real-mode code path was tested against a local stand-in for Blotato, and every request was checked against Blotato's official OpenAPI file. The only contact with the real Blotato was two read-only requests with a placeholder key (one on the first build day, one in this audit), which Blotato rejected as expected.

---

## 1. What I inspected

- **Every project file:** `server.js`, `blotatoClient.js`, `mockBlotato.js`, `preflight.js`, `platformRules.js`, `errorExplainer.js`, `config.js`, `public/index.html`, `public/app.js`, `public/style.css`, `package.json`, `.env`, `.env.example`, `.gitignore`, `.claude/launch.json`. For `.env`, I read only the setting names, never a value.
- **Dependencies:** `express` 5.3.0 and `image-size` 2.1.0. `npm audit` found 0 vulnerabilities. No packages were added in this audit.
- **Blotato's OpenAPI file** (`https://backend.blotato.com/openapi.json`), downloaded fresh. It is unchanged since the app was built, apart from timestamps the server generates. A copy is saved at `test/openapi.snapshot.json` so the tests can check requests against it.
- **Blotato's current help docs**, read directly:
  - Media Requirements
  - Upload Media
  - Media Uploads and Conversion
  - the Instagram, TikTok and LinkedIn platform pages
  - Rate Limits
  - Error Handling
  - the Errors list

## 2. What was already working (kept)

- **All 7 mock scenarios**, plus the mock/real switch on one line in `.env`, with mock mode as the default.
- **One file for all Blotato calls** (`blotatoClient.js`). Mock and real modes run the same code; only the web address changes.
- **The correct request shapes**, including TikTok's required fields with safe defaults (`SELF_ONLY`, all switches `false`).
- **The upload-then-publish order**, required by the OpenAPI file.
- **Timestamped logs** with the key shown as `[HIDDEN]`.
- **The error explainer**, the Google Drive check, and measuring sideways phone photos and videos the way viewers see them.
- **Status checking:** every 5 seconds, 24 times, then the timeout message.

## 3. What I fixed

| # | Problem found | Fix |
|---|---|---|
| 1 | **Any link was downloaded**, including `localhost`, home-network devices and cloud "metadata" addresses (an SSRF risk, see section 4). | New `mediaFetcher.js` blocks private and internal addresses. It checks each redirect, and checks the real address at the moment of connecting. |
| 2 | **FFmpeg downloaded the video link itself**, which skipped every safety check and could follow redirects or playlists to other files. | The app now downloads the file safely to a temporary file. FFmpeg may only read that file, and only real video formats. The file is deleted afterwards. |
| 3 | **"Failed checks block publishing" was only enforced by the page's button.** A direct request to the backend could publish without any preflight. | The backend issues a one-time pass when preflight succeeds. It's tied to the exact caption, link and platforms, and it expires after 10 minutes. Sending without a valid pass is refused. |
| 4 | **Platform rules didn't match Blotato's current docs.** Instagram's ratio rule was too strict (1000x700 was wrongly blocked), WebP on Instagram wrongly passed, and the TikTok and LinkedIn ratios were guesses. | `platformRules.js` now uses the official docs, with a source comment on every value. Where the docs give no firm rule, the check says **Skipped** and explains why, instead of guessing. |
| 5 | **Formats and file sizes weren't checked**, and "can the file be downloaded" was never really tested. | New rows for each platform: file format (read from inside the file, not the link), file size, and whether the whole file downloaded. There is a 1 GB overall limit. |
| 6 | **Videos passed "media type" based only on what the link claimed.** | The file is now looked inside. If FFmpeg is missing, the row says **Skipped**, not Pass. |
| 7 | **Connected accounts weren't checked before sending.** With two accounts on one platform, the app silently used the first. | Preflight now loads your accounts. A missing account fails that platform. With several accounts you must choose one, and the backend never guesses. |
| 8 | **Unsupported platforms were silently dropped.** | They now fail with a clear reason. |
| 9 | **Real mode with an empty key still contacted Blotato.** | It now stops before sending anything, and explains how to add the key. |
| 10 | **You could edit the post while it was being checked**, so Send could turn on for an older version of the post. | The form locks while checking or sending, and the backend's one-time pass catches any mismatch. |
| 11 | **Real publishing needed no extra confirmation.** | Real mode shows a red box naming the exact accounts. Send stays off until it's ticked, and the backend also refuses without it. |
| 12 | **A mock scenario could carry over into the next run.** | Every request sets the scenario fresh, and anything unknown falls back to "Success". |
| 13 | **The Instagram hashtag limit wasn't checked** (Blotato's error docs: "maximum of 5 hashtags per post"). | Added to the Instagram caption check. |
| 14 | **The error explainer missed errors listed in Blotato's docs.** | Added: "Wrong Blotato API Key", "Account not found", "Invalid File Format", "Unsupported media format", "Invalid Video Dimensions", "Could not upload media to storage", "Media conversion failed", and 503/504 (with "check before resending, to avoid a double post"). |

**Bugs found and fixed during this audit:**

- **A safety rule blocked every public website in real mode.** It was meant to catch IPv4 addresses written in IPv6 format, but Node's address checker applies it to all IPv4 addresses. The automated tests caught this, and those addresses are now handled separately.
- **Two public redirect services (httpbin, httpbingo) now refuse test redirects**, so the redirect safety test was never actually running. It now uses a local redirect server instead.
- **The page labelled this app's own error messages as "Blotato's message".** The label is now "Error message".
- **The hint under the Send button was out of date in two places.** It said "Ready" while sending, and "Tick the box" after the box was already ticked.
- **A test timing slip:** one test read the server's messages before a warning line had printed.

## 4. Security improvements

- **The API key stays on the backend.**
  - The page can't see it: `/api/health` (called `/api/config` at the time of this audit) returns only `ok`, `mock`, `hasApiKey` (true or false), the scenarios and the platform list.
  - Network responses never contain it: error messages pass through the same key-hiding as the logs.
  - Logs show `[HIDDEN]`, and tests check that the key never appears in them.
- **Secrets aren't committed:** `.gitignore` now covers `.env` and `.env.*` (but keeps `.env.example`), `node_modules` and `*.log`. The folder is not a git repository.
- **SSRF protection** (SSRF means tricking a server into fetching private things for an attacker).
  - Blocked:
    - `localhost`
    - private and link-local ranges such as `10.x`, `172.16-31.x`, `192.168.x` and `169.254.x`, the cloud metadata range
    - IPv6 local and private ranges, and IPv4 written as IPv6
    - unusual ports
    - links containing a username or password
    - non-web links (`file:`, `ftp:`, `javascript:`)
    - names like `router` or `*.local`
    - more than 5 redirects
  - Checked at the moment of connecting, so a website can't pass the check and then switch to a private address. Tested with `localtest.me`, a public name that points to this computer.
- **File checks:** the type is confirmed from inside the file, per-platform size limits apply, and there is a 1 GB overall limit, enforced while downloading and from the declared size.
- **Errors are short and safe:** unexpected errors show a short message, and the details go only to the terminal.
- **No shell commands:** FFmpeg is started directly, without a command shell (so nothing can be slipped into the command). It may only read local files, and only real video formats.
- **Browser protection:** the backend only answers this app's own page on `localhost:3000`, which stops other websites from using it. It sends safety headers (Content-Security-Policy, nosniff, no-referrer) and hides the "powered by Express" header.
- **The server only listens on this computer** (`127.0.0.1`).
- **A test-only switch**, `PREFLIGHT_ALLOW_PRIVATE_MEDIA=true`, lets automated tests use a local test website. It is ignored in real mode, which a test checks, and it prints a loud warning when on.

## 5. API endpoints verified

| Endpoint | How it was verified |
|---|---|
| `GET /v2/users/me/accounts` | Matched to OpenAPI (answer is `{ items: [{ id, platform, fullname, username }] }`; `id` is the accountId). **Live check:** real Blotato answered `401 {"message":"Unauthorized"}` to a placeholder key, and the app explained it correctly. |
| `POST /v2/media` | Matched to OpenAPI (`{ url }` in, `201 { url, id }` out). Checked by the contract test. Not called live. |
| `POST /v2/posts` | Matched to OpenAPI. The contract test checks every required field, every target field and allowed value, and TikTok's 7 required fields. Not called live. |
| `GET /v2/posts/{postSubmissionId}` | Matched to OpenAPI (`in-progress`, `published` with `publicUrl`, `failed` with `errorMessage`, `scheduled`). Not called live. |

- **Auth header:** `blotato-api-key`, sent with surrounding spaces trimmed off, and a `=` at the end kept.
- **Base URL:** `https://backend.blotato.com/v2`.
- **No made-up endpoints:** a test fails if the app calls any address that isn't in the OpenAPI file.

**Where Blotato's own sources disagree** (the brief asked me to record these):

- **Upload step.** The OpenAPI file says media "must originate from the blotato domain". The current help docs say "No upload step required" and call `/v2/media` optional. The app keeps the upload step, as you required, which works under both.
- **Media upload rate limit.** The OpenAPI file says 10 per minute; the Rate Limits page says 30. The app uploads once per send, so either way it stays far below the limit.
- **Instagram ratios.** Your brief listed 1:1, 4:5, 1.91:1 and 9:16. The docs give a 4:5 to 1.91:1 **range** for feed posts, plus 9:16 for Reels and Stories. The app accepts the range plus 9:16, so all four of your ratios still pass.
- **TikTok ratios.** The docs give no ratio rule, so that check shows Skipped.
- **Wrong-key wording.** The docs list "Authorization failed - please check your credentials", but the live API sent `Unauthorized`. The app recognises both.

**Rate limits** (docs): Publish 30/min, status 60/min, media upload 30/min (OpenAPI: 10/min). Status checks every 5 seconds use at most 36 per minute with 3 platforms, which stays under 60. A `429` reply is explained to the user ("wait one minute").

## 6. Automated test results

Run with `npm test` (Node's built-in test runner, no extra packages). **Final run: 129 tests, 129 passed, 0 failed, 0 skipped, about 2 minutes.**

| File | What it covers |
|---|---|
| `test/preflight.test.js` | The original 24 link cases and 4 caption cases, 21 new cases from this audit, a check that each platform gets its own rows, a check of which account details reach the page, and video checks when FFmpeg is missing (Skipped, not Pass). |
| `test/mockScenarios.test.js` | All 7 original scenarios plus the new 8th ("Only Instagram connected"), a wrong key caught at preflight, a check that mock mode never contacts `backend.blotato.com`, and a check that the chosen account is the one posted to. |
| `test/realMode.test.js` | The real-mode code with a local stand-in for Blotato: <ul><li>refusing to send without confirmation, without a pass, after the post changed, or with a pass already used</li><li>the order accounts, upload, then posts</li><li>every request checked against OpenAPI</li><li>the chosen accounts used</li><li>status reaching published</li><li>never guessing between accounts</li><li>the key hidden in logs</li><li>private links blocked in real mode</li></ul> |
| `test/realModeKeys.test.js` | A wrong key fails the account check with the fix and publishes nothing. A missing key sends nothing at all. The app defaults to mock mode. |
| `test/security.test.js` | 25 kinds of blocked link, private addresses in every written form, a public name pointing to this computer, redirects to private addresses, requests from other websites or fake host names, safety headers, sending without a pass, broken JSON, and 12 error explanations. |

**Cases whose expected result changed** (because the official docs differ from the first version):

- **Case 4 (WebP on Instagram):** now fails. The docs allow JPEG and PNG only.
- **Case 5 (1000x700 on Instagram):** now passes. It's inside the 4:5 to 1.91:1 range.
- **Case 9 (4:3 video on Instagram):** now passes, for the same reason.
- **Case 24 (the public test video, 1.82:1):** now passes, for the same reason.

The sideways-photo test (case 7) now uses a photo whose result actually depends on the rotation fix working.

## 7. Browser test results (real page, clicked through by script)

- **Preflight cases:** **48 of 48 passed** in the page: 24 link cases, 4 caption cases and 20 new cases. The 21st new case, an unsupported platform, can't be chosen in the page because it only has three tickboxes, so it's covered by the automated tests. For every case, Send turned on only when it should, and the expected explanation appeared.
- **Locked while checking:** during a slow check the form is locked, the button says "Checking..." and Send is off.
- **All 8 mock scenarios**, with all three platforms ticked and the second Instagram account chosen:
  - **1. Success:** Sending, In progress, then ✓ Published with links (about 19 seconds). The posts went to `@mock_instagram_two`.
  - **2. Wrong API key:** chosen before preflight, the account check fails and Send stays off. Chosen at send, it shows Failed with the key fix.
  - **3. Media fetch failed, 4. Bad media file, 5. Aspect ratio:** In progress, then ✕ Failed, each with its own meaning and fix.
  - **6. Rate limit:** ✕ Failed straight away with "Wait one minute".
  - **7. Stuck:** ✕ Timed out after 133 seconds (24 checks), with the link to `https://my.blotato.com/failed`.
  - **8. Only Instagram connected:** chosen before preflight, TikTok and LinkedIn fail the account check. Chosen at send, Instagram publishes and the other two fail with the account fix.
- **Real mode through the page, with the local stand-in:**
  - The red REAL MODE label shows and the scenario list is hidden.
  - A confirmation box names the exact accounts, and Send stays off until it's ticked.
  - Sending ran accounts, upload, 3 posts, then status checks until ✓ Published.
  - The key showed as `[HIDDEN]` in every log line.
- **Everyday `npm start`:**
  - The yellow MOCK MODE label shows.
  - A real public image at the wrong ratio (`picsum.photos/1000/1400`) was blocked, with "Publishing is blocked: fix 1 problem".
  - A real public 4:5 image passed and published on all three platforms in mock mode.
- **Phone width (375 px):** no sideways scrolling, and long links wrap.

## 8. Remaining limitations

- **Real publishing is unproven** until you run it with your own key. The four endpoints match the OpenAPI file exactly, but only the accounts list was contacted live.
- **Not checked yet** (the docs list these): video length, frame rate, bitrate and resolution limits, and how many items a carousel can hold.
- **Plan limits:** the app can't know your plan, so the 400 MB Starter upload limit is mentioned but not enforced. The overall limit used is 1 GB.
- **Missing Blotato features:** LinkedIn company pages (`pageId`), Instagram Reel/Story choice (`mediaType`), scheduling and carousels. Only one media link is sent per post.
- **Google Drive:** every Drive link fails, even the direct-download form the Blotato docs describe. This was confirmed as the intended rule on 2026-11-07, because Blotato's docs warn that Drive can block large videos with a virus-scan page.
- **Slow downloads:** a file that takes longer than 60 seconds to download gets a **Skipped** download check, not a Pass.
- **Rate limits:** there is no built-in slowing down. A `429` is explained when it happens.
- **No duplicate protection on Blotato's side:** Blotato offers no protection against duplicate posts. If you see a 503/504, check your Blotato posts before sending again; the app's explanation says this.
- **Status checking:** it stops after 2 minutes. A slow real post may still finish later, so check `https://my.blotato.com/failed` or your Blotato posts.
- **No login:** the app has no login of its own. It's protected by only answering on this computer.
- **Video checks need FFmpeg.** Without it, those checks show Skipped.

## 9. Is it ready for real API credentials?

**Yes, for a careful first test.**

- **Safe to switch:**
  - Mock is the default.
  - A missing key sends nothing.
  - A wrong key is caught at preflight.
  - Real posts need a ticked confirmation that names the accounts.
  - The backend refuses anything that didn't pass preflight.
- **Before relying on it,** do one real test post, ideally to TikTok, which defaults to "only me" (`SELF_ONLY`), or to a test account.
- **Then:** confirm the post appears, and that the status reaches Published with a working link.

## 10. How to start the app

1. Open a terminal in the project folder (`C:\Users\User\blotato project`).
2. Start it:
   ```bash
   npm start
   ```
3. Open http://localhost:3000. A yellow **MOCK MODE** bar means nothing is really posted.
4. To stop it, click in the terminal and press `Ctrl+C`.
5. To run all automated tests (the app must be stopped first, and FFmpeg must be installed):
   ```bash
   npm test
   ```

**To switch to real mode later:**
1. Open `.env`.
2. Set `BLOTATO_MOCK=false`.
3. Paste your own key (from Blotato Settings > API) after `BLOTATO_API_KEY=`, with no spaces, including any `=` at the end.
4. Save, then restart the app.
5. The bar turns red: **REAL MODE**.

Never share `.env` or paste the key anywhere else.

**Quick mock test:**
1. Type a caption.
2. Paste `https://picsum.photos/1080/1350`.
3. Tick the platforms.
4. Click **Run Preflight**.
5. Choose a scenario.
6. Click **Send to Blotato**.

To see a blocked post, use `https://picsum.photos/1000/1400` instead (wrong ratio for Instagram).
