#!/usr/bin/env python3
"""
autodukan.com full catalog scraper
====================================
Scrapes all ~1,060,600 products across 25 subcategories and inserts them into
the PostgreSQL table `autodukan_parts_staging`.

Strategy
--------
  • Navigate to autodukan.com/products-list (unfiltered = all 1M+ products)
  • Click each subcategory filter one at a time in the left sidebar
  • Paginate via the NEXT button (direct URL ?page=N doesn't work — React state)
  • Extract 9 cards per page: name, partNumber, type, brand, price, mrp, imageUrl
  • Category is known from the sidebar filter we clicked — no product-page visits
  • Insert to PostgreSQL with ON CONFLICT DO UPDATE (idempotent)
  • Progress is stored in `autodukan_scrape_progress` table for resume support

Usage
-----
  # First-time setup (once):
  pip install playwright psycopg2-binary
  playwright install chromium

  # Run all subcategories (very long — days):
  python scrape_autodukan_full.py --db-url "postgresql://user:pass@host/db"

  # Run a single subcategory (run different ones on different days):
  python scrape_autodukan_full.py --db-url "..." --category "FILTERS"
  python scrape_autodukan_full.py --db-url "..." --category "BRAKE SYSTEM"

  # Resume after a stop (picks up from last completed page per subcategory):
  python scrape_autodukan_full.py --db-url "..." --resume

  # Adjust delay between pages (default 10s ± 2s jitter):
  python scrape_autodukan_full.py --db-url "..." --delay 10

  # Dry run: print first 2 pages of a category without inserting:
  python scrape_autodukan_full.py --db-url "..." --category "FILTERS" --dry-run

Environment variable alternative (so you don't pass the URL on the command line):
  set DATABASE_URL=postgresql://user:pass@host/db
  python scrape_autodukan_full.py

Notes
-----
  • Runs in a VISIBLE browser window by default so you can monitor.
    Add --headless to run hidden.
  • At 5s/page × 117,845 pages ≈ 6.8 days for the full catalog.
    Running subcategories separately (--category X) lets you split across sessions.
  • The script is safe to interrupt (Ctrl+C) — progress is saved per page.
  • Re-running after a stop automatically skips already-completed pages.
"""

import argparse
import os
import sys
import time
import re
import random
from datetime import datetime

try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:
    print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
    sys.exit(1)

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("ERROR: playwright not installed. Run: pip install playwright && playwright install chromium")
    sys.exit(1)


# ---------------------------------------------------------------------------
# All 25 subcategories shown in the autodukan.com sidebar
# ---------------------------------------------------------------------------
ALL_SUBCATEGORIES = [
    "AIR CONDITIONING",
    "BELT & CHAIN DRIVE",
    "BODY PARTS",
    "BRAKE SYSTEM",
    "CAR ACCESSORIES",
    "CAR CARE",
    "CLUTCH SYSTEM",
    "COOLING SYSTEM",
    "ELECTRICAL",
    "ENGINE PARTS",
    "EXHAUST SYSTEM",
    "FASTENERS",
    "FILTERS",
    "FUEL SYSTEM",
    "GASKET & SEALS",
    "HYBRID & ELECTRIC DRIVE",
    "INTERIORS COMFORT & SAFETY",
    "LIGHTING",
    "OILS & FLUIDS",
    "SERVICE KIT",
    "STEERING",
    "SUSPENSION",
    "TRANSMISSION",
    "WHEELS & TYRE",
    "WINDSCREEN CLEANING SYSTEM",
]

BASE_URL = "https://autodukan.com/products-list"

# ---------------------------------------------------------------------------
# DB schema
# ---------------------------------------------------------------------------
CREATE_PARTS_TABLE = """
CREATE TABLE IF NOT EXISTS autodukan_parts_staging (
    id              SERIAL PRIMARY KEY,
    name            TEXT,
    part_number     TEXT,
    type            TEXT,
    brand           TEXT,
    category        TEXT,
    price           NUMERIC(14,2),
    mrp             NUMERIC(14,2),
    image_url       TEXT,
    scraped_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(part_number, brand)
);
"""

CREATE_PROGRESS_TABLE = """
CREATE TABLE IF NOT EXISTS autodukan_scrape_progress (
    id              SERIAL PRIMARY KEY,
    category        TEXT NOT NULL,
    page_num        INTEGER NOT NULL,
    products_count  INTEGER DEFAULT 0,
    completed_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(category, page_num)
);
"""

INSERT_PARTS_SQL = """
INSERT INTO autodukan_parts_staging (name, part_number, type, brand, category, price, mrp, image_url, scraped_at)
VALUES %s
ON CONFLICT (part_number, brand) DO UPDATE SET
    name       = EXCLUDED.name,
    type       = EXCLUDED.type,
    category   = EXCLUDED.category,
    price      = EXCLUDED.price,
    mrp        = EXCLUDED.mrp,
    image_url  = EXCLUDED.image_url,
    scraped_at = EXCLUDED.scraped_at;
"""

