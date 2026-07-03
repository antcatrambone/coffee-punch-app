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

function publicCustomer(c) {
  return {
    token: c.token,
    email: c.email,
    phone: c.phone,
    punches: c.punches,
    punchesNeeded: PUNCHES_NEEDED,
    freeRewards: c.freeRewards,
    totalCoffees: c.totalCoffees,
    createdAt: c.createdAt,
  };
}

function findCustomer(data, { token, email, phone }) {
  return data.customers.find(
    (c) =>
      (token && c.token === token) ||
      (email && c.email === email) ||
      (phone && c.phone === phone)
  );
}

function requireStaffPin(req, res, next) {
  const pin = req.headers['x-staff-pin'] || (req.body && req.body.pin);
  if (pin !== STAFF_PIN) {
    return res.status(401).json({ error: 'Incorrect staff PIN.' });
  }
  next();
}

// ---------- customer-facing API ----------

// Create a card, or return the existing one for this email/phone (idempotent).
app.post('/api/signup', (req, res) => {
  const email = normalizeEmail(req.body.email);
  const phone = normalizePhone(req.body.phone);

  if (!email && !phone) {
    return res.status(400).json({ error: 'Enter an email address or phone number.' });
  }

  const data = db.load();
  let customer = findCustomer(data, { email, phone });

  if (!customer) {
    customer = {
      token: uuidv4(),
      email,
      phone,
      punches: 0,
      freeRewards: 0,
      totalCoffees: 0,
      createdAt: new Date().toISOString(),
    };
    data.customers.push(customer);
    db.save(data);
  }

  res.json(publicCustomer(customer));
});

app.get('/api/customer/:token', (req, res) => {
  const data = db.load();
  const customer = data.customers.find((c) => c.token === req.params.token);
  if (!customer) return res.status(404).json({ error: 'Card not found.' });
  res.json(publicCustomer(customer));
});

// ---------- staff-facing API (requires PIN) ----------

app.post('/api/staff/lookup', requireStaffPin, (req, res) => {
  const email = normalizeEmail(req.body.contact);
  const phone = normalizePhone(req.body.contact);
  const data = db.load();
  const customer = findCustomer(data, { email, phone });
  if (!customer) {
    return res.status(404).json({ error: 'No card found for that email or phone.' });
  }
  res.json(publicCustomer(customer));
});

app.post('/api/staff/punch', requireStaffPin, (req, res) => {
  const { token } = req.body;
  const data = db.load();
  const customer = data.customers.find((c) => c.token === token);
  if (!customer) return res.status(404).json({ error: 'Card not found.' });

  customer.totalCoffees += 1;
  customer.punches += 1;

  let rewardEarned = false;
  if (customer.punches >= PUNCHES_NEEDED) {
    customer.punches = 0;
    customer.freeRewards += 1;
    rewardEarned = true;
  }

  db.save(data);

  const payload = { ...publicCustomer(customer), rewardEarned };
  io.to(customer.token).emit('punch-added', payload);
  res.json(payload);
});

app.post('/api/staff/redeem', requireStaffPin, (req, res) => {
  const { token } = req.body;
  const data = db.load();
  const customer = data.customers.find((c) => c.token === token);
  if (!customer) return res.status(404).json({ error: 'Card not found.' });
  if (customer.freeRewards <= 0) {
    return res.status(400).json({ error: 'This customer has no free coffee to redeem.' });
  }

  customer.freeRewards -= 1;
  db.save(data);

  const payload = publicCustomer(customer);
  io.to(customer.token).emit('reward-redeemed', payload);
  res.json(payload);
});

// ---------- realtime ----------

io.on('connection', (socket) => {
  socket.on('join', (token) => {
    if (typeof token === 'string' && token) socket.join(token);
  });
});

server.listen(PORT, () => {
  console.log(`Coffee punch app listening on port ${PORT}`);
  console.log(`Staff PIN is ${STAFF_PIN} (set STAFF_PIN env var to change it).`);
});
