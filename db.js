// Postgres-backed data store (works great with Supabase's free tier).
// server.js only ever calls the functions exported here, so this is the
// only file you'd touch to switch to a different database later.
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');

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

  // Where a signup came from — the in-store QR code by default, or a
  // specific marketing campaign/event (e.g. a Thanksgiving 5K). The
  // customer never picks this themselves (self-reported channel is
  // unreliable) — it's set entirely by which QR code/link they used to
  // land on the signup form, via a `?channel=<slug>` URL param that
  // server.js resolves and passes into createCustomer() below.
  //
  // `signup_bonus_punches`/`signup_bonus_rewards` are what let a campaign
  // hand out an incentive immediately at signup (e.g. "free coffee right
  // off the bat") without any special-case code — createCustomer() just
  // reads whatever this row says and applies it. Adding a new campaign
  // later is a data change (insert a row here), not a code change.
  await pool.query(`
    create table if not exists signup_channels (
      slug text primary key,
      label text not null,
      signup_bonus_punches integer not null default 0,
      signup_bonus_rewards integer not null default 0,
      is_active boolean not null default true,
      created_at timestamptz not null default now()
    );
  `);
  // Which emoji represents a free coffee earned through this channel, shown
  // as a little badge on the customer's punch card (e.g. a turkey for a
  // Thanksgiving 5K campaign) so multiple free coffees on one card read as
  // distinct rewards instead of one generic line. Defaults to the regular
  // party emoji — adding a new campaign later only needs this set if you
  // want something other than that default, still just a data change.
  await pool.query(`alter table signup_channels add column if not exists reward_emoji text not null default '🎉';`);
  await pool.query(`
    insert into signup_channels (slug, label)
    values ('in_store', 'In-Store')
    on conflict (slug) do nothing;
  `);
  await pool.query(`
    alter table customers
    add column if not exists signup_channel text not null default 'in_store' references signup_channels(slug);
  `);
  // This app only ever talks to Postgres directly with a privileged role
  // (see the Pool above), never through Supabase's public REST API — RLS
  // with no policies blocks that separate public API path with zero
  // effect on the app itself. Same reasoning as every other table here.
  await pool.query(`alter table signup_channels enable row level security;`);

  // Which campaign bonuses a customer has already claimed — separate from
  // signup_channel above (which records where they *originally* signed
  // up, forever, for the dashboard's "sign-ups by channel" breakdown).
  // This table is what makes it safe to let a customer who already has a
  // punch card also claim a *different* campaign's bonus later (e.g. an
  // existing regular scanning a Thanksgiving 5K QR): the primary key
  // guarantees each (customer, channel) pair is only ever claimed once,
  // no matter how many times they scan the same QR or how many requests
  // land at the same time.
  await pool.query(`
    create table if not exists channel_claims (
      customer_token uuid not null references customers(token) on delete cascade,
      channel_slug text not null references signup_channels(slug),
      claimed_at timestamptz not null default now(),
      primary key (customer_token, channel_slug)
    );
  `);
  await pool.query(`alter table channel_claims enable row level security;`);

  // One row per free coffee a customer has earned, remembering *where it
  // came from* so the card can show a distinct badge for each one instead
  // of a single generic "free coffee unlocked" line — a birthday coffee
  // shows a cake, a Thanksgiving 5K coffee shows a turkey, a plain 5-punch
  // reward shows the regular party emoji. `redeemed_at` is null while the
  // reward is still sitting unused on the card; redeem() below fills it in
  // (oldest first) instead of deleting the row, so redeemed rewards stay in
  // history. This is deliberately a parallel ledger to customers.free_rewards
  // (not a replacement) — free_rewards stays the fast, simple counter every
  // existing query already relies on; this table only adds "and here's the
  // story behind each one" on top.
  await pool.query(`
    create table if not exists reward_grants (
      id bigserial primary key,
      customer_token uuid not null references customers(token) on delete cascade,
      source text not null,
      channel_slug text references signup_channels(slug),
      emoji text not null default '🎉',
      label text not null default 'Free Coffee',
      created_at timestamptz not null default now(),
      redeemed_at timestamptz
    );
  `);
  await pool.query(`alter table reward_grants enable row level security;`);

  // Safety-net backfill, safe to run on every boot: tops up each customer's
  // unredeemed reward_grants rows until they match their existing
  // free_rewards count. This is what makes existing customers' free
  // coffees (earned before this feature shipped) show up as badges at all
  // — they're labeled with the plain party emoji rather than reconstructed
  // history, since there's no reliable way to know after the fact whether
  // an old free_rewards count came from punches, a birthday, or a campaign.
  // Once a customer is caught up, this is a no-op for them (the
  // greatest(...) below evaluates to 0) — it only ever fills a real gap.
  await pool.query(`
    insert into reward_grants (customer_token, source, emoji, label)
    select c.token, 'punches', '🎉', 'Free Coffee'
    from customers c
    left join (
      select customer_token, count(*)::int as n
      from reward_grants
      where redeemed_at is null
      group by customer_token
    ) g on g.customer_token = c.token
    cross join lateral generate_series(1, greatest(c.free_rewards - coalesce(g.n, 0), 0)) gs(i);
  `);

  // Records every SMS send attempt from the marketing segments page,
  // whether or not it actually went out. `status` is 'simulated' when no
  // SMS provider is configured yet (see sendSmsViaProvider below), so the
  // owner can try the whole flow — write a message, pick a segment, "send"
  // it — and see exactly what would happen, before any texting service or
  // its costs are involved. `batch_id` groups every recipient from one
  // send action together so the history view can show "sent to 42 people"
  // as a single line instead of 42 separate rows.
  await pool.query(`
    create table if not exists sms_log (
      id bigserial primary key,
      batch_id uuid not null,
      customer_token uuid references customers(token) on delete set null,
      segment_id text not null,
      message text not null,
      status text not null,
      error text,
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
    signupChannel: row.signup_channel,
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

// Looks up a signup channel by slug. Returns null if the slug doesn't
// exist or has been deactivated — callers should fall back to the
// 'in_store' channel rather than fail the signup over a bad/stale QR code.
async function getSignupChannel(slug) {
  if (!slug) return null;
  const { rows } = await pool.query(
    `select slug, label, signup_bonus_punches, signup_bonus_rewards, reward_emoji
     from signup_channels where slug = $1 and is_active`,
    [slug]
  );
  return rows[0] || null;
}

async function getActiveSignupChannels() {
  const { rows } = await pool.query(
    `select slug, label, signup_bonus_punches, signup_bonus_rewards, reward_emoji
     from signup_channels where is_active order by created_at`
  );
  return rows;
}

// Unredeemed free coffees for one customer, oldest first — each with the
// emoji/label describing where it came from. This is what lets the card
// show "🎂 🦃 🎉" instead of just a count.
async function getPendingRewards(token) {
  const { rows } = await pool.query(
    `select emoji, label, source, channel_slug, created_at
     from reward_grants
     where customer_token = $1 and redeemed_at is null
     order by created_at asc, id asc`,
    [token]
  );
  return rows.map((r) => ({
    emoji: r.emoji,
    label: r.label,
    source: r.source,
    channelSlug: r.channel_slug,
    earnedAt: r.created_at,
  }));
}

// `channelSlug` records where this signup came from (defaults to
// 'in_store' if missing, unrecognized, or inactive — never blocks a real
// customer over a bad QR code) — this is permanent, for the dashboard's
// "sign-ups by channel" breakdown, and is separate from whatever bonus
// actually gets applied. The customer starts at zero punches/rewards
// regardless of channel; claimChannelBonus() (below, called separately by
// server.js right after this) is what actually grants a campaign's
// incentive, since that same logic also has to work for an *existing*
// customer claiming a bonus later, not just a brand-new signup.
async function createCustomer({ token, email, phone, firstName, lastName, birthday, marketingOptIn, channelSlug }) {
  const optIn = !!marketingOptIn;
  const channel = (await getSignupChannel(channelSlug)) || { slug: 'in_store' };

  const { rows } = await pool.query(
    `insert into customers (token, email, phone, first_name, last_name, birthday, marketing_opt_in, marketing_opt_in_at, signup_channel)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
    [
      token,
      email || null,
      phone || null,
      firstName || null,
      lastName || null,
      birthday || null,
      optIn,
      optIn ? new Date() : null,
      channel.slug,
    ]
  );
  await logEvent(token, 'signup');
  if (optIn) await logEvent(token, 'marketing_opt_in');
  return rowToCustomer(rows[0]);
}

