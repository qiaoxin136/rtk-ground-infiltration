export type FlowUnit = 'MGD' | 'cfs' | 'gpm' | 'L/s' | 'm3/s';
export type RainUnit = 'in/hr' | 'in' | 'mm/hr' | 'mm';
export type AreaUnit = 'acres' | 'hectares' | 'sq_mi' | 'km2';

export interface TimeSeriesData {
  timestampsMs: Float64Array;
  values: Float64Array;
  medianStepMin: number;
  detectedHeader: string;
}

export interface AnalysisConfig {
  projectName: string;
  flowUnit: FlowUnit;
  rainUnit: RainUnit;
  areaValue: number;
  areaUnit: AreaUnit;
  smoothWindowMinOverride: number | null; // null = auto-detect from pump cycle
  enablePumpSmoothing: boolean;
  interEventGapHours: number;
  minEventDepthIn: number;
  longTailThresholdHours: number;
  enableCoupledGim: 'auto' | 'always' | 'off';
  optimizerIterations: number;
}

export interface PumpDiagnostics {
  dtMin: number;
  hasPumpInfluence: boolean;
  medianCycleMin: number | null;
  meanCycleMin: number | null;
  rawDiffStdMgd: number;
  smoothDiffStdMgd: number;
  roughnessReductionPct: number;
  smoothingApplied: boolean;
  windowPoints: number;
  windowActualMin: number;
}

export interface DiurnalHourRow {
  hour: number;
  weekdayFlowMgd: number;
  weekdayFactor: number;
  weekendFlowMgd: number;
  weekendFactor: number;
}

export interface DwfSummary {
  cleanDryDayCount: number;
  totalCompleteDays: number;
  weekdayMeanMgd: number;
  weekendMeanMgd: number;
  weightedMeanMgd: number;
  diurnal: DiurnalHourRow[];
  sampleDryDayStartMs: number;
  sampleStormStartMs: number;
}

export interface StormEventRtk {
  eventId: number;
  startMs: number;
  endMs: number;
  fitWindowEndMs: number;
  startIso: string;
  endIso: string;
  durationHours: number;
  totalRainIn: number;
  peakIntensityInHr: number;
  peakRdiiMgd: number;
  excessVolumeMg: number;
  rEmpirical: number;
  rTotalFit: number;
  R1: number;
  T1: number;
  K1: number;
  R2: number;
  T2: number;
  K2: number;
  R3: number;
  T3: number;
  K3: number;
  nse: number;
  tailHoursGt01Mgd: number;
  hasLongGroundwaterTail: boolean;
}

export interface IcmParameterRow {
  icmObject: string;
  parameter: string;
  value: string;
  units: string;
  notes: string;
}

export interface CoupledGimResult {
  enabled: boolean;
  reason: string;
  R1: number;
  T1: number;
  K1: number;
  R2: number;
  T2: number;
  K2: number;
  fInfil: number;
  sMaxIn: number;
  sInitIn: number;
  sThreshIn: number;
  kPercDay: number;
  pPerc: number;
  etInDay: number;
  phiGw: number;
  gInitIn: number;
  gThreshIn: number;
  kGwiDay: number;
  pGwi: number;
  gBfThreshIn: number;
  kBfDay: number;
  gInitFt: number;
  gThreshFt: number;
  gBfThreshFt: number;
  baseOffsetMgd: number;
  metrics: {
    nse15m: number;
    nseDaily: number;
    rmse15mMgd: number;
    rmseDailyMgd: number;
    volumeErrorPct: number;
  };
  icmRows: IcmParameterRow[];
}

export interface AlignedSeries15m {
  timestampsMs: number[];
  rainInHr: number[];
  rainDepthIn: number[];
  flowObservedSmoothMgd: number[];
  flowRawInterpMgd: number[];
  dwfBaselineMgd: number[];
  modeledTotalMgd: number[];
  rtkFastMedMgd: number[];
  gimGroundwaterMgd: number[];
  pureLinearRtkTotalMgd: number[];
  soilStorageIn: number[];
  gwStorageIn: number[];
}

export interface HighResFlowSeries {
  timestampsMs: number[];
  rawMgd: number[];
  smoothedMgd: number[];
}

export interface FullAnalysisResult {
  config: AnalysisConfig;
  areaAcres: number;
  mgPerInchOverArea: number;
  periodStartIso: string;
  periodEndIso: string;
  totalRainDepthIn: number;
  pump: PumpDiagnostics;
  dwf: DwfSummary;
  events: StormEventRtk[];
  maxTailHours: number;
  gim: CoupledGimResult;
  series15m: AlignedSeries15m;
  highResFlow: HighResFlowSeries;
}
