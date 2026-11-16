export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // 1. PUBLIC API (Fetch approved listings)
    if (path === "/api/public" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM rooms WHERE status = 'approved'").all();
        const parsedRooms = results.map(r => ({ ...r, images: r.images ? JSON.parse(r.images) : [] }));
        return Response.json({ rooms: parsedRooms }, { headers: corsHeaders });
      } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // 2. ADMIN LOGIN (Updated with your new credentials)
    if (path === "/api/admin/login" && request.method === "POST") {
        try {
            const body = await request.json();
            if (body.username === "Vusani24" && body.password === "Khanya0901@12") {
                return Response.json({ token: "vusani-secret-token-2024" }, { headers: corsHeaders });
            }
            return Response.json({ error: "Invalid credentials" }, { status: 401, headers: corsHeaders });
        } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // 3. ADMIN DATA (Dashboard Load)
    if (path === "/api/admin/data" && request.method === "GET") {
        const auth = request.headers.get("Authorization");
        if (auth !== "Bearer vusani-secret-token-2024") {
            return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }
        
        try {
            const { results: allRooms } = await env.DB.prepare("SELECT * FROM rooms").all();
            const rooms = { pending: [], approved: [], taken: [], declined: [], removed: [] };
            
            allRooms.forEach(r => {
                r.images = r.images ? JSON.parse(r.images) : [];
                if (rooms[r.status]) rooms[r.status].push(r);
            });
            
            return Response.json({
                rooms: rooms,
                ledger: [],
                auditTrail: [],
                tenantRequests: { pending: [], approved: [], declined: [], removed: [] },
                feeTotals: { rent: 0, sale: 0, surcharges: 0, manual: 0, grand: 0 }
            }, { headers: corsHeaders });
        } catch (e) {
            return Response.json({ error: e.message }, { status: 500, headers: corsHeaders });
        }
    }

    // 4. UPLOAD IMAGES TO R2 (Requires R2 binding 'BUCKET')
    if (path === "/api/upload" && request.method === "POST") {
        try {
            const formData = await request.formData();
            const file = formData.get("images"); 
            if (!file) return Response.json({ success: false, error: "No file uploaded" }, { status: 400, headers: corsHeaders });
            
            const filename = `${Date.now()}-${file.name.replace(/\s/g, '_')}`;
            await env.BUCKET.put(filename, file.stream(), {
                httpMetadata: { contentType: file.type }
            });
            
            // Note: You need to ensure your R2 bucket allows public access, or change this URL to your custom domain for R2.
            const publicUrl = `https://pub-689a28ae69db48e18112f4b260be5b23.r2.dev/${filename}`; 
            return Response.json({ success: true, urls: [publicUrl] }, { headers: corsHeaders });
        } catch (e) { return Response.json({ success: false, error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // 5. SUBMIT PROPERTY (Public Form)
    if (path === "/api/submit" && request.method === "POST") {
        try {
            const body = await request.json();
            const id = Date.now().toString();
            await env.DB.prepare(`
                INSERT INTO rooms (id, title, purpose, type, location, alexandraSuburb, address, amount, deposit, posterName, posterContact, notes, images, video, status) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
            `).bind(
                id, body.title, body.purpose, body.type, body.location, 
                body.alexandraSuburb || '', body.address, body.amount, 
                body.deposit, body.posterName, body.posterContact, 
                body.notes || '', JSON.stringify(body.images || []), body.video || ''
            ).run();
            return Response.json({ success: true, id }, { headers: corsHeaders });
        } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // 6. ADMIN ACTIONS (Approve/Delete)
    if (path === "/api/admin/action" && request.method === "POST") {
        const auth = request.headers.get("Authorization");
        if (auth !== "Bearer vusani-secret-token-2024") {
            return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        }
        
        try {
            const body = await request.json();
            if (body.action === "move") {
                await env.DB.prepare("UPDATE rooms SET status = ? WHERE id = ?").bind(body.to, body.id).run();
            } else if (body.action === "delete") {
                await env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(body.id).run();
            }
            return Response.json({ success: true }, { headers: corsHeaders });
        } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // Fallback to static files
    return env.ASSETS.fetch(request);
  }
};
