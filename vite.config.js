import { defineConfig, loadEnv } from "vite";

/**
 * תצורת Firebase ציבורית (לא סוד) — נטמעת בבנדל בזמן build.
 * ב-Vercel: אפשר להגדיר FIREBASE_* או VITE_* ב-Environment Variables — שניהם נקראים כאן מ־process.env.
 */
function firebasePublicDefine(mode) {
  const fromFiles = loadEnv(mode, process.cwd(), "");
  const env = { ...fromFiles, ...process.env };
  const pick = (viteName, plainName) => String(env[viteName] || env[plainName] || "").trim();

  const apiKey = pick("VITE_FIREBASE_API_KEY", "FIREBASE_API_KEY");
  const authDomain = pick("VITE_FIREBASE_AUTH_DOMAIN", "FIREBASE_AUTH_DOMAIN");
  const projectId = pick("VITE_FIREBASE_PROJECT_ID", "FIREBASE_PROJECT_ID");
  const appId = pick("VITE_FIREBASE_APP_ID", "FIREBASE_APP_ID");
  const storageBucket = pick("VITE_FIREBASE_STORAGE_BUCKET", "FIREBASE_STORAGE_BUCKET");
  const messagingSenderId = pick("VITE_FIREBASE_MESSAGING_SENDER_ID", "FIREBASE_MESSAGING_SENDER_ID");

  if (mode === "production" && (!apiKey || !authDomain || !projectId || !appId)) {
    console.warn(
      "[idea-planner] חסרים FIREBASE_* או VITE_FIREBASE_* בזמן build — גיבוי ענן לא יעבוד עד שמגדירים ב-Vercel (Settings → Environment Variables) ומריצים Deploy מחדש.",
    );
  }

  const cfg = { apiKey, authDomain, projectId, appId };
  if (storageBucket) cfg.storageBucket = storageBucket;
  if (messagingSenderId) cfg.messagingSenderId = messagingSenderId;
  /* Vite/esbuild מקבל ב-define רק literal — מחרוזת JSON שתפורש בקוד כ־JSON.parse */
  return JSON.stringify(JSON.stringify(cfg));
}

export default defineConfig(({ mode }) => ({
  define: {
    __FIREBASE_PUBLIC_CONFIG__: firebasePublicDefine(mode),
  },
  server: {
    port: 5174,
    strictPort: false,
    host: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
}));
