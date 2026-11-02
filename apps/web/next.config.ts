import type { NextConfig } from 'next';
import path from 'node:path';
const config: NextConfig = {
  devIndicators: false,
  outputFileTracingRoot: path.resolve(import.meta.dirname, '../..'),
  serverExternalPackages: ['pg'],
};
export default config;
