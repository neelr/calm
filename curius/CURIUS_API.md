# Curius HTTP API notes

Base origin: `https://curius.app` (cookies may also be scoped to `https://www.curius.app`).

This document has two parts:

1. **Calm (tested in code)** — behavior implemented in `calm-bridge.js` and called from `content.js` / `site-export.js`.
2. **Official Curius extension (untested)** — routes and request bodies recovered from static strings in the Chrome extension **Curius 0.2.8.45** (`FBPNBDIFOCKIFJIIMOGDJNDHPMMFGJKL_0_2_8_45.crx`, March 2025). These are **not** exercised by Calm’s integration; names and shapes are **inferred from minified bundles** (`service_worker.js`, `dist/extension.js`, `dist/helper.js`) and may drift from production.

---

## Shared: how Calm authenticates

Calm’s `curiusFetch` (`calm-bridge.js`) builds requests like a browser session:

| Mechanism | When |
|-----------|------|
| `Authorization: Bearer <jwt>` | If a `jwt` or `token` cookie holds a JWT (preferred for API access). |
| `Cookie: …` | All `curius.app` / `www.curius.app` cookies are merged into a single `Cookie` header. |
| `X-XSRF-TOKEN` | From `XSRF-TOKEN` / `xsrf-token` cookie (URL-decoded). Used for **cookie/session** writes. |
| `GET /sanctum/csrf-cookie` | Called when there is **no** JWT and **no** XSRF token yet, so Laravel can set `XSRF-TOKEN`. |
| `Referer: https://curius.app/` | Default if not overridden. |
| `X-Requested-With: XMLHttpRequest` | Default. |
| `Accept: application/json` | Default. |
| `credentials: "omit"` | Fetch uses manually built `Cookie` / `Authorization` headers. |

Any **POST / PUT / PATCH / DELETE** first runs the CSRF preflight above when not using Bearer-only auth.

---

## Part 1 — API surface Calm uses (from source)

Below, **bridge message** is what `content.js` sends with `{ scope: "curius", type, ...payload }`. The bridge maps that to HTTP.

### `GET /sanctum/csrf-cookie`

- **Purpose:** Laravel Sanctum CSRF cookie bootstrap for session-based API writes.
- **Calm usage:** Internal; not exposed as a message type. Triggered by `ensureXsrfCookiePresent()` when JWT is absent and XSRF cookie is missing.

### `GET /api/user`

- **Bridge:** `getUser` (no payload).
- **HTTP:** `GET /api/user`.
- **Notes:** JWT may identify the user; response shape is whatever the app returns (often includes `user` or top-level `id`).

### `POST /api/links/url`

- **Bridge:** `getPageLink` — `{ url }` (string; page URL after Calm’s `urlForCuriusApi` normalization).
- **HTTP body:** `{ "url": "<string>" }`.

### `POST /api/links/url/network`

- **Bridge:** `getPageNetwork` — `{ url }`.
- **HTTP body:** `{ "url": "<string>" }`.

### `GET /api/linkview/:linkId`

- **Bridge:** `getLinkView` — `{ linkId }` (string or number; URL-encoded in the path).
- **HTTP:** `GET /api/linkview/<linkId>`.
- **Notes:** Response is parsed as JSON. Calm merges highlight lists from `link.highlights`, `fullLink.highlights`, and top-level `highlights` (see `mergedHighlightsFromLinkviewBody` in `calm-bridge.js`).

### `POST /api/links`

- **Bridge:** `savePage` — payload fields used:
  - `url` → `link.link`
  - `title` → `link.title` (default `"Untitled"`)
  - `snippet` → `link.snippet` (default `"N/A"`)
  - `doc` → `link.doc` (optional; default `null`)
  - `classify` → `link.classify` (default `true` if omitted; set `false` to disable)
- **HTTP body:**

```json
{
  "link": {
    "link": "<url>",
    "title": "<string>",
    "snippet": "<string>",
    "doc": null,
    "classify": true
  }
}
```

### `DELETE /api/links/:linkId`

- **Bridge:** `unsavePage` — `{ linkId }`.
- **HTTP:** `DELETE /api/links/<linkId>` (no body in Calm).

### `POST /api/links/:linkId/highlights`

- **Bridge:** `addHighlight` — `{ linkId, highlight }`.
- **HTTP body:** `{ "highlight": { ... } }` where `highlight` is a copy of the message’s `highlight` object **with `comment` removed** (comment is handled separately).
- **Fields Calm actually sends** (from `content.js`): `highlight`, `text`, `highlightText`, `rawHighlight`, `leftContext`, `rightContext` (all aligned to the selected passage). If the user typed a margin comment, `comment` is present on the **message** only; it is **not** sent inside `highlight` on POST (server is assumed to ignore comment on this route).

### `PUT /api/links/:linkId/highlight/comment`

- **Calm usage:** After a successful highlight POST, if there was non-empty `comment` text, Calm resolves `highlightId` (from the POST body or by polling `GET /api/linkview/:id`), then:
- **HTTP body:**

```json
{
  "commentText": "<string>",
  "highlightId": <number>
}
```

### `DELETE /api/links/:linkId/highlights`

- **Bridge:** `deleteHighlight` — `{ linkId, highlightText }`.
- **HTTP body:** `{ "highlightText": "<string>" }`.

### `POST /api/comments`

