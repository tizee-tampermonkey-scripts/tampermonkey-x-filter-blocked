// ==UserScript==
// @name         X Block Filter
// @namespace    https://github.com/tizee-tampermonkey-scripts
// @version      1.0.0
// @description  Automatically hides tweets from users who have blocked you on X/Twitter.
//               Detects blocked-by status via fetch interception (GraphQL response) and
//               DOM fallback (disabled action buttons). Maintains a session-local blocklist.
// @author       tizee
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @match        https://x.com/*
// @grant        GM_addStyle
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ─── Configuration ───────────────────────────────────────────────────────────
    const DEBUG = true;
    // Set to true to show a subtle indicator instead of completely hiding the tweet.
    // Useful for debugging — you'll see a dimmed, collapsed version with a label.
    const SOFT_HIDE = true;

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
     * Recursively walks a GraphQL response object looking for tweet results
     * that carry the "blocked_by" signal. Two independent signals are checked:
     *
     * 1. __typename === "TweetWithVisibilityResults" with limitedActionResults
     * 2. relationship_perspectives.blocked_by === true in the user object
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
                const perspectives = user.relationship_perspectives;
                if (perspectives?.blocked_by === true) {
                    const id = user.rest_id;
                    const name = user.core?.screen_name || user.legacy?.screen_name || 'unknown';
                    if (!blockedByUsers.has(id)) {
                        blockedByUsers.set(id, name);
                        log(`Discovered blocked-by user: @${name} (${id})`);
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
    // pattern. A tweet from someone who blocked you will have BOTH the retweet
    // and share buttons set to aria-disabled="true" / disabled="".
    //
    // We intentionally require BOTH to be disabled to avoid false positives:
    //   - Your own tweets: retweet is disabled, but share is NOT
    //   - Protected/locked accounts: extremely rare in timeline, and typically
    //     only retweet is disabled
    //   - Blocked-by tweets: retweet AND share are both disabled

    /**
     * Checks whether a tweet article element belongs to a user who blocked you,
     * using DOM signals (disabled action buttons).
     * @param {HTMLElement} article - An article[data-testid="tweet"] element.
     * @returns {boolean}
     */
    function isBlockedByTweetDOM(article) {
        const retweetBtn = article.querySelector('button[data-testid="retweet"]');
        const shareBtn = article.querySelector('button[aria-label="Share post"]');

        // Both must exist and both must be disabled.
        if (!retweetBtn || !shareBtn) return false;

        const retweetDisabled = retweetBtn.hasAttribute('disabled') ||
                                retweetBtn.getAttribute('aria-disabled') === 'true';
        const shareDisabled = shareBtn.hasAttribute('disabled') ||
                              shareBtn.getAttribute('aria-disabled') === 'true';

        return retweetDisabled && shareDisabled;
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

    init();
})();
