// Tiny file-based data store. Good enough for a single coffee shop's
// punch-card volume. Swap this module out for a real database later
// if you outgrow it — every other file only talks to load()/save().
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(DB_FILE)) {
    return { customers: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (err) {
    console.error('Could not read data.json, starting fresh:', err.message);
    return { customers: [] };
  }
}

function save(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = { load, save };
