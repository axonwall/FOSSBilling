import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Next.js app is a strangler frontend: it owns no billing state.
  // All data comes from the FOSSBilling PHP API (see src/lib/fossbilling.ts)
  // until Scope B phases retire PHP modules one by one.
  reactStrictMode: true,
};

export default nextConfig;
