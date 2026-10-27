<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Database Migration Tool</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 40px; background: #f5f7fa; max-width: 800px; margin: 0 auto; }
  h1 { color: #0E382A; }
  textarea { width: 100%; height: 300px; padding: 12px; border-radius: 8px; border: 1px solid #ccc; font-family: monospace; margin-bottom: 20px; }
  button { background: #0E382A; color: white; padding: 14px 28px; border: none; border-radius: 6px; font-size: 16px; font-weight: bold; cursor: pointer; }
  #log { background: #fff; padding: 16px; border-radius: 8px; border: 1px solid #ccc; min-height: 60px; font-family: monospace; color: #333; white-space: pre-wrap; }
</style>
</head>
<body>
  <h1>🚀 Migrate Old Posts to Railway</h1>
  <p>Paste your <strong>full old db.json content</strong> below and click "Restore Data".</p>
  
  <textarea id="jsonInput" placeholder='Paste your old db.json content here...'></textarea>
  <button onclick="migrateData()">Restore Data</button>
  
  <h3 style="margin-top:30px;">Migration Log:</h3>
  <div id="log">Waiting for action...</div>

<script>
async function migrateData() {
  const log = document.getElementById('log');
  const rawInput = document.getElementById('jsonInput').value;
  
  if (!rawInput.trim()) {
    log.style.color = 'red';
    log.textContent = '❌ Please paste your old database content first.';
    return;
  }

  let parsedData;
  try {
    parsedData = JSON.parse(rawInput);
  } catch (err) {
    log.style.color = 'red';
    log.textContent = '❌ Invalid JSON format. Please make sure you copied the whole file exactly.';
    return;
  }

  log.style.color = '#0E382A';
  log.textContent = '⏳ Sending data to Railway database...';

  try {
    const res = await fetch('/api/migrate-direct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsedData)
    });

    const result = await res.json();
    
    if (res.ok) {
      log.style.color = 'green';
      log.textContent = '✅ SUCCESS! Your data has been restored to Railway.\n' +
        'Rooms Restored: ' + (result.roomsApproved || 0) + '\n' +
        'Pending Restored: ' + (result.roomsPending || 0) + '\n' +
        'You can now go to your homepage.';
    } else {
      throw new Error(result.error || 'Migration failed');
    }
  } catch (err) {
    log.style.color = 'red';
    log.textContent = '❌ ' + err.message;
  }
}
</script>
</body>
</html>