// Grants a signup channel's bonus (bonus punches and/or an outright free
// reward) to a customer — but only the first time, ever, for that
// specific (customer, channel) pair. This is deliberately *not* tied to
// "is this a new signup" — it runs the same way whether someone is
// scanning a campaign QR for the very first time ever, or they've had a
// punch card for a year and are now scanning a *different* campaign's QR
// (e.g. an existing regular claiming the Thanksgiving 5K bonus). The
// primary key on channel_claims is what makes "only the first time" safe
// even against someone scanning the same QR twice in a row.
//
// Returns { claimed, customer }. `claimed` is false (customer unchanged)
// if: the channel doesn't exist/is inactive, it has no bonus configured,
// or this customer already claimed it before.
async function claimChannelBonus(token, channelSlug, punchesNeeded) {
  const channel = await getSignupChannel(channelSlug);
  const hasBonus = channel && ((channel.signup_bonus_punches || 0) > 0 || (channel.signup_bonus_rewards || 0) > 0);
  if (!hasBonus) {
    return { claimed: false, customer: await findByToken(token) };
  }

  const claim = await pool.query(
    `insert into channel_claims (customer_token, channel_slug) values ($1, $2)
     on conflict (customer_token, channel_slug) do nothing
     returning customer_token`,
    [token, channel.slug]
  );
  if (claim.rows.length === 0) {
    // Already claimed this channel's bonus before — no-op.
    return { claimed: false, customer: await findByToken(token) };
  }

  const customer = await findByToken(token);
  if (!customer) return { claimed: false, customer: null };

  let punches = customer.punches + (channel.signup_bonus_punches || 0);
  let bonusRewardsFromPunches = 0;
  if (punchesNeeded && punches >= punchesNeeded) {
    bonusRewardsFromPunches = Math.floor(punches / punchesNeeded);
    punches = punches % punchesNeeded;
  }
  const freeRewards = customer.freeRewards + (channel.signup_bonus_rewards || 0) + bonusRewardsFromPunches;
  const totalCoffees = customer.totalCoffees + (channel.signup_bonus_punches || 0);

  const { rows } = await pool.query(
    `update customers set punches = $1, free_rewards = $2, total_coffees = $3 where token = $4 returning *`,
    [punches, freeRewards, totalCoffees, token]
  );

  // One reward_grants row per free coffee this claim actually handed out
  // (a channel can hand out more than one — a flat signup_bonus_rewards
  // plus whatever rolled over from signup_bonus_punches), each tagged with
  // this channel's own emoji so it shows up as its own badge on the card.
  const grantsToAdd = (channel.signup_bonus_rewards || 0) + bonusRewardsFromPunches;
  if (grantsToAdd > 0) {
    await pool.query(
      `insert into reward_grants (customer_token, source, channel_slug, emoji, label)
       select $1, 'channel', $2, $3, $4 from generate_series(1, $5)`,
      [token, channel.slug, channel.reward_emoji, channel.label, grantsToAdd]
    );
  }

  await logEvent(token, 'campaign_bonus_claimed');
  return { claimed: true, customer: rowToCustomer(rows[0]) };
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
  if (rewardEarned) {
    await logEvent(token, 'reward_earned');
    await pool.query(
      `insert into reward_grants (customer_token, source, emoji, label) values ($1, 'punches', '🎉', 'Free Coffee')`,
      [token]
    );
  }

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

  // Marks the oldest unredeemed reward as used, rather than picking any
  // row arbitrarily, so the badge someone's had the longest is the one
  // that disappears first — matching how redeeming actually feels to a
  // customer with multiple free coffees stacked up.
  await pool.query(
    `update reward_grants
     set redeemed_at = now()
     where id = (
       select id from reward_grants
       where customer_token = $1 and redeemed_at is null
       order by created_at asc, id asc
       limit 1
     )`,
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

  await pool.query(
    `insert into reward_grants (customer_token, source, emoji, label) values ($1, 'birthday', '🎂', 'Birthday Coffee')`,
    [customer.token]
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
// {periodStart, value} shape instead of a hardcoded "punches" field, so one
// helper covers punches, signups, or anything else counted weekly later.
function weeklySeries(rows, weeks) {
  const map = new Map(rows.map((r) => [isoDay(new Date(r.bucket)), r.n]));
  const out = [];
  const thisWeek = weekStart(new Date());
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisWeek);
    d.setUTCDate(d.getUTCDate() - i * 7);
    const key = isoDay(d);
    out.push({ periodStart: key, value: map.get(key) || 0 });
  }
  return out;
}

// Same idea as weeklySeries() above, but bucketed by single calendar day
// instead of by week — powers the owner dashboard's "Day" view, for a
// closer look at recent activity than the weekly trend lines give. Rows
// are expected to already be bucketed in the shop's local day (see the
// `at time zone 'America/New_York'` query in getOwnerDashboard() below),
// same reasoning as the "today" boundary elsewhere in this file: slicing
// on UTC days would shift a day's activity into the wrong bucket for a
// US shop for several hours around each day's edge.
function dailySeries(rows, days) {
  const map = new Map(rows.map((r) => [isoDay(new Date(r.bucket)), r.n]));
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = isoDay(d);
    out.push({ periodStart: key, value: map.get(key) || 0 });
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

// Builds the top-3 VIP leaderboard query for a given time window.
// 'all' trusts the customers.total_coffees running total (fast, and the
// long-standing source of truth for lifetime punches). 'month'/'year'
// instead sum punch events within that window, since total_coffees has
// no concept of "punches earned this month" — it only ever counts up.
// Window boundaries use the shop's local calendar (see punchesToday
// above) so "this month" matches what the owner would expect by eye.
function vipQueryForWindow(vipWindow) {
  if (vipWindow === 'month') {
    return {
      text: `
        select c.first_name, c.last_name, count(*)::int as total_coffees, min(e.created_at) as first_at
        from events e
        join customers c on c.token = e.customer_token
        where e.event_type = 'punch' and not c.is_test
          and e.created_at >= date_trunc('month', now() at time zone 'America/New_York') at time zone 'America/New_York'
        group by c.token, c.first_name, c.last_name
        order by total_coffees desc, first_at asc
        limit 3
      `,
    };
  }
  if (vipWindow === 'year') {
    return {
      text: `
        select c.first_name, c.last_name, count(*)::int as total_coffees, min(e.created_at) as first_at
        from events e
        join customers c on c.token = e.customer_token
        where e.event_type = 'punch' and not c.is_test
          and e.created_at >= date_trunc('year', now() at time zone 'America/New_York') at time zone 'America/New_York'
        group by c.token, c.first_name, c.last_name
        order by total_coffees desc, first_at asc
        limit 3
      `,
    };
  }
  return {
    text: `
      select first_name, last_name, total_coffees, created_at as first_at
      from customers
      where not is_test and total_coffees > 0
      order by total_coffees desc, created_at asc
      limit 3
    `,
  };
}

// Everything the owner-facing dashboard needs in one call: headline
// totals, trend lines (punches and signups) over the requested range, and
// a top-3 leaderboard scoped to the requested VIP window. Excludes is_test
// accounts throughout, same as getStats()/getDashboardStats() — a shop
// owner's numbers should never include anything created while building or
// testing the app.
//
// `granularity` picks whether the trend lines are bucketed by week (the
// original behavior, `weeks` controls how many) or by single day (`days`
// controls how many) — the owner dashboard exposes both as a toggle so an
// owner can zoom into "what happened yesterday" as easily as "how's this
// quarter going."
async function getOwnerDashboard({ weeks = 12, days = 14, vipWindow = 'all', granularity = 'week' } = {}) {
  // Defense in depth: server.js already validates/clamps these, but
  // getOwnerDashboard() shouldn't trust its caller blindly either.
  const safeWeeks = Number.isInteger(weeks) && weeks >= 1 && weeks <= 52 ? weeks : 12;
  const safeDays = [7, 14, 30].includes(days) ? days : 14;
  const safeVipWindow = ['all', 'month', 'year'].includes(vipWindow) ? vipWindow : 'all';
  const safeGranularity = ['week', 'day'].includes(granularity) ? granularity : 'week';
  const vipQuery = vipQueryForWindow(safeVipWindow);

  // Day buckets are computed in the shop's local timezone (same reasoning
  // as "today" elsewhere in this file); week buckets stay in plain UTC,
  // matching the original behavior — a week-wide bucket doesn't shift
  // noticeably from a few hours of timezone offset the way a single day's
  // bucket would.
  const seriesQuery = (eventType) =>
    safeGranularity === 'day'
      ? pool.query(
          `
      select date_trunc('day', e.created_at at time zone 'America/New_York') as bucket, count(*)::int as n
      from events e join customers c on c.token = e.customer_token
      where e.event_type = $2 and not c.is_test and e.created_at >= now() - make_interval(days => $1)
      group by bucket order by bucket
    `,
          [safeDays, eventType]
        )
      : pool.query(
          `
      select date_trunc('week', e.created_at) as bucket, count(*)::int as n
      from events e join customers c on c.token = e.customer_token
      where e.event_type = $2 and not c.is_test and e.created_at >= now() - make_interval(days => $1)
      group by bucket order by bucket
    `,
          [safeWeeks * 7, eventType]
        );

  const [totalsRes, punchesRes, punchesTodayRes, signupsTodayRes, rollingRes, rewardsRes, repeatRes, seriesPunchesRaw, seriesSignupsRaw, vipRaw] = await Promise.all([
    pool.query(`select count(*)::int as n from customers where not is_test`),
    pool.query(`select coalesce(sum(total_coffees), 0)::int as n from customers where not is_test`),
    // "Today" means the shop's local business day, not the database's UTC
    // day — the database itself runs in UTC, so slicing on UTC midnight
    // would zero these out mid-afternoon/evening for a US shop. Bucketing
    // in America/New_York (and letting Postgres's named-zone handling take
    // care of daylight saving) keeps this aligned with when the shop is
    // actually open. Hardcoded to this shop's timezone for now — if this
    // app ever serves shops in other timezones, this needs to become a
    // per-shop setting instead of a hardcoded zone.
    pool.query(`
      select count(*)::int as n from events e
      join customers c on c.token = e.customer_token
      where e.event_type = 'punch' and not c.is_test
        and e.created_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York'
        and e.created_at < (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York'
    `),
    pool.query(`
      select count(*)::int as n from events e
      join customers c on c.token = e.customer_token
      where e.event_type = 'signup' and not c.is_test
        and e.created_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York'
        and e.created_at < (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York'
    `),
    // Rolling 7-day comparison for the "up/down vs. last week" note under
    // each chart. Comparing calendar weeks (this week so far vs. all of
    // last week) makes the trend look falsely "down" for most of every
    // week, since a partial week is compared against a complete one. Two
    // fixed 7-day windows — the last 7 days vs. the 7 days before that —
    // are always apples-to-apples regardless of what day it is. Windows
    // end at the close of the shop's local "today" (see punchesToday
    // above) so today's activity counts in the "last 7 days" bucket.
    pool.query(`
      select
        count(*) filter (
          where e.event_type = 'punch' and e.created_at >= b.day_end - interval '7 days' and e.created_at < b.day_end
        )::int as punches_last7,
        count(*) filter (
          where e.event_type = 'punch' and e.created_at >= b.day_end - interval '14 days' and e.created_at < b.day_end - interval '7 days'
        )::int as punches_prev7,
        count(*) filter (
          where e.event_type = 'signup' and e.created_at >= b.day_end - interval '7 days' and e.created_at < b.day_end
        )::int as signups_last7,
        count(*) filter (
          where e.event_type = 'signup' and e.created_at >= b.day_end - interval '14 days' and e.created_at < b.day_end - interval '7 days'
        )::int as signups_prev7
      from events e
      join customers c on c.token = e.customer_token
      cross join (
        select (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York' as day_end
      ) b
      where e.event_type in ('punch', 'signup') and not c.is_test
        and e.created_at >= b.day_end - interval '14 days' and e.created_at < b.day_end
    `),
    pool.query(`
      select count(*)::int as n from events e
      join customers c on c.token = e.customer_token
      where e.event_type in ('reward_earned', 'birthday_reward', 'campaign_bonus_claimed') and not c.is_test
    `),
    pool.query(`
      select
        count(*)::int as total,
        count(*) filter (where total_coffees >= 2)::int as repeat
      from customers where not is_test
    `),
    seriesQuery('punch'),
    seriesQuery('signup'),
    pool.query(vipQuery.text),
  ]);

  const totalSignups = totalsRes.rows[0].n;
  const repeatCustomers = repeatRes.rows[0].repeat;
  const rolling = rollingRes.rows[0];
  const buildSeries = safeGranularity === 'day' ? dailySeries : weeklySeries;
  const seriesRange = safeGranularity === 'day' ? safeDays : safeWeeks;

  return {
    totalSignups,
    totalPunches: punchesRes.rows[0].n,
    punchesToday: punchesTodayRes.rows[0].n,
    signupsToday: signupsTodayRes.rows[0].n,
    punchesRolling7: { last7: rolling.punches_last7, prev7: rolling.punches_prev7 },
    signupsRolling7: { last7: rolling.signups_last7, prev7: rolling.signups_prev7 },
    totalRewardsEarned: rewardsRes.rows[0].n,
    repeatCustomers,
    repeatRatePercent: totalSignups > 0 ? Math.round((repeatCustomers / totalSignups) * 100) : 0,
    granularity: safeGranularity,
    weeks: safeWeeks,
    days: safeDays,
    series: {
      punches: buildSeries(seriesPunchesRaw.rows, seriesRange),
      signups: buildSeries(seriesSignupsRaw.rows, seriesRange),
    },
    vipWindow: safeVipWindow,
    vip: vipRaw.rows.map((r) => ({
      name: vipDisplayName(r.first_name, r.last_name),
      totalCoffees: r.total_coffees,
    })),
  };
}

// ---------- owner dashboard: signups by acquisition channel ----------
//
// Every customer is tagged with the channel they signed up through (see
// signup_channels / createCustomer() above) — this answers "where are our
// regulars actually coming from," which is exactly what makes a campaign
// like a Thanksgiving 5K QR code provable rather than anecdotal. Left-joins
// signup_channels so a channel that's since been deactivated (a past
// campaign) still shows its historical signups with its real label,
// instead of disappearing or falling back to its raw slug.
async function getSignupChannelBreakdown() {
  const { rows } = await pool.query(`
    select
      c.signup_channel as slug,
      coalesce(sc.label, c.signup_channel) as label,
      count(*)::int as signups,
      coalesce(sum(c.total_coffees), 0)::int as punches,
      coalesce(sum(c.redeemed_rewards), 0)::int as redeemed
    from customers c
    left join signup_channels sc on sc.slug = c.signup_channel
    where not c.is_test
    group by c.signup_channel, sc.label
    order by signups desc
  `);
  return rows;
}

// ---------- marketing: customer segmentation ----------
//
// This is the data layer behind the owner-facing "Marketing" page: a set
// of predefined customer segments (e.g. "signed up today," "one punch
// from a reward") that an owner can browse, preview, and export as a CSV
// to paste into whatever they actually send email/SMS from — Mailchimp,
// their phone, etc. This app deliberately does not send messages itself;
// it just answers "who should I message, and what do I know about them."
//
// New segments only need an entry added to segmentDefinitions() — the
// count, preview, and export routes all derive from that one list.

// Every segment query takes `includeNonOptedIn` (default false). With it
// false, only customers who checked the marketing opt-in box at signup
// are included. This matters because the whole point of this feature is
// exporting a list to actually message people, and messaging someone who
// didn't consent — especially over SMS — is both bad practice and, in the
// US, real legal exposure (TCPA) for whoever hits "send." Defaulting to
// opted-in-only makes the safe choice the easy choice; the toggle exists
// for an owner who wants to see full segment size for planning purposes.
function optInClause(includeNonOptedIn, alias = 'c') {
  return includeNonOptedIn ? 'true' : `${alias}.marketing_opt_in`;
}

function segmentDefinitions(punchesNeeded) {
  const oneAway = Math.max(punchesNeeded - 1, 0);
  return [
    {
      id: 'signed_up_today',
      label: 'Signed Up Today',
      description: "Joined the program today — a welcome or first-visit nudge lands best while it's fresh.",
      buildQuery: (includeNonOptedIn) => ({
        text: `
          select c.token, c.first_name, c.last_name, c.email, c.phone, c.marketing_opt_in, c.total_coffees, c.created_at
          from customers c
          where not c.is_test and ${optInClause(includeNonOptedIn)}
            and c.created_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York'
            and c.created_at < (date_trunc('day', now() at time zone 'America/New_York') + interval '1 day') at time zone 'America/New_York'
          order by c.created_at desc
        `,
      }),
    },
    {
      id: 'one_away_from_reward',
      label: 'One Punch Away From a Reward',
      description: `Sitting at ${oneAway} of ${punchesNeeded} punches — a nudge now could be the difference between them finishing the card or letting it go cold.`,
      buildQuery: (includeNonOptedIn) => ({
        text: `
          select c.token, c.first_name, c.last_name, c.email, c.phone, c.marketing_opt_in, c.punches, c.total_coffees, c.created_at
          from customers c
          where not c.is_test and ${optInClause(includeNonOptedIn)} and c.punches = $1
          order by c.created_at desc
        `,
        values: [oneAway],
      }),
    },
    {
      id: 'lapsed_14_days',
      label: 'Lapsed — No Punch in 14+ Days',
      description: "Signed up more than two weeks ago and haven't punched in the last 14 days — classic win-back territory.",
      buildQuery: (includeNonOptedIn) => ({
        text: `
          select c.token, c.first_name, c.last_name, c.email, c.phone, c.marketing_opt_in, c.total_coffees, c.created_at, lp.last_punch_at
          from customers c
          left join lateral (
            select max(e.created_at) as last_punch_at
            from events e
            where e.customer_token = c.token and e.event_type = 'punch'
          ) lp on true
          where not c.is_test and ${optInClause(includeNonOptedIn)}
            and c.created_at < now() - interval '14 days'
            and (lp.last_punch_at is null or lp.last_punch_at < now() - interval '14 days')
          order by coalesce(lp.last_punch_at, c.created_at) asc
        `,
      }),
    },
    {
      id: 'new_this_week',
      label: 'New This Week',
      description: 'Signed up in the last 7 days — still forming a habit, a good window for an extra-warm offer.',
      buildQuery: (includeNonOptedIn) => ({
        text: `
          select c.token, c.first_name, c.last_name, c.email, c.phone, c.marketing_opt_in, c.total_coffees, c.created_at
          from customers c
          where not c.is_test and ${optInClause(includeNonOptedIn)} and c.created_at >= now() - interval '7 days'
          order by c.created_at desc
        `,
      }),
    },
    {
      id: 'reward_ready',
      label: 'Reward Ready to Redeem',
      description: "Already earned a free reward and haven't cashed it in — a reminder text writes itself.",
      buildQuery: (includeNonOptedIn) => ({
        text: `
          select c.token, c.first_name, c.last_name, c.email, c.phone, c.marketing_opt_in, c.free_rewards, c.total_coffees, c.created_at
          from customers c
          where not c.is_test and ${optInClause(includeNonOptedIn)} and c.free_rewards > 0
          order by c.free_rewards desc, c.created_at asc
        `,
      }),
    },
    {
      id: 'birthday_this_month',
      label: 'Birthday This Month',
      description: 'Birthday falls in the current month — a nice hook for a personal-feeling promo beyond the automatic birthday reward.',
      buildQuery: (includeNonOptedIn) => ({
        text: `
          select c.token, c.first_name, c.last_name, c.email, c.phone, c.marketing_opt_in, c.birthday, c.total_coffees, c.created_at
          from customers c
          where not c.is_test and ${optInClause(includeNonOptedIn)} and c.birthday is not null
            and extract(month from c.birthday) = extract(month from now() at time zone 'America/New_York')
          order by extract(day from c.birthday) asc
        `,
      }),
    },
  ];
}

// Per-segment human-readable context column, shown in both the on-page
// preview table and the exported CSV so the "why is this person on this
// list" reason travels with the row instead of living only in the segment
// name.
function formatSegmentDetail(segmentId, row) {
  switch (segmentId) {
    case 'one_away_from_reward':
      return `${row.punches} punches so far`;
    case 'reward_ready':
      return `${row.free_rewards} reward${row.free_rewards === 1 ? '' : 's'} waiting`;
    case 'lapsed_14_days':
      return row.last_punch_at ? `Last punch ${isoDay(new Date(row.last_punch_at))}` : 'Never punched';
    case 'birthday_this_month': {
      if (!row.birthday) return '';
      const d = new Date(row.birthday);
      return `Birthday ${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    }
    default:
      return `${row.total_coffees} lifetime punches`;
  }
}

async function getMarketingSegments(punchesNeeded, includeNonOptedIn = false) {
  const defs = segmentDefinitions(punchesNeeded);
  const results = await Promise.all(
    defs.map((def) => {
      const q = def.buildQuery(includeNonOptedIn);
      return pool.query(`select count(*)::int as n from (${q.text}) as segment_rows`, q.values || []);
    })
  );
  return defs.map((def, i) => ({
    id: def.id,
    label: def.label,
    description: def.description,
    count: results[i].rows[0].n,
  }));
}

async function getMarketingSegmentCustomers(segmentId, punchesNeeded, includeNonOptedIn = false) {
  const defs = segmentDefinitions(punchesNeeded);
  const def = defs.find((d) => d.id === segmentId);
  if (!def) return null;

  const q = def.buildQuery(includeNonOptedIn);
  const { rows } = await pool.query(q.text, q.values || []);

  return {
    id: def.id,
    label: def.label,
    description: def.description,
    customers: rows.map((row) => ({
      token: row.token,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      phone: row.phone,
      marketingOptIn: row.marketing_opt_in,
      joinedAt: row.created_at,
      detail: formatSegmentDetail(def.id, row),
    })),
  };
}

// Plain CSV, no external dependency — this app has stayed dependency-free
// for exports/reports throughout (see the hand-rolled charts), so a small
// hand-rolled escaper is consistent with that and one less package to
// audit/update.
function customersToCsv(customers) {
  const columns = [
    { label: 'First Name', value: (c) => c.firstName || '' },
    { label: 'Last Name', value: (c) => c.lastName || '' },
    { label: 'Email', value: (c) => c.email || '' },
    { label: 'Phone', value: (c) => c.phone || '' },
    { label: 'Marketing Opt-In', value: (c) => (c.marketingOptIn ? 'Yes' : 'No') },
    { label: 'Joined', value: (c) => (c.joinedAt ? isoDay(new Date(c.joinedAt)) : '') },
    { label: 'Detail', value: (c) => c.detail || '' },
  ];
  const escape = (val) => {
    const s = val === null || val === undefined ? '' : String(val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map((c) => escape(c.label)).join(',');
  const lines = customers.map((c) => columns.map((col) => escape(col.value(c))).join(','));
  return [header, ...lines].join('\r\n');
}

// ---------- marketing: SMS sending (simulation-first) ----------
//
// This is deliberately built "simulation-first": every function here
// works fully today — pick a segment, write a message, hit send, get a
// real summary back — but no actual text goes out until a real SMS
// provider is configured (see sendSmsViaProvider). That means the whole
// workflow can be built, demoed, and tested for free, with zero risk of
// accidentally texting a real customer, before signing up for Twilio (or
// anything else) and taking on its cost/compliance requirements.

// Swaps {firstName} in a message template for the customer's first name
// (or a generic fallback if they didn't give one). Deliberately minimal —
// one merge field, not a templating engine — since the entire message is
// short-form SMS copy an owner types themselves.
function renderMessageTemplate(template, customer) {
  const firstName = customer.firstName || 'there';
  return template.replace(/\{firstName\}/gi, firstName);
}

// The one seam that turns this from a simulator into a real SMS sender.
// If TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER aren't
// all set, every send is simulated — logged and returned to the caller
// exactly like a real send, just never transmitted. Once those env vars
// exist (and the `twilio` package is installed — it's intentionally not a
// dependency yet, since there's no reason to require it before it's
// needed), this same function starts actually sending, and nothing else
// in this file needs to change.
async function sendSmsViaProvider(to, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    return { status: 'simulated' };
  }

  let twilio;
  try {
    // eslint-disable-next-line global-require
    twilio = require('twilio');
  } catch (err) {
    return {
      status: 'failed',
      error: "Twilio credentials are set but the 'twilio' package isn't installed. Run: npm install twilio",
    };
  }

  try {
    const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    await client.messages.create({ to, from: TWILIO_FROM_NUMBER, body });
    return { status: 'sent' };
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
}

// Sends (or simulates) one message to every customer in a segment.
// Always opted-in-only, regardless of what the segment browser's toggle
// is set to — unlike viewing/exporting a list for your own planning,
// actually messaging people is the one action where silently including
// non-consenting customers would be a real problem, so there's no
// override here on purpose.
async function sendSegmentSms(segmentId, punchesNeeded, message) {
  const segment = await getMarketingSegmentCustomers(segmentId, punchesNeeded, false);
  if (!segment) return null;

  const batchId = uuidv4();
  const withPhone = segment.customers.filter((c) => c.phone);
  const skippedNoPhone = segment.customers.length - withPhone.length;

  const results = [];
  for (const customer of withPhone) {
    const rendered = renderMessageTemplate(message, customer);
    const outcome = await sendSmsViaProvider(customer.phone, rendered);
    await pool.query(
      `insert into sms_log (batch_id, customer_token, segment_id, message, status, error)
       values ($1, $2, $3, $4, $5, $6)`,
      [batchId, customer.token, segmentId, rendered, outcome.status, outcome.error || null]
    );
    results.push({ name: customer.firstName || customer.lastName || 'Customer', phone: customer.phone, message: rendered, status: outcome.status });
  }

  const sentCount = results.filter((r) => r.status === 'sent').length;
  const simulatedCount = results.filter((r) => r.status === 'simulated').length;
  const failedCount = results.filter((r) => r.status === 'failed').length;

  return {
    batchId,
    segmentId,
    segmentLabel: segment.label,
    totalRecipients: withPhone.length,
    skippedNoPhone,
    sentCount,
    simulatedCount,
    failedCount,
    isLive: sentCount > 0 || failedCount > 0, // false when every send was simulated
    previews: results.slice(0, 5),
  };
}

// Recent send batches for the "send history" view — one row per batch
// (not per recipient), so an owner can see "sent to 42 people on Sep 9"
// as a single glanceable line.
async function getSmsBatches(limit = 20) {
  const { rows } = await pool.query(
    `
      select
        batch_id,
        segment_id,
        max(message) as message,
        count(*)::int as recipient_count,
        count(*) filter (where status = 'sent')::int as sent_count,
        count(*) filter (where status = 'simulated')::int as simulated_count,
        count(*) filter (where status = 'failed')::int as failed_count,
        min(created_at) as sent_at
      from sms_log
      group by batch_id, segment_id
      order by sent_at desc
      limit $1
    `,
    [limit]
  );
  return rows.map((r) => ({
    batchId: r.batch_id,
    segmentId: r.segment_id,
    message: r.message,
    recipientCount: r.recipient_count,
    sentCount: r.sent_count,
    simulatedCount: r.simulated_count,
    failedCount: r.failed_count,
    sentAt: r.sent_at,
  }));
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
  getSignupChannelBreakdown,
  getActiveSignupChannels,
  claimChannelBonus,
  getPendingRewards,
  getMarketingSegments,
  getMarketingSegmentCustomers,
  customersToCsv,
  sendSegmentSms,
  getSmsBatches,
};
