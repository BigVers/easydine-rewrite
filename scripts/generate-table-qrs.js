#!/usr/bin/env node
// scripts/generate-table-qrs.js
//
// Generates printable QR code HTML for each table.
//
// AUTO MODE (recommended — run this every time ngrok restarts):
//   node scripts/generate-table-qrs.js
//
//   Reads branchId from .env (EXPO_PUBLIC_BRANCH_ID)
//   Fetches the current ngrok URL from the local ngrok API automatically
//
// MANUAL MODE (override any value):
//   node scripts/generate-table-qrs.js \
//     --branch-id f6cbfe3b-dd2f-481b-90aa-df9c42208a3a \
//     --web-url https://your-custom-url.ngrok-free.app \
//     --tables "Table 1,Table 2,Table 3,Table 4,Table 5"
//
// Output: table-qr-codes.html  (open in browser, File → Print)

const fs   = require('fs');
const http = require('http');
const path = require('path');

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : null;
}

// ── Read .env for defaults ────────────────────────────────────────────────────
function readEnvFile() {
  const envPaths = [
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
      const env = {};
      for (const line of lines) {
        const match = line.match(/^\s*([^#=\s]+)\s*=\s*(.+?)\s*$/);
        if (match) env[match[1]] = match[2];
      }
      return env;
    }
  }
  return {};
}

// ── Fetch current ngrok URL from local ngrok API ───────────────────────────
function getNgrokUrl() {
  return new Promise((resolve, reject) => {
    // ngrok exposes a local API on port 4040 by default
    const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const tunnels = json.tunnels || [];
          // Find the HTTPS tunnel
          const https = tunnels.find(t => t.proto === 'https');
          if (https) {
            resolve(https.public_url);
          } else if (tunnels.length > 0) {
            resolve(tunnels[0].public_url);
          } else {
            reject(new Error('No ngrok tunnels found'));
          }
        } catch (e) {
          reject(new Error('Failed to parse ngrok API response: ' + e.message));
        }
      });
    });
    req.on('error', (e) => reject(new Error('Could not reach ngrok API at :4040 — is ngrok running? ' + e.message)));
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('ngrok API timed out'));
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const envVars = readEnvFile();

  const branchId  = getArg('branch-id')  || envVars['EXPO_PUBLIC_BRANCH_ID'];
  const tablesRaw = getArg('tables')      || 'Table 1,Table 2,Table 3,Table 4,Table 5';
  const tables    = tablesRaw.split(',').map(t => t.trim()).filter(Boolean);
  const manualUrl = getArg('web-url');

  if (!branchId) {
    console.error('❌  Error: branch ID not found.');
    console.error('    Either set EXPO_PUBLIC_BRANCH_ID in your .env file');
    console.error('    or pass --branch-id <UUID>');
    process.exit(1);
  }

  // Resolve web URL
  let webUrl = manualUrl;
  if (!webUrl) {
    process.stdout.write('🔍  Auto-detecting ngrok URL... ');
    try {
      const raw = await getNgrokUrl();
      // Ensure it ends with no trailing slash (we'll add / before ?)
      webUrl = raw.replace(/\/$/, '');
      console.log(`found: ${webUrl}`);
    } catch (err) {
      console.log('failed.');
      console.error(`\n⚠️   ${err.message}`);
      console.error('    Falling back to http://localhost:5173');
      console.error('    Pass --web-url <url> to set it manually.\n');
      webUrl = 'http://localhost:5173';
    }
  }

  // Build URLs — CRITICAL: use /? not just ? to avoid ngrok stripping query params
  function buildTableUrl(tableName) {
    const params = new URLSearchParams({ branchId, tableName });
    return `${webUrl}/?${params.toString()}`;
  }

  function qrApiUrl(tableUrl) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=4&data=${encodeURIComponent(tableUrl)}`;
  }

  const cards = tables.map(tableName => {
    const tableUrl = buildTableUrl(tableName);
    return `
    <div class="card">
      <div class="restaurant-name">EasyDine</div>
      <div class="table-name">${tableName}</div>
      <img src="${qrApiUrl(tableUrl)}" alt="QR Code for ${tableName}" />
      <div class="instruction">Scan to order &amp; call your waiter</div>
      <div class="url-hint">${tableUrl}</div>
    </div>
  `;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>EasyDine Table QR Codes</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Georgia', serif;
      background: #f5f5f5;
      padding: 24px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      max-width: 900px;
      margin: 0 auto;
    }
    .card {
      background: white;
      border: 2px solid #1a1a1a;
      border-radius: 12px;
      padding: 20px 16px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      page-break-inside: avoid;
    }
    .restaurant-name {
      font-size: 13px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: #888;
    }
    .table-name {
      font-size: 22px;
      font-weight: bold;
      color: #1a1a1a;
    }
    .card img {
      width: 180px;
      height: 180px;
    }
    .instruction {
      font-size: 14px;
      color: #333;
      font-style: italic;
    }
    .url-hint {
      font-size: 10px;
      color: #bbb;
      font-family: monospace;
      word-break: break-all;
    }
    @media print {
      body { background: white; padding: 0; }
      .grid { gap: 12px; }
    }
  </style>
</head>
<body>
  <div class="grid">
    ${cards}
  </div>
  <p style="text-align:center; margin-top:24px; font-size:12px; color:#aaa;">
    Generated ${new Date().toLocaleDateString()} — branch: ${branchId} — ${webUrl}
  </p>
</body>
</html>`;

  const outputPath = path.join(process.cwd(), 'table-qr-codes.html');
  fs.writeFileSync(outputPath, html, 'utf8');

  console.log(`\n✅  Generated ${tables.length} QR codes → table-qr-codes.html`);
  console.log(`    Open in a browser and print (File → Print → Save as PDF)\n`);
  console.log('Tables:');
  tables.forEach(t => console.log(`  • ${t}  →  ${buildTableUrl(t)}`));
  console.log('\n💡  Run this script again each time ngrok restarts to get fresh QR codes.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
