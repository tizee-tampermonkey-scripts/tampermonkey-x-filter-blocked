# X Block Filter

A Tampermonkey userscript that automatically hides tweets from users who have blocked you on X (formerly Twitter).

When someone blocks you, their tweets still appear in your timeline (in replies, quoted tweets, etc.) but with restricted interactions. This script detects those tweets and hides them.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser.
2. Open the Tampermonkey dashboard (click the extension icon > Dashboard).
3. Create a new script and paste the contents of `user.js`, or use "Utilities > Install from file".
4. Save and refresh any X/Twitter tab.

## How It Works

The script uses two complementary detection methods:

**Fetch Interception** -- Hooks into `window.fetch` to inspect X's GraphQL API responses before they reach the page. When a response contains `relationship_perspectives.blocked_by: true` for a user, that user is added to a session-local blocklist. This is the primary and most reliable detection method.

**DOM Fallback** -- As a backup, the script examines rendered tweets for a telltale DOM pattern: when both the retweet and share buttons are disabled on a tweet, the author has blocked you. (Your own tweets only disable retweet, so checking both avoids false positives.)

New tweets are caught as they render via a `MutationObserver`. When a new blocked user is discovered through the API, any already-visible tweets from that user are retroactively hidden.

## Usage

Right-click the Tampermonkey icon (or click the extension menu) on any X page to access:

- **View Blocked-by Users** -- Opens a panel listing all users detected as having blocked you in the current session. Each entry shows the `@username` and how it was detected (API or DOM). Click any entry to open their profile in a new tab, where you can block them back.
- **Soft Hide: ON/OFF** -- Toggles between soft hide (dimmed, collapsed) and hard hide (`display: none`) for blocked tweets. Takes effect immediately on all visible tweets.

## Configuration

Edit the flags at the top of `user.js`:

| Flag | Default | Description |
|------|---------|-------------|
| `DEBUG` | `true` | Log detection events to the browser console (`[X-Block-Filter]` prefix) |
| `SOFT_HIDE` | `true` | Dim and collapse blocked tweets instead of fully removing them |

**Soft hide mode** collapses tweets to a thin strip with a red left border and a "blocked-by @username" label. Hover to expand. Can also be toggled at runtime via the Tampermonkey menu without editing code.

## Limitations

- **Session-only memory.** The blocklist resets on page reload. The script does not persist blocked user data across sessions.
- **GraphQL schema changes.** X may change their API response structure at any time, which could break fetch-based detection. The DOM fallback provides resilience against this.
- **DOM selector fragility.** X uses `data-testid` attributes that could be renamed or removed in future updates.
- **No retroactive coverage for DOM-only detections.** If a blocked tweet is detected purely via DOM (not via fetch), only that specific tweet is hidden -- the script cannot scan backward through previously scrolled content.

## License

MIT