INSERT_PROGRESS_SQL = """
INSERT INTO autodukan_scrape_progress (category, page_num, products_count)
VALUES (%s, %s, %s)
ON CONFLICT (category, page_num) DO UPDATE SET
    products_count = EXCLUDED.products_count,
    completed_at   = NOW();
"""


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------
def setup_db(conn):
    with conn.cursor() as cur:
        cur.execute(CREATE_PARTS_TABLE)
        cur.execute(CREATE_PROGRESS_TABLE)
    conn.commit()
    print("DB: tables ready (autodukan_parts_staging + autodukan_scrape_progress)")


def get_completed_pages(conn, category):
    """Return set of page numbers already scraped for this category."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT page_num FROM autodukan_scrape_progress WHERE category = %s",
            (category,)
        )
        return {row[0] for row in cur.fetchall()}


def mark_page_done(conn, category, page_num, count):
    with conn.cursor() as cur:
        cur.execute(INSERT_PROGRESS_SQL, (category, page_num, count))
    conn.commit()


def insert_products(conn, rows, dry_run=False):
    """Bulk-insert product rows. Returns number inserted/updated."""
    if not rows:
        return 0
    if dry_run:
        return len(rows)
    with conn.cursor() as cur:
        execute_values(cur, INSERT_PARTS_SQL, rows)
    conn.commit()
    return len(rows)


# ---------------------------------------------------------------------------
# Page parsing
# ---------------------------------------------------------------------------
EXTRACT_CARDS_JS = """
() => {
    const cards = [...document.querySelectorAll('.MuiCard-root')];
    return cards.map(card => {
        const lines = card.innerText.split('\\n').map(s => s.trim()).filter(Boolean);
        const get = prefix => {
            const l = lines.find(s => s.startsWith(prefix));
            return l ? l.slice(prefix.length).trim() : null;
        };
        const SKIP = ['Part No:', 'Type:', 'Brand:', '₹', 'MRP', 'ADD', 'BUY'];
        const name = lines.find(l =>
            l === l.toUpperCase() && l.length > 2 &&
            !SKIP.some(p => l.startsWith(p))
        ) || null;
        const priceRaw = lines.find(l => l.startsWith('₹') && !l.includes('MRP'));
        const mrpRaw   = lines.find(l => l.startsWith('MRP ₹'));
        const img      = card.querySelector('img');
        return {
            name,
            partNumber: get('Part No:'),
            type:       get('Type:'),
            brand:      get('Brand:'),
            price: priceRaw ? parseFloat(priceRaw.replace(/[₹,]/g, '')) : null,
            mrp:   mrpRaw   ? parseFloat(mrpRaw.replace(/[MRP ₹,]/g, '')) : null,
            imageUrl: img ? img.src.split('?')[0] : null,
        };
    });
}
"""


def parse_page_info(page):
    """
    Return (current_page, total_pages) from pagination text like 'Page 3 of 117845'.
    Returns (None, None) if not found.
    """
    try:
        text = page.inner_text("body")
        m = re.search(r'Page\s+(\d[\d,]*)\s+of\s+(\d[\d,]*)', text)
        if m:
            cur  = int(m.group(1).replace(',', ''))
            tot  = int(m.group(2).replace(',', ''))
            return cur, tot

        # Fallback: "Showing X-Y out of Z products"
        m2 = re.search(r'Showing\s+\d+[-–]\d+\s+out\s+of\s+([\d,]+)\s+product', text)
        if m2:
            total_products = int(m2.group(1).replace(',', ''))
            # We don't know current page from this text alone; return total only
            return None, -((total_products + 8) // 9)  # negative = total_pages estimate
    except Exception:
        pass
    return None, None


def wait_for_products(page, timeout_ms=20000):
    """Wait until at least one .MuiCard-root appears. Returns True on success."""
    try:
        page.wait_for_selector('.MuiCard-root', timeout=timeout_ms)
        return True
    except PlaywrightTimeout:
        return False


def is_no_results(page):
    """True if the page is in the 'Product not found' empty state."""
    try:
        text = page.inner_text("body")
        return "Product not found" in text and not page.query_selector('.MuiCard-root')
    except Exception:
        return False


def click_next_button(page):
    """
    Click the NEXT pagination button.
    Returns True if clicked, False if not found / disabled.
    """
    try:
        # Try by aria role + name first
        btn = page.get_by_role("button", name="NEXT")
        if btn.count() > 0 and btn.first.is_enabled():
            btn.first.click()
            return True

        # Fallback: find any button whose text is exactly "NEXT"
        for b in page.locator("button").all():
            try:
                if b.inner_text().strip() == "NEXT" and b.is_enabled():
                    b.click()
                    return True
            except Exception:
                continue
    except Exception:
        pass
    return False


# ---------------------------------------------------------------------------
# Core scraper
# ---------------------------------------------------------------------------
def scrape_subcategory(page, conn, category, delay_s, completed_pages, dry_run=False):
    """
    Scrape one subcategory end-to-end.
    Returns total number of products inserted for this category.
    """
    print(f"\n{'='*62}", flush=True)
    print(f"  Subcategory: {category}", flush=True)
    print(f"{'='*62}", flush=True)

    # ── Step 1: Load the products listing page ──────────────────────────────
    print(f"  Loading {BASE_URL} ...", flush=True)
    try:
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)
    except Exception as e:
        print(f"  ERROR navigating to products page: {e}", flush=True)
        return 0

    # Wait up to 12s for the page to hydrate (React needs to boot)
    time.sleep(5)

    # ── Step 2: Click the subcategory filter ────────────────────────────────
    print(f"  Clicking filter: {category} ...", flush=True)
    # Use JS evaluate — single IPC call that searches the live DOM efficiently.
    # Playwright locator-based approaches require knowing the exact element role/class
    # which varies; JS can walk all leaf text nodes reliably.
    clicked = page.evaluate("""
        (cat) => {
            const all = document.querySelectorAll('span, li, div, button, a');
            for (const el of all) {
                if (el.children.length === 0 &&
                    el.textContent.trim().toUpperCase() === cat) {
                    el.click();
                    return true;
                }
            }
            return false;
        }
    """, category.upper())

    if not clicked:
        print(f"  WARNING: could not find filter '{category}' in DOM — scraping unfiltered", flush=True)
    else:
        print(f"  Filter clicked. Waiting for products to reload ...", flush=True)
        time.sleep(3)

    # ── Step 3: Wait for first card ─────────────────────────────────────────
    if not wait_for_products(page, timeout_ms=20000):
        print(f"  No products found for '{category}'. Skipping.")
        return 0

    # ── Step 4: Paginate ────────────────────────────────────────────────────
    grand_total  = 0
    page_num     = 1

    while True:
        # Resolve current / total pages
        cur_pg, tot_pg = parse_page_info(page)
        display_pg   = cur_pg or page_num
        display_tot  = tot_pg or "?"

        # Skip already-done pages (resume support)
        if page_num in completed_pages:
            print(f"  [{display_pg}/{display_tot}] already scraped — skipping", flush=True)
            if not click_next_button(page):
                break
            page_num += 1
            time.sleep(0.5)
            if not wait_for_products(page, timeout_ms=12000):
                break
            continue

        # Extract card data
        cards = page.evaluate(EXTRACT_CARDS_JS)

        # Build DB rows
        now = datetime.utcnow()
        rows = []
        for c in cards:
            if not c.get("partNumber") and not c.get("name"):
                continue
            rows.append((
                c.get("name"),
                c.get("partNumber"),
                c.get("type"),
                c.get("brand"),
                category,
                c.get("price"),
                c.get("mrp"),
                c.get("imageUrl"),
                now,
            ))

        # Insert (or dry-run)
        n = insert_products(conn, rows, dry_run=dry_run)
        grand_total += n

        # Persist progress
        if not dry_run:
            mark_page_done(conn, category, page_num, n)

        tag = "[DRY-RUN]" if dry_run else ""
        print(
            f"  [{display_pg}/{display_tot}] {n} products{tag} "
            f"(running total: {grand_total})",
            flush=True,
        )

        # Stop on dry-run after 2 pages
        if dry_run and page_num >= 2:
            print("  Dry-run limit reached (2 pages). Stopping.")
            break

        # Check last page
        if cur_pg is not None and tot_pg is not None and tot_pg > 0 and cur_pg >= tot_pg:
            print(f"  Reached last page ({tot_pg}). Done with '{category}'.")
            break

        # Click NEXT
        if not click_next_button(page):
            print(f"  NEXT button gone — done with '{category}'.")
            break

        page_num += 1

        # Polite delay with ±2s jitter so the interval isn't perfectly regular
        jitter = random.uniform(-2.0, 2.0)
        actual_delay = max(5.0, delay_s + jitter)  # never drop below 5s
        print(f"  Waiting {actual_delay:.1f}s ...", flush=True)
        time.sleep(actual_delay)

        # Wait for new page cards to render
        if not wait_for_products(page, timeout_ms=15000):
            print(f"  Products disappeared after NEXT click. Stopping '{category}'.")
            break

    return grand_total


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args():
    p = argparse.ArgumentParser(
        description="Scrape autodukan.com full catalog → PostgreSQL",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        "--db-url",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL connection URL (or set DATABASE_URL env var)",
    )
    p.add_argument(
        "--category",
        default=None,
        help="Scrape a single subcategory, e.g. 'FILTERS' (default: all 25)",
    )
    p.add_argument(
        "--delay",
        type=float,
        default=10.0,
        help="Seconds to wait between page loads (default: 5)",
    )
    p.add_argument(
        "--resume",
        action="store_true",
        help="Skip already-completed pages (reads autodukan_scrape_progress from DB)",
    )
    p.add_argument(
        "--headless",
        action="store_true",
        help="Run the browser in headless mode (no visible window)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Scrape 2 pages per category but do not insert to DB",
    )
    return p.parse_args()


def main():
    args = parse_args()

    if not args.db_url:
        print("ERROR: --db-url required, or set DATABASE_URL environment variable.")
        print("  Example: set DATABASE_URL=postgresql://user:pass@localhost/mydb")
        sys.exit(1)

    # Validate / resolve categories
    if args.category:
        cat_upper = args.category.upper()
        match = next((c for c in ALL_SUBCATEGORIES if c == cat_upper), None)
        if not match:
            # Try partial match
            match = next((c for c in ALL_SUBCATEGORIES if cat_upper in c), None)
        if not match:
            print(f"ERROR: unknown category '{args.category}'")
            print(f"  Valid categories: {', '.join(ALL_SUBCATEGORIES)}")
            sys.exit(1)
        categories = [match]
    else:
        categories = ALL_SUBCATEGORIES

    # Connect to PostgreSQL
    try:
        conn = psycopg2.connect(args.db_url)
    except Exception as e:
        print(f"ERROR: could not connect to DB: {e}")
        sys.exit(1)

    setup_db(conn)

    print(f"\nautodukan.com Full Catalog Scraper", flush=True)
    print(f"  Categories to scrape : {len(categories)}", flush=True)
    print(f"  Delay between pages  : {args.delay}s", flush=True)
    print(f"  Resume mode          : {'yes' if args.resume else 'no'}", flush=True)
    print(f"  Dry-run              : {'yes' if args.dry_run else 'no'}", flush=True)
    print(f"  Browser              : {'headless' if args.headless else 'visible (you can monitor)'}", flush=True)
    print(flush=True)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=args.headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                # Required for running in containers/sandboxed environments
                "--no-sandbox",
                "--disable-setuid-sandbox",
                # Critical: use disk instead of /dev/shm (shared mem is tiny on Render free tier)
                "--disable-dev-shm-usage",
                # No GPU needed for scraping
                "--disable-gpu",
                "--disable-software-rasterizer",
                # Reduce background work
                "--disable-extensions",
                "--disable-background-networking",
                "--disable-background-timer-throttling",
                "--disable-backgrounding-occluded-windows",
                "--disable-renderer-backgrounding",
                "--disable-sync",
                "--no-first-run",
                "--mute-audio",
                # Reduce renderer memory
                "--js-flags=--max-old-space-size=256",
            ],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            # Smaller viewport uses less memory than 1280x900
            viewport={"width": 1024, "height": 768},
            locale="en-IN",
        )
        # Block fonts, images (we only need text), and media to reduce memory/bandwidth
        context.route(
            "**/*.{woff,woff2,ttf,eot,otf,png,jpg,jpeg,gif,webp,svg,mp4,mp3,ogg}",
            lambda route: route.abort()
        )

        page = context.new_page()
        grand_total = 0

        try:
            for i, cat in enumerate(categories):
                # Load completed pages for this category (for resume)
                completed = get_completed_pages(conn, cat) if args.resume else set()
                if completed:
                    print(f"\n  [{i+1}/{len(categories)}] {cat}: resuming — {len(completed)} pages already done")

                n = scrape_subcategory(
                    page, conn, cat,
                    delay_s=args.delay,
                    completed_pages=completed,
                    dry_run=args.dry_run,
                )
                grand_total += n

                # Pause between categories (3× the per-page delay)
                if i < len(categories) - 1:
                    gap = args.delay * 3
                    print(f"\n  Category done. Pausing {gap:.0f}s before next category ...")
                    time.sleep(gap)

        except KeyboardInterrupt:
            print("\n\nInterrupted. Progress saved — run with --resume to continue.")
        finally:
            browser.close()

    conn.close()

    print(f"\n{'='*62}")
    print(f"  DONE. Total products inserted/updated: {grand_total}")
    print(f"  Table: autodukan_parts_staging")
    print(f"  Progress: autodukan_scrape_progress (use --resume next time)")
    print(f"{'='*62}\n")


if __name__ == "__main__":
    main()
