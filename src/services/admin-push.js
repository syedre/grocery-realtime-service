import crypto from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { adminTokens } from "../config/constants.js";
import { firebaseReady, firestore } from "../config/firebase.js";

export async function registerAdminPushToken(admin, token, platform) {
  const tokenId = crypto.createHash("sha256").update(token).digest("hex");
  await adminTokens(firestore).doc(tokenId).set({
    token,
    uid: admin.id,
    email: "admin@gmail.com",
    platform,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

export async function removeAdminPushToken(admin, token) {
  const tokenId = crypto.createHash("sha256").update(token).digest("hex");
  const ref = adminTokens(firestore).doc(tokenId);
  const snapshot = await ref.get();
  if (snapshot.exists && snapshot.data()?.uid === admin.id) await ref.delete();
}

const processedOrderPushes = new Set();

export async function sendNewOrderNotification(order) {
  if (!firebaseReady()) {
    console.warn("Skipped new-order push: Firebase Admin is not configured.");
    return;
  }
  if (processedOrderPushes.has(order.id)) {
    console.info(`Skipped duplicate new-order push for order ${order.id}.`);
    return;
  }
  processedOrderPushes.add(order.id);
  if (processedOrderPushes.size > 10_000) {
    processedOrderPushes.delete(processedOrderPushes.values().next().value);
  }

  try {
    const db = firestore();
    const snapshot = await adminTokens(firestore).get();
    const docs = snapshot.docs;
    if (docs.length === 0) {
      console.info("No registered admin FCM devices; new-order push was not sent.");
      return;
    }

    const invalidRefs = [];
    let successCount = 0;
    for (let offset = 0; offset < docs.length; offset += 500) {
      const batch = docs.slice(offset, offset + 500);
      const tokens = batch.map((doc) => doc.data().token).filter((value) => typeof value === "string");
      if (tokens.length === 0) continue;
      const response = await getMessaging().sendEachForMulticast({
        tokens,
        notification: {
          title: "New customer order",
          body: order.orderNumber ? `Order #${order.orderNumber} has been placed.` : "A new customer order has been placed.",
        },
        data: {
          type: "new_order",
          orderId: order.id,
          orderNumber: order.orderNumber ?? "",
        },
        android: { priority: "high", notification: { channelId: "sm_mart_orders", sound: "default" } },
        apns: { payload: { aps: { sound: "default" } } },
      });
      successCount += response.successCount;
      response.responses.forEach((result, index) => {
        if (
          !result.success &&
          ["messaging/invalid-registration-token", "messaging/registration-token-not-registered"].includes(result.error?.code)
        ) invalidRefs.push(batch[index].ref);
      });
    }
    if (invalidRefs.length) {
      const batch = db.batch();
      invalidRefs.forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    console.info(`New-order push processed for order ${order.id}: ${successCount} device(s) accepted.`);
  } catch (error) {
    processedOrderPushes.delete(order.id);
    throw error;
  }
}
