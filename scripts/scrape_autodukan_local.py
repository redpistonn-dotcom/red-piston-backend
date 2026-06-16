#!/usr/bin/env python3
"""
autodukan.com — LOCAL scraper
==============================
Run this on your own machine (no memory limits).
Data goes straight to your Supabase PostgreSQL staging table.

SETUP (one time):
  pip install playwright psycopg2-binary
  playwright install chromium

RUN:
  python scrape_autodukan_local.py

  # Single category:
  python scrape_autodukan_local.py --category "FILTERS"

  # Resume after stop (skips already-scraped pages):
  python scrape_autodukan_local.py --resume

  # Headless (no browser window):
  python scrape_autodukan_local.py --headless
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
DATABASE_URL = os.environ.get("DATABASE_URL", "")
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
# ─────────────────────────────────────────────────────────────────────────────

DDL_STAGING = """
CREATE TABLE IF NOT EXISTS autodukan_parts_staging (
    id          SERIAL PRIMARY KEY,
    name        TEXT,
    part_number TEXT,
    type        TEXT,
    brand       TEXT,
    category    TEXT,
    price       NUMERIC(14,2),
    mrp         NUMERIC(14,2),
    image_url   TEXT,
    source      TEXT DEFAULT 'autodukan',
    scraped_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(part_number, brand)
);
"""

DDL_ADD_SOURCE_COL = """
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'autodukan_parts_staging' AND column_name = 'source'
    ) THEN
        ALTER TABLE autodukan_parts_staging ADD COLUMN source TEXT DEFAULT 'autodukan';
    END IF;
END$$;
"""

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
        cur.execute(DDL_STAGING)
        cur.execute(DDL_ADD_SOURCE_COL)   # adds source col if table already existed
        cur.execute(DDL_PROGRESS)
    conn.commit()
    print("DB: tables ready", flush=True)


def get_completed_pages(conn, category):
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
        page.goto(BASE_URL, wait_until="domcontentloaded", timeout=45000)
    except Exception as e:
        print(f"  ERROR loading page: {e}", flush=True)
        return 0

    time.sleep(6)   # let React hydrate

    # 2. Click category filter
    print(f"  Clicking filter '{category}' ...", flush=True)
    if click_filter(page, category):
        print(f"  Filter clicked — waiting for products ...", flush=True)
        time.sleep(4)
    else:
        print(f"  WARNING: filter not found — scraping unfiltered page", flush=True)

    # 3. Wait for first card
    if not wait_for_cards(page, timeout_ms=25000):
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
            break

        if not click_next(page):
            print(f"  NEXT button gone — done with '{category}'.", flush=True)
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

def parse_args():
    p = argparse.ArgumentParser(description="Scrape autodukan.com → Supabase staging table")
    p.add_argument("--db-url", default=DATABASE_URL,
                   help="PostgreSQL connection URL (or set DATABASE_URL env var)")
    p.add_argument("--category", default=None,
                   help="Single category to scrape, e.g. 'FILTERS'")
    p.add_argument("--delay", type=float, default=8.0,
                   help="Seconds between pages (default 8)")
    p.add_argument("--resume", action="store_true",
                   help="Skip already-completed pages")
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

    print(f"\nautodukan.com Local Scraper", flush=True)
    print(f"  Source tag     : {SOURCE_TAG}", flush=True)
    print(f"  Categories     : {len(categories)}", flush=True)
    print(f"  Delay          : {args.delay}s ± 2s jitter", flush=True)
    print(f"  Resume mode    : {'yes' if args.resume else 'no'}", flush=True)
    print(f"  Browser        : {'headless' if args.headless else 'visible'}", flush=True)
    print(flush=True)

    session_total = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=args.headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-extensions",
                "--disable-background-networking",
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
            print(f"\n[{i}/{len(categories)}] Starting '{category}' ...", flush=True)
            try:
                n = scrape_category(page, conn, category, args.delay, args.resume)
                session_total += n
                print(f"  Category done. {n} products inserted.", flush=True)
            except KeyboardInterrupt:
                print("\nInterrupted by user. Progress saved — run with --resume to continue.")
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
