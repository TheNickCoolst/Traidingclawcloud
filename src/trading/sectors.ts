/**
 * GICS Sector Mapping for S&P 500 stocks.
 * Used for sector diversification — max 2 positions per sector.
 */

const SECTOR_MAP: Record<string, string> = {
    // ── Information Technology ──────────────────────────────────────────
    AAPL: "Technology", MSFT: "Technology", NVDA: "Technology", AVGO: "Technology",
    ADBE: "Technology", CRM: "Technology", AMD: "Technology", INTC: "Technology",
    CSCO: "Technology", ORCL: "Technology", ACN: "Technology", IBM: "Technology",
    TXN: "Technology", QCOM: "Technology", AMAT: "Technology", ADI: "Technology",
    LRCX: "Technology", KLAC: "Technology", SNPS: "Technology", CDNS: "Technology",
    MCHP: "Technology", MU: "Technology", FTNT: "Technology", PANW: "Technology",
    NOW: "Technology", INTU: "Technology", ADSK: "Technology", NXPI: "Technology",
    APH: "Technology", TEL: "Technology", IT: "Technology", KEYS: "Technology",
    CDW: "Technology", ANET: "Technology", FFIV: "Technology", SWKS: "Technology",
    MPWR: "Technology", ON: "Technology", EPAM: "Technology", AKAM: "Technology",
    BR: "Technology", FICO: "Technology", HPQ: "Technology", HPE: "Technology",
    DELL: "Technology", WDC: "Technology", STX: "Technology", NTAP: "Technology",
    JKHY: "Technology", TDY: "Technology", TER: "Technology", ZBRA: "Technology",
    SMCI: "Technology", PLTR: "Technology", CRWD: "Technology", TTD: "Technology",
    GEN: "Technology", PTC: "Technology", TRMB: "Technology", TYL: "Technology",
    CSGP: "Technology", PAYC: "Technology", FDS: "Technology", FIS: "Technology",
    FI: "Technology", CPAY: "Technology", COIN: "Technology",

    // ── Communication Services ──────────────────────────────────────────
    GOOGL: "Communications", GOOG: "Communications", META: "Communications",
    NFLX: "Communications", DIS: "Communications", CMCSA: "Communications",
    T: "Communications", VZ: "Communications", TMUS: "Communications",
    CHTR: "Communications", EA: "Communications", TTWO: "Communications",
    FOXA: "Communications", FOX: "Communications", OMC: "Communications",
    IPG: "Communications", LYV: "Communications", NWSA: "Communications",
    NWS: "Communications", WBD: "Communications", MTCH: "Communications",

    // ── Consumer Discretionary ──────────────────────────────────────────
    AMZN: "Consumer Discretionary", TSLA: "Consumer Discretionary",
    HD: "Consumer Discretionary", MCD: "Consumer Discretionary",
    NKE: "Consumer Discretionary", LOW: "Consumer Discretionary",
    SBUX: "Consumer Discretionary", TJX: "Consumer Discretionary",
    BKNG: "Consumer Discretionary", CMG: "Consumer Discretionary",
    ROST: "Consumer Discretionary", ORLY: "Consumer Discretionary",
    AZO: "Consumer Discretionary", LULU: "Consumer Discretionary",
    DHI: "Consumer Discretionary", LEN: "Consumer Discretionary",
    PHM: "Consumer Discretionary", NVR: "Consumer Discretionary",
    F: "Consumer Discretionary", GM: "Consumer Discretionary",
    APTV: "Consumer Discretionary", BBY: "Consumer Discretionary",
    EBAY: "Consumer Discretionary", EXPE: "Consumer Discretionary",
    MAR: "Consumer Discretionary", HLT: "Consumer Discretionary",
    RCL: "Consumer Discretionary", CCL: "Consumer Discretionary",
    NCLH: "Consumer Discretionary", WYNN: "Consumer Discretionary",
    MGM: "Consumer Discretionary", LVS: "Consumer Discretionary",
    CZR: "Consumer Discretionary", DPZ: "Consumer Discretionary",
    DRI: "Consumer Discretionary", DECK: "Consumer Discretionary",
    POOL: "Consumer Discretionary", TSCO: "Consumer Discretionary",
    ULTA: "Consumer Discretionary", KMX: "Consumer Discretionary",
    GPC: "Consumer Discretionary", GRMN: "Consumer Discretionary",
    RL: "Consumer Discretionary", TPR: "Consumer Discretionary",
    HAS: "Consumer Discretionary", WSM: "Consumer Discretionary",
    DG: "Consumer Discretionary", DLTR: "Consumer Discretionary",
    DASH: "Consumer Discretionary", ABNB: "Consumer Discretionary",
    UBER: "Consumer Discretionary", CARR: "Consumer Discretionary",

    // ── Consumer Staples ─────────────────────────────────────────────────
    PG: "Consumer Staples", KO: "Consumer Staples", PEP: "Consumer Staples",
    COST: "Consumer Staples", WMT: "Consumer Staples", PM: "Consumer Staples",
    MO: "Consumer Staples", CL: "Consumer Staples", MDLZ: "Consumer Staples",
    KDP: "Consumer Staples", MNST: "Consumer Staples", KHC: "Consumer Staples",
    SYY: "Consumer Staples", GIS: "Consumer Staples", K: "Consumer Staples",
    HSY: "Consumer Staples", KR: "Consumer Staples", CHD: "Consumer Staples",
    CAG: "Consumer Staples", CPB: "Consumer Staples", HRL: "Consumer Staples",
    SJM: "Consumer Staples", MKC: "Consumer Staples", CLX: "Consumer Staples",
    STZ: "Consumer Staples", TAP: "Consumer Staples", BG: "Consumer Staples",
    ADM: "Consumer Staples", KMB: "Consumer Staples", EL: "Consumer Staples",
    KVUE: "Consumer Staples", BF_B: "Consumer Staples",
    LW: "Consumer Staples",

    // ── Healthcare ───────────────────────────────────────────────────────
    UNH: "Healthcare", JNJ: "Healthcare", LLY: "Healthcare",
    ABBV: "Healthcare", MRK: "Healthcare", TMO: "Healthcare",
    ABT: "Healthcare", DHR: "Healthcare", PFE: "Healthcare",
    BMY: "Healthcare", AMGN: "Healthcare", GILD: "Healthcare",
    ISRG: "Healthcare", VRTX: "Healthcare", REGN: "Healthcare",
    MDT: "Healthcare", SYK: "Healthcare", BSX: "Healthcare",
    EW: "Healthcare", BDX: "Healthcare", ZBH: "Healthcare",
    CI: "Healthcare", ELV: "Healthcare", HCA: "Healthcare",
    MOH: "Healthcare", CNC: "Healthcare", HUM: "Healthcare",
    BIIB: "Healthcare", MRNA: "Healthcare", DXCM: "Healthcare",
    IDXX: "Healthcare", IQV: "Healthcare", A: "Healthcare",
    BAX: "Healthcare", HSIC: "Healthcare", ALGN: "Healthcare",
    HOLX: "Healthcare", INCY: "Healthcare", CRL: "Healthcare",
    RVTY: "Healthcare", PODD: "Healthcare", TECH: "Healthcare",
    WST: "Healthcare", STE: "Healthcare", COO: "Healthcare",
    MCK: "Healthcare", CAH: "Healthcare", COR: "Healthcare",
    DVA: "Healthcare", UHS: "Healthcare", LH: "Healthcare",
    DGX: "Healthcare",

    // ── Financials ───────────────────────────────────────────────────────
    BRK_B: "Financials", JPM: "Financials", V: "Financials",
    MA: "Financials", BAC: "Financials", WFC: "Financials",
    GS: "Financials", MS: "Financials", SCHW: "Financials",
    BLK: "Financials", BX: "Financials", KKR: "Financials",
    AXP: "Financials", C: "Financials", USB: "Financials",
    PNC: "Financials", SPGI: "Financials", MCO: "Financials",
    CME: "Financials", ICE: "Financials", NDAQ: "Financials",
    COF: "Financials", MMC: "Financials", AON: "Financials",
    AJG: "Financials", PYPL: "Financials", TFC: "Financials",
    FITB: "Financials", KEY: "Financials", CFG: "Financials",
    MTB: "Financials", HBAN: "Financials", RF: "Financials",
    STT: "Financials", BK: "Financials", RJF: "Financials",
    PRU: "Financials", MET: "Financials", AIG: "Financials",
    AFL: "Financials", PGR: "Financials", TRV: "Financials",
    ALL: "Financials", CINF: "Financials", ACGL: "Financials",
    HIG: "Financials", GL: "Financials", AIZ: "Financials",
    ERIE: "Financials", WRB: "Financials", BEN: "Financials",
    IVZ: "Financials", SYF: "Financials", PFG: "Financials",
    L: "Financials", MKTX: "Financials", CBOE: "Financials",
    MSCI: "Financials", APO: "Financials",

    // ── Industrials ──────────────────────────────────────────────────────
    CAT: "Industrials", HON: "Industrials", UNP: "Industrials",
    UPS: "Industrials", RTX: "Industrials", DE: "Industrials",
    BA: "Industrials", GE: "Industrials", LMT: "Industrials",
    GD: "Industrials", NOC: "Industrials", HII: "Industrials",
    TXT: "Industrials", LHX: "Industrials", HWM: "Industrials",
    ETN: "Industrials", ITW: "Industrials", EMR: "Industrials",
    ROK: "Industrials", PH: "Industrials", MMM: "Industrials",
    CSX: "Industrials", NSC: "Industrials", FDX: "Industrials",
    PCAR: "Industrials", DAL: "Industrials", UAL: "Industrials",
    LUV: "Industrials", ODFL: "Industrials", JBHT: "Industrials",
    CHRW: "Industrials", EXPD: "Industrials", URI: "Industrials",
    WAB: "Industrials", FAST: "Industrials", CMI: "Industrials",
    DOV: "Industrials", IR: "Industrials", AME: "Industrials",
    OTIS: "Industrials", SNA: "Industrials", SWK: "Industrials",
    GNRC: "Industrials", HUBB: "Industrials", LDOS: "Industrials",
    JCI: "Industrials", ROL: "Industrials", CTAS: "Industrials",
    PAYX: "Industrials", ADP: "Industrials", AOS: "Industrials",
    BRO: "Industrials", AXON: "Industrials", BLDR: "Industrials",
    TDG: "Industrials", PWR: "Industrials", ALLE: "Industrials",
    IEX: "Industrials", NDSN: "Industrials", GWW: "Industrials",
    ROP: "Industrials", FTV: "Industrials", J: "Industrials",
    JBL: "Industrials", GEHC: "Industrials", GEV: "Industrials",
    MSI: "Industrials", DAY: "Industrials", CPRT: "Industrials",
    RSG: "Industrials", WM: "Industrials", VRSK: "Industrials",
    CTSH: "Industrials",

    // ── Energy ───────────────────────────────────────────────────────────
    XOM: "Energy", CVX: "Energy", COP: "Energy", EOG: "Energy",
    SLB: "Energy", MPC: "Energy", PSX: "Energy", VLO: "Energy",
    OXY: "Energy", DVN: "Energy", FANG: "Energy", HAL: "Energy",
    BKR: "Energy", APA: "Energy", EQT: "Energy", OKE: "Energy",
    KMI: "Energy", WMB: "Energy", CTRA: "Energy", TRGP: "Energy",
    CF: "Energy",

    // ── Utilities ────────────────────────────────────────────────────────
    NEE: "Utilities", DUK: "Utilities", SO: "Utilities",
    D: "Utilities", AEP: "Utilities", EXC: "Utilities",
    SRE: "Utilities", ED: "Utilities", EIX: "Utilities",
    WEC: "Utilities", DTE: "Utilities", XEL: "Utilities",
    ES: "Utilities", AEE: "Utilities", ETR: "Utilities",
    PPL: "Utilities", CMS: "Utilities", CNP: "Utilities",
    PNW: "Utilities", NI: "Utilities", EVRG: "Utilities",
    ATO: "Utilities", LNT: "Utilities", NRG: "Utilities",
    PCG: "Utilities", PEG: "Utilities", AWK: "Utilities",
    CEG: "Utilities", VST: "Utilities", EXE: "Utilities",

    // ── Real Estate ──────────────────────────────────────────────────────
    PLD: "Real Estate", AMT: "Real Estate", CCI: "Real Estate",
    EQIX: "Real Estate", PSA: "Real Estate", SPG: "Real Estate",
    O: "Real Estate", DLR: "Real Estate", WELL: "Real Estate",
    SBAC: "Real Estate", VICI: "Real Estate", AVB: "Real Estate",
    EQR: "Real Estate", ARE: "Real Estate", VTR: "Real Estate",
    MAA: "Real Estate", UDR: "Real Estate", ESS: "Real Estate",
    CPT: "Real Estate", BXP: "Real Estate", FRT: "Real Estate",
    REG: "Real Estate", KIM: "Real Estate", INVH: "Real Estate",
    EXR: "Real Estate", HST: "Real Estate", IRM: "Real Estate",
    DOC: "Real Estate",

    // ── Materials ────────────────────────────────────────────────────────
    LIN: "Materials", APD: "Materials", SHW: "Materials",
    FCX: "Materials", NUE: "Materials", NEM: "Materials",
    DOW: "Materials", DD: "Materials", ECL: "Materials",
    PPG: "Materials", VMC: "Materials", MLM: "Materials",
    EMN: "Materials", ALB: "Materials", CTVA: "Materials",
    IFF: "Materials", BALL: "Materials", AVY: "Materials",
    MOS: "Materials", AMCR: "Materials", PKG: "Materials",
    IP: "Materials", MHK: "Materials", STLD: "Materials",
    LYB: "Materials", CE: "Materials", GLW: "Materials",
    SOLV: "Materials", SW: "Materials",
};

