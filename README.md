# Madifyx Clips

Your own screen recorder with share links. Record your screen, voice and camera in the browser, get a link instantly, and keep every video on your own server. No per seat fees.

## What it does

- **Library home page** with search, and a team view for admins
- **Three ways to record:** screen and camera, screen only, or camera only (phones get camera only)
- **Floating controls** in Chrome and Edge: your camera bubble plus pause and finish stay on top of other apps
- Microphone and computer sound mixed together, 3 second countdown, pause, discard
- When you finish, it saves and opens the video's page with the link already copied
- **Share page** clients can open without an account: creator name, speed control, view count, emoji reactions and timestamped comments
- **Invite links** for teammates: they pick their own password
- Videos are converted to mp4 with thumbnails when ffmpeg is installed, so they play on iPhones too

Shortcuts while recording (with the app tab focused): Alt+Shift+P pause, Alt+Shift+S finish.

## Accounts

- The first time you open the app, it asks you to set up the **admin account**. That's you.
- Go to **Team** and click **Invite teammate**. Copy the link and send it to them. They create their own account with it. Each link works once and expires in 7 days.
- **Members** record and see their own videos. **Admins** also invite people and can switch the library to "Whole team".
- Removing someone moves their videos to you, so their links keep working.
- Video pages (`/v/...`) never need a login.
- Forgot the admin password? Stop the app and run: `node reset-password.js you@email.com newpassword`

## Run it on your computer

Needs Node.js 18 or newer, nothing else to install. ffmpeg is optional but recommended (on Mac: `brew install ffmpeg`, on Windows: `winget install ffmpeg`).

```bash
node server.js
```

Open http://localhost:3000 in Chrome or Edge.

## Put it online with Railway (easiest, no Terminal)

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
2. **Point your subdomain at it.** Where you manage madifyx.com's DNS, add an **A record**: name `clips`, value = your server's IP address.
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
| `MAX_UPLOAD_MB` | 2048 | Largest upload allowed |
| `KEEP_ORIGINAL` | 0 | Set to 1 to keep the raw recording after mp4 conversion |

## Roadmap ideas

- Sign in with Google
- Store videos on Cloudflare R2 or S3 instead of the server disk
- Comments and emoji reactions on the timeline
- Automatic transcripts and AI summaries
- Trim start/end before sharing
- Chrome extension for one click recording
