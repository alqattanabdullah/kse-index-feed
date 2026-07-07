// Scrapes the Boursa Kuwait "All Share Index" value AND live prices for every
// individual Kuwait-listed stock from their public website (no login required),
// and writes it all to kse.json in this repo. Runs on a schedule via GitHub
// Actions — see .github/workflows/scrape.yml.
//
// Why this exists: Boursa Kuwait does not publish a free public API. This
// script instead loads their public pages with a real headless browser
// (so the page's own JavaScript renders the live numbers, same as a human
// visitor would see), then searches the rendered text/DOM for the values.
// That's more resilient than guessing their internal API endpoints, which
// aren't documented and could change without notice.
//
// If the site's layout changes enough that this stops finding a match, the
// script does NOT overwrite the last known-good value(s) in kse.json — it
// marks the affected part as "stale" and keeps the previous data, along with
// a debug screenshot + the page's rendered text (saved as a workflow
// artifact) so the extraction pattern can be fixed.
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
//
// SECOND DISCOVERY (this session): clicking the "All-Share" tab doesn't just
// reveal the index value — it ALSO switches the stock table below from a
// "Premier Market only" view (~39 symbols) to the full combined "All-Share"
// universe (~139 symbols, Premier + Main Market). That table is a virtualized
// Ember grid — only ~100 of the ~139 rows exist in the DOM at once — so a full
// scrape requires scrolling its internal viewport through a few steps and
// merging whatever rows are rendered at each step. Individual stock prices on
// this page are delayed ~15 minutes per Boursa Kuwait's own disclosure (unlike
// the All-Share index value, which the app treats as real-time), so the app
// surfaces per-stock prices with an explicit "delayed ~15min" label.

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

// Scrapes the full per-stock price table for every Kuwait-listed symbol shown
// in the Market Watch "All Sectors" panel. Must run AFTER the page is already
// showing the All-Share view (see trySwitchToAllShareTab) since that's what
// reveals the full combined stock table rather than just Premier Market.
//
// The table is a virtualized Ember grid — it recycles a pool of ~100 DOM rows
// as you scroll rather than rendering all ~139 at once — so this scrolls the
// table's internal viewport through a few steps, merging whatever rows are
// rendered at each step into a map keyed by row code (which is stable even
// though DOM node identity/position is recycled).
async function scrapeStockTable(page) {
  try {
    const rows = await page.evaluate(async () => {
      function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

      // A stock row renders as 20 cells: Code, Ticker, Name, Session, Prev,
      // Open, High, Low, Bid, Bid Vol., Ask, Ask Vol., Curr. Price, Change,
      // Change %, Volume, Value, Trades, 52 High, 52 Low.
      function extractRows(container) {
        const els = container.querySelectorAll('.ember-table-table-row');
        const out = [];
        els.forEach((r) => {
          const cells = r.querySelectorAll('.ember-table-cell, [class*="ember-table-cell"]');
          const texts = [...cells].map((c) => c.textContent.trim());
          if (texts.length === 20) out.push(texts);
        });
        return out;
      }

      // Find the lazy-list-container whose rows actually look like stock data
      // (rather than hard-coding a DOM index, which could shift if the page
      // adds/removes other widgets built on the same Ember table component).
      const containers = [...document.querySelectorAll('.lazy-list-container')];
      let target = null;
      for (const c of containers) {
        if (extractRows(c).length > 0) { target = c; break; }
      }
      if (!target) return [];

      // Find the nearest scrollable ancestor (overflow-y scroll/auto with real
      // overflow) — this is the actual viewport whose scrollTop controls which
      // rows the virtualized grid renders.
      let scroller = target.parentElement;
      while (scroller) {
        const cs = getComputedStyle(scroller);
        if ((cs.overflowY === 'scroll' || cs.overflowY === 'auto') && scroller.scrollHeight > scroller.clientHeight + 10) break;
        scroller = scroller.parentElement;
      }

      const seen = new Map();
      extractRows(target).forEach((cells) => seen.set(cells[0], cells));

      if (scroller) {
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        const fractions = [0, 0.25, 0.45, 0.65, 0.85, 1];
        for (const f of fractions) {
          scroller.scrollTop = Math.round(maxScroll * f);
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
          await sleep(300);
          extractRows(target).forEach((cells) => seen.set(cells[0], cells));
        }
      }
      return [...seen.values()];
    });

    if (!rows || rows.length === 0) return null;

    const stocks = {};
    for (const cells of rows) {
      const code = cells[0];
      const ticker = (cells[1] || '').trim().toUpperCase();
      const name = (cells[2] || '').trim();
      const priceRaw = (cells[12] || '').replace(/,/g, '');
      const price = parseFloat(priceRaw);
      // Skip rows with no ticker or a blank/zero current price (suspended /
      // not-traded-today symbols show "0" here rather than a real quote).
      if (!ticker || isNaN(price) || price <= 0) continue;
      stocks[ticker] = { price, name, code };
    }
    const count = Object.keys(stocks).length;
    console.log('  scraped', count, 'individual stock prices (delayed ~15min per source)');
    return count > 0 ? stocks : null;
  } catch (e) {
    console.log('  could not scrape individual stock prices:', e.message);
    return null;
  }
}

