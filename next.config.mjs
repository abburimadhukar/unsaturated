/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The API route reads data/feed-snapshot.json with fs at runtime. Next only
  // bundles files it can statically trace, so a plain fs.readFile would be
  // missing in the deployed function — this includes it explicitly.
  outputFileTracingIncludes: {
    '/api/**': ['./data/**'],
  },

  // The modules under src/ are shared between this app and the tsx CLIs. Node's
  // ESM loader requires explicit ".js" specifiers, but those files are TypeScript,
  // so the bundler has to map ".js" back to ".ts". Without this every shared
  // import fails to resolve.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },

  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
};

export default nextConfig;