/**
 * Get the GICS sector for a stock symbol.
 * Returns "Other" if the sector is unknown.
 */
export function getSector(symbol: string): string {
    // Handle Alpaca format (BRK-B → BRK_B) and dot format (BRK.B → BRK_B)
    const normalized = symbol.replace(/[-.]/, "_");
    return SECTOR_MAP[symbol] || SECTOR_MAP[normalized] || "Other";
}

/**
 * Count how many of the given symbols are in each sector.
 * Used for diversification checks.
 */
export function countBySector(symbols: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const sym of symbols) {
        const sector = getSector(sym);
        counts[sector] = (counts[sector] || 0) + 1;
    }
    return counts;
}

/**
 * Check if adding a position in `symbol` would violate sector diversification limits.
 * @param currentPositionSymbols - symbols of currently held positions
 * @param symbol - the new symbol to check
 * @param maxPerSector - maximum positions allowed per sector (default: 2)
 */
export function isSectorLimitReached(
    currentPositionSymbols: string[],
    symbol: string,
    maxPerSector: number = 2
): { blocked: boolean; sector: string; count: number } {
    const sector = getSector(symbol);
    const currentCount = currentPositionSymbols.filter(s => getSector(s) === sector).length;
    return {
        blocked: currentCount >= maxPerSector,
        sector,
        count: currentCount,
    };
}
