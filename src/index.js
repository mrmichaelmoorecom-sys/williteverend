export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: true, path: url.pathname });
    }
    return env.ASSETS.fetch(request);
  },
};
