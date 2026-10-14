import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  clearScreen: false,
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { port: 1420, strictPort: true },
});
