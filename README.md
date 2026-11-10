# Encode (public web version)

This is the public copy of Encode that runs on Netlify. Your own Encode at `~/Claude/encode` (with your
notebooks and Claude plan) is separate and isn't affected. A backup of it is in `~/Claude/encode_backup_2026-11-09`.

## How it works

- **AI:** Google Gemini. The site uses your Gemini key, which is stored on Netlify where visitors can't see it.
  Visitors can also paste their own free key in Settings; it's saved only in their browser.
  - The site picks the newest Flash model your key can use.
  - Gemini's free tier has a daily limit that everyone on your key shares. When it runs out, visitors see a message
    asking them to add their own free key.
  - On a free key with no billing, the worst case is "used up for today". It can never charge you.
- **Data:** each visitor's notebooks, pictures and XP are saved in their own browser. You can't see them and they
  can't see yours. Settings has Export/Import backup.
- **Server code:** only `netlify/edge-functions/gemini.js`. It forwards requests to Gemini with the key, reads public
  web pages for "add a link", and checks YouTube links. Everything else is static files in `site/`.

### Differences from your Mac version

| | Your Mac (`encode/`) | Public (`encode_public/`) |
|---|---|---|
| AI | Claude, on your plan | Gemini (your key, or the visitor's own) |
| Data | `~/Claude/encode/data`, daily backups | The visitor's browser, plus Export/Import |
| YouTube links | Captions, often blocked | Gemini watches the video and writes notes |
| Video finder | Claude web search; videos play inline | Gemini picks a YouTube search per concept, with "watch for" questions (inline videos too if you add a YouTube key) |
| Daily Mac reminder, dashboard panel | Yes | No |
| Kit-building pictures | Up to 60 | Up to 30 (smaller, for the free tier) |

## Deploy (one time)

Netlify Drop (drag a zip) can't run the edge function, so deploy from GitHub:

1. **Get a Gemini key:** go to https://aistudio.google.com/apikey → *Create API key*. Keep billing off to stay free.
2. **Put the code on GitHub:**
   1. On github.com, click **+** → *New repository* and name it `encode`.
   2. Choose Public or Private (either works with Netlify), then click *Create*.
   3. Click *uploading an existing file*.
   4. Drag in **everything inside** `~/Claude/encode_public`: the `site` and `netlify` folders plus `netlify.toml`, `README.md`, `.gitignore` and `dev_server.py`.
   5. Never upload `.env.local`.
   6. Click *Commit changes*.
3. **Connect Netlify:**
   1. On app.netlify.com, choose *Add new project* → *Import an existing project* → *GitHub*, then pick `encode`.
   2. Netlify reads `netlify.toml`, so leave the build settings as they are.
   3. Before deploying, open *Environment variables* and add `GEMINI_API_KEY` = your key.
   4. Click *Deploy*.
4. **Check it:** open the site, then Settings. It should say *AI tutor: Google Gemini ✓ on*.
5. **Optional:** change the address under *Domain management*, e.g. `encode-study.netlify.app`.
6. **Optional: real videos in the Videos tab.**
   1. At https://console.cloud.google.com, enable **YouTube Data API v3** for your Gemini project.
   2. Create an API key under *Credentials*.
   3. Add it on Netlify as `YOUTUBE_API_KEY`.
   It's free for about 100 searches a day. Without it, video cards open a YouTube search instead.
7. **Optional: Google Images in the background picker.**
   1. Sign up at https://serper.dev. The first 2,500 searches are free.
   2. Copy your API key from the dashboard.
   3. Add it on Netlify as `SERPER_API_KEY`, then redeploy.
   Without it, background search uses free Wikimedia photos plus a button that opens Google Images.

**Updating later:** upload the changed files to the same GitHub repo. Netlify redeploys on its own.

## Notes from testing (Nov 9, 2026, free key)

- **Model:** the site picks gemini-3.6-flash, then 3.5-flash, then Lite models. If one is busy ("high demand"),
  stalls or is out of quota, it moves to the next one on its own.
  - The newest (3.7/3.8) can sit in a queue for minutes on the free tier, so they're tried last.
  - Visitors can choose a model in Settings.
- **Speed:** full kit with 23 slide pictures ~85 s · grading ~5–12 s · exam ~6 s · teach-back ~5 s · diagram ~13 s ·
  chat starts in ~2 s · YouTube link → notes ~40 s · video picks ~5 s.
- **Google Search:** Gemini's built-in Google Search has no free allowance, so the video finder doesn't use it.

## Try it on this Mac first

```bash
cd ~/Claude/encode_public && python3 dev_server.py
```

Open http://localhost:8795. For AI, put `GEMINI_API_KEY=your-key` in `~/Claude/encode_public/.env.local`.
Git ignores that file, so never upload it.
