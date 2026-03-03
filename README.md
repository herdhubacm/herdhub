[README.md](https://github.com/user-attachments/files/25699544/README.md)
# 🐄 Herd Hub — American Cattle Market

A full-stack classifieds & marketplace platform for farmers and ranchers to buy, sell, and advertise cattle, equipment, trucks, trailers, working dogs, and farm-to-table products.

---

## 🚀 Quick Start

```bash
# 1. Clone / unzip the project
cd herdhub

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — at minimum set a strong JWT_SECRET

# 4. Initialize database + seed sample data
npm run setup

# 5. Start the server
npm run dev     # development (auto-restarts)
npm start       # production
```

Open **http://localhost:3000** in your browser.

**Default login credentials (from seed data):**
| Role  | Email                    | Password      |
|-------|--------------------------|---------------|
| Admin | admin@herdhub.com        | Password123!  |
| User  | rancher@example.com      | Password123!  |

---

## 📡 USDA Market Data Feed

Live cattle prices are pulled from the **USDA Agricultural Marketing Service (AMS) MARS API** — a free public API that requires no API key.

**Endpoint:** `https://marsapi.ams.usda.gov/services/v1.2`

### Reports used:

| Key              | Report ID  | Description                                    |
|------------------|------------|------------------------------------------------|
| `fed_cattle`     | LM_CT155   | 5-Area Weekly Weighted Average Fed Cattle      |
| `feeder_stocker` | LM_CT150   | National Weekly Feeder & Stocker Cattle        |
| `boxed_beef`     | LM_XB459   | National Daily Boxed Beef Cutout               |
| `cattle_on_feed` | LM_CT166   | Monthly Cattle on Feed Inventory               |

### API endpoints:

| Endpoint                      | Description                                |
|-------------------------------|--------------------------------------------|
| `GET /api/market/ticker`      | Ticker items for the marquee bar           |
| `GET /api/market/prices`      | Full unified market summary                |
| `GET /api/market/report/:id`  | Specific USDA report by ID                 |
| `GET /api/market/cache-status`| Check cache freshness                      |
| `DELETE /api/market/cache`    | Force-refresh market data                  |

Data is **cached in SQLite for 15 minutes** (configurable via `MARKET_CACHE_TTL`) to avoid overloading the public API. If USDA is unreachable, the last cached data is served with a `stale: true` flag.

---

## 🗂️ Full API Reference

### Auth
| Method | Endpoint              | Auth     | Description            |
|--------|-----------------------|----------|------------------------|
| POST   | /api/auth/register    | —        | Create account         |
| POST   | /api/auth/login       | —        | Sign in, get JWT token |
| GET    | /api/auth/me          | ✅ JWT   | Get current user       |
| PUT    | /api/auth/me          | ✅ JWT   | Update profile         |
| POST   | /api/auth/change-password | ✅ JWT | Change password      |

### Listings
| Method | Endpoint                      | Auth       | Description              |
|--------|-------------------------------|------------|--------------------------|
| GET    | /api/listings                 | Optional   | Search/filter listings   |
| GET    | /api/listings/featured        | —          | Homepage featured ads    |
| GET    | /api/listings/stats           | —          | Category counts          |
| GET    | /api/listings/:id             | Optional   | Get listing detail       |
| POST   | /api/listings                 | ✅ JWT     | Create listing           |
| PUT    | /api/listings/:id             | ✅ JWT     | Edit listing             |
| DELETE | /api/listings/:id             | ✅ JWT     | Remove listing           |
| POST   | /api/listings/:id/save        | ✅ JWT     | Save/unsave a listing    |
| POST   | /api/listings/:id/contact     | ✅ JWT     | Message the seller       |
| GET    | /api/listings/user/me         | ✅ JWT     | My listings              |

**Query params for GET /api/listings:**
`category`, `state`, `breed`, `sex`, `min_price`, `max_price`, `q` (full-text), `sort` (featured/newest/price_asc/price_desc), `page`, `limit`

### Forum
| Method | Endpoint                        | Auth   | Description           |
|--------|---------------------------------|--------|-----------------------|
| GET    | /api/forum/topics               | —      | List topics           |
| GET    | /api/forum/topics/:id           | —      | Topic + replies       |
| POST   | /api/forum/topics               | ✅ JWT | Post new topic        |
| POST   | /api/forum/topics/:id/replies   | ✅ JWT | Reply to topic        |

### Payments (Stripe)
| Method | Endpoint                            | Auth   | Description              |
|--------|-------------------------------------|--------|--------------------------|
| POST   | /api/payments/create-checkout       | ✅ JWT | Start Stripe checkout    |
| POST   | /api/payments/webhook               | —      | Stripe webhook handler   |
| GET    | /api/payments/listing/:id/status    | ✅ JWT | Check payment status     |

---

## 💾 Database Schema

SQLite database at `./db/herdhub.sqlite` with these tables:

- **users** — accounts, hashed passwords, state/city
- **listings** — all classifieds with full search index (SQLite FTS5)
- **listing_photos** — multiple photos per listing
- **saved_listings** — user favorites
- **messages** — buyer–seller inbox
- **market_cache** — USDA API response cache
- **forum_topics + forum_replies** — community forum
- **audit_log** — action tracking

---

## 💳 Stripe Payments Setup

1. Create a [Stripe](https://stripe.com) account
2. Create two Products in your Stripe dashboard:
   - **Standard Listing** — $9.95 one-time
   - **Featured Listing** — $24.95 one-time
3. Copy the Price IDs into `.env`:
   ```
   STRIPE_SECRET_KEY=sk_live_...
   STRIPE_PRICE_STANDARD=price_...
   STRIPE_PRICE_FEATURED=price_...
   ```
4. Set up a webhook pointing to `https://yourdomain.com/api/payments/webhook`
5. Copy the webhook secret into `STRIPE_WEBHOOK_SECRET`

---

## 🏗️ Project Structure

```
herdhub/
├── server.js              # Express app entry point
├── .env.example           # Environment variable template
├── package.json
├── db/
│   ├── schema.sql         # SQLite schema
│   └── database.js        # DB connection singleton
├── routes/
│   ├── auth.js            # Registration, login, profile
│   ├── listings.js        # CRUD + search + photos
│   ├── market.js          # USDA AMS market data feed
│   ├── forum.js           # Community forum
│   └── payments.js        # Stripe checkout & webhooks
├── middleware/
│   └── auth.js            # JWT verify, optional auth, admin guard
├── scripts/
│   ├── setup-db.js        # Initialize database
│   └── seed.js            # Sample data seeder
└── public/
    ├── index.html         # Full frontend (single page)
    └── uploads/           # User-uploaded listing photos
```

---

## 🔒 Security Features

- **Helmet.js** — HTTP security headers
- **Rate limiting** — 200 req/15min general, 20/15min auth, 30/min market
- **bcrypt** (12 rounds) — password hashing  
- **JWT** — stateless auth tokens (7-day expiry)
- **Multer** — file type and size validation for uploads
- **SQLite parameterized queries** — SQL injection prevention
- **Stripe webhook signature verification**

---

## 🌐 Deployment

```bash
# Set production environment
NODE_ENV=production
PORT=80  # or use nginx as reverse proxy

# PM2 (recommended)
npm install -g pm2
pm2 start server.js --name herdhub
pm2 save && pm2 startup
```

For HTTPS, place Nginx in front with a Let's Encrypt certificate.

---

## 📞 Support

Built by Herd Hub. Questions? Email support@herdhub.com
