export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/public") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM rooms WHERE status = 'approved'").all();
        return Response.json({ rooms: results || [] });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }
    
    // Other routes temporarily return 404
    return new Response("API not found", { status: 404 });
  }
};
