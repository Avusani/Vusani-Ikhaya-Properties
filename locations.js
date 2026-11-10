// locations.js
const { mainLocations } = require('./locations.seed');

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
}

async function initLocations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      parent_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
      name VARCHAR(200) NOT NULL,
      slug VARCHAR(200) NOT NULL,
      aliases TEXT[] DEFAULT '{}',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM locations');
  if (rows[0].c === 0) await seedLocations(pool);
}

async function seedLocations(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const main of mainLocations) {
      const parent = await client.query(
        `INSERT INTO locations (parent_id,name,slug,aliases) VALUES (NULL,$1,$2,$3) RETURNING id`,
        [main.name, main.slug, main.aliases || []]
      );
      const pid = parent.rows[0].id;
      for (const childName of main.children) {
        await client.query(
          `INSERT INTO locations (parent_id,name,slug,aliases) VALUES ($1,$2,$3,$4) ON CONFLICT (parent_id,name) DO NOTHING`,
          [pid, childName, slugify(childName), []]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function getTree(pool) {
  const { rows } = await pool.query(`SELECT id,parent_id,name,slug,aliases FROM locations WHERE active = TRUE ORDER BY name`);
  const parents = rows.filter(r => r.parent_id === null);
  return parents.map(p => ({
    id: p.id, name: p.name, slug: p.slug, aliases: p.aliases || [],
    children: rows.filter(r => r.parent_id === p.id).map(c => ({ id: c.id, name: c.name }))
  }));
}

module.exports = { initLocations, getTree };
