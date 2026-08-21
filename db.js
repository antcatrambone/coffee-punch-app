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

  // Marketing consent — not acted on by any code yet (no emails/texts are
  // actually sent). This just captures the opt-in itself, with a
  // timestamp, so there's a clean consent record ready for whenever
  // email/SMS campaigns are turned on.
  await pool.query(`alter table customers add column if not exists marketing_opt_in boolean not null default false;`);
  await pool.query(`alter table customers add column if not exists marketing_opt_in_at timestamptz;`);

  // Lifetime count of redeemed free rewards — distinct from free_rewards,
  // which is how many they currently have *available* to redeem right now.
  // This one only ever goes up.
  await pool.query(`alter table customers add column if not exists redeemed_rewards integer not null default 0;`);

  // Marks dev/QA signups (test cards created while building or testing the
  // app) so they can be excluded from every stats/dashboard query without
  // ever deleting the underlying rows. Defaults to false for real
  // customers; flip it with setTestFlag() for anything that isn't a real
  // customer, present or future.
  await pool.query(`alter table customers add column if not exists is_test boolean not null default false;`);

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

  // Not backfilling on purpose: redeemed_rewards starts at 0 for every
  // existing customer and only counts redemptions from here forward. If
  // you change your mind later, the historical numbers are still sitting
  // in the events table (event_type = 'redeem') and can be backfilled
  // any time with:
  //
  //   update customers
  //   set redeemed_rewards = sub.cnt
  //   from (
  //     select customer_token, count(*)::int as cnt
  //     from events
  //     where event_type = 'redeem'
  //     group by customer_token
  //   ) sub
  //   where customers.token = sub.customer_token;

  // Infrastructure for future multi-tier rewards (e.g. free merch at 20
  // punches, in addition to a free coffee at 5). The app doesn't act on
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
    values (5, 'Free Coffee')
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
    marketingOptIn: row.marketing_opt_in,
    marketingOptInAt: row.marketing_opt_in_at,
    punches: row.punches,
    freeRewards: row.free_rewards,
    redeemedRewards: row.redeemed_rewards,
    totalCoffees: row.total_coffees,
    isTest: row.is_test,
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

