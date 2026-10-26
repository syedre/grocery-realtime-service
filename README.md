# SM mart catalogue WebSocket service

Standalone Node.js service that broadcasts a small `catalog_changed` event to connected apps when Supabase sends a database webhook for the public `products` or `product_category` tables. It does not expose catalogue data and does not use Supabase Realtime.

## Deploy to Render

1. In Render, create a Web Service or Blueprint from this repository's default branch.
2. The repository root contains `server.js` and `package.json`; leave the Render root directory blank.
3. Configure `WEBHOOK_SECRET` as a secret environment variable. Keep it private.
4. Deploy the service. The health URL should return JSON with `"status":"ok"`.
5. The WebSocket endpoint is the service URL with `/catalog` and the `wss://` scheme.

## Configure Supabase database webhooks

Create a Database Webhook for each table below, using events INSERT, UPDATE, and DELETE:

- schema: `public`, table: `products`
- schema: `public`, table: `product_category`

For each webhook, use HTTP POST to:

`https://YOUR-RENDER-SERVICE.onrender.com/webhooks/catalog`

Add these headers:

- `Content-Type: application/json`
- `x-catalog-webhook-secret: YOUR_WEBHOOK_SECRET`

Use exactly the same secret configured in Render. Do not put this secret in the Expo app or commit it to Git.

## Configure the Expo app

Set this in the app's local `.env` and production build environment:

`EXPO_PUBLIC_CATALOG_SOCKET_URL=wss://YOUR-RENDER-SERVICE.onrender.com/catalog`

Restart Expo with its cache cleared after changing the environment variable.

## Notes

- This service broadcasts notifications only; clients fetch current data from Supabase with existing RLS-protected queries.
- The client reconnects and refreshes on app foreground. WebSocket delivery cannot guarantee delivery to disconnected devices.
- Render's free service can spin down after inactivity and may take time to wake. Clients should reconnect and use the app's fallback refresh strategy.
- This service uses an in-memory connection list and is intended for a single instance. Multiple instances require shared pub/sub so notifications reach clients connected to every instance.
