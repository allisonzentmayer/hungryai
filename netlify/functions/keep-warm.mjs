// netlify/functions/keep-warm.mjs
//
// Scheduled ping that keeps the search-restaurants function's container
// warm. This site's traffic is low enough that the function would otherwise
// almost always be cold when a real user shows up — a 1-3s cold start on
// top of the actual work. Hitting it every 10 minutes keeps at least one
// container (and its module-scope cache) alive, and warms the edge cache
// for a couple of common metros as a bonus.
//
// Netlify runs this automatically from the `schedule` below — no netlify.toml
// entry needed.

export const config = { schedule: "*/10 * * * *" };

const SPOTS = [
  { lat: 40.713, lng: -74.006 }, // NYC
  { lat: 34.052, lng: -118.244 }, // LA
];

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  if (!base) return new Response("no site url in env", { status: 200 });

  await Promise.all(
    SPOTS.map((s) =>
      fetch(
        `${base}/.netlify/functions/search-restaurants?lat=${s.lat}&lng=${s.lng}&radius=1609`
      ).catch(() => {})
    )
  );
  return new Response("warmed", { status: 200 });
};
