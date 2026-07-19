import path from 'path'
import { fileURLToPath } from 'url'

import { withPayload } from '@payloadcms/next/withPayload'

import type { NextConfig } from 'next'

const __filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(__filename)
const distDir = process.env.NEXT_DIST_DIR?.trim()
const monacoCDNSource = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs/'
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self' https://*.xero.com",
      "font-src 'self' data:",
      "form-action 'self' https://login.xero.com",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob: https:",
      "object-src 'none'",
      `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${monacoCDNSource}`,
      `style-src 'self' 'unsafe-inline' ${monacoCDNSource}`,
      "worker-src 'self' blob:",
    ].join('; '),
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
]

const nextConfig: NextConfig = {
  ...(distDir ? { distDir } : {}),
  async headers() {
    return [{ headers: securityHeaders, source: '/:path*' }]
  },
  poweredByHeader: false,
  webpack: (webpackConfig) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }

    return webpackConfig
  },
  turbopack: {
    root: path.resolve(dirname),
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
