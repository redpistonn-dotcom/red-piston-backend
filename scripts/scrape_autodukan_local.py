#!/usr/bin/env python3
"""
autodukan.com — LOCAL scraper
==============================
Run this on your own machine (no memory limits).
Data goes straight to your Supabase PostgreSQL staging table.

SETUP (one time):
  pip install playwright psycopg2-binary
  playwright install chromium

RUN — all categories, auto-resume, 10s between pages (recommended):
  python scrape_autodukan_local.py --resume --delay 10

  Stop anytime with Ctrl+C. Restart with the same command — it picks up
  from the exact page it stopped on.

  # Single category (also resumes):
  python scrape_autodukan_local.py --resume --delay 10 --category "FILTERS"

  # Hide browser window:
  python scrape_autodukan_local.py --resume --delay 10 --headless
"""

import argparse
import os
import sys
import time
import re
import random
from datetime import datetime

# ─────────────────────────────────────────────────────────────────────────────
# CONFIGURATION — paste your Supabase connection string here
# OR set the DATABASE_URL environment variable
# ─────────────────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postgres.xxyjzmrcctpipvnxkojb:IIXTD6xbXW1IhDTX@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true")
# Example:
# DATABASE_URL = "postgresql://postgres.xxxx:PASSWORD@aws-0-ap-south-1.pooler.supabase.com:5432/postgres"

SOURCE_TAG = "autodukan"   # stored in every row so you know where it came from

# ─────────────────────────────────────────────────────────────────────────────

try:
    import psycopg2
    from psycopg2.extras import execute_values
except ImportError:
    print("ERROR: psycopg2 not installed.")
    print("  Run: pip install psycopg2-binary")
    sys.exit(1)

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("ERROR: playwright not installed.")
    print("  Run: pip install playwright && playwright install chromium")
    sys.exit(1)


BASE_URL = "https://autodukan.com/products-list"

ALL_CATEGORIES = [
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

# ─────────────────────────────────────────────────────────────────────────────
# DB setup
# Note: autodukan_parts_staging already exists in Supabase — no DDL needed.
# Only the progress-tracking table is created here (needed for --resume).
# ─────────────────────────────────────────────────────────────────────────────

DDL_PROGRESS = """
CREATE TABLE IF NOT EXISTS autodukan_scrape_progress (
    id             SERIAL PRIMARY KEY,
    category       TEXT NOT NULL,
    page_num       INTEGER NOT NULL,
    products_count INTEGER DEFAULT 0,
    completed_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(category, page_num)
);
"""

INSERT_SQL = """
INSERT INTO autodukan_parts_staging
    (name, part_number, type, brand, category, price, mrp, image_url, source, scraped_at)
VALUES %s
ON CONFLICT (part_number, brand) DO UPDATE SET
    name       = EXCLUDED.name,
    type       = EXCLUDED.type,
    category   = EXCLUDED.category,
    price      = EXCLUDED.price,
    mrp        = EXCLUDED.mrp,
    image_url  = EXCLUDED.image_url,
    source     = EXCLUDED.source,
    scraped_at = EXCLUDED.scraped_at;
"""

INSERT_PROGRESS_SQL = """
INSERT INTO autodukan_scrape_progress (category, page_num, products_count)
VALUES (%s, %s, %s)
ON CONFLICT (category, page_num) DO UPDATE SET
    products_count = EXCLUDED.products_count,
    completed_at   = NOW();
"""


def setup_db(conn):
    with conn.cursor() as cur:
        cur.execute(DDL_PROGRESS)
    conn.commit()
    print("DB: progress table ready", flush=True)


def get_completed_pages(conn, category):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT page_num FROM autodukan_scrape_progress WHERE category = %s AND page_num > 0",
            (category,)
        )
        return {row[0] for row in cur.fetchall()}


