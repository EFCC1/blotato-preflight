---
name: blotato-error-explainer
description: Answer a Blotato support question about a failed or refused post. Use when someone pastes a Blotato error message, a failed status from GET /v2/posts/{id}, a 401/403/422/429 response, or asks why a Blotato post failed. Matches the message against this project's errorExplainer.js and Blotato's error reference, then gives one plain-English sentence and the exact fix.
---

# Blotato error explainer

Use this skill to answer "why did my Blotato post fail?" questions. The answer is always short: **what happened** in one plain sentence, then **the exact fix**.

## Sources, in this order

1. **This project's `errorExplainer.js`.** Read it every time, because the list changes. Each entry has a `test` (which messages it matches), a `meaning` and a `fix`. If the message matches an entry, use that entry's wording, so the answer agrees with what the app shows.
2. **Blotato's error reference:** https://help.blotato.com/support/errors. The Markdown version, https://help.blotato.com/support/errors.md, is easier to read with a tool. Use it when `errorExplainer.js` has no match, or to add detail it lacks.
3. **Never guess.** If neither source covers the message, say so plainly, quote the raw message, and point to https://my.blotato.com/failed and Blotato support.

## Steps

1. **Get the exact error text.** Ask for it if the person only describes it. Also get the HTTP status if there is one (401, 403, 422, 429), because `errorExplainer.js` matches some errors by status as well as text.
2. **Read `errorExplainer.js`** and find the first entry whose `test` matches. The order matters: the first match wins, as in the app.
3. **If nothing matches,** look the message up in the error reference.
4. **Answer in this shape, with no other preamble:**
   - **What happened:** one plain sentence. Explain any technical word in it.
   - **How to fix it:** the exact steps, one or two sentences.
   - **Error message:** the raw text, quoted, so they can search for it.
5. **If the error is new** (it was found in the reference but not in `errorExplainer.js`), say so, and offer to add an entry. Only add it if they agree, and then run `npm test`.

## Rules

- Never ask for, or repeat, an API key. If one appears in pasted text, tell the person to replace it in Blotato Settings > API, because it is now exposed.
- Don't promise a retry will work for 503 or 504 errors. Blotato has no duplicate protection, so the post may already exist. Tell them to check their Blotato posts before sending again.
- Keep the answer short. Beginners read this.

## Worked examples

### 1. Wrong API key

**Input:** `401 {"message":"Unauthorized"}` (older wording: "Authorization failed - please check your credentials").

**Match:** the first key entry in `errorExplainer.js`. It matches status 401 or the text "authorization failed", "unauthorized" or "wrong blotato api key".

**Answer:**
- **What happened:** Blotato did not accept your API key, so it refused the request.
- **How to fix it:** Copy the key again from Blotato Settings > API, with no spaces, including any "=" at the end. Paste it after `BLOTATO_API_KEY=` in `.env`, then restart the app.
- **Error message:** "Unauthorized"

### 2. Media fetch 403

**Input:** a post status of `failed` with `errorMessage: "Failed to fetch media URL: 403 Forbidden"`.

**Match:** the "failed to fetch media url" entry.

**Answer:**
- **What happened:** Blotato tried to download your media file, but the link refused to give it the file (403 means "forbidden": the file is private or blocks outside access).
- **How to fix it:** Use a direct public file link, not a Google Drive share link. Upload the file somewhere that serves the raw file.
- **Error message:** "Failed to fetch media URL: 403 Forbidden"

### 3. Aspect ratio

**Input:** a post status of `failed` with `errorMessage: "The aspect ratio is not supported"`.

**Match:** the "aspect ratio" entry. The error reference also lists this message, for video.

**Answer:**
- **What happened:** The shape of your image or video (its width compared to its height) is one the platform doesn't accept.
- **How to fix it:** Resize the media to a ratio the platform supports. For Instagram that is 4:5 to 1.91:1, or 9:16 for Reels and Stories (see `platformRules.js`). Then run Preflight again.
- **Error message:** "The aspect ratio is not supported"
