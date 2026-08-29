/**
 * Enterprise employers — the half of the market the startup seed list misses.
 *
 * These are where on-site cloud and infrastructure roles actually live: banks,
 * insurers, hospital systems, manufacturers, utilities, retailers, universities
 * and government contractors. They hire the same skills as the tech companies
 * but draw a fraction of the applicants, because almost nobody in the cloud
 * job-seeking crowd is watching their boards.
 *
 * Most sit on Workday, which is precisely why they stay uncontested.
 */
export const ENTERPRISE_COMPANIES: string[] = [
  // Banks, financial services, insurance
  'JPMorgan Chase', 'Bank of America', 'Wells Fargo', 'Citigroup', 'Goldman Sachs',
  'Morgan Stanley', 'US Bancorp', 'PNC Financial', 'Truist', 'Capital One',
  'Charles Schwab', 'Fidelity Investments', 'BlackRock', 'State Street',
  'Northern Trust', 'Regions Bank', 'KeyBank', 'Fifth Third Bank', 'Citizens Bank',
  'Huntington Bank', 'M&T Bank', 'Ally Financial', 'Discover Financial',
  'American Express', 'Visa', 'Mastercard', 'Fiserv', 'FIS', 'Global Payments',
  'Broadridge', 'Nasdaq', 'Intercontinental Exchange', 'CME Group',
  'Allstate', 'Progressive', 'Geico', 'State Farm', 'Liberty Mutual', 'Travelers',
  'Chubb', 'AIG', 'MetLife', 'Prudential Financial', 'Aflac', 'Unum',
  'Nationwide', 'USAA', 'Erie Insurance', 'Cincinnati Financial', 'Markel',
  'Guardian Life', 'Principal Financial', 'Lincoln Financial', 'Voya Financial',

  // Healthcare systems, payers, pharma
  'HCA Healthcare', 'Tenet Healthcare', 'CommonSpirit Health', 'Ascension',
  'Providence Health', 'Trinity Health', 'Advocate Health', 'Baylor Scott and White',
  'Intermountain Health', 'Sutter Health', 'Kaiser Permanente', 'Mayo Clinic',
  'Cleveland Clinic', 'Mass General Brigham', 'Johns Hopkins Medicine',
  'NewYork-Presbyterian', 'Northwestern Medicine', 'UPMC', 'Geisinger',
  'Novant Health', 'Atrium Health', 'Banner Health', 'Corewell Health',
  'UnitedHealth Group', 'Elevance Health', 'Centene', 'Humana', 'Cigna',
  'Molina Healthcare', 'CVS Health', 'McKesson', 'Cardinal Health', 'Cencora',
  'Pfizer', 'Merck', 'Eli Lilly', 'Bristol Myers Squibb', 'Amgen', 'Gilead',
  'Biogen', 'Regeneron', 'Vertex Pharmaceuticals', 'Moderna', 'Abbott',
  'Baxter', 'Becton Dickinson', 'Stryker', 'Boston Scientific', 'Medtronic',
  'Zimmer Biomet', 'Edwards Lifesciences', 'Hologic', 'ResMed',

  // Retail, consumer, food
  'Walmart', 'Target', 'Costco', 'Kroger', 'Albertsons', 'Publix', 'HEB',
  'Home Depot', 'Lowes', 'Best Buy', 'Dollar General', 'Dollar Tree',
  'AutoZone', 'OReilly Automotive', 'Tractor Supply', 'Ulta Beauty',
  'Nordstrom', 'Macys', 'Gap', 'Nike', 'Levi Strauss', 'VF Corporation',
  'PepsiCo', 'Coca-Cola', 'Mondelez', 'General Mills', 'Kellanova', 'Kraft Heinz',
  'Conagra Brands', 'Tyson Foods', 'Hormel Foods', 'JM Smucker', 'Hershey',
  'Starbucks', 'Chipotle', 'Yum Brands', 'Darden Restaurants', 'Dominos Pizza',
  'Marriott International', 'Hilton', 'Hyatt', 'MGM Resorts', 'Caesars Entertainment',

  // Manufacturing, industrial, energy, utilities
  'General Electric', 'Honeywell', 'Emerson Electric', '3M', 'Caterpillar',
  'Deere and Company', 'Cummins', 'Paccar', 'Illinois Tool Works', 'Parker Hannifin',
  'Eaton', 'Rockwell Automation', 'Dover Corporation', 'Stanley Black and Decker',
  'Whirlpool', 'Carrier Global', 'Trane Technologies', 'Johnson Controls',
  'Ford Motor', 'General Motors', 'Tesla', 'Rivian', 'Lucid Motors', 'Polaris',
  'Boeing', 'Lockheed Martin', 'Northrop Grumman', 'RTX', 'General Dynamics',
  'L3Harris', 'Huntington Ingalls', 'Textron', 'Spirit AeroSystems',
  'Leidos', 'Booz Allen Hamilton', 'CACI International', 'SAIC', 'ManTech',
  'Peraton', 'Amentum', 'KBR', 'Jacobs Engineering', 'AECOM', 'Fluor',
  'Exxon Mobil', 'Chevron', 'ConocoPhillips', 'Marathon Petroleum', 'Phillips 66',
  'Valero Energy', 'Halliburton', 'Schlumberger', 'Baker Hughes',
  'NextEra Energy', 'Duke Energy', 'Southern Company', 'Dominion Energy',
  'American Electric Power', 'Exelon', 'Xcel Energy', 'Consolidated Edison',
  'PG&E', 'Edison International', 'Sempra', 'WEC Energy', 'DTE Energy',
  'Entergy', 'FirstEnergy', 'PPL Corporation', 'CenterPoint Energy',

  // Telecom, media, transport, logistics
  'AT&T', 'Verizon', 'T-Mobile', 'Comcast', 'Charter Communications',
  'Warner Bros Discovery', 'Paramount', 'Fox Corporation', 'Disney',
  'United Parcel Service', 'FedEx', 'XPO Logistics', 'CH Robinson', 'Ryder',
  'JB Hunt', 'Old Dominion Freight', 'Union Pacific', 'CSX', 'Norfolk Southern',
  'Delta Air Lines', 'United Airlines', 'American Airlines', 'Southwest Airlines',
  'Alaska Air Group', 'Uber Freight', 'Penske',

  // Tech enterprises that still run classic enterprise ATS
  'IBM', 'Oracle', 'SAP', 'Dell Technologies', 'Hewlett Packard Enterprise',
  'HP Inc', 'Cisco Systems', 'Intel', 'Texas Instruments', 'Micron Technology',
  'Analog Devices', 'Applied Materials', 'Lam Research', 'KLA Corporation',
  'Qualcomm', 'Broadcom', 'Western Digital', 'Seagate Technology',
  'Accenture', 'Cognizant', 'Infosys', 'Wipro', 'Capgemini', 'DXC Technology',
  'Kyndryl', 'Unisys', 'NTT Data', 'Sopra Steria', 'Atos',

  // Universities and public sector employers
  'Harvard University', 'Stanford University', 'Yale University',
  'Columbia University', 'Duke University', 'Vanderbilt University',
  'University of Chicago', 'Northwestern University', 'Emory University',
  'Georgetown University', 'Boston University', 'New York University',
  'Carnegie Mellon University', 'Purdue University', 'Ohio State University',
  'Penn State University', 'University of Michigan', 'University of Washington',
];
