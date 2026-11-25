# Christmas Jeopardy

A host-run Jeopardy-style game. Static front end in `public/`, FastAPI backend in `api/`, data in Supabase, hosted on Vercel.

## 1. Supabase

1. Create a project.
2. SQL Editor: paste and run [schema.sql](schema.sql).
3. Project Settings > Database > Connection string > **Transaction pooler**: copy it as `DATABASE_URL` (put your DB password in).
4. Project Settings > API: copy the project URL (`SUPABASE_URL`) and the `service_role` key (`SUPABASE_SERVICE_ROLE_KEY`). Keep the key secret; never put it in front-end code.
5. Media bucket: created automatically (public bucket named `media`) the first time you open Manage questions.

## 2. Deploy to Vercel

1. Push this folder to a GitHub repo and import it in Vercel (Framework preset: Other).
2. Add these environment variables (Settings > Environment Variables):
   - `DATABASE_URL`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ADMIN_PASSWORD` (unlocks Manage questions)
   - `THINK_MUSIC` (optional)
3. Deploy. Everyone, players included, uses the same site URL.

## 3. Use it

- Open the site, click **Manage questions**, enter the admin password, download the Excel template, fill it in and upload it. Without an upload the built-in Christmas sample board is used.
- Players join from their phones with **Join as a player** and the 4-letter game code.

## Run locally

```powershell
py -m pip install -r requirements.txt
Copy-Item .env.example .env   # then fill it in; set the variables in your shell, e.g.:
$env:LOCAL_DEV = '1'
$env:DATABASE_URL = '...'
py -m uvicorn api.index:app --port 8765
```

Open http://localhost:8765. With no `DATABASE_URL` only the sample board and keyboard play work (player devices need the database). `LOCAL_DEV=1` skips the admin password.

## Notes

- Player buzzers use short polling against Postgres (about 0.3 s resolution), because Vercel functions cannot hold shared in-memory state.
- Media is uploaded straight from the browser to Supabase Storage (50 MB per file on the free plan). Question files are limited to 4 MB by Vercel.
- Supabase's free plan pauses projects after a week of inactivity; open the dashboard to resume it before game night.
