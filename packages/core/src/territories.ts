/**
 * The territories the stores sell in, and the one place their codes are reconciled.
 *
 * Apple and Google disagree about how to name a country, and the manifest sits between them.
 * App Store Connect speaks ISO 3166-1 **alpha-3** (`USA`, `ESP`, `IND`); Google Play speaks
 * **alpha-2** region codes (`US`, `ES`, `IN`). Before this table existed, whatever the user
 * typed was passed through verbatim to both, so one manifest could not serve two stores:
 * write the alpha-3 form Apple needs and Google's pricing failed outright, write alpha-2 and
 * Apple received a code it does not recognise. The manifest's own default — `baseTerritory:
 * 'US'` — was alpha-2, so it was wrong for Apple out of the box, and because the base
 * territory is folded into the territory map by *string* equality, `US` alongside an `USA`
 * entry produced a phantom extra territory and quietly dropped the base price.
 *
 * The currency column exists for a sharper reason. Play prices every region in that region's
 * own currency, and the adapter used to resolve **one** currency from the base territory and
 * stamp it on every price. A user writing `IN: 199` means ₹199; what would have been sent is
 * 199 *USD*. Money is the one thing this tool must never get quietly wrong, so a price is now
 * denominated in the currency of the territory it belongs to.
 *
 * Deliberately a fixed table rather than a lookup: an unknown territory is an error, never a
 * default. Guessing a currency means charging the wrong amount, and a loud failure the user
 * can answer is always better than a silent transfer of their customers' money.
 */

/** One selling territory: its two code systems and the currency stores price it in. */
export interface Territory {
  /** ISO 3166-1 alpha-2 — Google Play's `regionCode`, and Agentship's canonical form. */
  readonly alpha2: string;
  /** ISO 3166-1 alpha-3 — App Store Connect's territory code. */
  readonly alpha3: string;
  /** ISO 4217 currency the stores price this territory in. */
  readonly currency: string;
}