async function createCustomer({ token, email, phone, firstName, lastName, birthday, marketingOptIn }) {
  const optIn = !!marketingOptIn;
  const { rows } = await pool.query(
    `insert into customers (token, email, phone, first_name, last_name, birthday, marketing_opt_in, marketing_opt_in_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [
      token,
      email || null,
      phone || null,
      firstName || null,
      lastName || null,
      birthday || null,
      optIn,
      optIn ? new Date() : null,
    ]
  );
  await logEvent(token, 'signup');
  if (optIn) await logEvent(token, 'marketing_opt_in');
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
    `update customers
     set free_rewards = free_rewards - 1, redeemed_rewards = redeemed_rewards + 1
     where token = $1
     returning *`,
    [token]
  );

  await logEvent(token, 'redeem');
  return { customer: rowToCustomer(rows[0]) };
}

// Marks (or unmarks) a customer as a test/dev account. Test accounts stay
// in the table — full history intact, nothing deleted — they're just
// excluded from getStats() and getDashboardStats() below. Returns the
// updated customer, or null if the token doesn't exist.
async function setTestFlag(token, isTest) {
  const { rows } = await pool.query(
    `update customers set is_test = $1 where token = $2 returning *`,
    [!!isTest, token]
  );
  return rowToCustomer(rows[0]);
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

// Shop-wide totals for the live stats page. Excludes anything flagged
// is_test — dev/QA accounts never count toward numbers shown to the shop
// or used in marketing.
async function getStats() {
  const [punches, customers, redeemed, outstanding] = await Promise.all([
    pool.query(`select coalesce(sum(total_coffees), 0)::int as n from customers where not is_test`),
    pool.query(`select count(*)::int as n from customers where not is_test`),
    pool.query(`
      select count(*)::int as n from events e
      join customers c on c.token = e.customer_token
      where e.event_type = 'redeem' and not c.is_test
    `),
    pool.query(`select coalesce(sum(free_rewards), 0)::int as n from customers where not is_test`),
  ]);
  return {
    totalPunches: punches.rows[0].n,
    totalCustomers: customers.rows[0].n,
    totalRedeemed: redeemed.rows[0].n,
    outstandingRewards: outstanding.rows[0].n,
  };
}

// ---------- dashboard: punch trends + repeat customers ----------

function isoDay(d) { return d.toISOString().slice(0, 10); }
function isoMonth(d) { return d.toISOString().slice(0, 7); }

// Monday-based week start, matching Postgres's date_trunc('week', ...).
function weekStart(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setUTCDate(date.getUTCDate() + diff);
  return date;
}

// Turns sparse "bucket -> count" rows into a fixed-length, zero-filled
// array covering the last N days/weeks/months, so gaps in activity show
// up as 0 in the chart instead of just being skipped.
function fillDaily(rows, days) {
  const map = new Map(rows.map((r) => [isoDay(new Date(r.bucket)), r.punches]));
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = isoDay(d);
    out.push({ bucket: key, punches: map.get(key) || 0 });
  }
  return out;
}

function fillWeekly(rows, weeks) {
  const map = new Map(rows.map((r) => [isoDay(new Date(r.bucket)), r.punches]));
  const out = [];
  const thisWeek = weekStart(new Date());
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisWeek);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const key = isoDay(d);
    out.push({ bucket: key, punches: map.get(key) || 0 });
  }
  return out;
}

function fillMonthly(rows, months) {
  const map = new Map(rows.map((r) => [isoMonth(new Date(r.bucket)), r.punches]));
  const out = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = isoMonth(d);
    out.push({ bucket: key, punches: map.get(key) || 0 });
  }
  return out;
}

// Day-over-day (30d), week-over-week (12wk), and month-over-month (12mo)
// punch counts, plus how many customers have ever come back for a second
// coffee (total_coffees >= 2 — total_coffees is a lifetime counter that
// never resets, even across free-reward rollovers). Excludes is_test
// accounts throughout, same as getStats().
async function getDashboardStats() {
  const [dailyRaw, weeklyRaw, monthlyRaw, repeat] = await Promise.all([
    pool.query(
      `select date_trunc('day', e.created_at) as bucket, count(*)::int as punches
       from events e join customers c on c.token = e.customer_token
       where e.event_type = 'punch' and not c.is_test and e.created_at >= now() - interval '30 days'
       group by bucket order by bucket`
    ),
    pool.query(
      `select date_trunc('week', e.created_at) as bucket, count(*)::int as punches
       from events e join customers c on c.token = e.customer_token
       where e.event_type = 'punch' and not c.is_test and e.created_at >= now() - interval '84 days'
       group by bucket order by bucket`
    ),
    pool.query(
      `select date_trunc('month', e.created_at) as bucket, count(*)::int as punches
       from events e join customers c on c.token = e.customer_token
       where e.event_type = 'punch' and not c.is_test and e.created_at >= now() - interval '365 days'
       group by bucket order by bucket`
    ),
    pool.query(`select count(*)::int as n from customers where total_coffees >= 2 and not is_test`),
  ]);

  return {
    daily: fillDaily(dailyRaw.rows, 30),
    weekly: fillWeekly(weeklyRaw.rows, 12),
    monthly: fillMonthly(monthlyRaw.rows, 12),
    repeatCustomers: repeat.rows[0].n,
  };
}

// ---------- owner dashboard: high-level business metrics ----------

// Same weekly bucketing as fillWeekly above, but with a generic
// {weekStart, value} shape instead of a hardcoded "punches" field, so one
// helper covers punches, signups, or anything else counted weekly later.
function weeklySeries(rows, weeks) {
  const map = new Map(rows.map((r) => [isoDay(new Date(r.bucket)), r.n]));
  const out = [];
  const thisWeek = weekStart(new Date());
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisWeek);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const key = isoDay(d);
    out.push({ weekStart: key, value: map.get(key) || 0 });
  }
  return out;
}

// Turns a name into something friendly for a leaderboard without exposing
// a full last name on a screen that might be visible at the counter.
function vipDisplayName(firstName, lastName) {
  if (firstName && lastName) return `${firstName} ${lastName.charAt(0).toUpperCase()}.`;
  if (firstName) return firstName;
  return 'A loyal regular';
}

// Everything the owner-facing dashboard needs in one call: headline
// totals, two 12-week trend lines (punches and signups), and a top-3
// leaderboard by lifetime punches. Excludes is_test accounts throughout,
// same as getStats()/getDashboardStats() — a shop owner's numbers should
// never include anything created while building or testing the app.
async function getOwnerDashboard() {
  const [totalsRes, punchesRes, punchesTodayRes, rewardsRes, repeatRes, weeklyPunchesRaw, weeklySignupsRaw, vipRaw] = await Promise.all([
    pool.query(`select count(*)::int as n from customers where not is_test`),
    pool.query(`select coalesce(sum(total_coffees), 0)::int as n from customers where not is_test`),
    // Same UTC-day bucketing as fillDaily above, just narrowed to "today."
    pool.query(`
      select count(*)::int as n from events e
      join customers c on c.token = e.customer_token
      where e.event_type = 'punch' and not c.is_test
        and e.created_at >= date_trunc('day', now())
        and e.created_at < date_trunc('day', now()) + interval '1 day'
    `),
    pool.query(`
      select count(*)::int as n from events e
      join customers c on c.token = e.customer_token
      where e.event_type in ('reward_earned', 'birthday_reward') and not c.is_test
    `),
    pool.query(`
      select
        count(*)::int as total,
        count(*) filter (where total_coffees >= 2)::int as repeat
      from customers where not is_test
    `),
    pool.query(`
      select date_trunc('week', e.created_at) as bucket, count(*)::int as n
      from events e join customers c on c.token = e.customer_token
      where e.event_type = 'punch' and not c.is_test and e.created_at >= now() - interval '84 days'
      group by bucket order by bucket
    `),
    pool.query(`
      select date_trunc('week', e.created_at) as bucket, count(*)::int as n
      from events e join customers c on c.token = e.customer_token
      where e.event_type = 'signup' and not c.is_test and e.created_at >= now() - interval '84 days'
      group by bucket order by bucket
    `),
    pool.query(`
      select first_name, last_name, total_coffees
      from customers
      where not is_test and total_coffees > 0
      order by total_coffees desc, created_at asc
      limit 3
    `),
  ]);

  const totalSignups = totalsRes.rows[0].n;
  const repeatCustomers = repeatRes.rows[0].repeat;

  return {
    totalSignups,
    totalPunches: punchesRes.rows[0].n,
    punchesToday: punchesTodayRes.rows[0].n,
    totalRewardsEarned: rewardsRes.rows[0].n,
    repeatCustomers,
    repeatRatePercent: totalSignups > 0 ? Math.round((repeatCustomers / totalSignups) * 100) : 0,
    weeklyPunches: weeklySeries(weeklyPunchesRaw.rows, 12),
    weeklySignups: weeklySeries(weeklySignupsRaw.rows, 12),
    vip: vipRaw.rows.map((r) => ({
      name: vipDisplayName(r.first_name, r.last_name),
      totalCoffees: r.total_coffees,
    })),
  };
}

module.exports = {
  init,
  findByToken,
  findByContact,
  createCustomer,
  addPunch,
  redeem,
  setTestFlag,
  maybeGrantBirthday,
  getStats,
  getDashboardStats,
  getOwnerDashboard,
};
