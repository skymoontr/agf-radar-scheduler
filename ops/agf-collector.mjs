const siteUrl = process.env.AGF_SITE_URL ?? "https://agf-radar.kemalgokayyarar.chatgpt.site";

async function readJson(response) {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { return { error: text.slice(0, 300) || `HTTP ${response.status}` }; }
}

const tracksResponse = await fetch(`${siteUrl}/api/tracks`, { headers: { accept: "application/json" } });
const tracksPayload = await readJson(tracksResponse);
if (!tracksResponse.ok || !Array.isArray(tracksPayload.tracks)) {
  throw new Error(tracksPayload.error ?? "Günlük pist listesi alınamadı.");
}

let cursor = 0;
let failures = 0;

async function collectOne(track) {
  let result;
  try {
    const response = await fetch(`${siteUrl}/api/collect`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agf-background": "github-actions" },
      body: JSON.stringify({ track, force: false, headless: true }),
      signal: AbortSignal.timeout(50_000),
    });
    const payload = await readJson(response);
    result = {
      success: response.ok,
      skipped: Boolean(payload.skipped),
      acceptedCount: payload.acceptedCount ?? 0,
      message: response.ok ? undefined : payload.error ?? `HTTP ${response.status}`,
    };
  } catch (error) {
    result = { success: false, skipped: false, acceptedCount: 0, message: error instanceof Error ? error.message : "Bilinmeyen hata" };
  }

  const heartbeat = await fetch(`${siteUrl}/api/background`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ track, result }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!result.success || !heartbeat.ok) failures += 1;
  console.log(`${track.name}: ${result.success ? result.skipped ? "zamanı bekliyor" : `${result.acceptedCount} değer` : result.message}`);
}

async function worker() {
  while (cursor < tracksPayload.tracks.length) {
    const track = tracksPayload.tracks[cursor];
    cursor += 1;
    await collectOne(track);
  }
}

await Promise.all(Array.from({ length: Math.min(3, tracksPayload.tracks.length) }, () => worker()));
if (failures) process.exitCode = 1;