// alpha-2, alpha-3, currency. Ordered by alpha-2 so a diff of this table is readable.
const TABLE: readonly (readonly [string, string, string])[] = [
  ['AD', 'AND', 'EUR'],
  ['AE', 'ARE', 'AED'],
  ['AF', 'AFG', 'AFN'],
  ['AG', 'ATG', 'XCD'],
  ['AI', 'AIA', 'XCD'],
  ['AL', 'ALB', 'ALL'],
  ['AM', 'ARM', 'AMD'],
  ['AO', 'AGO', 'AOA'],
  ['AR', 'ARG', 'ARS'],
  ['AT', 'AUT', 'EUR'],
  ['AU', 'AUS', 'AUD'],
  ['AW', 'ABW', 'AWG'],
  ['AZ', 'AZE', 'AZN'],
  ['BA', 'BIH', 'BAM'],
  ['BB', 'BRB', 'BBD'],
  ['BD', 'BGD', 'BDT'],
  ['BE', 'BEL', 'EUR'],
  ['BF', 'BFA', 'XOF'],
  ['BG', 'BGR', 'BGN'],
  ['BH', 'BHR', 'BHD'],
  ['BJ', 'BEN', 'XOF'],
  ['BM', 'BMU', 'BMD'],
  ['BN', 'BRN', 'BND'],
  ['BO', 'BOL', 'BOB'],
  ['BR', 'BRA', 'BRL'],
  ['BS', 'BHS', 'BSD'],
  ['BT', 'BTN', 'BTN'],
  ['BW', 'BWA', 'BWP'],
  ['BY', 'BLR', 'BYN'],
  ['BZ', 'BLZ', 'BZD'],
  ['CA', 'CAN', 'CAD'],
  ['CD', 'COD', 'CDF'],
  ['CG', 'COG', 'XAF'],
  ['CH', 'CHE', 'CHF'],
  ['CI', 'CIV', 'XOF'],
  ['CL', 'CHL', 'CLP'],
  ['CM', 'CMR', 'XAF'],
  ['CN', 'CHN', 'CNY'],
  ['CO', 'COL', 'COP'],
  ['CR', 'CRI', 'CRC'],
  ['CV', 'CPV', 'CVE'],
  ['CY', 'CYP', 'EUR'],
  ['CZ', 'CZE', 'CZK'],
  ['DE', 'DEU', 'EUR'],
  ['DK', 'DNK', 'DKK'],
  ['DM', 'DMA', 'XCD'],
  ['DO', 'DOM', 'DOP'],
  ['DZ', 'DZA', 'DZD'],
  ['EC', 'ECU', 'USD'],
  ['EE', 'EST', 'EUR'],
  ['EG', 'EGY', 'EGP'],
  ['ES', 'ESP', 'EUR'],
  ['ET', 'ETH', 'ETB'],
  ['FI', 'FIN', 'EUR'],
  ['FJ', 'FJI', 'FJD'],
  ['FM', 'FSM', 'USD'],
  ['FR', 'FRA', 'EUR'],
  ['GA', 'GAB', 'XAF'],
  ['GB', 'GBR', 'GBP'],
  ['GD', 'GRD', 'XCD'],
  ['GE', 'GEO', 'GEL'],
  ['GH', 'GHA', 'GHS'],
  ['GM', 'GMB', 'GMD'],
  ['GR', 'GRC', 'EUR'],
  ['GT', 'GTM', 'GTQ'],
  ['GW', 'GNB', 'XOF'],
  ['GY', 'GUY', 'GYD'],
  ['HK', 'HKG', 'HKD'],
  ['HN', 'HND', 'HNL'],
  ['HR', 'HRV', 'EUR'],
  ['HU', 'HUN', 'HUF'],
  ['ID', 'IDN', 'IDR'],
  ['IE', 'IRL', 'EUR'],
  ['IL', 'ISR', 'ILS'],
  ['IN', 'IND', 'INR'],
  ['IQ', 'IRQ', 'IQD'],
  ['IS', 'ISL', 'ISK'],
  ['IT', 'ITA', 'EUR'],
  ['JM', 'JAM', 'JMD'],
  ['JO', 'JOR', 'JOD'],
  ['JP', 'JPN', 'JPY'],
  ['KE', 'KEN', 'KES'],
  ['KG', 'KGZ', 'KGS'],
  ['KH', 'KHM', 'KHR'],
  ['KN', 'KNA', 'XCD'],
  ['KR', 'KOR', 'KRW'],
  ['KW', 'KWT', 'KWD'],
  ['KY', 'CYM', 'KYD'],
  ['KZ', 'KAZ', 'KZT'],
  ['LA', 'LAO', 'LAK'],
  ['LB', 'LBN', 'LBP'],
  ['LC', 'LCA', 'XCD'],
  ['LK', 'LKA', 'LKR'],
  ['LR', 'LBR', 'LRD'],
  ['LT', 'LTU', 'EUR'],
  ['LU', 'LUX', 'EUR'],
  ['LV', 'LVA', 'EUR'],
  ['LY', 'LBY', 'LYD'],
  ['MA', 'MAR', 'MAD'],
  ['MD', 'MDA', 'MDL'],
  ['ME', 'MNE', 'EUR'],
  ['MG', 'MDG', 'MGA'],
  ['MK', 'MKD', 'MKD'],
  ['ML', 'MLI', 'XOF'],
  ['MM', 'MMR', 'MMK'],
  ['MN', 'MNG', 'MNT'],
  ['MO', 'MAC', 'MOP'],
  ['MR', 'MRT', 'MRU'],
  ['MS', 'MSR', 'XCD'],
  ['MT', 'MLT', 'EUR'],
  ['MU', 'MUS', 'MUR'],
  ['MV', 'MDV', 'MVR'],
  ['MW', 'MWI', 'MWK'],
  ['MX', 'MEX', 'MXN'],
  ['MY', 'MYS', 'MYR'],
  ['MZ', 'MOZ', 'MZN'],
  ['NA', 'NAM', 'NAD'],
  ['NE', 'NER', 'XOF'],
  ['NG', 'NGA', 'NGN'],
  ['NI', 'NIC', 'NIO'],
  ['NL', 'NLD', 'EUR'],
  ['NO', 'NOR', 'NOK'],
  ['NP', 'NPL', 'NPR'],
  ['NZ', 'NZL', 'NZD'],
  ['OM', 'OMN', 'OMR'],
  ['PA', 'PAN', 'USD'],
  ['PE', 'PER', 'PEN'],
  ['PG', 'PNG', 'PGK'],
  ['PH', 'PHL', 'PHP'],
  ['PK', 'PAK', 'PKR'],
  ['PL', 'POL', 'PLN'],
  ['PT', 'PRT', 'EUR'],
  ['PY', 'PRY', 'PYG'],
  ['QA', 'QAT', 'QAR'],
  ['RO', 'ROU', 'RON'],
  ['RS', 'SRB', 'RSD'],
  ['RU', 'RUS', 'RUB'],
  ['RW', 'RWA', 'RWF'],
  ['SA', 'SAU', 'SAR'],
  ['SB', 'SLB', 'SBD'],
  ['SC', 'SYC', 'SCR'],
  ['SE', 'SWE', 'SEK'],
  ['SG', 'SGP', 'SGD'],
  ['SI', 'SVN', 'EUR'],
  ['SK', 'SVK', 'EUR'],
  ['SL', 'SLE', 'SLE'],
  ['SN', 'SEN', 'XOF'],
  ['SR', 'SUR', 'SRD'],
  ['ST', 'STP', 'STN'],
  ['SV', 'SLV', 'USD'],
  ['SZ', 'SWZ', 'SZL'],
  ['TC', 'TCA', 'USD'],
  ['TD', 'TCD', 'XAF'],
  ['TH', 'THA', 'THB'],
  ['TJ', 'TJK', 'TJS'],
  ['TM', 'TKM', 'TMT'],
  ['TN', 'TUN', 'TND'],
  ['TO', 'TON', 'TOP'],
  ['TR', 'TUR', 'TRY'],
  ['TT', 'TTO', 'TTD'],
  ['TW', 'TWN', 'TWD'],
  ['TZ', 'TZA', 'TZS'],
  ['UA', 'UKR', 'UAH'],
  ['UG', 'UGA', 'UGX'],
  ['US', 'USA', 'USD'],
  ['UY', 'URY', 'UYU'],
  ['UZ', 'UZB', 'UZS'],
  ['VC', 'VCT', 'XCD'],
  ['VE', 'VEN', 'USD'],
  ['VG', 'VGB', 'USD'],
  ['VN', 'VNM', 'VND'],
  ['VU', 'VUT', 'VUV'],
  ['WS', 'WSM', 'WST'],
  ['YE', 'YEM', 'YER'],
  ['ZA', 'ZAF', 'ZAR'],
  ['ZM', 'ZMB', 'ZMW'],
  ['ZW', 'ZWG', 'USD'],
];

