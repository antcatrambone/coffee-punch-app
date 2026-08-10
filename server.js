require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const PUNCHES_NEEDED = parseInt(process.env.PUNCHES_NEEDED || '5', 10);
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------

function normalizeEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return e || null;
}

function normalizePhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  return digits || null;
}

function normalizeName(name) {
  const n = (name || '').trim();
  return n || null;
}

// The signup form only collects month + day (a fixed placeholder year is
// used to build this string client-side, since the birthday reward check
// below ignores year entirely). We re-validate and re-build it here too,
// rather than trusting the client's year, so a direct API call can't ever
// store a bogus or future-dated birthday.
const BIRTHDAY_PLACEHOLDER_YEAR = 2000;

function normalizeBirthday(birthday) {
  const b = (birthday || '').trim();
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(b);
  if (!match) return null;

  const month = parseInt(match[1], 10);
  const day = parseInt(match[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Round-trip through Date to catch invalid combinations like Feb 30 —
  // the UTC constructor silently rolls those into the next month instead
  // of throwing, so we compare the parts back out.
  const check = new Date(Date.UTC(BIRTHDAY_PLACEHOLDER_YEAR, month - 1, day));
  if (check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day) return null;

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${BIRTHDAY_PLACEHOLDER_YEAR}-${mm}-${dd}`;
}

function publicCustomer(c) {
  return {
    token: c.token,
    email: c.email,
    phone: c.phone,
    firstName: c.firstName,
    lastName: c.lastName,
    birthday: c.birthday,
    marketingOptIn: c.marketingOptIn,
    punches: c.punches,
    punchesNeeded: PUNCHES_NEEDED,
    freeRewards: c.freeRewards,
    redeemedRewards: c.redeemedRewards,
    totalCoffees: c.totalCoffees,
    isTest: c.isTest,
    createdAt: c.createdAt,
  };
}

function requireStaffPin(req, res, next) {
  const pin = req.headers['x-staff-pin'] || (req.body && req.body.pin);
  if (pin !== STAFF_PIN) {
    return res.status(401).json({ error: 'Incorrect staff PIN.' });
  }
  next();
}

// Wraps an async route handler so thrown errors/rejections become a 500
// instead of crashing the process or hanging the request.
function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((err) => {
      console.error(err);
      res.status(500).json({ error: 'Something went wrong on the server.' });
    });
  };
}

// Recomputes shop-wide totals and pushes them to every connected stats
// page. Called after anything that changes punches/rewards/signups.
async function broadcastStats() {
  try {
    const stats = await db.getStats();
    io.emit('stats-updated', stats);
  } catch (err) {
    console.error('Failed to broadcast stats:', err);
  }
}

// ---------- customer-facing API ----------

// Create a card, or return the existing one for this email/phone (idempotent).
app.post(
  '/api/signup',
  asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const phone = normalizePhone(req.body.phone);
    const firstName = normalizeName(req.body.firstName);
    const lastName = normalizeName(req.body.lastName);
    const birthday = normalizeBirthday(req.body.birthday);
    const marketingOptIn = req.body.marketingOptIn === true;

    if (!email && !phone) {
      return res.status(400).json({ error: 'Enter an email address or phone number.' });
    }

    let customer = await db.findByContact({ email, phone });
    let isNew = false;
    if (!customer) {
      customer = await db.createCustomer({ token: uuidv4(), email, phone, firstName, lastName, birthday, marketingOptIn });
      isNew = true;
    }

    if (isNew) broadcastStats();
    res.json(publicCustomer(customer));
  })
);

app.get(
  '/api/customer/:token',
  asyncRoute(async (req, res) => {
    const customer = await db.findByToken(req.params.token);
    if (!customer) return res.status(404).json({ error: 'Card not found.' });

    const { customer: updated, birthdayGranted } = await db.maybeGrantBirthday(customer);
    if (birthdayGranted) broadcastStats();
    res.json({ ...publicCustomer(updated), birthdayGranted });
  })
);

// ---------- staff-facing API (requires PIN) ----------

app.get(
  '/api/stats',
  requireStaffPin,
  asyncRoute(async (req, res) => {
    const stats = await db.getStats();
    res.json(stats);
  })
);

app.get(
  '/api/staff/dashboard',
  requireStaffPin,
  asyncRoute(async (req, res) => {
    const dashboard = await db.getDashboardStats();
    res.json(dashboard);
  })
);

app.post(
  '/api/staff/lookup',
  requireStaffPin,
  asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body.contact);
    const phone = normalizePhone(req.body.contact);
    const customer = await db.findByContact({ email, phone });
    if (!customer) {
      return res.status(404).json({ error: 'No card found for that email or phone.' });
    }

    const { customer: updated, birthdayGranted } = await db.maybeGrantBirthday(customer);
    if (birthdayGranted) broadcastStats();
    res.json({ ...publicCustomer(updated), birthdayGranted });
  })
);

app.post(
  '/api/staff/punch',
  requireStaffPin,
  asyncRoute(async (req, res) => {
    const { token } = req.body;
    const result = await db.addPunch(token, PUNCHES_NEEDED);
    if (!result) return res.status(404).json({ error: 'Card not found.' });

    const payload = { ...publicCustomer(result.customer), rewardEarned: result.rewardEarned };
    io.to(result.customer.token).emit('punch-added', payload);
    broadcastStats();
    res.json(payload);
  })
);

app.post(
  '/api/staff/redeem',
  requireStaffPin,
  asyncRoute(async (req, res) => {
    const { token } = req.body;
    const result = await db.redeem(token);
    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'Card not found.' });
    }
    if (result.error === 'none_available') {
      return res.status(400).json({ error: 'This customer has no free coffee to redeem.' });
    }

    const payload = publicCustomer(result.customer);
    io.to(result.customer.token).emit('reward-redeemed', payload);
    broadcastStats();
    res.json(payload);
  })
);

// Marks (or unmarks) a card as a test/dev account, e.g. anything created
// while trying out the signup flow yourself. Test accounts stay fully
// intact — nothing is deleted — they're just excluded from /api/stats and
// the staff dashboard from that point on.
app.post(
  '/api/staff/mark-test',
  requireStaffPin,
  asyncRoute(async (req, res) => {
    const { token, isTest } = req.body;
    const customer = await db.setTestFlag(token, isTest !== false);
    if (!customer) return res.status(404).json({ error: 'Card not found.' });

    broadcastStats();
    res.json(publicCustomer(customer));
  })
);

// ---------- realtime ----------

io.on('connection', (socket) => {
  socket.on('join', (token) => {
    if (typeof token === 'string' && token) socket.join(token);
  });
});

db.init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Coffee punch app listening on port ${PORT}`);
      console.log(`Staff PIN is ${STAFF_PIN} (set STAFF_PIN env var to change it).`);
    });
  })
  .catch((err) => {
    console.error('Failed to set up the database:', err);
    process.exit(1);
  });
