export function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.redirect("/login");
}