const BY_ALPHA2 = new Map<string, Territory>(
  TABLE.map(([alpha2, alpha3, currency]) => [alpha2, { alpha2, alpha3, currency }]),
);
const BY_ALPHA3 = new Map<string, Territory>(
  [...BY_ALPHA2.values()].map((territory) => [territory.alpha3, territory]),
);

/** Every territory Agentship can price, in canonical order. */
export function knownTerritories(): readonly Territory[] {
  return [...BY_ALPHA2.values()];
}

/**
 * Resolves a territory written in either code system, or `undefined` when it is unknown.
 *
 * Case-insensitive, because a manifest is hand-written and `es`, `Es` and `ES` all obviously
 * mean Spain. Never falls back to a guess: an unrecognised code has to reach the caller as
 * "unknown" so it can be reported rather than silently priced.
 */
export function findTerritory(code: string): Territory | undefined {
  const upper = code.trim().toUpperCase();
  return upper.length === 3 ? BY_ALPHA3.get(upper) : BY_ALPHA2.get(upper);
}

/**
 * The canonical (alpha-2) form of a territory code.
 *
 * This is what makes `US` and `USA` the same key. The base territory is folded into the
 * per-territory price map, and comparing raw strings there let one country appear twice —
 * once as the base price and once as its own entry, with the store receiving a code from a
 * system it does not use.
 */
export function canonicalTerritory(code: string): string | undefined {
  return findTerritory(code)?.alpha2;
}