- **Bridge:** `addComment` — forwards `msg.body` as JSON (default `{}`). **Not used** from `content.js` in the current tree; exposed for future or manual messaging.
- **HTTP body:** whatever the caller puts in `body` (opaque to Calm).

### Cookie import/export (not REST, but part of the bridge)

- **`exportCuriusCookies`** — no HTTP; returns JSON of `chrome.cookies` objects for `curius.app` / `www.curius.app`.
- **`importCuriusCookies`** — `{ payload }` array of cookie objects; then `GET /sanctum/csrf-cookie` to refresh CSRF.

---

## Part 2 — Routes from the official extension Calm does **not** use (untested)

Recovered from **Curius 0.2.8.45** minified sources. Parameter names below are **as they appear in the bundle** (short names expanded in prose).

### Auth

| Method | Path | Inferred body / params | Source hint |
|--------|------|-------------------------|-------------|
| *unclear* | `/api/login` | Route exists as `auth.login: () => "/api/login"`. **No** email/password literal found next to this path in the scanned chunks; likely JSON credentials for the extension popup. | `helper.js` / `service_worker.js` route table |

### User topics (discovery)

| Method | Path | Params | Source hint |
|--------|------|--------|-------------|
| GET | `/api/user/topics` | Optional query `?uid=<userId>` — `getTopics(uid)` builds `"/api/user/topics?uid="+uid` when `uid` is truthy, else bare `/api/user/topics`. | Route table |

### Link metadata and state (same link id namespace as Calm)

| Method | Path | Inferred body | Source hint |
|--------|------|---------------|-------------|
| POST | `/api/links/:id/title` | `{ title }` — rename. | `service_worker.js` (`renameLink`) |
| POST | `/api/links/:id/favorite` | `{ favorite }` (boolean or flag). | `service_worker.js` |
| POST | `/api/links/:id` | `{ toRead }` — read/unread toggle (URL is `"/api/links/"+id`, not the `/title` suffix). | `service_worker.js` |

### Classification and topics on a link

| Method | Path | Inferred body | Source hint |
|--------|------|---------------|-------------|
| POST | `/api/links/:linkId/classify` | `{ doc }` — `doc` is the field name in the bundle (`let { linkId, doc }`). | `extension.js` |
| POST | `/api/links/:linkId/topics` | `{ topic }` — add a single topic. | `extension.js` |
| DELETE | `/api/links/:linkId/topics` | `{ topic }` — remove. | `extension.js` |
| PUT | `/api/links/:linkId/topics` | `{ topics }` — bulk upsert. | `extension.js` |

### Mentions (different shape than Calm’s highlight comment)

| Method | Path | Inferred body | Source hint |
|--------|------|---------------|-------------|
| PUT | `/api/links/:linkId/mention` | `{ toUids, comment, highlight, link }` — `upsertUserMentions` in `service_worker.js`. Same path key as `addUserMention` in the route table; likely one route for mention graph updates. | `service_worker.js` |

### Comments / replies (threaded model)

The official client uses **`/api/comments`** for both add and delete, with different methods:

| Method | Path | Inferred body | Source hint |
|--------|------|---------------|-------------|
| POST | `/api/comments` | `{ commentId, replyText }` — reply to an existing comment. | `service_worker.js` |
| DELETE | `/api/comments` | `{ commentId }` — delete (HTTP DELETE with JSON body in their axios wrapper). | `service_worker.js` |

Calm’s `addComment` is a **generic** POST body and does not match this structure unless callers adopt it.

### Trails (extension UI)

| Method | Path | Inferred body | Source hint |
|--------|------|---------------|-------------|
| POST | `/api/links/:linkId/trails` | `{ trailHash }` (from `trail.hash`). | `extension.js` |
| DELETE | `/api/links/:linkId/trails` | `{ trailHash }`. | `extension.js` |

### Highlight comment (official)

The bundle contains a `PUT` to `links/${linkId}/highlight/comment` with `{ commentText, highlightId }`, matching Calm’s shape (also seen in `service_worker.js` around `upsertLinkComment` / highlight actions). Calm **does** use this; it is listed in Part 1.

### Overlap: save link payload

The official `service_worker.js` uses the same **top-level** save shape Calm uses:

```text
POST /api/links
data: { link: { link, title, snippet, doc, classify }, highlight }
```

Optional `highlight` on save is present in the official client but **not** sent by Calm’s `savePage` handler (Calm only sends `link`).

---

## Practical differences summary

| Area | Calm | Official extension (decompiled) |
|------|------|----------------------------------|
| Login | Assumes session/JWT via site or cookie import | Calls `/api/login` from the extension |
| Link view | Uses `GET /api/linkview/:id` heavily | No literal `linkview` string in bundles (may use other clients or code paths) |
| CSRF | Explicit `GET /sanctum/csrf-cookie` | Not found as a literal in scanned bundles |
| Topics / trails / favorite / toRead / classify-after-save | Not implemented | Dedicated routes (see Part 2) |
| Comments | Generic `POST /api/comments` body | Structured reply/delete with `commentId` |

---

## Chrome extension API surface (for context)

Calm’s Curius code uses **`chrome.runtime`**, **`chrome.storage.local`**, and **`chrome.cookies`** (see `calm-bridge.js`, `content.js`, `site-export.js`). The store **Curius** extension also declares **`contextMenus`** and **`tabs`** in its manifest; Calm does not use `chrome.contextMenus` for Curius.
