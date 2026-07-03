# Coffee Punch Card

A virtual punch card for a coffee shop. Customers sign up with an email or
phone number, get a card with an animated stamp + sound every time staff
scan them, and unlock a free coffee after 10 punches.

## How it works

- **Customers** open the web app, enter their email or phone, and get a
  personal card with a QR code. The card is remembered on their phone
  (no app install needed — it works like a bookmarked web page).
- **Staff** open `/staff.html` on a phone or tablet behind the counter,
  enter a shared PIN once, and scan each customer's QR code with the
  camera. Tapping "Add punch" instantly updates the customer's card —
  the stamp animation and sound fire live on the customer's screen.
- After the 10th punch, the counter resets, a "free coffee" reward is
  added to their account, and confetti + a chime play. Staff redeem it
  with one tap the next time that customer orders.
- Customers are tracked by normalized email (lowercased) or phone
  (digits only) — signing up twice with the same contact info just
  reopens the same card instead of creating a duplicate.

## Project layout

```
server.js         Express + Socket.IO backend (all API routes)
db.js             Tiny JSON file data store (data.json, created on first use)
public/
  index.html      Customer sign-up page
  card.html       Customer's punch card (animation + sound + QR code)
  staff.html      Staff scanner (camera QR scan + manual lookup)
  js/config.js    Shop name / tagline — edit this to rebrand
  js/card.js      Punch card rendering, live updates, animation
  js/staff.js     Scanner logic, PIN gate, manual lookup
  js/sounds.js    Synthesized "stamp" and "reward" sounds (Web Audio API)
  css/style.css   All styling (paper punch-card look)
```

## Running it locally

Requires Node.js 18+.

```
npm install
cp .env.example .env      # edit STAFF_PIN before real use
npm start
```

Then open:
- `http://localhost:3000` — customer sign-up
- `http://localhost:3000/staff.html` — staff scanner

## Deploying so it works outside your kitchen Wi-Fi

Any Node.js host works. Two easy free/cheap options:

**Render**
1. Push this folder to a GitHub repo.
2. Create a new "Web Service" on Render, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add environment variable `STAFF_PIN` with your real PIN.
5. Render gives you a URL like `https://your-shop.onrender.com`.

**Railway**
1. Push to GitHub, then "New Project" → "Deploy from repo" on Railway.
2. Railway auto-detects Node and runs `npm start`.
3. Add the `STAFF_PIN` variable in the project's Variables tab.

Once deployed, print the URL (or a QR code linking to it) on a table
tent or receipt so customers can sign up, and bookmark `/staff.html`
on the shop's phone/tablet.

## Data storage note

Customer data lives in `data.json` next to the server — fine for a
single shop's punch-card volume. If you outgrow it (multiple
locations, need backups/reporting), swap `db.js` for a real database;
every route only calls `db.load()` / `db.save()`, so it's the only
file that needs to change.

## Security notes

- The staff PIN is shared across your team and only gates the
  "add punch" / "redeem" actions — it's meant to stop random people
  from tapping punches into their own card, not as strong auth.
  Rotate it if a device is lost.
- Anyone with a customer's QR code (a photo of it, say) could have
  staff punch it — same as a physical stamp card. Loyalty apps at this
  scale generally accept that tradeoff.

## Adding real Apple Wallet passes later

The current app already mimics the Wallet card experience in the
browser, so customers don't need to install anything. If you later
want an actual `.pkpass` that lives in Apple Wallet (with lock-screen
notifications when a punch is added), you'll need to obtain:

1. An Apple Developer Program account ($99/year) — this has to be
   opened by the business, Anthropic/Claude can't create it for you.
2. A Pass Type ID and its signing certificate from Apple's developer
   portal.
3. A small addition to this backend that generates and signs `.pkpass`
   files (a zip of JSON + images + a manifest signed with your
   certificate) and implements Apple's Wallet web service protocol so
   passes update automatically when a punch is added.

Once you have the Apple Developer account and certificate, that
`.pkpass` generation code can be added to this same backend without
changing the customer/staff flows already built.
