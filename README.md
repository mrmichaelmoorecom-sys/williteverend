# williteverend.com

**Will it ever end?** — a one-page site. Big answer in the middle (NO, until it isn't),
days left in the term underneath, live betting-market odds, approval rating and a news
feed below. Served by a single Cloudflare Worker (static assets + a tiny cached JSON API).

## Develop

```bash
npm install
npm run dev        # http://localhost:8787
```

## Deploy

Pushes to `main` auto-deploy via Cloudflare Workers Builds. Manual: `npm run deploy`.

## Flip the answer

Edit `config.json` → `"override": "YES"` and push. See that file for all knobs.
