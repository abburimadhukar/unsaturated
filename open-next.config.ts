import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * OpenNext configuration.
 *
 * No incremental cache override: every page here is either static or fully
 * dynamic, and the job feed does its own caching through Cache-Control headers
 * that Cloudflare honours. Adding an R2-backed ISR cache would be a bucket to
 * pay for and maintain with nothing to put in it.
 */
export default defineCloudflareConfig({});
