// Rotas que NÃO exigem login. /api/webhook é chamado direto pela Meta.
const PUBLIC_PATHS = new Set(["/login", "/api/webhook"]);

export function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (req.session?.user) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect("/login");
}
