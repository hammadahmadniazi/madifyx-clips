// Emergency password reset. Stop the app first, then run:
//   node reset-password.js you@email.com newpassword
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.log('Usage: node reset-password.js you@email.com newpassword   (password 8+ characters)');
  process.exit(1);
}
const DB_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'db.json');
if (!fs.existsSync(DB_FILE)) { console.log('No database found at ' + DB_FILE); process.exit(1); }
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const user = Object.values(db.users || {}).find(u => u.email === email.trim().toLowerCase());
if (!user) { console.log('No account with that email.'); process.exit(1); }
user.salt = crypto.randomBytes(16).toString('hex');
user.hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
for (const [t, s] of Object.entries(db.sessions || {})) if (s.userId === user.id) delete db.sessions[t];
fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
console.log(`Password updated for ${user.name} (${user.email}). Start the app again and sign in.`);