def is_category_done(conn, category):
    """Returns True if this category was fully scraped in a previous run."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM autodukan_scrape_progress WHERE category = %s AND page_num = 0",
            (category,)
        )
        return cur.fetchone() is not None


def mark_category_done(conn, category):
    """Record that this category is 100% complete so future --resume runs skip it."""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO autodukan_scrape_progress (category, page_num, products_count) "
            "VALUES (%s, 0, -1) ON CONFLICT (category, page_num) DO NOTHING",
            (category,)
        )
    conn.commit()


def mark_page_done(conn, category, page_num, count):
    with conn.cursor() as cur:
        cur.execute(INSERT_PROGRESS_SQL, (category, page_num, count))
    conn.commit()


def insert_products(conn, rows):
    if not rows:
        return 0
    with conn.cursor() as cur:
        execute_values(cur, INSERT_SQL, rows)
    conn.commit()
    return len(rows)


# ─────────────────────────────────────────────────────────────────────────────
# Page helpers
# ─────────────────────────────────────────────────────────────────────────────

EXTRACT_CARDS_JS = """
() => {
    const cards = [...document.querySelectorAll('.MuiCard-root')];
    return cards.map(card => {
        const lines = card.innerText.split('\\n').map(s => s.trim()).filter(Boolean);
        const get = prefix => {
            const l = lines.find(s => s.startsWith(prefix));
            return l ? l.slice(prefix.length).trim() : null;
        };
        const SKIP = ['Part No:', 'Type:', 'Brand:', '₹', 'MRP', 'ADD', 'BUY', 'CART'];
        // Name always appears before "Part No:" in the card — grab the first
        // meaningful line from that slice (works for both ALL-CAPS and mixed-case names).
        const partNoIdx = lines.findIndex(l => l.startsWith('Part No:'));
        const candidates = partNoIdx > 0 ? lines.slice(0, partNoIdx) : lines;
        const name = candidates.find(l =>
            l.length > 2 && !SKIP.some(p => l.startsWith(p))
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


def wait_for_cards(page, timeout_ms=20000):
    try:
        page.wait_for_selector('.MuiCard-root', timeout=timeout_ms)
        return True
    except PlaywrightTimeout:
        return False


def parse_page_info(page):
    """Returns (current_page, total_pages) or (None, None)."""
    try:
        text = page.inner_text("body")
        m = re.search(r'Page\s+(\d[\d,]*)\s+of\s+(\d[\d,]*)', text)
        if m:
            return int(m.group(1).replace(',', '')), int(m.group(2).replace(',', ''))
        m2 = re.search(r'Showing\s+\d+[-–]\d+\s+out\s+of\s+([\d,]+)\s+product', text)
        if m2:
            total_products = int(m2.group(1).replace(',', ''))
            return None, (total_products + 8) // 9
    except Exception:
        pass
    return None, None


def click_filter(page, category):
    """
    Click the sidebar category filter using a JS DOM walk.
    Returns True if clicked.
    """
    return page.evaluate("""
        (cat) => {
            const els = document.querySelectorAll('span, li, div, button, a');
            for (const el of els) {
                if (el.children.length === 0 &&
                    el.textContent.trim().toUpperCase() === cat) {
                    el.click();
                    return true;
                }
            }
            return false;
        }
    """, category.upper())


def click_next(page):
    """Click the NEXT pagination button. Returns True on success."""
    try:
        btn = page.get_by_role("button", name="NEXT")
        if btn.count() > 0 and btn.first.is_enabled():
            btn.first.click()
            return True
        # JS fallback
        return page.evaluate("""
            () => {
                const btns = [...document.querySelectorAll('button')];
                const next = btns.find(b => b.textContent.trim() === 'NEXT' && !b.disabled);
                if (next) { next.click(); return true; }
                return false;
            }
        """)
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Core scraper
# ─────────────────────────────────────────────────────────────────────────────

def scrape_category(page, conn, category, delay_s, resume):
    completed_pages = get_completed_pages(conn, category) if resume else set()

    print(f"\n{'='*60}", flush=True)
    print(f"  Category: {category}", flush=True)
    if completed_pages:
        print(f"  Resume: skipping {len(completed_pages)} already-done pages", flush=True)
    print(f"{'='*60}", flush=True)

    # 1. Load page
    print(f"  Navigating to {BASE_URL} ...", flush=True)
    try:
        page.goto(BASE_URL, wait_until="networkidle", timeout=60000)
    except Exception as e:
        print(f"  ERROR loading page: {e}", flush=True)
        return 0

    # Wait for the splash/loading animation to finish and real product cards to appear.
    # The page shows a car animation on first load that can take 10-20s.
    print(f"  Waiting for product cards to load (splash may take ~15s) ...", flush=True)
    if not wait_for_cards(page, timeout_ms=45000):
        print(f"  Page did not load products after 45s — skipping category.", flush=True)
        return 0
    print(f"  Products visible. Clicking filter '{category}' ...", flush=True)

    # 2. Click category filter
    if click_filter(page, category):
        print(f"  Filter clicked — waiting for filtered results ...", flush=True)
        time.sleep(4)
        # Wait for cards to refresh after filter click
        if not wait_for_cards(page, timeout_ms=15000):
            print(f"  No products after filter click — skipping.", flush=True)
            return 0
    else:
        print(f"  WARNING: filter not found — scraping unfiltered page", flush=True)

    # 3. Confirm cards are present
    if not wait_for_cards(page, timeout_ms=10000):
        print(f"  No products found — skipping category.", flush=True)
        return 0

    grand_total = 0
    page_num = 1

    while True:
        cur_pg, tot_pg = parse_page_info(page)
        display_pg  = cur_pg  or page_num
        display_tot = tot_pg  or "?"

        # Skip already-done pages when resuming
        if page_num in completed_pages:
            print(f"  [{display_pg}/{display_tot}] skipping (already done)", flush=True)
            if not click_next(page):
                break
            page_num += 1
            time.sleep(1)
            wait_for_cards(page, timeout_ms=12000)
            continue

        # Extract cards
        cards = page.evaluate(EXTRACT_CARDS_JS)
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
                SOURCE_TAG,
                now,
            ))

        n = insert_products(conn, rows)
        grand_total += n
        mark_page_done(conn, category, page_num, n)

        print(
            f"  [{display_pg}/{display_tot}]  {n} products  (total so far: {grand_total})",
            flush=True,
        )

        # Last page?
        if cur_pg and tot_pg and tot_pg > 0 and cur_pg >= tot_pg:
            print(f"  Reached last page. Done with '{category}'.", flush=True)
            mark_category_done(conn, category)
            break

        if not click_next(page):
            print(f"  NEXT button gone — done with '{category}'.", flush=True)
            mark_category_done(conn, category)
            break

        page_num += 1

        jitter = random.uniform(-2.0, 2.0)
        sleep_for = max(4.0, delay_s + jitter)
        print(f"  Waiting {sleep_for:.1f}s ...", flush=True)
        time.sleep(sleep_for)

        if not wait_for_cards(page, timeout_ms=15000):
            print(f"  Products disappeared after NEXT. Stopping category.", flush=True)
            break

    return grand_total


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def get_null_name_categories(conn):
    """Return list of categories that have at least one row with name IS NULL."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT DISTINCT COALESCE(NULLIF(TRIM(category), ''), 'UNKNOWN')
            FROM autodukan_parts_staging
            WHERE name IS NULL AND source = 'autodukan'
            ORDER BY 1
        """)
        return [r[0] for r in cur.fetchall()]


def clear_category_progress(conn, category):
    """Delete ALL progress rows for a category so it gets fully re-scraped."""
    with conn.cursor() as cur:
        cur.execute(
            "DELETE FROM autodukan_scrape_progress WHERE category = %s",
            (category,)
        )
    conn.commit()


def parse_args():
    p = argparse.ArgumentParser(description="Scrape autodukan.com → Supabase staging table")
    p.add_argument("--db-url", default=DATABASE_URL,
                   help="PostgreSQL connection URL (or set DATABASE_URL env var)")
    p.add_argument("--category", default=None,
                   help="Single category to scrape, e.g. 'FILTERS'")
    p.add_argument("--delay", type=float, default=10.0,
                   help="Seconds between pages (default 10)")
    p.add_argument("--resume", action="store_true",
                   help="Skip already-completed pages")
    p.add_argument("--fix-nulls", action="store_true",
                   help="Re-scrape only categories that have NULL product names in the DB")
    p.add_argument("--headless", action="store_true",
                   help="Hide the browser window")
    return p.parse_args()


def main():
    args = parse_args()

    db_url = args.db_url
    if not db_url:
        print("ERROR: database URL not set.")
        print("  Either edit DATABASE_URL at the top of this file, OR")
        print("  run:  set DATABASE_URL=postgresql://...")
        print("  then: python scrape_autodukan_local.py")
        sys.exit(1)

    # Supabase pooler URLs include ?pgbouncer=true which psycopg2 rejects — strip it
    db_url = re.sub(r'([?&])pgbouncer=true', r'\1', db_url, flags=re.IGNORECASE)
    db_url = db_url.rstrip('?&')

    # Resolve categories
    if args.category:
        cat_upper = args.category.strip().upper()
        match = next((c for c in ALL_CATEGORIES if c == cat_upper), None)
        if not match:
            match = next((c for c in ALL_CATEGORIES if cat_upper in c), None)
        if not match:
            print(f"ERROR: unknown category '{args.category}'")
            print(f"  Valid: {', '.join(ALL_CATEGORIES)}")
            sys.exit(1)
        categories = [match]
    else:
        categories = ALL_CATEGORIES

    # Connect
    print(f"Connecting to database ...", flush=True)
    try:
        conn = psycopg2.connect(db_url)
    except Exception as e:
        print(f"ERROR connecting to DB: {e}")
        sys.exit(1)

    setup_db(conn)

    # --fix-nulls: find categories with NULL names, reset their progress, restrict to those
    if args.fix_nulls:
        null_cats = get_null_name_categories(conn)
        if not null_cats:
            print("No NULL-name rows found in staging. Nothing to fix!")
            conn.close()
            sys.exit(0)
        # Intersect with known categories; warn about unrecognised ones
        recognised   = [c for c in null_cats if c in ALL_CATEGORIES]
        unrecognised = [c for c in null_cats if c not in ALL_CATEGORIES]
        if unrecognised:
            print(f"  (skipping {len(unrecognised)} DB categories not in ALL_CATEGORIES: {unrecognised})")
        if not recognised:
            print("No matching categories to re-scrape.")
            conn.close()
            sys.exit(0)
        print(f"\n--fix-nulls: {len(recognised)} categor(ies) have NULL names → clearing their progress and re-scraping:")
        for c in recognised:
            null_count_row = None
            with conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM autodukan_parts_staging WHERE name IS NULL AND source='autodukan' AND COALESCE(NULLIF(TRIM(category),''),'UNKNOWN')=%s", (c,))
                null_count_row = cur.fetchone()
            count = null_count_row[0] if null_count_row else '?'
            print(f"  {c}  ({count} NULL rows)")
            clear_category_progress(conn, c)
        categories = recognised
        # Force resume=True so per-page tracking works during re-scrape
        args.resume = True
    print(f"\nautodukan.com Local Scraper", flush=True)
    print(f"  Source tag     : {SOURCE_TAG}", flush=True)
    print(f"  Categories     : {len(categories)}", flush=True)
    print(f"  Delay          : {args.delay}s ± 2s jitter", flush=True)
    print(f"  Mode           : {'fix-nulls' if args.fix_nulls else 'resume' if args.resume else 'full'}", flush=True)
    print(f"  Browser        : {'headless' if args.headless else 'visible'}", flush=True)
    print(flush=True)

    session_total = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=args.headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--mute-audio",
            ],
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 900},
            locale="en-IN",
        )
        # Block fonts to speed up loads
        context.route("**/*.{woff,woff2,ttf,eot,otf}", lambda r: r.abort())

        page = context.new_page()

        for i, category in enumerate(categories, 1):
            # Skip fully-finished categories immediately — no browser needed
            if args.resume and is_category_done(conn, category):
                print(f"\n[{i}/{len(categories)}] '{category}' — already fully scraped. Skipping.", flush=True)
                continue

            print(f"\n[{i}/{len(categories)}] Starting '{category}' ...", flush=True)
            try:
                n = scrape_category(page, conn, category, args.delay, args.resume)
                session_total += n
                print(f"  Category done. {n} products inserted.", flush=True)
            except KeyboardInterrupt:
                print("\nInterrupted by user. Progress saved — run with --resume to continue.", flush=True)
                break
            except Exception as e:
                print(f"  ERROR in category '{category}': {e}", flush=True)
                continue

            if i < len(categories):
                print(f"\n  Pausing 30s before next category ...", flush=True)
                time.sleep(30)

        browser.close()

    conn.close()
    print(f"\n{'='*60}", flush=True)
    print(f"  DONE. Total products inserted this session: {session_total}", flush=True)
    print(f"  Source tag '{SOURCE_TAG}' applied to all rows.", flush=True)
    print(f"{'='*60}", flush=True)


if __name__ == "__main__":
    main()
