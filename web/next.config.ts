import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: '/landing-clean', destination: '/', permanent: true },
      { source: '/d/index', destination: '/leads', permanent: true },
      { source: '/index', destination: '/leads', permanent: true },
      { source: '/d/:path*', destination: '/:path*', permanent: true },
    ];
  },
};

export default nextConfig;
