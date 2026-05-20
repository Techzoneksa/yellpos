import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Hostinger Node.js hosting — do NOT set output: 'export' (app has API routes)
  // output: 'standalone' can be enabled for faster deployment if needed
  transpilePackages: [
    "lucide-react",
    "date-fns",
    "sonner",
  ],
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
};

export default nextConfig;
