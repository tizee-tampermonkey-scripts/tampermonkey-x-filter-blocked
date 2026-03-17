// ==UserScript==
// @name         X Block Filter
// @namespace    https://github.com/tizee-tampermonkey-scripts/tampermonkey-x-filter-blocked
// @version      1.1.0
// @description  Automatically hides tweets from users who have blocked you on X/Twitter. Detects blocked-by status via fetch interception (GraphQL response) and DOM fallback (disabled action buttons). Maintains a session-local blocklist.
// @author       tizee
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @downloadURL  https://raw.githubusercontent.com/tizee-tampermonkey-scripts/tampermonkey-x-filter-blocked/refs/heads/main/user.js
// @updateURL    https://raw.githubusercontent.com/tizee-tampermonkey-scripts/tampermonkey-x-filter-blocked/refs/heads/main/user.js
// @match        https://x.com/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ─── Configuration ───────────────────────────────────────────────────────────
    const DEBUG = true;
    // Set to true to show a subtle indicator instead of completely hiding the tweet.
    // Useful for debugging — you'll see a dimmed, collapsed version with a label.
    // Togglable at runtime via Tampermonkey menu command.
    let SOFT_HIDE = true;

    // ─── State ───────────────────────────────────────────────────────────────────
    // Session-level cache of user IDs confirmed as "blocked me".
    // Keyed by rest_id (string), value is screen_name for logging.
    const blockedByUsers = new Map();

    function log(...args) {
        if (DEBUG) console.debug('[X-Block-Filter]', ...args);
    }

    // ─── Styles ──────────────────────────────────────────────────────────────────
    GM_addStyle(`
        /* Hard hide: completely remove from layout */
        article[data-testid="tweet"].xbf-hidden {
            display: none !important;
        }

        /* Soft hide: collapsed with a label, expandable on hover for debugging */
        article[data-testid="tweet"].xbf-soft-hidden {
            opacity: 0.15;
            max-height: 48px;
            overflow: hidden;
            transition: opacity 0.2s, max-height 0.3s;
            position: relative;
            border-left: 3px solid #e74c3c;
        }
        article[data-testid="tweet"].xbf-soft-hidden:hover {
            opacity: 0.6;
            max-height: none;
        }
        .xbf-label {
            position: absolute;
            top: 8px;
            right: 12px;
            font-size: 11px;
            color: #e74c3c;
            background: rgba(0, 0, 0, 0.7);
            padding: 2px 8px;
            border-radius: 4px;
            z-index: 10;
            pointer-events: none;
        }
    `);

    // ─── Layer 1: Fetch Interception ─────────────────────────────────────────────
    // Hook into fetch to inspect GraphQL timeline responses before they reach
    // X's React renderer. This lets us extract blocked_by signals from the raw
    // JSON — the most reliable detection method.

    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const response = await originalFetch.apply(this, args);

        // Only inspect GraphQL API responses for timeline/tweet endpoints.
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (!url.includes('/i/api/graphql/')) return response;

        // We need to clone the response so both we and X's code can read the body.
        const clone = response.clone();

        // Fire-and-forget: parse in background, don't block the original response.
        clone.json().then(json => {
            try {
                extractBlockedUsers(json);
            } catch (e) {
                // Silently ignore parse errors — not every GraphQL response
                // has the shape we're looking for, and that's fine.
            }
        }).catch(() => { /* non-JSON response, ignore */ });

        return response;
    };

    /**
     * Checks whether limitedActionResults contains a "Like" action restriction,
     * which is the definitive blocked-by signal. Protected accounts restrict
     * retweet/share but NOT like.
     * @param {object} limitedActionResults
     * @returns {boolean}
     */
    function hasLikeRestriction(limitedActionResults) {
        const actions = limitedActionResults?.limited_actions;
        if (!Array.isArray(actions)) return false;
        return actions.some(a => a.action === 'Like');
    }

    /**
     * Recursively walks a GraphQL response object looking for tweet results
     * that carry the "blocked_by" signal. Three independent signals are checked:
     *
     * 1. __typename === "TweetWithVisibilityResults" with a "Like" action in
     *    limitedActionResults (most reliable — blocked-by restricts Like,
     *    protected accounts do not)
     * 2. __typename === "TweetWithVisibilityResults" with
     *    relationship_perspectives.blocked_by === true
     * 3. relationship_perspectives.blocked_by === true on any user object
     *
     * When found, the user's rest_id and screen_name are added to blockedByUsers.
     */
    function extractBlockedUsers(obj) {
        if (!obj || typeof obj !== 'object') return;

        // Check for the TweetWithVisibilityResults wrapper — this is the outermost
        // signal that a tweet has visibility restrictions applied.
        if (obj.__typename === 'TweetWithVisibilityResults' && obj.tweet) {
            const user = obj.tweet?.core?.user_results?.result;
            if (user) {
                // Primary signal: Like action is restricted (blocked-by only).
                // Secondary signal: relationship_perspectives.blocked_by flag.
                const likeRestricted = hasLikeRestriction(obj.limitedActionResults);
                const blockedBy = user.relationship_perspectives?.blocked_by === true;

                if (likeRestricted || blockedBy) {
                    const id = user.rest_id;
                    const name = user.core?.screen_name || user.legacy?.screen_name || 'unknown';
                    if (!blockedByUsers.has(id)) {
                        blockedByUsers.set(id, name);
                        log(`Discovered blocked-by user: @${name} (${id}) [like_restricted=${likeRestricted}, blocked_by=${blockedBy}]`);
                        // Immediately try to hide any already-rendered tweets from this user.
                        hideExistingTweetsFromUser(name);
                    }
                }
            }
        }

        // Also check any user object we encounter for the blocked_by field,
        // even outside of TweetWithVisibilityResults — some endpoints return
        // relationship data in different shapes.
        if (obj.relationship_perspectives?.blocked_by === true && obj.rest_id) {
            const id = obj.rest_id;
            const name = obj.core?.screen_name || obj.legacy?.screen_name || 'unknown';
            if (!blockedByUsers.has(id)) {
                blockedByUsers.set(id, name);
                log(`Discovered blocked-by user (via perspectives): @${name} (${id})`);
                hideExistingTweetsFromUser(name);
            }
        }

        // Recurse into arrays and objects.
        if (Array.isArray(obj)) {
            for (const item of obj) extractBlockedUsers(item);
        } else {
            for (const key of Object.keys(obj)) {
                extractBlockedUsers(obj[key]);
            }
        }
    }

    // ─── Layer 2: DOM-Based Detection ────────────────────────────────────────────
    // Fallback detection that examines rendered tweet DOM for the disabled button
    // pattern. Both blocked-by and protected accounts disable retweet + share in
    // the DOM (like button is NOT disabled in either case — X uses JS event
    // interception for blocked-by like restriction, not HTML attributes).
    //
    // To distinguish:
    //   - Protected/locked accounts have a lock icon (data-testid="icon-lock")
    //     next to the username
    //   - Blocked-by tweets do NOT have the lock icon
    //
    // Detection: retweet disabled AND share disabled AND no icon-lock present.

    /**
     * Checks whether a tweet article element belongs to a user who blocked you,
     * using DOM signals (disabled action buttons + absence of lock icon).
     * @param {HTMLElement} article - An article[data-testid="tweet"] element.
     * @returns {boolean}
     */
    function isBlockedByTweetDOM(article) {
        const retweetBtn = article.querySelector('button[data-testid="retweet"]');
        const shareBtn = article.querySelector('button[aria-label="Share post"]');

        if (!retweetBtn || !shareBtn) return false;

        const retweetDisabled = retweetBtn.hasAttribute('disabled') ||
                                retweetBtn.getAttribute('aria-disabled') === 'true';
        const shareDisabled = shareBtn.hasAttribute('disabled') ||
                              shareBtn.getAttribute('aria-disabled') === 'true';

        if (!retweetDisabled || !shareDisabled) return false;

        // Exclude protected/locked accounts: they have a lock icon in the
        // User-Name area (data-testid="icon-lock").
        const lockIcon = article.querySelector('[data-testid="icon-lock"]');
        if (lockIcon) return false;

        return true;
    }

    /**
     * Extracts the screen_name from a tweet article by finding the user link.
     * @param {HTMLElement} article
     * @returns {string|null}
     */
    function getScreenNameFromArticle(article) {
        // The user's profile link in a tweet typically matches /<screen_name>/status/
        const statusLink = article.querySelector('a[href*="/status/"]');
        if (statusLink) {
            const match = statusLink.href.match(/x\.com\/([^/]+)\/status\//);
            if (match) return match[1];
        }
        return null;
    }

    // ─── Hide Logic ──────────────────────────────────────────────────────────────

    /**
     * Applies the hide treatment to a tweet article element.
     * @param {HTMLElement} article
     * @param {string} reason - Why it was hidden (for logging).
     */
    function hideTweet(article, reason) {
        // Guard against double-processing.
        if (article.dataset.xbfProcessed) return;
        article.dataset.xbfProcessed = 'true';

        if (SOFT_HIDE) {
            article.classList.add('xbf-soft-hidden');
            // Add a small label indicating why it's hidden.
            const label = document.createElement('div');
            label.className = 'xbf-label';
            label.textContent = `blocked-by ${reason}`;
            article.style.position = 'relative';
            article.appendChild(label);
        } else {
            article.classList.add('xbf-hidden');
        }

        log(`Hidden tweet: ${reason}`);
    }

    /**
     * Scans a single tweet article and hides it if the author has blocked you.
     * Uses both cached blocklist (from fetch interception) and DOM signals.
     * @param {HTMLElement} article
     */
    function processTweet(article) {
        if (article.dataset.xbfProcessed) return;

        const screenName = getScreenNameFromArticle(article);

        // Check 1: Is this user already in our blocklist (from fetch interception)?
        if (screenName) {
            for (const [, name] of blockedByUsers) {
                if (name.toLowerCase() === screenName.toLowerCase()) {
                    hideTweet(article, `@${screenName}`);
                    return;
                }
            }
        }

        // Check 2: DOM-level detection — both retweet and share buttons disabled.
        if (isBlockedByTweetDOM(article)) {
            hideTweet(article, `@${screenName || '?'} (DOM)`);

            // Also add to our cache so future tweets from this user get caught
            // immediately by Check 1 without waiting for DOM rendering.
            if (screenName) {
                const placeholder_id = `dom_${screenName}`;
                if (!blockedByUsers.has(placeholder_id)) {
                    blockedByUsers.set(placeholder_id, screenName);
                    log(`Added @${screenName} to blocklist via DOM detection`);
                }
            }
            return;
        }
    }

    /**
     * Retroactively hides any already-rendered tweets from a newly-discovered
     * blocked-by user. Called when fetch interception discovers a new user.
     * @param {string} screenName
     */
    function hideExistingTweetsFromUser(screenName) {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach(article => {
            if (article.dataset.xbfProcessed) return;
            const name = getScreenNameFromArticle(article);
            if (name && name.toLowerCase() === screenName.toLowerCase()) {
                hideTweet(article, `@${screenName} (retroactive)`);
            }
        });
    }

    // ─── MutationObserver ────────────────────────────────────────────────────────
    // Watch for new tweet articles added to the DOM. X renders tweets lazily
    // as you scroll, so we need continuous observation.

    function processExistingTweets() {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach(article => processTweet(article));
    }

    function handleMutations(mutations) {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                // If the added node itself is a tweet article, process it.
                if (node.matches?.('article[data-testid="tweet"]')) {
                    processTweet(node);
                }

                // Also check descendants — X often adds wrapper divs that
                // contain the article deeper in the subtree.
                const articles = node.querySelectorAll?.('article[data-testid="tweet"]');
                if (articles) {
                    articles.forEach(article => processTweet(article));
                }
            }
        }
    }

    // ─── Initialization ──────────────────────────────────────────────────────────
    // We use @run-at document-start so that fetch interception is installed before
    // X's own scripts run. The MutationObserver is set up once the body exists.

    function init() {
        if (!document.body) {
            // Body not ready yet (we're running at document-start).
            // Retry on the next animation frame.
            requestAnimationFrame(init);
            return;
        }

        const observer = new MutationObserver(handleMutations);
        observer.observe(document.body, { childList: true, subtree: true });

        // Process anything already on the page.
        processExistingTweets();

        log('Initialized. Fetch interception active, MutationObserver watching.');
        log(`Blocklist size: ${blockedByUsers.size}`);
    }

    // ─── Soft Hide Toggle ──────────────────────────────────────────────────────
    // Re-applies hide treatment to all already-processed tweets when mode changes.

    function reapplyHideMode() {
        const articles = document.querySelectorAll('article[data-testid="tweet"][data-xbf-processed]');
        articles.forEach(article => {
            if (SOFT_HIDE) {
                article.classList.remove('xbf-hidden');
                article.classList.add('xbf-soft-hidden');
                if (!article.querySelector('.xbf-label')) {
                    const label = document.createElement('div');
                    label.className = 'xbf-label';
                    const name = getScreenNameFromArticle(article);
                    label.textContent = `blocked-by @${name || '?'}`;
                    article.style.position = 'relative';
                    article.appendChild(label);
                }
            } else {
                article.classList.remove('xbf-soft-hidden');
                article.classList.add('xbf-hidden');
                const label = article.querySelector('.xbf-label');
                if (label) label.remove();
            }
        });
    }

    // ─── Panel UI ────────────────────────────────────────────────────────────────

    GM_addStyle(`
        #xbf-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.6);
            z-index: 99998;
            backdrop-filter: blur(4px);
        }

        #xbf-panel {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 500px;
            max-width: 90vw;
            max-height: 70vh;
            background: #15202b;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            color: #f7f9f9;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            z-index: 99999;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
            animation: xbf-slide-in 0.2s ease-out;
        }

        @keyframes xbf-slide-in {
            from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
            to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }

        #xbf-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px 12px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            flex-shrink: 0;
        }

        #xbf-header h3 {
            margin: 0;
            font-size: 18px;
            font-weight: 700;
        }

        #xbf-close {
            background: transparent;
            border: none;
            color: #e7e9ea;
            font-size: 20px;
            cursor: pointer;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
            flex-shrink: 0;
        }

        #xbf-close:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        #xbf-search-container {
            padding: 12px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            flex-shrink: 0;
        }

        #xbf-search {
            width: 100%;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 24px;
            color: #f7f9f9;
            padding: 10px 16px;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
            box-sizing: border-box;
        }

        #xbf-search:focus {
            border-color: #1d9bf0;
        }

        #xbf-search::placeholder {
            color: #71767b;
        }

        #xbf-stats {
            padding: 8px 20px;
            font-size: 12px;
            color: #71767b;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            flex-shrink: 0;
        }

        #xbf-list {
            overflow-y: auto;
            flex: 1;
            padding: 4px 0;
        }

        .xbf-entry {
            display: flex;
            align-items: center;
            padding: 12px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.03);
            cursor: pointer;
            transition: background 0.15s;
            gap: 12px;
        }

        .xbf-entry:hover {
            background: rgba(255, 255, 255, 0.03);
        }

        .xbf-entry-name {
            flex: 1;
            font-size: 14px;
            color: #e7e9ea;
            font-weight: 600;
        }

        .xbf-entry-source {
            font-size: 11px;
            color: #71767b;
            font-family: "SF Mono", Monaco, Menlo, monospace;
            flex-shrink: 0;
        }

        .xbf-entry-arrow {
            color: #71767b;
            font-size: 14px;
            flex-shrink: 0;
        }

        #xbf-empty {
            padding: 40px 20px;
            text-align: center;
            color: #71767b;
            font-size: 14px;
        }
    `);

    function showBlockedByPanel() {
        // Remove existing panel if any
        const existing = document.getElementById('xbf-overlay');
        if (existing) existing.remove();

        // Collect unique users, dedup by screen_name (lowercase)
        const seen = new Map();
        for (const [id, name] of blockedByUsers) {
            const key = name.toLowerCase();
            if (!seen.has(key)) {
                seen.set(key, { screenName: name, source: id.startsWith('dom_') ? 'DOM' : 'API' });
            }
        }
        let users = Array.from(seen.values()).sort((a, b) =>
            a.screenName.toLowerCase().localeCompare(b.screenName.toLowerCase())
        );

        // Overlay
        const overlay = document.createElement('div');
        overlay.id = 'xbf-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        // Panel
        const panel = document.createElement('div');
        panel.id = 'xbf-panel';

        // Header
        const header = document.createElement('div');
        header.id = 'xbf-header';

        const title = document.createElement('h3');
        title.textContent = 'Blocked-by Users';

        const closeBtn = document.createElement('button');
        closeBtn.id = 'xbf-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', () => overlay.remove());

        header.appendChild(title);
        header.appendChild(closeBtn);

        // Search
        const searchContainer = document.createElement('div');
        searchContainer.id = 'xbf-search-container';

        const searchInput = document.createElement('input');
        searchInput.id = 'xbf-search';
        searchInput.type = 'text';
        searchInput.placeholder = 'Search by username...';

        searchContainer.appendChild(searchInput);

        // Stats
        const stats = document.createElement('div');
        stats.id = 'xbf-stats';
        stats.textContent = `${users.length} user${users.length !== 1 ? 's' : ''} detected this session`;

        // List
        const list = document.createElement('div');
        list.id = 'xbf-list';

        function renderList(filtered) {
            list.innerHTML = '';
            if (filtered.length === 0) {
                const empty = document.createElement('div');
                empty.id = 'xbf-empty';
                empty.textContent = users.length === 0
                    ? 'No blocked-by users detected yet'
                    : 'No matching users';
                list.appendChild(empty);
                return;
            }

            for (const user of filtered) {
                const row = document.createElement('div');
                row.className = 'xbf-entry';
                row.title = `Open @${user.screenName} profile`;

                const nameEl = document.createElement('div');
                nameEl.className = 'xbf-entry-name';
                nameEl.textContent = `@${user.screenName}`;

                const sourceEl = document.createElement('div');
                sourceEl.className = 'xbf-entry-source';
                sourceEl.textContent = user.source;

                const arrow = document.createElement('div');
                arrow.className = 'xbf-entry-arrow';
                arrow.textContent = '\u203A'; // single right-pointing angle quotation mark

                row.addEventListener('click', () => {
                    window.open(`https://x.com/${user.screenName}`, '_blank');
                });

                row.appendChild(nameEl);
                row.appendChild(sourceEl);
                row.appendChild(arrow);
                list.appendChild(row);
            }
        }

        renderList(users);

        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            if (!query) {
                renderList(users);
                stats.textContent = `${users.length} user${users.length !== 1 ? 's' : ''} detected this session`;
                return;
            }
            const filtered = users.filter(u => u.screenName.toLowerCase().includes(query));
            renderList(filtered);
            stats.textContent = `${filtered.length} of ${users.length} user${users.length !== 1 ? 's' : ''}`;
        });

        // Keyboard: Escape to close
        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', onKeyDown);
            }
        };
        document.addEventListener('keydown', onKeyDown);

        // Assemble
        panel.appendChild(header);
        panel.appendChild(searchContainer);
        panel.appendChild(stats);
        panel.appendChild(list);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        searchInput.focus();
    }

    // ─── Menu Commands ───────────────────────────────────────────────────────────

    function registerMenuCommands() {
        GM_registerMenuCommand('View Blocked-by Users', showBlockedByPanel);
        GM_registerMenuCommand(
            `Soft Hide: ${SOFT_HIDE ? 'ON' : 'OFF'} (click to toggle)`,
            () => {
                SOFT_HIDE = !SOFT_HIDE;
                reapplyHideMode();
                log(`Soft hide ${SOFT_HIDE ? 'enabled' : 'disabled'}`);
            }
        );
    }

    registerMenuCommands();

    init();
})();
