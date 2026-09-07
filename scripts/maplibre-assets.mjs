import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!["--check", "--sync"].includes(mode) || process.argv.length !== 3) {
  throw new Error("Usage: node scripts/maplibre-assets.mjs --check|--sync");
}

const destination = new URL("../public/maplibre/", import.meta.url);
const filenames = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

// Read the complete installed pair before changing either local file. A changed
// upstream layout must fail visibly rather than leave an old/new mixture.
const assets = await Promise.all(filenames.map(async (name) => ({
  name,
  contents: await readFile(fileURLToPath(import.meta.resolve(`maplibre-gl/dist/${name}`))),
})));

if (mode === "--sync") {
  await mkdir(destination, { recursive: true });
  for (const { name, contents } of assets) {
    await writeFile(new URL(name, destination), contents);
  }
  console.log("Synced both MapLibre worker assets from the installed package.");
} else {
  const mismatches = [];
  for (const { name, contents } of assets) {
    let local;
    try {
      local = await readFile(new URL(name, destination));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!local?.equals(contents)) mismatches.push(name);
  }
  if (mismatches.length) {
    console.error(`MapLibre worker assets are missing or out of sync: ${mismatches.join(", ")}.\nRun npm run maplibre:sync and commit both assets with the dependency update.`);
    process.exitCode = 1;
  } else {
    console.log("Both MapLibre worker assets match the installed package.");
  }
}
