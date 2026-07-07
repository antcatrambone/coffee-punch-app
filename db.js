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

// Shop is in St. Petersburg, FL — birthdays are checked against this
// timezone rather than whatever timezone the server happens to run in.
const SHOP_TIMEZONE = 'America/New_York';

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

  // Safe to run every time the server starts — adds these columns if this
  // table already existed from before names/birthdays were tracked.
  await pool.query(`alter table customers add column if not exists first_name text;`);
  await pool.query(`alter table customers add column if not exists last_name text;`);
  await pool.query(`alter table customers add column if not exists birthday date;`);
  await pool.query(`alter table customers add column if not exists birthday_reward_year integer;`);

  // One row per signup/punch/reward/redemption, so you can run retention
  // and frequency analysis in Supabase's SQL editor later.
  await pool.query(`
    create table if not exists events (
      id bigserial primary key,
      customer_token uuid not null references customers(token) on delete cascade,
      event_type text not null,
      created_at timestamptz not null default now()
    );
  `);

  // Infrastructure for future multi-tier rewards (e.g. free merch at 20
  // punches, in addition to a free coffee at 10). The app doesn't act on
  // this table yet — punches still only check the single PUNCHES_NEEDED
  // threshold from server.js — but the reward structure already lives in
  // the database instead of being hardcoded, so extending it later is a
  // data change, not a schema change. `total_coffees` on customers never
  // resets, so it's already the right lifetime counter to check multiple
  // thresholds against once that logic is built.
  await pool.query(`
    create table if not exists reward_tiers (
      id serial primary key,
      threshold integer not null unique,
      name text not null,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(`
    insert into reward_tiers (threshold, name)
    values (10, 'Free Coffee')
    on conflict (threshold) do nothing;
  `);
}

function rowToCustomer(row) {
  if (!row) return null;
  return {
    token: row.token,
    email: row.email,
    phone: row.phone,
    firstName: row.first_name,
    lastName: row.last_name,
    birthday: row.birthday,
    birthdayRewardYear: row.birthday_reward_year,
    punches: row.punches,
    freeRewards: row.free_rewards,
    totalCoffees: row.total_coffees,
    createdAt: row.created_at,
  };
}

async function logEvent(token, eventType) {
  await pool.query(
    `insert into events (customer_token, event_type) values ($1, $2)`,
    [token, eventType]
  );
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

async function createCustomer({ token, email, phone, firstName, lastName, birthday }) {
  const { rows } = await pool.query(
    `insert into customers (token, email, phone, first_name, last_name, birthday)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [token, email || null, phone || null, firstName || null, lastName || null, birthday || null]
  );
  await logEvent(token, 'signup');
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

  await logEvent(token, 'punch');
  if (rewardEarned) await logEvent(token, 'reward_earned');

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

  await logEvent(token, 'redeem');
  return { customer: rowToCustomer(rows[0]) };
}

// Today's date in the shop's timezone, regardless of what timezone the
// server itself happens to run in.
function shopToday() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { year: parseInt(parts.year, 10), month: parseInt(parts.month, 10), day: parseInt(parts.day, 10) };
}

// If today is the customer's birthday (in the shop's timezone) and they
// haven't already received this year's birthday coffee, grants one and
// logs it. Safe to call every time a customer's card is loaded — it's a
// no-op on every day that isn't their birthday, and only fires once per
// year even if they open the app multiple times that day.
async function maybeGrantBirthday(customer) {
  if (!customer || !customer.birthday) {
    return { customer, birthdayGranted: false };
  }

  const bday = new Date(customer.birthday);
  const today = shopToday();
  const isBirthdayToday = bday.getUTCMonth() + 1 === today.month && bday.getUTCDate() === today.day;

  if (!isBirthdayToday || customer.birthdayRewardYear === today.year) {
    return { customer, birthdayGranted: false };
  }

  const { rows } = await pool.query(
    `update customers
     set free_rewards = free_rewards + 1, birthday_reward_year = $1
     where token = $2
     returning *`,
    [today.year, customer.token]
  );

  await logEvent(customer.token, 'birthday_reward');
  return { customer: rowToCustomer(rows[0]), birthdayGranted: true };
}

// Shop-wide totals for the live stats page.
async function getStats() {
  const [punches, customers, redeemed, outstanding] = await Promise.all([
    pool.query(`select coalesce(sum(total_coffees), 0)::int as n from customers`),
    pool.query(`select count(*)::int as n from customers`),
    pool.query(`select count(*)::int as n from events where event_type = 'redeem'`),
    pool.query(`select coalesce(sum(free_rewards), 0)::int as n from customers`),
  ]);
  return {
    totalPunches: punches.rows[0].n,
    totalCustomers: customers.rows[0].n,
    totalRedeemed: redeemed.rows[0].n,
    outstandingRewards: outstanding.rows[0].n,
  };
}

module.exports = {
  init,
  findByToken,
  findByContact,
  createCustomer,
  addPunch,
  redeem,
  maybeGrantBirthday,
  getStats,
};
