require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// 👇 PASTE YOUR OLD db.json DATA HERE
const oldDatabaseData = {
  // Example:
  // "rooms": { "pending": [], "approved": [ { "id": "123", "title": "My Old Room" ... } ], "taken": [], "declined": [], "removed": [] },
  // "reviews": { ... },
  // "contacts": [ ... ]
};
// 👆 PASTE YOUR OLD db.json DATA HERE

async function migrate() {
  try {
    console.log("⏳ Starting migration...");
    const res = await pool.query('SELECT data FROM app_state WHERE id = $1', ['main_db']);
    
    if (res.rowCount > 0) {
      const currentData = res.rows[0].data;
      
      // Merge old rooms into the existing database
      if (oldDatabaseData.rooms) {
        if (!currentData.rooms) currentData.rooms = {};
        if (!currentData.rooms.approved) currentData.rooms.approved = [];
        if (!currentData.rooms.pending) currentData.rooms.pending = [];
        
        // Add approved rooms from old DB
        if (oldDatabaseData.rooms.approved) {
          currentData.rooms.approved = [...currentData.rooms.approved, ...oldDatabaseData.rooms.approved];
        }
        // Add pending rooms from old DB
        if (oldDatabaseData.rooms.pending) {
          currentData.rooms.pending = [...currentData.rooms.pending, ...oldDatabaseData.rooms.pending];
        }
      }

      // Merge contacts
      if (oldDatabaseData.contacts) {
        if (!currentData.contacts) currentData.contacts = [];
        currentData.contacts = [...currentData.contacts, ...oldDatabaseData.contacts];
      }

      // Save merged data back to PostgreSQL
      await pool.query('UPDATE app_state SET data = $1 WHERE id = $2', [currentData, 'main_db']);
      console.log("✅ Migration successful! Old posts added to Railway database.");
    }
  } catch (err) {
    console.error("❌ Migration failed:", err.message);
  } finally {
    pool.end();
  }
}

migrate();
