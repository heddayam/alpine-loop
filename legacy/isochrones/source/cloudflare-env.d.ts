declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ARCGIS_API_KEY?: string;
    }
  }
}

export {};
