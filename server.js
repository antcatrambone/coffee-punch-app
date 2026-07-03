require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const PUNCHES_NEEDED = parseInt(process.env.PUNCHES_NEEDED || '10', 10);
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

// Expects the value an <input type="date"> sends: "YYYY-MM-DD", or empty.
function normalizeBirthday(birthday) {
  const b = (birthday || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(b) ? b : null;
}

function publicCustomer(c) {
  return {
    token: c.token,
    email: c.email,
    phone: c.phone,
    firstName: c.firstName,
    lastName: c.lastName,
    birthday: c.birthday,
    punches: c.punches,
    punchesNeeded: PUNCHES_NEEDED,
    freeRewards: c.freeRewards,
    totalCoffees: c.totalCoffees,
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

    if (!email && !phone) {
      return res.status(400).json({ error: 'Enter an email address or phone number.' });
    }

    let customer = await db.findByContact({ email, phone });
    if (!customer) {
      customer = await db.createCustomer({ token: uuidv4(), email, phone, firstName, lastName, birthday });
    }

    res.json(publicCustomer(customer));
  })
);

app.get(
  '/api/customer/:token',
  asyncRoute(async (req, res) => {
    const customer = await db.findByToken(req.params.token);
    if (!customer) return res.status(404).json({ error: 'Card not found.' });

    const { customer: updated, birthdayGranted } = await db.maybeGrantBirthday(customer);
    res.json({ ...publicCustomer(updated), birthdayGranted });
  })
);

// ---------- staff-facing API (requires PIN) ----------

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
    res.json(payload);
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
