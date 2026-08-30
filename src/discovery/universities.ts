/**
 * US university and health-system domains, for careers-page detection.
 *
 * Measured reality: only about 7% of these are reachable by slug-guessing,
 * because higher education is spread across iCIMS, SuccessFactors, PageUp,
 * SilkRoad, Taleo/BrassRing and Workday with no dominant platform — and of
 * those, only Workday publishes a usable JSON feed.
 *
 * So this list is deliberately paired with careers-page detection rather than
 * the slug prober: the ones running Workday get found with their real tenant
 * and site names (Ohio State is "osu" / "OSUCareers", which no naming rule
 * would ever produce), and the rest simply return nothing.
 */
export const UNIVERSITY_DOMAINS: string[] = [
  // Large publics — the highest concentration of Workday tenants
  'osu.edu', 'umich.edu', 'psu.edu', 'msu.edu', 'purdue.edu', 'indiana.edu',
  'illinois.edu', 'wisc.edu', 'umn.edu', 'iastate.edu', 'uiowa.edu',
  'ku.edu', 'k-state.edu', 'missouri.edu', 'unl.edu', 'colostate.edu',
  'colorado.edu', 'utah.edu', 'byu.edu', 'unm.edu', 'arizona.edu', 'asu.edu',
  'nau.edu', 'unlv.edu', 'unr.edu', 'uoregon.edu', 'oregonstate.edu',
  'washington.edu', 'wsu.edu', 'uidaho.edu', 'umt.edu', 'ndsu.edu', 'sdstate.edu',
  'utexas.edu', 'tamu.edu', 'ttu.edu', 'uh.edu', 'unt.edu', 'baylor.edu',
  'ou.edu', 'okstate.edu', 'uark.edu', 'lsu.edu', 'olemiss.edu', 'msstate.edu',
  'ua.edu', 'auburn.edu', 'uga.edu', 'gatech.edu', 'gsu.edu', 'fsu.edu',
  'ufl.edu', 'ucf.edu', 'usf.edu', 'fiu.edu', 'miami.edu',
  'clemson.edu', 'sc.edu', 'ncsu.edu', 'unc.edu', 'ecu.edu', 'appstate.edu',
  'vt.edu', 'virginia.edu', 'vcu.edu', 'gmu.edu', 'jmu.edu', 'odu.edu',
  'wvu.edu', 'uky.edu', 'louisville.edu', 'utk.edu', 'memphis.edu',
  'umd.edu', 'umbc.edu', 'towson.edu', 'udel.edu', 'rutgers.edu', 'njit.edu',
  'stonybrook.edu', 'buffalo.edu', 'albany.edu', 'binghamton.edu', 'cornell.edu',
  'syr.edu', 'rit.edu', 'rpi.edu', 'clarkson.edu', 'umass.edu', 'uconn.edu',
  'uvm.edu', 'unh.edu', 'maine.edu', 'uri.edu',
  'pitt.edu', 'temple.edu', 'drexel.edu', 'psu.edu', 'lehigh.edu',
  'case.edu', 'uc.edu', 'kent.edu', 'ohio.edu', 'bgsu.edu', 'wayne.edu',
  'wmich.edu', 'cmich.edu', 'niu.edu', 'siu.edu', 'uic.edu', 'depaul.edu',
  'luc.edu', 'iit.edu', 'marquette.edu', 'uwm.edu', 'nd.edu',

  // Privates and research institutions
  'harvard.edu', 'mit.edu', 'yale.edu', 'princeton.edu', 'columbia.edu',
  'upenn.edu', 'brown.edu', 'dartmouth.edu', 'stanford.edu', 'caltech.edu',
  'uchicago.edu', 'northwestern.edu', 'duke.edu', 'vanderbilt.edu', 'rice.edu',
  'emory.edu', 'wustl.edu', 'jhu.edu', 'georgetown.edu', 'gwu.edu',
  'american.edu', 'howard.edu', 'bu.edu', 'northeastern.edu', 'tufts.edu',
  'brandeis.edu', 'bc.edu', 'wpi.edu', 'stevens.edu', 'nyu.edu', 'fordham.edu',
  'newschool.edu', 'pace.edu', 'usc.edu', 'scu.edu', 'pepperdine.edu',
  'baylor.edu', 'smu.edu', 'tcu.edu', 'tulane.edu', 'rollins.edu',

  // Academic health systems — HRIS and clinical-systems roles concentrate here
  'mayoclinic.org', 'clevelandclinic.org', 'massgeneralbrigham.org',
  'hopkinsmedicine.org', 'nyp.org', 'uchicagomedicine.org', 'upmc.com',
  'geisinger.org', 'ochsner.org', 'inova.org', 'sentara.com', 'novanthealth.org',
  'atriumhealth.org', 'bannerhealth.com', 'intermountainhealthcare.org',
  'sutterhealth.org', 'scripps.org', 'sharp.com', 'cedars-sinai.org',
  'stanfordhealthcare.org', 'ucsfhealth.org', 'uchealth.org', 'houstonmethodist.org',
  'memorialhermann.org', 'baylorscottandwhite.com', 'ssmhealth.com',
  'bjc.org', 'ohiohealth.com', 'promedica.org', 'henryford.com', 'corewellhealth.org',
  'allinahealth.org', 'healthpartners.com', 'sanfordhealth.org', 'avera.org',
  'froedtert.com', 'aurorahealthcare.org', 'gundersenhealth.org',
  'wellstar.org', 'piedmont.org', 'prismahealth.org', 'muschealth.org',
  'vumc.org', 'ukhealthcare.uky.edu',
];
