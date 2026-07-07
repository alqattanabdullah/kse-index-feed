// Scrapes the Boursa Kuwait "All Share Index" value from their public website
// (no login required) and writes it to kse.json in this repo. Runs on a
// schedule via GitHub Actions — see .github/workflows/scrape.yml.
//
// Why this exists: Boursa Kuwait does not publish a free public API. This
// script instead loads their public pages with a real headless browser
// (so the page's own JavaScript renders the live numbers, same as a human
// visitor would see), then searches the rendered text for the index value.
// That's more resilient than guessing their internal API endpoints, which
// aren't documented and could change without notice.
//
// If the site's layout changes enough that this stops finding a match, the
// script does NOT overwrite the last known-good value in kse.json — it
// marks status as "stale" and keeps the previous number, along with a debug
// screenshot + the page's rendered text (saved as a workflow artifact) so
// the extraction pattern can be fixed.
//
// IMPORTANT DISCOVERY (from the first real run against the live site): the
// Market Watch page shows a ticker strip of 4 indices at the top (Premier
// Market, BK Main 50, Main Market, All-Share), but BY DEFAULT each one only
// shows its point CHANGE (e.g. "All-Share -5.26"), not its actual value. The
// real index value only appears in the detail panel below once that index's
// ticker item is clicked/selected. So this script now clicks the "All-Share"
// ticker item before extracting, and only falls back to a default-view
// extraction if no click target is found. Also note the site labels it
// "All-Share" WITH A HYPHEN, not "All Share" with a space.
 
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
 
const OUTPUT_FILE = path.join(__dirname, 'kse.json');
const DEBUG_DIR = path.join(__dirname, 'debug');
 
// Try the homepage first (often has a simple summary ticker), then the
// dedicated Market Watch page as a fallback.
const TARGET_URLS = [
  'https://www.boursakuwait.com.kw/en/',
  'https://www.boursakuwait.com.kw/en/securities/prices-and-screens/market-watch/',
];
 
// Matches things like "All Share Index 7,123.45" or "All-Share  7,123.4" or
// "Kuwait All-Share 7,123.45" appearing anywhere in the page's visible text,
// tolerating whatever label text/whitespace/hyphens/icons/newlines sit
// between the words and the number. [^0-9\-]{0,60} also naturally spans
// newlines, so this works even when the label and number sit in separate
// DOM elements/lines, which is how Boursa Kuwait's detail panel renders it.
const INDEX_PATTERNS = [
  /kuwait\s*all[\s-]*share[^0-9\-]{0,60}([\d,]{3,7}\.\d{1,3})/i,
  /all[\s-]*share\s*index[^0-9\-]{0,60}([\d,]{3,7}\.\d{1,3})/i,
  /all[\s-]*share[^0-9\-]{0,60}([\d,]{3,7}\.\d{1,3})/i,
];
 
async function tryExtract(page) {
  const text = await page.evaluate(() => document.body.innerText || '');
  for (const pattern of INDEX_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      // Sanity check: the All Share Index has historically traded in the
      // thousands. Reject obviously-wrong matches (stray small numbers like
      // the ticker's point-change value, e.g. "-5.26", which won't have
      // enough digits before the decimal point to match anyway, but this is
      // a second line of defense).
      if (!isNaN(val) && val > 500 && val < 100000) {
        return { value: val, matchedText: m[0].slice(0, 160) };
      }
    }
  }
  return null;
}
 
// The index's real value is hidden behind a click in Boursa Kuwait's UI (see
// the comment at the top of this file). Try clicking anything on the page
// whose text looks like the "All-Share" ticker label, wait for the detail
// panel to update, and re-extract. Tries a few candidates in case the first
// text match isn't the clickable ticker item itself.
async function trySwitchToAllShareTab(page) {
  try {
    const candidates = page.getByText(/all[\s-]*share/i);
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5); i++) {
      try {
        await candidates.nth(i).click({ timeout: 5000 });
        await page.waitForTimeout(2000);
        const result = await tryExtract(page);
        if (result) return result;
      } catch (e) {
        // This candidate wasn't clickable or didn't reveal a value — try the next one.
      }
    }
  } catch (e) {
    console.log('  could not attempt All-Share tab switch:', e.message);
  }
  return null;
}
 
async function saveDebugArtifacts(page) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: path.join(DEBUG_DIR, 'last-page.png'), fullPage: true }).catch(() => {});
    const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    fs.writeFileSync(path.join(DEBUG_DIR, 'last-page-text.txt'), text);
  } catch (e) {
    console.log('Could not save debug artifacts:', e.message);
  }
}
 
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });
  page.setDefaultTimeout(45000);
 
  let result = null;
  let lastError = null;
 
  for (const url of TARGET_URLS) {
    try {
      console.log('Loading', url);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => {
        console.log('  goto did not fully settle (continuing anyway):', e.message);
      });
      // Give the Ember/JS app extra time to finish rendering dynamic data
      // after the network goes idle.
      await page.waitForTimeout(6000);
 
      result = await tryExtract(page);
      if (result) {
        console.log('  found match on default view:', result.matchedText);
        break;
      }
      console.log('  no match on default view — trying to switch to the All-Share tab');
      result = await trySwitchToAllShareTab(page);
      if (result) {
        console.log('  found match after switching tabs:', result.matchedText);
        break;
      }
      console.log('  no match on this page even after trying to switch tabs');
    } catch (e) {
      lastError = e.message;
      console.log('  error loading page:', e.message);
    }
  }
 
  if (!result) {
    await saveDebugArtifacts(page);
  }
 
  await browser.close();
 
  const now = new Date().toISOString();
  let output;
 
  if (result) {
    output = {
      value: result.value,
      unit: 'points',
      label: 'Kuwait All Share Index',
      source: 'boursakuwait.com.kw (scraped)',
      matchedText: result.matchedText,
      updatedAt: now,
      status: 'ok',
    };
    console.log('SUCCESS:', JSON.stringify(output));
  } else {
    // Never destroy the last known-good value on a failed run — merge with
    // whatever's already on disk and just flag it as stale.
    let prev = {};
    try {
      prev = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
    } catch (e) {
      /* first run ever, or file missing/corrupt — start from empty */
    }
    output = {
      ...prev,
      status: 'stale',
      lastError: lastError || 'Could not locate the All Share Index value on either page.',
      lastAttemptAt: now,
    };
    console.log('FAILED to extract a value — keeping last known value (if any). Error:', output.lastError);
  }
 
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n');
})().catch((e) => {
  console.error('Fatal scraper error:', e);
  process.exit(1);
});
 
