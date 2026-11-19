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

    // AUTO-FIX: This ensures your database gets the missing columns automatically
    try {
      await env.DB.prepare("ALTER TABLE rooms ADD COLUMN bedrooms TEXT DEFAULT '1'").run();
    } catch (e) {} // Ignore if it already exists
    
    try {
      await env.DB.prepare("ALTER TABLE rooms ADD COLUMN bathrooms TEXT DEFAULT '1'").run();
    } catch (e) {} // Ignore if it already exists

    try {
      await env.DB.prepare("ALTER TABLE rooms ADD COLUMN depositMonths TEXT DEFAULT '1'").run();
    } catch (e) {}
    
    try {
      await env.DB.prepare("ALTER TABLE rooms ADD COLUMN splitDeposit TEXT DEFAULT 'No'").run();
    } catch (e) {}

    try {
      await env.DB.prepare("ALTER TABLE rooms ADD COLUMN hasBalance TEXT DEFAULT 'No'").run();
    } catch (e) {}

    // 1. PUBLIC API
    if (path === "/api/public" && request.method === "GET") {
      try {
        const today = new Date().toISOString().split('T')[0];
        await env.DB.prepare(`
            INSERT INTO traffic (id, date, page, count) VALUES (?, ?, 'home', 1)
            ON CONFLICT(id) DO UPDATE SET count = count + 1
        `).bind(today, today).run();

        const { results } = await env.DB.prepare("SELECT * FROM rooms WHERE LOWER(TRIM(status)) = 'approved'").all();
        const parsedRooms = results.map(r => ({ ...r, images: r.images ? JSON.parse(r.images) : [] }));
        return Response.json({ rooms: parsedRooms }, { headers: corsHeaders });
      } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // 2. ADMIN LOGIN
    if (path === "/api/admin/login" && request.method === "POST") {
        try {
            const body = await request.json();
            if (body.username === "Vusani24" && body.password === "Khanya0901@12") {
                return Response.json({ token: "vusani-secret-token-2024" }, { headers: corsHeaders });
            }
            return Response.json({ error: "Invalid credentials" }, { status: 401, headers: corsHeaders });
        } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // 3. ADMIN DATA
    if (path === "/api/admin/data" && request.method === "GET") {
        const auth = request.headers.get("Authorization");
        if (auth !== "Bearer vusani-secret-token-2024") return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        
        try {
            const { results: allRooms } = await env.DB.prepare("SELECT * FROM rooms").all();
            const { results: allExpenses } = await env.DB.prepare("SELECT * FROM expenses ORDER BY date DESC").all();
            const { results: allTraffic } = await env.DB.prepare("SELECT * FROM traffic ORDER BY date DESC").all();

            const rooms = { pending: [], approved: [], taken: [], declined: [] };
            allRooms.forEach(r => {
                r.images = r.images ? JSON.parse(r.images) : [];
                const status = r.status ? r.status.trim().toLowerCase() : 'pending';
                if (rooms[status]) rooms[status].push(r);
            });
            
            return Response.json({
                rooms: rooms, expenses: allExpenses || [], traffic: allTraffic || []
            }, { headers: corsHeaders });
        } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // 4. UPLOAD TO R2
    if (path === "/api/upload" && request.method === "POST") {
        try {
            const formData = await request.formData();
            const file = formData.get("images"); 
            if (!file) return Response.json({ success: false, error: "No file" }, { status: 400, headers: corsHeaders });
            const filename = `${Date.now()}-${file.name.replace(/\s/g, '_')}`;
            await env.BUCKET.put(filename, file.stream(), { httpMetadata: { contentType: file.type } });
            
            const publicUrl = `https://pub-a1fed41b33a448038bb13c22ff962e9b.r2.dev/${filename}`; 
            return Response.json({ success: true, urls: [publicUrl] }, { headers: corsHeaders });
        } catch (e) { return Response.json({ success: false, error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // 5. SUBMIT PROPERTY
    if (path === "/api/submit" && request.method === "POST") {
        try {
            const body = await request.json();
            const id = Date.now().toString();
            
            const childFriendly = String(body.childFriendly).toLowerCase() === 'yes' ? 'Yes' : 'No';
            const parking = String(body.parking).toLowerCase() === 'yes' ? 'Yes' : 'No';

            await env.DB.prepare(`
                INSERT INTO rooms (
                    id, title, purpose, type, location, alexandraSuburb, address, amount, deposit, posterName, posterContact, notes, images, video, status, 
                    childFriendly, maxKids, parking, maxCars, petsFriendly, ceiling, tiles, kitchenType, furniture, wardrobe, kitchenUnit, toiletType, bedrooms, bathrooms
                ) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).bind(
                id, body.title, body.purpose, body.type, body.location, body.alexandraSuburb || '', body.address, body.amount, body.deposit, body.posterName, body.posterContact, body.notes || '', JSON.stringify(body.images || []), body.video || '',
                childFriendly, body.maxKids || '0', parking, body.maxCars || '0', body.petsFriendly || 'No', body.ceiling || 'No', body.tiles || 'No', 
                body.kitchenType || 'No Kitchen', body.furniture || 'Unfurnished', body.wardrobe || 'Not Available', body.kitchenUnit || 'Not Available', body.toiletType || 'Shared Toilet',
                body.bedrooms || '1', body.bathrooms || '1'
            ).run();
            
            return Response.json({ success: true, id }, { headers: corsHeaders });
        } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // 6. ADMIN ACTIONS
    if (path === "/api/admin/action" && request.method === "POST") {
        const auth = request.headers.get("Authorization");
        if (auth !== "Bearer vusani-secret-token-2024") return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        
        try {
            const body = await request.json();
            if (body.action === "move") {
                await env.DB.prepare("UPDATE rooms SET status = ? WHERE id = ?").bind(body.to.toLowerCase().trim(), body.id).run();
            } else if (body.action === "delete") {
                await env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(body.id).run();
            } else if (body.action === "edit") {
                const childFriendly = String(body.data.childFriendly).toLowerCase() === 'yes' ? 'Yes' : 'No';
                const parking = String(body.data.parking).toLowerCase() === 'yes' ? 'Yes' : 'No';

                await env.DB.prepare(`
                    UPDATE rooms SET 
                        title = ?, amount = ?, deposit = ?, location = ?, type = ?, notes = ?, images = ?, video = ?,
                        childFriendly = ?, maxKids = ?, parking = ?, maxCars = ?, petsFriendly = ?, ceiling = ?, tiles = ?, 
                        kitchenType = ?, furniture = ?, wardrobe = ?, kitchenUnit = ?, toiletType = ?, bedrooms = ?, bathrooms = ?
                    WHERE id = ?
                `).bind(
                    body.data.title, body.data.amount, body.data.deposit, body.data.location, body.data.type, body.data.notes, JSON.stringify(body.data.images || []), body.data.video || '',
                    childFriendly, body.data.maxKids || '0', parking, body.data.maxCars || '0', body.data.petsFriendly, body.data.ceiling, body.data.tiles,
                    body.data.kitchenType, body.data.furniture, body.data.wardrobe, body.data.kitchenUnit, body.data.toiletType, body.data.bedrooms, body.data.bathrooms,
                    body.id
                ).run();
            }
            return Response.json({ success: true }, { headers: corsHeaders });
        } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    // 7. RECORD TAKEN
    if (path === "/api/admin/take" && request.method === "POST") {
        const auth = request.headers.get("Authorization");
        if (auth !== "Bearer vusani-secret-token-2024") return Response.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders });
        
        try {
            const body = await request.json();
            await env.DB.prepare(`
                UPDATE rooms SET 
                    status = 'taken', 
                    amount = ?, 
                    tenantName = ?, 
                    rent = ?, 
                    deposit = ?, 
                    houseNumber = ?,
                    amountPaid = ?,
                    balanceDate = ?,
                    hasBalance = ?,
                    splitDeposit = ?
                WHERE id = ?
            `).bind(body.fee, body.tenantName, body.rent, body.deposit, body.houseNumber, body.amountPaid, body.balanceDate, body.hasBalance, body.splitDeposit, body.id).run();
            
            return Response.json({ success: true }, { headers: corsHeaders });
        } catch (e) { return Response.json({ error: e.message }, { status: 500, headers: corsHeaders }); }
    }

    return env.ASSETS.fetch(request);
  }
};
