# HTTPS Deployment

## Target

Deploy `apps/web` to GitHub Pages so it has an HTTPS URL and can be installed
from iPhone Safari with Add to Home Screen.

## Provider

```text
GitHub Pages
```

## Repository Assumption

Repository name:

```text
Simple-Schedule-Multiplatform
```

GitHub Pages production URL:

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/
```

The Vite config uses `GITHUB_PAGES=true` to set the correct base path for this
repository name.

## GitHub Actions

The workflow lives at:

```text
.github/workflows/pages.yml
```

It:

1. Installs dependencies with `npm install`.
2. Builds the PWA with `npm run build:web`.
3. Uploads `apps/web/dist`.
4. Deploys to GitHub Pages.

## Environment Variables

The public Supabase values are used at build time:

```text
VITE_SUPABASE_URL=https://vzojfajfpjdjeoavhtks.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_oVpjHxc8WK7c-aoPYtwOSw_aU0A1IUy
```

These are included in the GitHub Actions workflow because they are public PWA
values. Do not add database passwords or service role keys to the frontend.

## GitHub Pages Settings

After the repository is pushed:

1. Open the GitHub repository.
2. Go to `Settings -> Pages`.
3. Set `Build and deployment` source to `GitHub Actions`.
4. Wait for the `Deploy PWA to GitHub Pages` workflow to finish.

## Supabase Auth URLs

GitHub Pages deployment is active at:

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/
```

Update Supabase:

```text
Authentication -> URL Configuration
```

Keep local URLs:

```text
http://localhost:5173/**
http://127.0.0.1:5173/**
```

Add the GitHub Pages URL:

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/**
```

Set `Site URL` to the production GitHub Pages URL once it is confirmed.

Recommended Site URL:

```text
https://wangxuanmin.github.io/Simple-Schedule-Multiplatform/
```
