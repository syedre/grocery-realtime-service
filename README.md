# SM mart catalogue and order realtime service

This Render service keeps the existing catalogue WebSocket broadcasts and customer order-status WebSocket updates. It also sends new-order push notifications to the authenticated SM mart Admin app.

## Existing configuration

Keep the current `WEBHOOK_SECRET`, `SUPABASE_URL`, and `SUPABASE_ANON_KEY` (or `SUPABASE_PUBLISHABLE_KEY`) Render environment variables. Do not change the existing Supabase webhook URL or secret header.

## Admin order push notifications

1. Enable **Cloud Firestore** in the existing Firebase project `sm-delivery-app-10f03` (Native mode, default database).
2. In Firebase Console > Project settings > Service accounts, generate a Firebase Admin SDK service-account JSON key. Keep it private.
3. Add the complete JSON as the Render environment variable `FIREBASE_SERVICE_ACCOUNT_JSON`. Never commit this credential or put it in the Flutter app.
4. Keep the existing Supabase Auth environment variables configured. Device registration validates the Supabase bearer token against Auth and only accepts the existing `admin@gmail.com` account.
5. Deploy this branch after review/merge. The Flutter app registers its FCM token with `POST /admin/push-tokens` and removes it with `DELETE /admin/push-tokens`, using the Supabase access token as a Bearer token.
6. Keep the Supabase database webhook subscribed to `orders` INSERT and UPDATE. INSERT with status `placed` sends a push; UPDATE continues to emit the existing customer-specific `order_status_changed` WebSocket event. Catalogue broadcasts are unchanged.

Firestore collections are created automatically on first use:
- `admin_fcm_tokens`: hashed token document IDs; stores the token, admin UID, platform and update timestamp.
- `admin_push_events`: one idempotency record per order ID to avoid duplicate notifications on webhook retries.

No Supabase tables, columns, policies, triggers, or order-processing functions are added or modified by this service.

## Endpoints

- `POST /admin/push-tokens` — JSON body `{"token":"...","platform":"android|ios"}`; requires the authorized admin Supabase bearer token.
- `DELETE /admin/push-tokens` — JSON body `{"token":"..."}`; requires the same authorized admin session.
- `POST /webhooks/catalog` — unchanged shared-secret webhook endpoint.
- `GET /` — health check.
