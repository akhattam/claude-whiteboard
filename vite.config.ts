import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  server: {
    proxy: {
      "/scene": "http://localhost:3737",
      "/snapshot": "http://localhost:3737",
      "/draw": "http://localhost:3737",
      "/events": "http://localhost:3737",
      "/ask": "http://localhost:3737",
      "/respond": "http://localhost:3737",
      "/message": "http://localhost:3737",
      "/chat": "http://localhost:3737",
    },
  },
});
