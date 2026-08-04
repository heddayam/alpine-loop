import { access, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// Packages Sites metadata and migrations after Vite finishes compiling.
export function sites(): Plugin {
  let root = process.cwd();
  let isBuild = false;

  return {
    name: "sites",
    configResolved(config) {
      root = config.root;
      isBuild = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const match = /^\/trails\/([a-z0-9]+(?:-[a-z0-9]+)*)\/segments\/(index\.json|[0-9a-f]\.ndjson)$/.exec(
          new URL(request.url ?? "/", "http://localhost").pathname,
        );
        if (!match) return next();
        const path = resolve(root, "data", "trails", "generated", match[1], "segments", match[2]);
        try {
          const content = await readFile(path);
          response.statusCode = 200;
          response.setHeader(
            "Content-Type",
            match[2].endsWith(".json") ? "application/json" : "application/x-ndjson",
          );
          response.end(content);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return next();
          next(error as Error);
        }
      });
    },
    async closeBundle() {
      if (!isBuild) return;
      const outputDirectory = resolve(root, "dist", ".openai");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const drizzleSource = resolve(root, "drizzle");
      const trailArtifacts = resolve(root, "data", "trails", "generated");
      const publicTrails = resolve(root, "dist", "client", "trails");

      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });

      if (await exists(hostingConfig)) {
        await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      }
      if (await exists(drizzleSource)) {
        await cp(drizzleSource, resolve(outputDirectory, "drizzle"), {
          recursive: true,
        });
      }
      await rm(publicTrails, { recursive: true, force: true });
      if (await exists(trailArtifacts)) {
        const regions = await readdir(trailArtifacts, { withFileTypes: true });
        await Promise.all(regions.filter((entry) => entry.isDirectory()).map(async (entry) => {
          const segmentSource = resolve(trailArtifacts, entry.name, "segments");
          if (!await exists(segmentSource)) return;
          await cp(segmentSource, resolve(publicTrails, entry.name, "segments"), {
            recursive: true,
          });
        }));
      }
    },
  };
}
