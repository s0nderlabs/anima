import type { NextConfig } from 'next'

const config: NextConfig = {
  reactStrictMode: true,
  images: {
    formats: ['image/avif', 'image/webp'],
    qualities: [70, 75, 85, 95],
  },
  async rewrites() {
    return [
      { source: '/llms.txt', destination: '/llms' },
      { source: '/llms-full.txt', destination: '/llms/full' },
      { source: '/docs/:slug.md', destination: '/llms/docs/:slug' },
    ]
  },
}

export default config
