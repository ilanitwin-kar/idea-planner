import sharp from "sharp";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, "icons", "app-icon.svg");
const outDir = join(root, "public", "icons");
mkdirSync(outDir, { recursive: true });

const base = sharp(svgPath);

await base.clone().resize(192, 192).png({ compressionLevel: 9 }).toFile(join(outDir, "icon-192.png"));
await base.clone().resize(512, 512).png({ compressionLevel: 9 }).toFile(join(outDir, "icon-512.png"));
await base.clone().resize(180, 180).png({ compressionLevel: 9 }).toFile(join(outDir, "apple-touch-icon.png"));

console.log("Generated public/icons/icon-192.png, icon-512.png, apple-touch-icon.png");
