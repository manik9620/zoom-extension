# Deploying the server to Fly.io

## Prereqs
- Fly.io account created + `flyctl` CLI installed: https://fly.io/docs/flyctl/install/
- `fly auth login`

## First-time deploy

```
cd server
fly launch
```

This detects the `Dockerfile` and asks a few questions:
- **App name** — pick something like `zoom-class-companion` (must be globally unique on Fly).
- **Region** — pick one close to where you and classmates actually are (e.g. `bom` for Mumbai).
- **Postgres / Redis?** — say **No** to both. DB is Supabase, not Fly's.
- **Deploy now?** — say **No** first, so we can set the secret below before the first boot.

This generates `server/fly.toml`. Then set the Gemini key as a Fly secret (never goes in the image or git):

```
fly secrets set GEMINI_API_KEY=your_key_here
```

Then deploy:

```
fly deploy
```

## After deploy

- Your server is live at `https://<app-name>.fly.dev`.
- Test it: `curl https://<app-name>.fly.dev/health` → should return `{"ok":true}`.
- Test transcription/notes endpoints the same way you tested locally, just pointing at the `fly.dev` URL instead of `127.0.0.1:8765`.

## Updating later

Any time server code changes:
```
cd server
fly deploy
```

## Notes on machine size

Default Fly machine (shared-cpu-1x, 256MB-1GB RAM) may be tight for `small.en`
whisper under concurrent load. If transcription feels slow/crashes under
multiple simultaneous users, bump memory/CPU:
```
fly scale vm shared-cpu-2x --memory 2048
```
This costs more — check Fly's pricing page before scaling up.