// The index's real value is hidden behind a click in Boursa Kuwait's UI (see
// the comment at the top of this file). Try clicking anything on the page
// whose text looks like the "All-Share" ticker label, wait for the detail
// panel to update, and re-extract. Tries a few candidates in case the first
// text match isn't the clickable ticker item itself. Once the index value is
// found, also scrapes the full per-stock table from that same revealed view.
async function trySwitchToAllShareTab(page) {
  try {
    const candidates = page.getByText(/all[\s-]*share/i);
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 5); i++) {
      try {
        await candidates.nth(i).click({ timeout: 5000 });
        await page.waitForTimeout(2000);
        const result = await tryExtract(page);
        if (result) {
          const stocks = await scrapeStockTable(page);
          return { ...result, stocks };
        }
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

      // Try the click-to-reveal path FIRST, not as a fallback: it's a superset
      // of the plain text match below (it gets the index value AND the full
      // per-stock table), whereas the plain match alone never yields stocks.
      // On some pages/views (e.g. the homepage ticker) the index value is
      // already visible without any click, which would otherwise short-circuit
      // this loop before the stock table was ever scraped.
      result = await trySwitchToAllShareTab(page);
      if (result) {
        console.log('  found match after switching tabs:', result.matchedText);
        break;
      }
      console.log('  no click-based match — trying plain text extraction on this view');
      result = await tryExtract(page);
      if (result) {
        console.log('  found match on default view:', result.matchedText);
        // This fallback path doesn't reveal the All-Share stock table, so no
        // per-stock data will be available this run even though the index
        // value was found.
        break;
      }
      console.log('  no match on this page at all');
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

  // Never destroy the last known-good value(s) on a failed run — start from
  // whatever's already on disk and only overwrite the parts that succeeded.
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch (e) {
    /* first run ever, or file missing/corrupt — start from empty */
  }

  let output;
  if (result) {
    output = {
      ...prev,
      value: result.value,
      unit: 'points',
      label: 'Kuwait All Share Index',
      source: 'boursakuwait.com.kw (scraped)',
      matchedText: result.matchedText,
      updatedAt: now,
      status: 'ok',
    };
    console.log('SUCCESS:', JSON.stringify({ value: output.value, updatedAt: output.updatedAt, status: output.status }));
 } else {
    output = {
      ...prev,
      status: 'stale',
      lastError: lastError || 'Could not locate the All Share Index value on either page.',
      lastAttemptAt: now,
    };
    console.log('FAILED to extract the index value — keeping last known value (if any). Error:', output.lastError);
  }

  // Stock-level data has its own independent status, since the index value
  // and the per-stock table can succeed/fail separately (e.g. index extraction
  // works but the table scrape errors, or vice versa).
  if (result && result.stocks) {
    output.stocks = result.stocks;
    output.stocksCount = Object.keys(result.stocks).length;
    output.stocksUpdatedAt = now;
    output.stocksStatus = 'ok';
    output.stocksError = '';
  } else {
    output.stocksStatus = 'stale';
    output.stocksError = result ? 'Reached the All-Share view but could not read the stock table.' : (lastError || 'Could not reach the All-Share stock table.');
    output.stocksLastAttemptAt = now;
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n');
})().catch((e) => {
  console.error('Fatal scraper error:', e);
  process.exit(1);
});
