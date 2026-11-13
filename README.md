# Trakin Thumbnail Studio

A web app for making Reel covers and YouTube thumbnails in the Trakin style. Pick a style, add screenshots or media, choose the host avatar and type the headline, and ChatGPT designs it.

Each teammate connects **their own ChatGPT account**. Images count against their ChatGPT plan, and no API key is needed.

---

## Host it online (for the team)

The app needs a server that runs Node.js and a long-running program, so it **won't work on Vercel or Netlify** (those can't run it). Use a Docker host such as **Railway** or **Render**, or any VPS (DigitalOcean, Hostinger VPS and so on).

### Railway (easiest)
1. Put this folder in a **private** GitHub repo, or use `railway up` from the folder.
2. In Railway, choose **New Project → Deploy from GitHub repo**. It detects the `Dockerfile` automatically.
3. Under **Variables**, add:
   - `TEAM_PASSWORD`: a strong password (8+ characters) that you share with your 3–4 teammates
4. Under **Volumes**, add a volume mounted at **`/data`**. This keeps everyone's ChatGPT connections, avatars and thumbnails safe across redeploys.
5. Under **Networking**, click **Generate Domain**. That's your link, which you can also point at a subdomain such as `thumbs.trakin.ai`.

### Render
New → **Web Service** → connect the repo → Runtime **Docker**. Add the `TEAM_PASSWORD` environment variable and a **Disk** mounted at `/data`. The free plan sleeps and has no disk, so use a paid instance.

### Any VPS with Docker
```bash
docker build -t trakin-thumbs .
docker run -d --name trakin-thumbs --restart unless-stopped \
  -p 8080:8080 -e TEAM_PASSWORD='choose-a-strong-one' \
  -v trakin-data:/data trakin-thumbs
```
Put it behind HTTPS (Caddy, Nginx or Cloudflare). Don't serve it over plain http on the internet.

---

## First time for each teammate

1. In ChatGPT, go to **Settings → Security** and turn on **Device code login** (one-time).
2. Open the app link, enter **your name** and the **team password**.
3. Click **Connect ChatGPT**, open the link shown, sign in to ChatGPT and type the code.
4. Done. Use the same name next time and you stay connected.

## Making a thumbnail
1. **Style:** *Trakin Reel Cover* is the default and is built from the channel's past thumbnails.
2. **Past thumbnails:** 32 references are already included. Tick up to 4, or tick none and the 3 closest to your headline are picked automatically.
3. **Media:** drag in images, browse, or `Ctrl+V` to paste a screenshot.
4. **Host avatar:** add a clear, well-lit photo once with **+**. It's saved for the whole team.
5. **Text (required):** choose whether ChatGPT draws the text, or you place exact text yourself in the editor afterwards.
6. **Generate.** It takes about 1–3 minutes. Click a result to add the logo or text, then **Download PNG**.

Logo: upload your logo as `logo.png` into the `brand` folder before deploying, or into `/data/brand` on the server.

## Good to know
- Each person's ChatGPT sign-in is stored on the server in `/data/users/<name>/`. Anyone with server access could use those sign-ins, so keep the server and the team password private.
- Free ChatGPT accounts hit image limits quickly; Plus gives far more room.
- To disconnect someone, delete their folder in `/data/users/`, or they can turn off device code login in ChatGPT.
- Style presets are in `styles.json`.

## Run it on your own computer instead (no hosting)
Install Node.js LTS, then double-click **start.bat**. It runs at `http://localhost:4321` without a password, using your own ChatGPT sign-in.
