export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ==========================================
    // PUBLIC API
    // ==========================================
    if (path === "/api/public" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM rooms WHERE status = 'approved'").all();
        const parsedRooms = results.map(r => ({
            ...r,
            images: r.images ? JSON.parse(r.images) : []
        }));
        return Response.json({ rooms: parsedRooms }, { headers: corsHeaders });
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // ADMIN LOGIN
    // ==========================================
    if (path === "/api/admin/login" && request.method === "POST") {
        try {
            const body = await request.json();
            // Hardcoded admin login for now (you can move this to DB later)
            if (body.username === "admin" && body.password === "admin123") {
                return Response.json({ token: "vusani-secret-token-2024" }, { headers: corsHeaders });
            }
            return Response.json({ error: "Invalid credentials" }, { status: 401, headers: corsHeaders });
        } catch (e) {
            return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
        }
    }

    // ==========================================
    // ADMIN DATA (Dashboard)
    // ==========================================
    if (path === "/api/admin/data" && request.method === "GET") {
        const auth = request.headers.get("Authorization");
        if (auth !== "Bearer vusani-secret-token-2024") {
            return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }
        
        try {
            const { results: allRooms } = await env.DB.prepare("SELECT * FROM rooms").all();
            
            // Group rooms by status for the frontend
            const rooms = { pending: [], approved: [], taken: [], declined: [] };
            allRooms.forEach(r => {
                r.images = r.images ? JSON.parse(r.images) : [];
                if (rooms[r.status]) rooms[r.status].push(r);
            });
            
            return Response.json({
                rooms: rooms,
                ledger: [],
                auditTrail: [],
                tenantRequests: { pending: [], approved: [], declined: [] },
                feeTotals: { rent: 0, sale: 0, surcharges: 0, manual: 0, grand: 0 }
            }, { headers: corsHeaders });
        } catch (e) {
            return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
        }
    }

    // ==========================================
    // SUBMIT PROPERTY (Public Post Form)
    // ==========================================
    if (path === "/api/submit" && request.method === "POST") {
        // This needs multipart/form-data handling (complex in Workers without libraries)
        // For now, returning an error until we implement R2 image upload
        return Response.json({ error: "Image upload not yet supported." }, { status: 501, headers: corsHeaders });
    }

    // ==========================================
    // ADMIN ACTIONS (Approve, Edit, etc.)
    // ==========================================
    if (path === "/api/admin/action" && request.method === "POST") {
        const auth = request.headers.get("Authorization");
        if (auth !== "Bearer vusani-secret-token-2024") {
            return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }
        
        try {
            const body = await request.json();
            if (body.action === "move") {
                await env.DB.prepare("UPDATE rooms SET status = ? WHERE id = ?")
                    .bind(body.to, body.id).run();
            } else if (body.action === "delete") {
                await env.DB.prepare("DELETE FROM rooms WHERE id = ?")
                    .bind(body.id).run();
            }
            // Add other actions (edit, fee override) here later
            return Response.json({ success: true }, { headers: corsHeaders });
        } catch (e) {
            return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
        }
    }

    // Fallback for any other API routes
    if (path.startsWith("/api/")) {
        return new Response("API route not found", { status: 404, headers: corsHeaders });
    }

    // If no API matched, serve the static files (HTML, CSS, JS)
    return env.ASSETS.fetch(request);
  }
};
