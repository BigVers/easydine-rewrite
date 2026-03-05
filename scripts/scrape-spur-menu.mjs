#!/usr/bin/env node
/**
 * scrape-spur-menu.mjs  (v2 — Puppeteer edition)
 *
 * The Spur website is a Vue.js SPA. All menu content is rendered
 * client-side, so fetch + cheerio only returns an empty shell.
 * This version uses Puppeteer to drive a real browser, visit each
 * category page, wait for the cards to render, then extract:
 *
 *   - Category names  (from the nav tab strip)
 *   - Item name       (h3.text-brand-blue)
 *   - Badges          (img[alt] inside the badge container → "New", "Vegetarian", etc.)
 *   - Description     (span inside div.text-gray-700)
 *   - Price           (span.text-brand-orange)
 *
 * Output: idempotent SQL ready to run against the EasyDine Supabase DB.
 *
 * Usage:
 *   npm install puppeteer           # first time only
 *   node scrape-spur-menu.mjs                        # writes spur-menu.sql
 *   node scrape-spur-menu.mjs --out ./my-seed.sql
 *   node scrape-spur-menu.mjs --dry-run              # print SQL to stdout
 *   node scrape-spur-menu.mjs --json                 # dump raw JSON instead of SQL
 *   node scrape-spur-menu.mjs --categories "Starters & Light Meals,Shareables"
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun    = args.includes('--dry-run');
const jsonMode  = args.includes('--json');
const outIdx    = args.indexOf('--out');
const outFile   = outIdx !== -1 ? args[outIdx + 1] : (jsonMode ? 'spur-menu.json' : 'spur-menu.sql');
const catIdx    = args.indexOf('--categories');
const onlyCats  = catIdx !== -1
  ? args[catIdx + 1].split(',').map(s => s.trim().toLowerCase())
  : null;

// ─── Constants ────────────────────────────────────────────────────────────────
const BASE_URL      = 'https://www.spursteakranches.com/za/menu';
const SPUR_PRIMARY   = '#8B0000';
const SPUR_SECONDARY = '#F5A623';
const SPUR_BG        = '#FFFDF7';
const SPUR_TEXT      = '#1A1A1A';

// Delay between category page visits (ms) — be polite to the server
const PAGE_DELAY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── UUID helpers (stable per name so re-runs produce same IDs) ───────────────
const uuidMap = new Map();
function stableId(name) {
  if (!uuidMap.has(name)) uuidMap.set(name, randomUUID());
  return uuidMap.get(name);
}

// ─── SQL escaping ─────────────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return 'NULL';
  return `'${String(str).replace(/'/g, "''")}'`;
}
function escOrNull(str) {
  if (!str || !String(str).trim()) return 'NULL';
  return esc(String(str).trim());
}
function parsePriceCents(str) {
  if (!str) return 0;
  const num = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? 0 : Math.round(num * 100);
}

// ─── Category slug map ────────────────────────────────────────────────────────
// Derived from the live nav tab strip — maps display name → URL slug.
// The scraper will also auto-discover these from the category nav, but
// this table acts as a fallback and ensures correct slug mapping.
const KNOWN_CATEGORY_SLUGS = {
  'starters & light meals': 'starters-light-meals',
  'shareables':             'shareables',
  'salads & veg':           'salads-veg',
  'toasted sarmies':        'toasted-sarmies',
  'sizzling steaks & grills': 'sizzling-steaks-grills',
  'add a sauce':            'add-a-sauce',
  'ribs':                   'ribs',
  "combo's":                'combos',
  'chicken':                'chicken',
  'schnitzels':             'schnitzels',
  'burgers':                'burgers',
  'seafood':                'seafood',
  'vegetarian':             'vegetarian',
  'decadent delights':      'decadent-delights',
  'ice-cream delights':     'ice-cream-delights',
  'waffles':                'waffles',
  'milkshakes':             'milkshakes',
  'hot drinks':             'hot-drinks',
  'cold drinks':            'cold-drinks',
  'breakfast menu':         'breakfast-menu',
  'kids menu':              'kids-menu',
};

function categorySlug(displayName) {
  const lower = displayName.toLowerCase();
  if (KNOWN_CATEGORY_SLUGS[lower]) return KNOWN_CATEGORY_SLUGS[lower];
  // Auto-generate slug: lowercase, remove special chars, spaces to hyphens
  return lower.replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

// ─── Puppeteer scrape ─────────────────────────────────────────────────────────
async function scrapeWithPuppeteer() {
  let puppeteer;
  try {
    puppeteer = await import('puppeteer');
    puppeteer = puppeteer.default ?? puppeteer;
  } catch {
    console.error('❌  Puppeteer not found. Install it first:');
    console.error('      npm install puppeteer');
    process.exit(1);
  }

  console.log('\n🚀  Launching browser…');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const page = await browser.newPage();

  // Block images, fonts and tracking to speed things up
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const type = req.resourceType();
    const url  = req.url();
    if (['image', 'font', 'media'].includes(type)) {
      req.abort();
    } else if (url.includes('google-analytics') || url.includes('hotjar') || url.includes('facebook')) {
      req.abort();
    } else {
      req.continue();
    }
  });

  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );
  await page.setViewport({ width: 1280, height: 900 });

  // ── Step 1: Load the main menu page and discover category names + slugs ──────
  console.log(`\n🌐  Loading ${BASE_URL}…`);
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for the category nav strip to appear
  await page.waitForSelector('.v-hl-container .tag span', { timeout: 15000 })
    .catch(() => console.warn('  ⚠️  Category nav not found — will use known slug list'));

  const discoveredCategories = await page.evaluate(() => {
    const tags = document.querySelectorAll('.v-hl-container .tag span');
    return Array.from(tags).map(el => el.textContent.trim()).filter(Boolean);
  });

  const categoryNames = discoveredCategories.length > 0
    ? discoveredCategories
    : Object.keys(KNOWN_CATEGORY_SLUGS).map(k =>
        k.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
      );

  console.log(`\n  📋  Found ${categoryNames.length} categories:`);
  categoryNames.forEach(c => console.log(`       • ${c}`));

  // ── Step 2: Visit each category page and scrape items ────────────────────────
  const allCategories = [];

  for (const catName of categoryNames) {
    // Skip if --categories filter is active and this category isn't listed
    if (onlyCats && !onlyCats.includes(catName.toLowerCase())) continue;

    const slug = categorySlug(catName);
    const url  = `${BASE_URL}/${slug}`;

    console.log(`\n  🍽️   Scraping: ${catName}`);
    console.log(`       → ${url}`);

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

      // Wait for at least one menu card to appear
      await page.waitForSelector('.menu-card', { timeout: 12000 });
      await sleep(500); // small extra wait for all cards to render

      const items = await page.evaluate(() => {
        const cards = document.querySelectorAll('.menu-card');
        return Array.from(cards).map(card => {
          // Name
          const nameEl = card.querySelector('h3.text-brand-blue, h3[class*="text-sm"]');
          const name   = nameEl ? nameEl.textContent.trim() : null;
          if (!name) return null;

          // Badges (New, Vegetarian, Hot!, etc.) — read from img alt attributes
          const badgeImgs = card.querySelectorAll('img[alt][class*="h-[11px]"]');
          const badges = Array.from(badgeImgs)
            .map(img => img.getAttribute('alt'))
            .filter(Boolean);

          // Description
          const descEl = card.querySelector('div.text-gray-700 span, .text-gray-700 span');
          const description = descEl
            ? descEl.textContent.replace(/\s+/g, ' ').trim()
            : null;

          // Price
          const priceEl = card.querySelector('span.text-brand-orange');
          const priceRaw = priceEl ? priceEl.textContent.trim() : null;

          return { name, badges, description, priceRaw };
        }).filter(Boolean);
      });

      if (items.length === 0) {
        console.log(`       ⚠️  No items found — page may not have loaded correctly`);
        continue;
      }

      console.log(`       ✅  ${items.length} items`);

      // Parse prices to cents
      const parsedItems = items.map(item => ({
        name:        item.name,
        badges:      item.badges,
        description: item.description || null,
        price_cents: parsePriceCents(item.priceRaw),
        price_raw:   item.priceRaw,
      }));

      allCategories.push({ name: catName, slug, items: parsedItems });

    } catch (err) {
      console.warn(`       ⚠️  Failed to scrape ${catName}: ${err.message}`);
    }

    await sleep(PAGE_DELAY_MS);
  }

  await browser.close();
  console.log(`\n  ✅  Scraped ${allCategories.length} categories, ` +
    `${allCategories.reduce((n, c) => n + c.items.length, 0)} total items`);

  return allCategories;
}

// ─── Derive Halaal menu by filtering non-halaal items ────────────────────────
const NON_HALAAL_KEYWORDS = [
  'pork', 'bacon', 'ham', 'pepperoni', 'prosciutto', 'blt',
  'beer', 'wine', 'whisky', 'whiskey', 'rum', 'gin', 'vodka',
  'alcohol', 'brandy', 'amarula', 'cocktail', 'shooter', 'lager',
];
const NON_HALAAL_CATEGORIES = [
  'cocktails', 'spirits', 'beers', 'wines', 'beverages alcoholic',
];

function isHalaalSafe(name = '', description = '', categoryName = '') {
  const haystack = `${name} ${description} ${categoryName}`.toLowerCase();
  return (
    !NON_HALAAL_KEYWORDS.some(kw => haystack.includes(kw)) &&
    !NON_HALAAL_CATEGORIES.some(cat => categoryName.toLowerCase().includes(cat))
  );
}

function deriveHalaalCategories(categories) {
  return categories
    .filter(cat => isHalaalSafe('', '', cat.name))
    .map(cat => ({
      ...cat,
      items: cat.items.filter(item =>
        isHalaalSafe(item.name, item.description ?? '', cat.name)
      ),
    }))
    .filter(cat => cat.items.length > 0);
}

// ─── SQL generation ───────────────────────────────────────────────────────────
function buildSQL(standardCategories, halaalCategories) {
  const restaurantId     = stableId('spur-restaurant');
  const standardBranchId = stableId('spur-standard-branch');
  const halaalBranchId   = stableId('spur-halaal-branch');

  const lines = [];
  lines.push(`-- ============================================================`);
  lines.push(`-- EasyDine — Spur Menu Seed (Puppeteer scrape)`);
  lines.push(`-- Generated: ${new Date().toISOString()}`);
  lines.push(`-- Source:    ${BASE_URL}`);
  lines.push(`-- Standard:  ${standardCategories.length} categories, ` +
             `${standardCategories.reduce((n,c) => n+c.items.length, 0)} items`);
  lines.push(`-- Halaal:    ${halaalCategories.length} categories, ` +
             `${halaalCategories.reduce((n,c) => n+c.items.length, 0)} items`);
  lines.push(`-- ============================================================`);
  lines.push(``);
  lines.push(`BEGIN;`);
  lines.push(``);

  // Restaurant
  lines.push(`-- ── Restaurant ─────────────────────────────────────────────`);
  lines.push(`INSERT INTO restaurants (id, name, slug, is_active) VALUES (`);
  lines.push(`  '${restaurantId}', 'Spur Steak Ranches', 'spur', TRUE`);
  lines.push(`) ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name;`);
  lines.push(``);

  // Branches
  lines.push(`-- ── Branches ────────────────────────────────────────────────`);
  const branches = [
    { id: standardBranchId, name: 'Spur — Standard', isHalaal: false },
    { id: halaalBranchId,   name: 'Spur — Halaal',   isHalaal: true  },
  ];
  for (const b of branches) {
    lines.push(`INSERT INTO branches (id, restaurant_id, name, timezone, metadata, is_active) VALUES (`);
    lines.push(`  '${b.id}', '${restaurantId}', '${b.name}',`);
    lines.push(`  'Africa/Johannesburg', '{"halaal": ${b.isHalaal}}'::jsonb, TRUE`);
    lines.push(`) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`);
    lines.push(``);
  }

  // Customisations
  lines.push(`-- ── Brand customisations ────────────────────────────────────`);
  for (const b of branches) {
    const custId = stableId(`spur-cust-${b.id}`);
    lines.push(`INSERT INTO restaurant_customisations`);
    lines.push(`  (id, branch_id, primary_color, secondary_color, background_color, text_color, font_family, border_radius)`);
    lines.push(`VALUES (`);
    lines.push(`  '${custId}', '${b.id}',`);
    lines.push(`  '${SPUR_PRIMARY}', '${SPUR_SECONDARY}', '${SPUR_BG}', '${SPUR_TEXT}', 'System', 8`);
    lines.push(`) ON CONFLICT (branch_id) DO UPDATE`);
    lines.push(`  SET primary_color = EXCLUDED.primary_color, secondary_color = EXCLUDED.secondary_color;`);
    lines.push(``);
  }

  // Menus
  const menuDefs = [
    { key: 'standard', branchId: standardBranchId, name: 'Spur Standard Menu', categories: standardCategories },
    { key: 'halaal',   branchId: halaalBranchId,   name: 'Spur Halaal Menu',   categories: halaalCategories  },
  ];

  for (const { key, branchId, name: menuName, categories } of menuDefs) {
    const menuId = stableId(`spur-menu-${key}`);
    lines.push(`-- ── ${menuName} ${'─'.repeat(Math.max(0, 44 - menuName.length))}`);
    lines.push(`INSERT INTO menus (id, branch_id, name, is_active) VALUES (`);
    lines.push(`  '${menuId}', '${branchId}', ${esc(menuName)}, TRUE`);
    lines.push(`) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`);
    lines.push(``);

    categories.forEach((cat, catIdx) => {
      const catId = stableId(`spur-cat-${key}-${cat.name}`);
      lines.push(`-- Category: ${cat.name} (${cat.items.length} items)`);
      lines.push(`INSERT INTO categories (id, menu_id, name, sort_order) VALUES (`);
      lines.push(`  '${catId}', '${menuId}', ${esc(cat.name)}, ${catIdx}`);
      lines.push(`) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;`);
      lines.push(``);

      cat.items.forEach((item, itemIdx) => {
        const itemId = stableId(`spur-item-${key}-${cat.name}-${item.name}`);
        // Store badges as a JSON array in the description prefix, or as metadata
        const fullDescription = item.description || null;
        const badgesJson = item.badges && item.badges.length > 0
          ? JSON.stringify(item.badges)
          : 'NULL';

        lines.push(`INSERT INTO menu_items`);
        lines.push(`  (id, menu_id, category_id, name, description, price_cents, is_available, sort_order)`);
        lines.push(`VALUES (`);
        lines.push(`  '${itemId}',`);
        lines.push(`  '${menuId}',`);
        lines.push(`  '${catId}',`);
        lines.push(`  ${esc(item.name)},`);
        lines.push(`  ${escOrNull(fullDescription)},`);
        lines.push(`  ${item.price_cents},`);
        lines.push(`  TRUE,`);
        lines.push(`  ${itemIdx}`);
        lines.push(`) ON CONFLICT (id) DO UPDATE`);
        lines.push(`  SET name        = EXCLUDED.name,`);
        lines.push(`      description = EXCLUDED.description,`);
        lines.push(`      price_cents = EXCLUDED.price_cents;`);
        lines.push(``);
      });
    });
  }

  lines.push(`COMMIT;`);
  lines.push(``);
  lines.push(`-- Done.`);

  return lines.join('\n');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  try {
    const standardCategories = await scrapeWithPuppeteer();

    if (standardCategories.length === 0) {
      throw new Error('No categories were scraped. Check your internet connection and try again.');
    }

    const halaalCategories = deriveHalaalCategories(standardCategories);

    console.log(`\n  📊  Summary:`);
    console.log(`       Standard: ${standardCategories.length} categories, ` +
      `${standardCategories.reduce((n, c) => n + c.items.length, 0)} items`);
    console.log(`       Halaal:   ${halaalCategories.length} categories, ` +
      `${halaalCategories.reduce((n, c) => n + c.items.length, 0)} items`);

    if (jsonMode) {
      const output = JSON.stringify({ standard: standardCategories, halaal: halaalCategories }, null, 2);
      if (dryRun) {
        console.log('\n' + output);
      } else {
        const absOut = path.resolve(outFile);
        fs.writeFileSync(absOut, output, 'utf8');
        console.log(`\n✅  JSON written to: ${absOut}`);
      }
      return;
    }

    const sql = buildSQL(standardCategories, halaalCategories);

    if (dryRun) {
      console.log('\n' + sql);
    } else {
      const absOut = path.resolve(outFile);
      fs.writeFileSync(absOut, sql, 'utf8');
      console.log(`\n✅  SQL written to: ${absOut}`);
      console.log(`    Apply with:`);
      console.log(`      psql $DATABASE_URL -f "${absOut}"`);
      console.log(`      supabase db execute -f "${absOut}"`);
    }

  } catch (err) {
    console.error('\n❌  Scrape failed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
