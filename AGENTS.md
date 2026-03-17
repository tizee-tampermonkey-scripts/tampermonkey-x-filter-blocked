# AGENTS.md

This file provides guidance to AI coding agents when working with code in this repository.

## Project Overview

A Tampermonkey userscript that hides tweets from users who have blocked you on X/Twitter. Single file (`user.js`), no build system, no dependencies, no tests.

## Development

- **Install**: Copy `user.js` into Tampermonkey's editor (Dashboard > Create new script) or use the "Install from file" option.
- **Iterate**: Edit in Tampermonkey's editor or edit `user.js` locally and re-import. Refresh the X tab to pick up changes.
- **No build/lint/test toolchain.** The file runs directly in the browser via Tampermonkey's `GM_*` runtime.

## Architecture

Single IIFE in `user.js` with two cooperating detection layers:

### Fetch Interception (Layer 1, lines 67-148)

Hooks `window.fetch` **before X's own scripts load** (`@run-at document-start`) to inspect GraphQL API responses (`/i/api/graphql/`). Recursively walks JSON looking for two signals:
- `__typename === "TweetWithVisibilityResults"` with `relationship_perspectives.blocked_by === true`
- Any user object with `relationship_perspectives.blocked_by === true` and a `rest_id`

Discovered users are cached in a session-local `Map<rest_id, screen_name>` (`blockedByUsers`).

### DOM Fallback (Layer 2, lines 150-195)

For tweets that slip through (e.g., already rendered before fetch interception fires), checks the rendered DOM: if **both** the retweet and share buttons are disabled on a tweet, it's from a user who blocked you. Requires both to avoid false positives (your own tweets only disable retweet).

### Processing Pipeline

1. `MutationObserver` on `document.body` catches lazily-rendered tweet `<article>` elements.
2. Each article is checked against the cached blocklist first (fast path), then DOM signals (fallback).
3. When fetch interception discovers a new blocked user, it retroactively scans already-rendered tweets via `hideExistingTweetsFromUser`.
4. Each article is processed at most once (`data-xbf-processed` attribute guard).

## Key Constraints

- **`@run-at document-start` is required.** The fetch hook must be installed before X's scripts execute their first API call. Changing this to `document-idle` or `document-end` will break Layer 1.
- **`GM_addStyle` grant is required.** Used to inject CSS for hide/soft-hide treatment and panel UI.
- **`GM_registerMenuCommand` grant is required.** Used for Tampermonkey menu entries (view panel, toggle soft hide).
- **Session-only state.** The `blockedByUsers` Map resets on page reload. There is no persistent storage.

## Panel UI

An overlay panel (opened via Tampermonkey menu > "View Blocked-by Users") displays all blocked-by users detected in the current session. Each entry shows `@screen_name` and detection source (API / DOM). Clicking an entry opens the user's profile in a new tab. Supports search filtering. CSS class prefix: `xbf-`.

## Configuration

Two flags at the top of the IIFE (lines 19-22):

| Flag | Default | Effect |
|------|---------|--------|
| `DEBUG` | `true` | Enables `console.debug` logging with `[X-Block-Filter]` prefix |
| `SOFT_HIDE` | `true` | Dims + collapses tweets instead of fully hiding them (`display: none`). Togglable at runtime via Tampermonkey menu. |

`SOFT_HIDE` can be toggled at runtime via Tampermonkey menu > "Soft Hide: ON/OFF". Toggling calls `reapplyHideMode()` which swaps CSS classes on all already-processed tweets.
