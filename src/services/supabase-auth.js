async function authenticate(accessToken) {
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const publishableKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !publishableKey) {
    throw new Error("Supabase Auth validation is not configured on the realtime service.");
  }
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: publishableKey,
      authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return null;
  return response.json();
}

export async function authenticateCustomer(accessToken) {
  const user = await authenticate(accessToken);
  return typeof user?.id === "string" ? user.id : null;
}

export async function authenticateAdmin(accessToken) {
  const user = await authenticate(accessToken);
  if (
    typeof user?.id !== "string" ||
    typeof user?.email !== "string" ||
    user.email.trim().toLowerCase() !== "admin@gmail.com"
  ) return null;
  return { id: user.id, email: user.email };
}

export async function requireAdmin(req, res) {
  const authorization = req.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const accessToken = match?.[1];
  if (!accessToken || accessToken.length < 20 || accessToken.length > 8192) {
    res.status(401).json({ error: "Authentication required" });
    return null;
  }
  try {
    const admin = await authenticateAdmin(accessToken);
    if (!admin) {
      res.status(403).json({ error: "Admin access only" });
      return null;
    }
    return admin;
  } catch (error) {
    console.error("Admin token authentication failed:", error.message);
    res.status(503).json({ error: "Authentication unavailable" });
    return null;
  }
}
