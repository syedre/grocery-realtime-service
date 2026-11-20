export const ORDER_STATUSES = new Set([
  "placed",
  "confirmed",
  "preparing",
  "out_for_delivery",
  "delivered",
  "cancelled",
]);

export const adminTokens = (firestore) => firestore().collection("admin_fcm_tokens");
