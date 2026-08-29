/**
 * Seed company list for discovery.
 *
 * Weighted toward US tech companies that actually employ platform, DevOps, SRE
 * and cloud infrastructure engineers. Startups and scale-ups dominate because
 * they cluster on Greenhouse, Lever and Ashby — the three providers with the
 * cleanest public APIs.
 *
 * This is a bootstrap list, not the ceiling. Once boards are registered, the
 * resolver harvests further tokens from any apply URL it sees.
 */
export const SEED_COMPANIES: string[] = [
  // Infrastructure, devtools, observability — densest source of platform roles
  'HashiCorp', 'Datadog', 'Grafana Labs', 'Confluent', 'Cloudflare', 'Fastly',
  'DigitalOcean', 'Linode', 'Vultr', 'Render', 'Vercel', 'Netlify', 'Fly.io',
  'Railway', 'Supabase', 'PlanetScale', 'CockroachDB', 'MongoDB', 'Redis',
  'Elastic', 'Sentry', 'Honeycomb', 'Chronosphere', 'Pulumi', 'Docker',
  'Replicated', 'Buildkite', 'CircleCI', 'JFrog', 'Sysdig', 'Snyk', 'Aqua Security',
  'Wiz', 'Orca Security', 'Lacework', 'Tailscale', 'Teleport', 'Temporal',
  'Airbyte', 'dbt Labs', 'Astronomer', 'Prefect', 'Dagster Labs', 'Materialize',
  'ClickHouse', 'Timescale', 'Neon', 'Turso', 'Upstash', 'Nginx', 'Kong',
  'Ambassador Labs', 'Solo.io', 'Isovalent', 'Rancher', 'Mirantis', 'Weaveworks',
  'Spectro Cloud', 'Loft Labs', 'Northflank', 'Porter', 'Qovery', 'Coder',
  'Gitpod', 'Depot', 'Namespace', 'Warpbuild', 'Blacksmith',

  // Fintech
  'Stripe', 'Plaid', 'Brex', 'Ramp', 'Mercury', 'Chime', 'Affirm', 'Marqeta',
  'Modern Treasury', 'Unit', 'Lithic', 'Column', 'Increase', 'Alloy', 'Persona',
  'Middesk', 'Codat', 'Pave', 'Carta', 'AngelList', 'Robinhood', 'Coinbase',
  'Kraken', 'Gemini', 'Anchorage Digital', 'Fireblocks', 'Circle', 'Paxos',
  'Betterment', 'Wealthfront', 'SoFi', 'Block', 'Bill.com', 'Navan', 'Deel',
  'Rippling', 'Gusto', 'Justworks', 'Remote', 'Oyster',

  // SaaS and enterprise
  'Notion', 'Linear', 'Figma', 'Airtable', 'Asana', 'Monday.com', 'ClickUp',
  'Miro', 'Canva', 'Loom', 'Zapier', 'Retool', 'Webflow', 'Contentful',
  'Sanity', 'Amplitude', 'Mixpanel', 'Segment', 'Heap', 'FullStory', 'LaunchDarkly',
  'Split', 'Optimizely', 'Braze', 'Klaviyo', 'Iterable', 'Customer.io',
  'Intercom', 'Zendesk', 'Front', 'Gladly', 'Ada', 'Drift', 'Gong', 'Clari',
  'Outreach', 'Salesloft', 'Apollo.io', 'ZoomInfo', 'Lattice', 'Culture Amp',
  'Greenhouse Software', 'Lever', 'Ashby', 'Workable', 'SmartRecruiters',

  // Healthcare, biotech, insurance
  'Lyra Health', 'Headway', 'Spring Health', 'Cerebral', 'Ro', 'Hims and Hers',
  'Oscar Health', 'Devoted Health', 'Clover Health', 'Included Health',
  'Carbon Health', 'One Medical', 'Zocdoc', 'Komodo Health', 'Datavant',
  'Tempus', 'Flatiron Health', 'Benchling', 'Recursion', 'Ginkgo Bioworks',
  'Color Health', 'Verily', 'Olive', 'Cedar', 'Candid Health', 'Sword Health',
  'Hinge Health', 'Omada Health', 'Maven Clinic', 'Kindbody',

  // Commerce, logistics, marketplaces
  'Shopify', 'Faire', 'Instacart', 'DoorDash', 'Gopuff', 'Wayfair', 'Etsy',
  'Chewy', 'Warby Parker', 'Allbirds', 'Peloton', 'Away', 'Glossier',
  'Flexport', 'Convoy', 'Samsara', 'Motive', 'project44', 'Shippo', 'ShipBob',
  'Stord', 'Deliverr', 'Bolt', 'Fanatics', 'StockX', 'GOAT', 'Poshmark',
  'ThredUp', 'Rent the Runway', 'Turo', 'Getaround', 'Lyft', 'Uber',

  // Data, AI, ML infrastructure
  'Databricks', 'Snowflake', 'Scale AI', 'Weights and Biases', 'Hugging Face',
  'Anyscale', 'Modal', 'Replicate', 'Together AI', 'Baseten', 'OctoML',
  'Pinecone', 'Weaviate', 'Chroma', 'LangChain', 'LlamaIndex', 'Cohere',
  'Runway', 'Midjourney', 'Perplexity', 'Glean', 'Sierra', 'Harvey',
  'Abridge', 'Cresta', 'Observe.ai', 'DeepL', 'Grammarly',

  // Security
  'CrowdStrike', 'SentinelOne', 'Okta', 'Auth0', 'JumpCloud', 'Duo Security',
  'Cloudflare Area 1', 'Abnormal Security', 'Material Security', 'Vanta',
  'Drata', 'Secureframe', 'Tailscale Security', 'Chainguard', 'Socket',
  'Semgrep', 'Endor Labs', 'Oso', 'WorkOS', 'Stytch', 'Clerk', 'Descope',

  // Media, consumer, gaming
  'Spotify', 'Discord', 'Reddit', 'Pinterest', 'Twitch', 'Roblox', 'Unity',
  'Epic Games', 'Riot Games', 'Niantic', 'Duolingo', 'Coursera', 'Udemy',
  'Khan Academy', 'Chegg', 'MasterClass', 'Patreon', 'Substack', 'Medium',
  'Vimeo', 'SoundCloud', 'Bandcamp', 'Calm', 'Headspace', 'Strava', 'Whoop',

  // Real estate, proptech, govtech, industrials
  'Zillow', 'Redfin', 'Opendoor', 'Compass', 'Divvy Homes', 'Roofstock',
  'Procore', 'ServiceTitan', 'EquipmentShare', 'Built Robotics', 'Zipline',
  'Anduril', 'Shield AI', 'Applied Intuition', 'Skydio', 'Astranis',
  'Relativity Space', 'Varda', 'Hadrian', 'Nuro', 'Zoox', 'Aurora',
];
