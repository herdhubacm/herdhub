# Herd Hub – PostgreSQL Migration Guide

Complete guide to setting up and running the PostgreSQL version of Herd Hub.

---

## What Changed From SQLite

| Area | SQLite (old) | PostgreSQL (new) |
|---|---|---|
| Driver | `better-sqlite3` | `pg` (node-postgres) |
| Queries | Synchronous | Async/await |
| Placeholders | `?` | `$1, $2, $3...` |
| Auto-increment | `INTEGER AUTOINCREMENT` | `BIGSERIAL` |
| Timestamps | `datetime('now')` | `NOW()` |
| Full-text search | SQLite FTS5 | Native `tsvector` + GIN index |
| JSON storage | `TEXT` blob | `JSONB` (queryable) |
| Upsert | `INSERT OR REPLACE` | `INSERT ... ON CONFLICT DO UPDATE` |
| Connection | Single file handle | Connection pool (10 connections) |
| Auto-update triggers | Manual | `BEFORE UPDATE` triggers on `users`, `forum_topics`, `listings` |

---

## Option 1: Local Setup (Development)

### Install PostgreSQL

**macOS:**
```bash
brew install postgresql@16
brew services start postgresql@16
```

**Ubuntu/Debian:**
```bash
sudo apt update && sudo apt install postgresql postgresql-contrib -y
sudo systemctl start postgresql
```

**Windows:**
Download from https://www.postgresql.org/download/windows/

### Create the database

```bash
# Connect as postgres superuser
psql -U postgres

# Inside psql:
CREATE DATABASE herdhub;
CREATE USER herdhub_user WITH ENCRYPTED PASSWORD 'your_strong_password';
GRANT ALL PRIVILEGES ON DATABASE herdhub TO herdhub_user;
# PostgreSQL 15+ also needs this:
\c herdhub
GRANT ALL ON SCHEMA public TO herdhub_user;
\q
```

### Configure .env

```bash
cp .env.example .env
```

Edit `.env`:
```env
DATABASE_URL=postgresql://herdhub_user:your_strong_password@localhost:5432/herdhub
JWT_SECRET=your_64_char_random_string_here
NODE_ENV=development
PORT=3000
```

Generate a strong JWT secret:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### Install and run

```bash
npm install
npm run db:migrate   # creates all tables, indexes, and triggers
npm run db:seed      # inserts sample data
npm run dev          # start with auto-restart
```

Open http://localhost:3000

---

## Option 2: Railway (Recommended for Production)

Railway is the fastest path from code to live URL.

### Steps

1. **Push to GitHub**
   ```bash
   git init && git add . && git commit -m "Initial commit"
   # Create repo on github.com, then:
   git remote add origin https://github.com/YOU/herdhub.git
   git push -u origin main
   ```

2. **Create Railway project**
   - Go to https://railway.app → New Project → Deploy from GitHub
   - Select your `herdhub` repo
   - Railway auto-detects Node.js

3. **Add PostgreSQL**
   - In your Railway project → New → Database → PostgreSQL
   - Railway automatically sets `DATABASE_URL` in your environment

4. **Set environment variables** in Railway dashboard:
   ```
   NODE_ENV=production
   JWT_SECRET=<your 64-char secret>
   PORT=3000
   ```

