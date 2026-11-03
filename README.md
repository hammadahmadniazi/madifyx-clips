# Madifyx Clips

Your own screen recorder with share links. Record your screen, voice and camera in the browser, get a link instantly, and keep every video on your own server. No per seat fees.

## What it does

- **Library home page** with search, and a team view for admins
- **Three ways to record:** screen and camera, screen only, or camera only
- **On phones:** a full screen camera recorder with front/back camera flip (phone browsers can't share their screen)
- **Upload a video** from your computer or camera roll instead of recording; large phone videos are resized to 1080p
- **Floating controls** in Chrome and Edge: your camera bubble plus pause and finish stay on top of other apps
- Microphone and computer sound mixed together, 3 second countdown, pause, discard
- When you finish, it saves and opens the video's page with the link already copied
- **Share page** clients can open without an account: creator name, speed control, view count, emoji reactions and timestamped comments
- **Invite links** for teammates: they pick their own password
- Videos are converted to mp4 with thumbnails when ffmpeg is installed, so they play on iPhones too

Shortcuts while recording (with the app tab focused): Alt+Shift+P pause, Alt+Shift+S finish.

## Accounts

- The first time you open the app, it asks you to set up the **admin account**. That's you.
- Set `OWNER_EMAIL` so only that email can create the owner account. That email is always an owner, even if it joined some other way.
- **Sign up page:** on the Team page, switch on **Sign up page**. Your team can then create their own profiles at `/signup` (for example record.madifyx.com/signup), and the sign in page shows a "Create an account" link. Switch it off when everyone has joined.
- **One-time invites:** click **Invite teammate** for a private link that works once and expires in 7 days (it can also make someone an admin).
- Everyone can change their own name and password on the Account page.
- **Email verification:** new accounts (sign up page and invites) get a 6-digit code by email and are only created once the code, or the button in the email, is used. This needs an email service: create a free [Resend](https://resend.com) account, add and verify your domain there, then set `RESEND_API_KEY` and `MAIL_FROM` (for example `Madifyx Clips <clips@madifyx.com>`). The sign up page can only be switched on once email is set up.
- **Members** record and see their own videos. **Admins** also invite people and can switch the library to "Whole team".
- Removing someone moves their videos to you, so their links keep working.
- Video pages (`/v/...`) never need a login.
- Forgot the admin password? Stop the app and run: `node reset-password.js you@email.com newpassword`

## Plans and payments (Stripe)

Anyone can sign up at `/signup` and gets their **own private workspace** on the Free plan. Workspaces never see each other's people or videos.

| | Free | Pro (paid, flat monthly price) |
|---|---|---|
| Videos | 25 per workspace | Unlimited |
| Recording length | 5 minutes | No limit |
| Teammates | Just you | Invite links and a team join link |
| Share pages | "Recorded with Madifyx Clips" | Your workspace name instead |

- Your own workspace (and anyone you choose) is **Free forever**: everything included at no cost. Switch it on per workspace on the **Admin** page, which only the `OWNER_EMAIL` account can open.
- Upgrades go through **Stripe Checkout**; customers manage or cancel in the **Stripe Customer Portal** (Manage billing). A signed webhook keeps plans in sync.
- If a subscription ends, the workspace returns to Free: nothing is deleted, but they can't add more than the free limits.

**Stripe setup**
1. In Stripe, create a **Product** (for example "Madifyx Clips Pro") with a **recurring monthly price**. Copy the price ID (`price_...`).
2. **Developers > API keys**: copy the **Secret key** (`sk_live_...`, or `sk_test_...` while testing).
3. **Developers > Webhooks > Add endpoint**: URL `https://record.madifyx.com/api/stripe/webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the **Signing secret** (`whsec_...`).
4. **Settings > Billing > Customer portal**: save the settings once so customers can manage and cancel.
5. Add `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET` in Render.

Free plan limits can be changed with `FREE_MAX_VIDEOS` and `FREE_MAX_SECONDS`.

## Run it on your computer

Needs Node.js 18 or newer, nothing else to install. ffmpeg is optional but recommended (on Mac: `brew install ffmpeg`, on Windows: `winget install ffmpeg`).

```bash
node server.js
```

Open http://localhost:3000 in Chrome or Edge.

## Put it online for free (Render + Cloudflare R2)

Render runs the app from this GitHub repo for free. Its free plan wipes the disk on every restart, so videos and accounts are kept in Cloudflare R2 (10 GB free).

**Cloudflare R2 (where videos are kept)**
1. In the Cloudflare dashboard, open **R2 Object Storage** and turn it on (Cloudflare asks for a card, the free 10 GB isn't charged).
2. Click **Create bucket**, name it `madifyx-clips`, and create it.
3. Back on the R2 page, open **API tokens** (Manage R2 API tokens), click **Create API token**, choose **Object Read & Write**, limit it to the `madifyx-clips` bucket, and create it.
4. Copy the **Access Key ID**, **Secret Access Key** and the **S3 endpoint** (looks like `https://<account id>.r2.cloudflarestorage.com`). The secret is shown only once.

**Render (runs the app)**
1. Sign in at **render.com** with GitHub.
2. Click **New**, then **Blueprint**, and pick this repo. Render reads `render.yaml`.
3. Fill in: `S3_ENDPOINT` (the endpoint), `S3_BUCKET` (`madifyx-clips`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Click **Apply**.
4. When it says **Live**, open the service, go to **Settings > Custom Domains**, and add `record.madifyx.com`.
5. In Cloudflare DNS add a **CNAME** record: name `record`, target `madifyx-clips.onrender.com` (use the address Render shows), cloud **grey (DNS only)**.
6. Open https://record.madifyx.com and create your admin account right away.

On the free plan the app sleeps after 15 minutes without visitors, and the next visit takes about a minute to wake it. To keep it awake, a free service like cron-job.org can open `https://record.madifyx.com/api/config` every 10 minutes (the free plan's 750 hours a month cover a full month).

## Or use Railway ($5 a month, always on)


Railway runs the app straight from this GitHub repo and updates it automatically when the code changes.

1. Sign in at **railway.com** with your GitHub account and choose the **Hobby** plan.
2. Click **New Project**, then **Deploy from GitHub repo**, and pick this repo. Railway finds the Dockerfile on its own.
3. In the service, open **Settings > Volumes** (or right-click the service and choose **Attach volume**) and set the mount path to `/app/data`. This is where videos and accounts are kept, so they survive restarts.
4. In **Variables**, add `APP_NAME` = `Madifyx Clips` (optional).
5. In **Settings > Networking**, click **Custom Domain**, type `record.madifyx.com`, and copy the records Railway shows you.
6. In Cloudflare DNS, add those records exactly (a **CNAME** named `record`, and a **TXT** record if Railway asks for one). Set the CNAME's cloud to **grey (DNS only)**.
7. Open https://record.madifyx.com and create your admin account right away.

## Or run it on your own server

### Put it online at your own domain (e.g. record.madifyx.com)

Browsers only allow screen recording on `https://`, so the included setup gets a free HTTPS certificate automatically.

1. **Get a small server** (Ubuntu, 2 GB RAM is plenty to start). Hetzner, DigitalOcean, Vultr and similar all work.
2. **Point your subdomain at it.** Where you manage madifyx.com's DNS, add an **A record**: name `record`, value = your server's IP address.
3. **On the server**, install Docker, copy this folder over, and start it:

```bash
curl -fsSL https://get.docker.com | sh
cd madifyx-clips
DOMAIN=record.madifyx.com docker compose up -d --build
```

4. Open https://record.madifyx.com and create your owner account. Do this right away, since the first person to open it becomes the owner.

To update later: copy the new files over and run the same `docker compose up -d --build` command. Your videos and accounts live in the `data` folder, so back that up.

## Settings (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `APP_NAME` | Madifyx Clips | Name shown in the app |
| `DATA_DIR` | ./data | Where videos, accounts and the database live |
| `SESSION_DAYS` | 30 | How long people stay signed in |
| `OWNER_EMAIL` | (empty) | Only this email can set up the workspace, and it always has owner rights |
| `RESEND_API_KEY` | (empty) | Resend key for sending verification emails |
| `MAIL_FROM` | (empty) | Sender, e.g. `Madifyx Clips <clips@madifyx.com>` (the domain must be verified in Resend) |
| `STRIPE_SECRET_KEY` | (empty) | Stripe secret key |
| `STRIPE_PRICE_ID` | (empty) | The monthly price customers pay for Pro |
| `STRIPE_WEBHOOK_SECRET` | (empty) | Signing secret of the Stripe webhook |
| `FREE_MAX_VIDEOS` | 25 | Videos allowed per workspace on the Free plan |
| `FREE_MAX_SECONDS` | 300 | Longest recording on the Free plan, in seconds |
| `HOME_WORKSPACE_NAME` | Madifyx | Name of your own (free forever) workspace |
| `MAIL_DEV` | (empty) | Set to 1 on your own computer to print emails in the terminal instead of sending them |
| `MAX_UPLOAD_MB` | 2048 | Largest upload allowed |
| `KEEP_ORIGINAL` | 0 | Set to 1 to keep the raw recording after mp4 conversion |
| `S3_ENDPOINT` | (empty) | Cloud storage address, e.g. your Cloudflare R2 endpoint. When the four S3 settings are set, videos and data are kept there |
| `S3_BUCKET` | (empty) | Bucket name |
| `S3_ACCESS_KEY_ID` | (empty) | Storage access key |
| `S3_SECRET_ACCESS_KEY` | (empty) | Storage secret key |
| `S3_REGION` | auto | Region (R2 uses `auto`) |

## Roadmap ideas

- Sign in with Google
- Store videos on Cloudflare R2 or S3 instead of the server disk
- Comments and emoji reactions on the timeline
- Automatic transcripts and AI summaries
- Trim start/end before sharing
- Chrome extension for one click recording
