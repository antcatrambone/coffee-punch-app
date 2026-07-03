// Postgres-backed data store (works great with Supabase's free tier).
// server.js only ever calls the functions exported here, so this is the
// only file you'd touch to switch to a different database later.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's pooled connection requires SSL; this works for that and
  // for most other hosted Postgres providers too.
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function init() {
  await pool.query(`
    create table if not exists customers (
      token uuid primary key,
      email text unique,
      phone text unique,
      punches integer not null default 0,
      free_rewards integer not null default 0,
      total_coffees integer not null default 0,
      created_at timestamptz not null default now()
    );
  `);
}

function rowToCustomer(row) {
  if (!row) return null;
  return {
    token: row.token,
    email: row.email,
    phone: row.phone,
    punches: row.punches,
    freeRewards: row.free_rewards,
    totalCoffees: row.total_coffees,
    createdAt: row.created_at,
  };
}

async function findByToken(token) {
  const { rows } = await pool.query('select * from customers where token = $1', [token]);
  return rowToCustomer(rows[0]);
}

// Looks a customer up by email OR phone — whichever one is provided.
async function findByContact({ email, phone }) {
  const { rows } = await pool.query(
    `select * from customers
     where ($1::text is not null and email = $1)
        or ($2::text is not null and phone = $2)
     limit 1`,
    [email || null, phone || null]
  );
  return rowToCustomer(rows[0]);
}

async function createCustomer({ token, email, phone }) {
  const { rows } = await pool.query(
    `insert into customers (token, email, phone) values ($1, $2, $3) returning *`,
    [token, email || null, phone || null]
  );
  return rowToCustomer(rows[0]);
}

// Adds one punch, rolling over into a free reward at punchesNeeded.
// Returns { customer, rewardEarned } or null if the token doesn't exist.
async function addPunch(token, punchesNeeded) {
  const customer = await findByToken(token);
  if (!customer) return null;

  let punches = customer.punches + 1;
  let freeRewards = customer.freeRewards;
  let rewardEarned = false;

  if (punches >= punchesNeeded) {
    punches = 0;
    freeRewards += 1;
    rewardEarned = true;
  }

  const { rows } = await pool.query(
    `update customers
     set punches = $1, free_rewards = $2, total_coffees = total_coffees + 1
     where token = $3
     returning *`,
    [punches, freeRewards, token]
  );
  return { customer: rowToCustomer(rows[0]), rewardEarned };
}

// Redeems one free reward. Returns { error: 'not_found' | 'none_available' }
// or { customer } on success.
async function redeem(token) {
  const customer = await findByToken(token);
  if (!customer) return { error: 'not_found' };
  if (customer.freeRewards <= 0) return { error: 'none_available' };

  const { rows } = await pool.query(
    `update customers set free_rewards = free_rewards - 1 where token = $1 returning *`,
    [token]
  );
  return { customer: rowToCustomer(rows[0]) };
}

module.exports = { init, findByToken, findByContact, createCustomer, addPunch, redeem };