5. **Run migrations** (one-time, from Railway's shell tab):
   ```bash
   npm run db:migrate
   npm run db:seed
   ```

6. **Add custom domain** in Railway → Settings → Domains

Total time: ~15 minutes. Cost: ~$5/month.

---

## Option 3: Render

1. Create account at https://render.com
2. New → Web Service → connect your GitHub repo
3. Build command: `npm install && npm run db:migrate`
4. Start command: `npm start`
5. Add a **Render PostgreSQL** database → copy the `DATABASE_URL` → add to environment variables

---

## Option 4: Supabase (Managed PostgreSQL)

Supabase gives you hosted PostgreSQL with a nice dashboard.

1. Create project at https://supabase.com
2. Settings → Database → Connection string → copy `DATABASE_URL`
3. Add to `.env` or Railway/Render environment variables
4. Run `npm run db:migrate` locally pointing at Supabase

```env
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@db.[PROJECT-ID].supabase.co:5432/postgres
```

Note: Supabase connection strings require SSL. The `pg` pool in `db/database.js` enables `ssl: { rejectUnauthorized: false }` automatically when `NODE_ENV=production`.

---

## Option 5: DigitalOcean ($6/mo VPS)

```bash
# On your droplet:
sudo apt update && sudo apt install nodejs npm postgresql nginx certbot -y
sudo systemctl start postgresql

# Create DB (same as local setup above)

# Clone your repo
git clone https://github.com/YOU/herdhub.git
cd herdhub
cp .env.example .env   # fill in values
npm install
npm run db:migrate
npm run db:seed

# Run with PM2
npm install -g pm2
pm2 start server.js --name herdhub
pm2 startup && pm2 save

# Nginx config at /etc/nginx/sites-available/herdhub:
# server {
#   listen 80;
#   server_name herdhub.com www.herdhub.com;
#   location / { proxy_pass http://localhost:3000; proxy_http_version 1.1; }
# }

sudo ln -s /etc/nginx/sites-available/herdhub /etc/nginx/sites-enabled/
sudo certbot --nginx -d herdhub.com -d www.herdhub.com
sudo systemctl reload nginx
```

---

## Verifying Your Setup

### Health check
```bash
curl http://localhost:3000/api/health
# Should return: { "status": "ok", "db": "postgres connected" }
```

### Test the API
```bash
# Register a user
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"Password123!","name":"Test User"}'

# Get listings
curl http://localhost:3000/api/listings

# Get USDA market prices
curl http://localhost:3000/api/market/prices
```

### Check FTS is working
```bash
curl "http://localhost:3000/api/listings?q=angus+bull"
```

---

## Database Maintenance

### Backup
```bash
pg_dump $DATABASE_URL > herdhub_backup_$(date +%Y%m%d).sql
```

### Restore
```bash
psql $DATABASE_URL < herdhub_backup_20260301.sql
```

### Expire old listings (run as a cron job)
```sql
UPDATE listings SET status='expired'
WHERE expires_at < NOW() AND status='active';
```

Add to crontab (runs daily at 2am):
```bash
0 2 * * * psql $DATABASE_URL -c "UPDATE listings SET status='expired' WHERE expires_at < NOW() AND status='active';"
```

---

## PostgreSQL Features Used

### Native Full-Text Search
The `search_vector` column is a `tsvector` maintained by a `BEFORE INSERT/UPDATE` trigger. It uses weighted fields:
- **A weight** (highest): title
- **B weight**: breed, category
- **C weight**: city, state
- **D weight** (lowest): description

Search query example:
```sql
SELECT * FROM listings
WHERE search_vector @@ plainto_tsquery('english', 'registered angus bull')
ORDER BY ts_rank(search_vector, plainto_tsquery('english', 'registered angus bull')) DESC;
```

### JSONB for Market Cache
Market data from USDA is stored as native `JSONB`, enabling queries like:
```sql
SELECT data->'ticker' FROM market_cache WHERE report_id = 'unified_prices';
```

### Connection Pool
The `pg.Pool` is configured with:
- Max 10 connections (configurable via `PG_POOL_MAX`)
- 30s idle timeout
- 5s connection timeout
- Automatic error logging and reconnection

---

## Troubleshooting

**`ECONNREFUSED` on startup**
→ PostgreSQL is not running. Start it: `brew services start postgresql@16` (Mac) or `sudo systemctl start postgresql` (Linux)

**`role "herdhub_user" does not exist`**
→ Run the `CREATE USER` SQL in the local setup steps above.

**`permission denied for schema public`**
→ PostgreSQL 15+ changed defaults. Run: `GRANT ALL ON SCHEMA public TO herdhub_user;`

**`SSL SYSCALL error` on Supabase/Railway**
→ Already handled — the pool sets `ssl: { rejectUnauthorized: false }` in production.

**`cannot read properties of undefined (reading 'rows')`**
→ A `query()` call threw an error that was swallowed. Check server logs for the underlying DB error.

---

## Next Steps After Deployment

1. [ ] Point your domain DNS to your host
2. [ ] Enable HTTPS (automatic on Railway/Render, use Certbot on VPS)
3. [ ] Set up S3/Cloudflare R2 for photo storage (photos currently save to disk)
4. [ ] Configure Stripe with live keys
5. [ ] Set up daily pg_dump backups
6. [ ] Add the cron job to expire old listings
7. [ ] Set `NODE_ENV=production` in your host environment
